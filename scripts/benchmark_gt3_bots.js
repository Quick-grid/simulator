import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const trackIds = [21, 16, 14, 8, 4];
const seeds = [17, 83];
const ticksPerSecond = 60;
const maxTicks = 120 * ticksPerSecond;
const args = process.argv.slice(2);
const option = name => args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1);
const mode = args[0] && !args[0].startsWith('--') ? args[0] : 'current';
const recordIntervals = args.includes('--trace');
const recordFailures = args.includes('--failures');
const diagnostics = !args.includes('--plain');
const packOnly = args.includes('--pack-only');
const durations = (option('--seconds') ?? '30').split(',').map(Number);
const selectedTrack = option('--track') && Number(option('--track'));
if (!['current', 'legacy'].includes(mode)) throw new Error('Use current or legacy');
if (durations.some(seconds => ![30, 60, 120, 180].includes(seconds))) throw new Error('Use 30, 60, 120 or 180 seconds');
if (selectedTrack !== undefined && !trackIds.includes(selectedTrack)) throw new Error('Unknown benchmark track');
if (!diagnostics && (recordIntervals || recordFailures)) throw new Error('Trace capture requires diagnostics');
const source = option('--repo');
const load = file => import(source ? pathToFileURL(resolve(source, 'src', file)).href : new URL('../src/' + file, import.meta.url));
const [{ Car }, { handleCarCollisions, integrateOfflineCars, state }, { generateTrackPath },
  { racePosition }, { signedRaceGap }, { GT3_BASE_GRIP, GT3_AERO_GRIP, MAX_INTERNAL_SPEED }, { WAKE_TUNING }] = await Promise.all([
  load('car.js'), load('game.js'), load('track.js'), load('ai/gt3Driver.js'), load('ai/racePlanner.js'),
  load('constants.js'), load('aerodynamics.js')
]);

let tick;
function setup(trackId, condition, seed, count) {
  let randomState = seed;
  Math.random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 2 ** 32;
  };
  tick = 0;
  Object.defineProperty(performance, 'now', {
    configurable: true, value: () => 1000 + tick * 1000 / ticksPerSecond
  });
  generateTrackPath(trackId);
  Object.assign(state, {
    selectedTrack: trackId, trackCondition: condition, botDifficulty: 'pro',
    keys: {}, particles: [], skidMarks: [], floatingNotices: [], finishedCarsOrder: [],
    firstFinishedCar: true, gameMode: 'race', totalLaps: 2
  });

  state.cars = Array.from({ length: count }, (_, slot) => {
    const bot = new Car('#ff0000', 'GT3 benchmark', true, slot);
    if (mode === 'legacy') bot.brain.driver = 'legacy';
    return bot;
  });
  return state.cars;
}

function simulate(trackId, condition, seed) {
  const [bot] = setup(trackId, condition, seed, 1);
  let offTicks = 0, exits = 0, wasOff = false, peakKmh = 0;
  let lapStartTick = 0;
  const lapTicks = [];
  let distance = 0;
  let distanceAt30Seconds;
  let previousDistance = state.trackPath[bot.pathIndex].cumulativeDistance;
  while (tick < maxTicks && !bot.finished) {
    const lap = bot.currentLap;
    tick++;
    bot.update();
    handleCarCollisions();
    if (bot.currentLap !== lap) {
      lapTicks.push(tick - lapStartTick);
      lapStartTick = tick;
    }
    const position = state.trackPath[bot.pathIndex].cumulativeDistance;
    const length = state.totalTrackLength;
    distance += signedRaceGap(previousDistance, position, length);
    previousDistance = position;
    if (tick === 30 * ticksPerSecond) distanceAt30Seconds = Math.round(distance);
    const off = bot.currentSurface === 'GRAVEL' || bot.currentSurface === 'RUNOFF';
    offTicks += Number(off);
    exits += Number(off && !wasOff);
    wasOff = off;
    peakKmh = Math.max(peakKmh, bot.getKmh());
  }
  return {
    trackId, condition, seed, ticks: tick, offTicks, exits,
    lapTicks, distanceMetres: Math.round(distance), distanceAt30Seconds, peakKmh
  };
}

