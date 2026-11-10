import { NUM_CHECKPOINTS } from '../constants.js';
import { SIMULATION_FINGERPRINT_SHA256, TELEMETRY_LINEAGE_VERSIONS } from '../ml/lineage/baselineManifest.js';
import { BOT_TICK_HZ } from './gt3Driver.js';

export const GT3_DRIVER_VERSION = 'gt3-phase1.1-v1';
const MEMORY_VERSION = 1;
const round = value => Number(value.toFixed(3));

const metrics = () => ({
  ticks: 0, offTrackTicks: 0, speed: 0, throttle: 0, brake: 0, steering: 0, slip: 0,
  offset: 0, minOffset: Infinity, maxOffset: -Infinity
});

function summarize(data) {
  const mean = value => round(value / data.ticks);
  return {
    ticks: data.ticks, seconds: round(data.ticks / BOT_TICK_HZ), offTrackTicks: data.offTrackTicks,
    meanSpeedMps: mean(data.speed),
    controls: {
      meanThrottle: mean(data.throttle), meanBrake: mean(data.brake),
      meanAbsoluteSteer: mean(data.steering), meanRearSlip: mean(data.slip)
    },
    trajectory: {
      meanOffsetMetres: mean(data.offset), minOffsetMetres: round(data.minOffset), maxOffsetMetres: round(data.maxOffset)
    }
  };
}

function retain(list, item, limit) {
  list.push(item);
  if (list.length > limit) list.shift();
}

export class PilotRun {
  constructor(pilotId, { trackId, condition, difficulty }) {
    this.context = {
      pilotId, trackId, carId: 'gt3', condition, difficulty, driverVersion: GT3_DRIVER_VERSION,
      physicsVersion: TELEMETRY_LINEAGE_VERSIONS.PHYSICS_VERSION,
      physicsFingerprint: SIMULATION_FINGERPRINT_SHA256,
      trackGeometryVersion: TELEMETRY_LINEAGE_VERSIONS.TRACK_GEOMETRY_VERSION
    };
    this.tick = 0;
    this.lapNumber = 1;
    this.sector = metrics();
    this.lap = metrics();
    this.sectors = [];
    this.laps = [];
    this.events = [];
    this.bestCleanSectorTicks = {};
    this.sectorStartedAtCheckpoint = false;
    this.surface = 'TARMAC';
    this.maneuver = 'cruise';
  }

  record({ position, surface, speed, rearSlip, throttleInput, brakeInput, steerInput, maneuver }) {
    if (this.closed) return;
    this.tick++;
    if (surface !== this.surface) {
      retain(this.events, { tick: this.tick, type: 'surface', surface }, 48);
      this.surface = surface;
    }
    if (maneuver !== this.maneuver) {
      retain(this.events, { tick: this.tick, type: 'maneuver', maneuver }, 48);
      this.maneuver = maneuver;
    }
    const offTrack = surface === 'RUNOFF' || surface === 'GRAVEL';
    for (const data of [this.sector, this.lap]) {
      data.ticks++;
      data.offTrackTicks += Number(offTrack);
      data.speed += speed;
      data.throttle += throttleInput;
      data.brake += brakeInput;
      data.steering += Math.abs(steerInput);
      data.slip += rearSlip;
      data.offset += position.d;
      data.minOffset = Math.min(data.minOffset, position.d);
      data.maxOffset = Math.max(data.maxOffset, position.d);
    }
  }

  contact() {
    if (this.closed || this.lastContactTick === this.tick) return;
    retain(this.events, { tick: this.tick, type: 'contact' }, 48);
    this.lastContactTick = this.tick;
    this.sector.contact = this.lap.contact = true;
  }

  checkpoint(index) {
    if (this.closed || this.sector.ticks === 0) return;
    const sector = (index + NUM_CHECKPOINTS - 1) % NUM_CHECKPOINTS;
    const clean = !this.sector.contact && this.sector.offTrackTicks === 0;
    const complete = this.sectorStartedAtCheckpoint;
    retain(this.sectors, { lap: this.lapNumber, sector, complete, clean, ...summarize(this.sector) }, 32);
    if (complete && clean) {
      this.bestCleanSectorTicks[sector] = Math.min(this.bestCleanSectorTicks[sector] ?? Infinity, this.sector.ticks);
    }
    this.sector = metrics();
    this.sectorStartedAtCheckpoint = true;
    if (index === 0) {
      retain(this.laps, { lap: this.lapNumber, start: this.lapNumber === 1 ? 'grid' : 'line',
        clean: !this.lap.contact && this.lap.offTrackTicks === 0, ...summarize(this.lap) }, 8);
      this.lapNumber++;
      this.lap = metrics();
    }
  }

  finish(reason, storage) {
    if (this.closed || this.tick === 0) return;
    this.closed = true;
    const key = 'quick-grid:bot-memory:' + JSON.stringify([MEMORY_VERSION, ...Object.values(this.context)]);
    const run = {
      ticks: this.tick, reason, completedLaps: this.lapNumber - 1, bestCleanSectorTicks: this.bestCleanSectorTicks,
      sectors: this.sectors, laps: this.laps, events: this.events,
      partialLap: this.lap.ticks ? { lap: this.lapNumber, ...summarize(this.lap) } : null
    };
    try {
      storage ??= globalThis.localStorage;
      if (!storage) return;
      let previous;
      try { previous = JSON.parse(storage.getItem(key)); } catch { previous = null; }
      const runs = previous?.version === MEMORY_VERSION && Array.isArray(previous.runs) ? previous.runs.slice(-2) : [];
      storage.setItem(key, JSON.stringify({ version: MEMORY_VERSION, scope: 'BOT_PILOT', context: this.context, runs: [...runs, run] }));
    } catch {
      // Storage may be disabled, full, or unavailable in headless simulation.
    }
  }
}