function simulatePack(trackId, condition, count, seconds) {
  const cars = setup(trackId, condition, 17, count);
  const { trackPath, totalTrackLength, selectedTrackData } = state;
  const packTicks = seconds * ticksPerSecond;
  const hash = createHash('sha256');
  const frame = Buffer.alloc(count * 14 * Float64Array.BYTES_PER_ELEMENT);
  const traceFailures = recordFailures;
  const failures = [], pending = [], history = [];
  const firstFailure = { offTrack: null, contact: null };
  const windowTicks = 24;
  let offTicks = 0, contactTicks = 0, contacts = 0, maxPenetration = 0, maxClosingMps = 0;
  let activeContacts = new Set();
  const progress = cars.map(() => 0);
  const slots = new Map(cars.map((car, index) => [car.participantId, index]));
  const metrics = cars.map(() => ({
    stoppedTicks: 0, blockedTicks: 0, longestBlockTicks: 0, openBlock: 0,
    longestViableBlockTicks: 0, openViableBlock: 0, passes: 0, accepted: 0, completed: 0, aborted: 0,
    releaseAcceptedDuringBlock: 0, viableTicksInBlock: 0, mostViableTicksInBlock: 0,
    exits: 0, offTicks: 0, wasOff: false, lapTicks: [], lap: 1, lapStartTick: 0,
    sectorTicks: [], sectorStart: 0, metresDriven: 0, activeTicks: 0,
    contacts: 0, overlapTicks: 0, maxPenetrationMetres: 0, maxClosingMps: 0,
    reasons: {}, blockedBy: {}, rejectedWhileBlocked: {}, maneuvers: {}, intervalManeuvers: {}, intervals: []
  }));
  const traces = [];
  const controls = [];
  const passedSide = new Int8Array(count * count);
  const bump = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };
  if (diagnostics && mode === 'current') cars.forEach((car, slot) => {
    car.brain.raceTrace = trace => { traces[slot] = trace; };
  });
  if (traceFailures) cars.forEach((car, slot) => {
    const computeInputs = car.brain.computeInputs.bind(car.brain);
    car.brain.computeInputs = (...args) => {
      const inputs = computeInputs(...args);
      const { steerInput, throttleInput, brakeInput, plan } = inputs;
      controls[slot] = { steerInput, throttleInput, brakeInput, offset: plan?.offset, duration: plan?.duration };
      return inputs;
    };
  });
  let field = cars.map(car => racePosition(car, trackPath));
  const startingS = field.map(car => car.s);
  const checkpoint = cars.map(car => car.nextCheckpoint);
  const noteFailure = (type, slots, details, events) => {
    firstFailure[type] ??= { tick, slots, ...details };
    if (traceFailures) events.push({ type, tick, slots, ...details });
  };
  function capture(events) {
    const snapshots = cars.map((car, slot) => {
      const t = traces[slot];
      const { lateralDist, segmentIdx } = car.getTrackDistanceAndSegment();
      const speed = Math.hypot(car.vx, car.vy);
      const wet = condition === 'wet';
      const surface = { GRAVEL: 0.28, RUNOFF: 0.74, KERB: 0.84 }[car.currentSurface] ?? 1;
      const temperature = Math.max(0, 1 - Math.abs(car.tyreTemp - (wet ? 62 : 92)) / (wet ? 42 : 58));
      const grip = (GT3_BASE_GRIP + GT3_AERO_GRIP * Math.min(1.35, (speed / MAX_INTERNAL_SPEED) ** 2)
        * (1 - (car.wakeIntensity ?? 0) * WAKE_TUNING.downforceLoss))
        * surface * (wet ? 0.74 : 1) * (0.80 + temperature * 0.20) * (1 - car.tyreWear * 0.22);
      return {
        tick, slot, speed: t?.speed, target: t?.targetSpeed, envelope: t?.envelopeSpeed, limit: t?.limit,
        action: t?.action, previousAction: t?.previousAction,
        position: t?.position && { ...t.position, id: undefined }, ...controls[slot],
        x: car.x, y: car.y, heading: car.angle, segmentIdx, lateralDist, finished: car.finished, lap: car.currentLap,
        groundSpeed: speed * ticksPerSecond,
        surface: car.currentSurface, halfWidth: selectedTrackData.trackWidth / 2,
        grip: Number.isFinite(grip) ? grip : null, yawRate: car.yawRate, rearSlip: car.rearSlip,
        blockTicks: metrics[slot].openBlock, priority: t?.priority, blockReason: t?.blockReason,
        changes: t?.passEvents, proposals: t?.proposals.map(({ opponent, ...proposal }) => ({ ...proposal, opponent: slots.get(opponent) })),
        opponents: t?.opponents.filter(other => Math.abs(other.gap) < 45).map(other => ({
          slot: slots.get(other.id), gap: other.gap, d: other.d, relativeSpeed: other.speed - t.position.speed,
          x: other.x, y: other.y, heading: other.angle
        }))
      };
    });
    for (const event of events) {
      event.frames = history.filter(row => row.tick % 4 === 0)
        .flatMap(row => event.slots.map(slot => row.snapshots[slot]).filter(Boolean));
      failures.push(event);
      pending.push(event);
    }
    for (let i = pending.length - 1; i >= 0; i--) {
      const event = pending[i];
      if (tick === event.tick || tick % 4 === 0) {
        event.frames.push(...event.slots.map(slot => snapshots[slot]).filter(Boolean));
      }
      if (tick >= event.tick + windowTicks) pending.splice(i, 1);
    }
    history.push({ tick, snapshots });
    if (history.length > windowTicks) history.shift();
  }
  for (tick = 1; tick <= packTicks; tick++) {
    const active = cars.map(car => !car.finished);
    const events = [];
    traces.fill(undefined);
    controls.fill(undefined);
    integrateOfflineCars();
    const nextContacts = new Set();
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const first = cars[i], second = cars[j];
        const dx = second.x - first.x, dy = second.y - first.y;
        const distance = Math.hypot(dx, dy), penetration = first.radius + second.radius - distance;
        if (penetration > 0) {
          contactTicks++;
          const pair = i * count + j;
          nextContacts.add(pair);
          const started = !activeContacts.has(pair);
          contacts += Number(started);
          maxPenetration = Math.max(maxPenetration, penetration);
          const closing = -((second.vx - first.vx) * dx + (second.vy - first.vy) * dy) * ticksPerSecond / (distance || 1);
          maxClosingMps = Math.max(maxClosingMps, closing);
          for (const slot of [i, j]) {
            const m = metrics[slot];
            m.contacts += Number(started);
            m.overlapTicks++;
            m.maxPenetrationMetres = Math.max(m.maxPenetrationMetres, penetration);
            m.maxClosingMps = Math.max(m.maxClosingMps, closing);
          }
          if (started) noteFailure('contact', [i, j], { penetration, closing }, events);
        }
      }
    }
    activeContacts = nextContacts;
    cars.forEach((car, slot) => {
      if (!active[slot]) return;
      metrics[slot].activeTicks++;
      metrics[slot].metresDriven += Math.hypot(car.x - field[slot].x, car.y - field[slot].y);
    });
    handleCarCollisions();
    const next = cars.map(car => racePosition(car, trackPath));
    for (let i = 0; i < count; i++) {
      const surface = cars[i].currentSurface;
      const off = surface === 'GRAVEL' || surface === 'RUNOFF';
      offTicks += Number(off);
      progress[i] += signedRaceGap(field[i].s, next[i].s, totalTrackLength);
      const car = cars[i], m = metrics[i], trace = traces[i];
      const values = [car.x, car.y, car.vx, car.vy, car.angle, car.currentLap, car.nextCheckpoint, Number(car.finished),
        ['TARMAC', 'KERB', 'RUNOFF', 'GRAVEL'].indexOf(surface),
        car.lastSteerInput ?? 0, car.lastThrottleInput ?? 0, car.lastBrakeInput ?? 0, car.yawRate, car.brakePressure];
      values.forEach((value, index) => frame.writeDoubleLE(value, (i * values.length + index) * 8));
      const speed = Math.hypot(car.vx, car.vy) * ticksPerSecond;
      if (off && !m.wasOff) {
        const distance = car.getTrackDistanceAndSegment().lateralDist;
        noteFailure('offTrack', [i], { surface, distance, halfWidth: selectedTrackData.trackWidth / 2 }, events);
      }
      m.exits += Number(off && !m.wasOff);
      m.offTicks += Number(off);
      m.wasOff = off;
      if (car.nextCheckpoint !== checkpoint[i]) {
        m.sectorTicks.push({ lap: m.lap, checkpoint: checkpoint[i], ticks: tick - m.sectorStart });
        m.sectorStart = tick;
        checkpoint[i] = car.nextCheckpoint;
      }
      m.stoppedTicks += Number(tick > 60 && speed < 0.5);
      if (car.currentLap !== m.lap) {
        m.lapTicks.push(tick - m.lapStartTick);
        m.lapStartTick = tick;
        m.lap = car.currentLap;
      }
      // Count a pass after the longitudinal lead changes by a full clearance
      // in both directions. This definition also applies to the legacy driver.
      for (let j = 0; j < count; j++) {
        if (j === i) continue;
        const gap = signedRaceGap(startingS[i], startingS[j], totalTrackLength) + progress[j] - progress[i];
        const index = i * count + j;
        if (gap > 5) passedSide[index] = -1;
        else if (gap < -5) {
          m.passes += Number(passedSide[index] === -1);
          passedSide[index] = 1;
        }
      }
      const blocked = active[i] && tick > 60 && speed < 2 && (trace?.envelopeSpeed ?? 7) > 6;
      m.blockedTicks += Number(blocked);
      m.openBlock = blocked ? m.openBlock + 1 : 0;
      m.longestBlockTicks = Math.max(m.longestBlockTicks, m.openBlock);
      if (!trace) continue;
      bump(m.reasons, trace.limit);
      if (blocked) bump(m.blockedBy, trace.blockReason ?? trace.action ?? trace.limit);
      if (blocked) for (const proposal of trace.proposals) {
        if (!proposal.rejection) continue;
        const direction = proposal.gap < 0 ? 'rear' : 'front';
        const type = proposal.rejection === 'traffic' ? `traffic:${direction}:${proposal.time <= 0.2 ? 'initial' : 'future'}`
          : proposal.rejection;
        bump(m.rejectedWhileBlocked, type);
      }
      for (const proposal of trace.proposals) {
        const key = proposal.maneuver + (proposal.accepted ? ':accepted' : ':rejected');
        bump(m.maneuvers, key);
        if (recordIntervals) bump(m.intervalManeuvers, key);
      }
      for (const event of trace.passEvents) m[event]++;
      const viable = trace.proposals.some(proposal => proposal.accepted && proposal.speedLimit >= 3 && proposal.eligible !== false);
      m.releaseAcceptedDuringBlock += Number(blocked && trace.proposals.some(proposal => proposal.maneuver === 'release'
        && proposal.accepted && proposal.speedLimit >= 3));
      m.viableTicksInBlock = blocked ? m.viableTicksInBlock + Number(viable) : 0;
      m.mostViableTicksInBlock = Math.max(m.mostViableTicksInBlock, m.viableTicksInBlock);
      m.openViableBlock = blocked && viable ? m.openViableBlock + 1 : 0;
      m.longestViableBlockTicks = Math.max(m.longestViableBlockTicks, m.openViableBlock);
      if (recordIntervals && tick % 30 === 0) {
        m.intervals.push({
          tick, metres: Math.round(progress[i] * 10) / 10, speed: trace.speed, target: trace.targetSpeed,
          envelope: trace.envelopeSpeed, brake: trace.brakeInput, limit: trace.limit, action: trace.action,
          s: trace.position.s, angle: trace.position.angle, yawRate: car.yawRate, steer: car.steerAmount,
          headingError: Math.atan2(Math.sin(trace.position.angle - trackPath[trace.position.index].angle),
            Math.cos(trace.position.angle - trackPath[trace.position.index].angle)),
          blockReason: trace.blockReason, priority: trace.priority,
          surface, offset: trace.position.d, intervalManeuvers: m.intervalManeuvers,
          freeCorridor: viable || trace.action === 'cruise', blockedTicks: m.blockedTicks, currentBlockTicks: m.openBlock,
          nearby: trace.opponents.filter(other => Math.abs(other.gap) < 45).map(other => ({
            slot: slots.get(other.id), gap: other.gap, offset: other.d, relativeSpeed: other.speed - trace.position.speed
          })),
          proposals: trace.proposals.map(({ opponent, ...proposal }) => ({ ...proposal, opponent: slots.get(opponent) })),
          passesAccepted: m.accepted, passesCompleted: m.completed, passesAborted: m.aborted
        });
        m.intervalManeuvers = {};
      }
    }
    hash.update(frame);
    if (traceFailures) capture(events);
    field = next;
  }
  return {
    trackId, condition, count, seed: 17, ticks: packTicks, offTicks, contactTicks, contacts,
    simulationHash: hash.digest('hex'), firstFailure, ...(traceFailures && { failures }),
    maxPenetrationMetres: Number(maxPenetration.toFixed(3)), maxClosingMps: Number(maxClosingMps.toFixed(3)),
    minDistanceMetres: Math.round(Math.min(...progress)),
    medianDistanceMetres: Math.round([...progress].sort((a, b) => a - b)[Math.floor(count / 2)]),
    bots: metrics.map(({ openBlock, openViableBlock, viableTicksInBlock, wasOff, lap, lapStartTick, intervalManeuvers, intervals, ...m }, i) => ({
      slot: i, metres: Math.round(progress[i]), ...m,
      meanSpeedMps: m.metresDriven * ticksPerSecond / Math.max(1, m.activeTicks),
      ...(recordIntervals && { intervals })
    }))
  };
}

const originalRandom = Math.random;
const originalLog = console.log;
const originalClock = Object.getOwnPropertyDescriptor(performance, 'now');
let scenarios, packs;
try {
  console.log = console.error; // Keep legacy diagnostics out of the JSON report.
  scenarios = packOnly ? [] : trackIds.filter(trackId => !selectedTrack || trackId === selectedTrack)
    .flatMap(trackId => ['dry', 'wet'].flatMap(condition =>
    seeds.map(seed => simulate(trackId, condition, seed))));
  packs = durations.flatMap(seconds => [[21, 'dry', 19], [8, 'wet', 19], [16, 'dry', 10], [14, 'wet', 10]]
    .filter(([trackId]) => !selectedTrack || trackId === selectedTrack)
    .map(scenario => simulatePack(...scenario, seconds)));
} finally {
  Math.random = originalRandom;
  console.log = originalLog;
  if (originalClock) Object.defineProperty(performance, 'now', originalClock);
  else delete performance.now;
}
console.log(JSON.stringify({ mode, ticksPerSecond, scenarios, packs }, null, 2));
