import { Car } from '../src/car.js';
import { handleCarCollisions, integrateOfflineCars, state } from '../src/game.js';
import { generateTrackPath } from '../src/track.js';
import { racePosition } from '../src/ai/gt3Driver.js';
import { signedRaceGap } from '../src/ai/racePlanner.js';

const trackIds = [21, 16, 14, 8, 4];
const seeds = [17, 83];
const ticksPerSecond = 60;
const maxTicks = 120 * ticksPerSecond;
const mode = process.argv[2] ?? 'current';
const recordIntervals = process.argv.includes('--trace');
const diagnostics = recordIntervals || !process.argv.includes('--plain');
if (!['current', 'legacy'].includes(mode)) throw new Error('Use current or legacy');

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

function simulatePack(trackId, condition, count) {
  const cars = setup(trackId, condition, 17, count);
  const { trackPath, totalTrackLength } = state;
  const packTicks = 30 * ticksPerSecond;
  let offTicks = 0, contactTicks = 0, contacts = 0, maxPenetration = 0, maxClosingMps = 0;
  let activeContacts = new Set();
  const progress = cars.map(() => 0);
  const slots = new Map(cars.map((car, index) => [car.participantId, index]));
  const metrics = cars.map(() => ({
    stoppedTicks: 0, blockedTicks: 0, longestBlockTicks: 0, openBlock: 0,
    longestViableBlockTicks: 0, openViableBlock: 0, passes: 0, accepted: 0, completed: 0, aborted: 0,
    releaseAcceptedDuringBlock: 0, viableTicksInBlock: 0, mostViableTicksInBlock: 0,
    exits: 0, offTicks: 0, wasOff: false, lapTicks: [], lap: 1, lapStartTick: 0,
    reasons: {}, stops: {}, maneuvers: {}, intervalManeuvers: {}, intervals: []
  }));
  const traces = [];
  const passedSide = new Int8Array(count * count);
  const bump = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };
  if (diagnostics && mode === 'current') cars.forEach((car, slot) => {
    car.brain.raceTrace = trace => { traces[slot] = trace; };
  });
  let field = cars.map(car => racePosition(car, trackPath));
  const startingS = field.map(car => car.s);
  for (tick = 1; tick <= packTicks; tick++) {
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
          contacts += Number(!activeContacts.has(pair));
          maxPenetration = Math.max(maxPenetration, penetration);
          const closing = -((second.vx - first.vx) * dx + (second.vy - first.vy) * dy) * ticksPerSecond / (distance || 1);
          maxClosingMps = Math.max(maxClosingMps, closing);
        }
      }
    }
    activeContacts = nextContacts;
    handleCarCollisions();
    const next = cars.map(car => racePosition(car, trackPath));
    for (let i = 0; i < count; i++) {
      const surface = cars[i].currentSurface;
      const off = surface === 'GRAVEL' || surface === 'RUNOFF';
      offTicks += Number(off);
      progress[i] += signedRaceGap(field[i].s, next[i].s, totalTrackLength);
      const car = cars[i], m = metrics[i], trace = traces[i];
      const speed = Math.hypot(car.vx, car.vy) * ticksPerSecond;
      m.exits += Number(off && !m.wasOff);
      m.offTicks += Number(off);
      m.wasOff = off;
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
      const blocked = tick > 60 && speed < 2 && (trace?.envelopeSpeed ?? 7) > 6;
      m.blockedTicks += Number(blocked);
      m.openBlock = blocked ? m.openBlock + 1 : 0;
      m.longestBlockTicks = Math.max(m.longestBlockTicks, m.openBlock);
      if (!trace) continue;
      bump(m.reasons, trace.limit);
      if (blocked) for (const proposal of trace.proposals) {
        if (!proposal.rejection) continue;
        const direction = proposal.gap < 0 ? 'rear' : 'front';
        const type = proposal.rejection === 'traffic' ? `traffic:${direction}:${proposal.time <= 0.2 ? 'initial' : 'future'}`
          : proposal.rejection;
        bump(m.stops, type);
      }
      for (const proposal of trace.proposals) {
        const key = proposal.maneuver + (proposal.accepted ? ':accepted' : ':rejected');
        bump(m.maneuvers, key);
        if (recordIntervals) bump(m.intervalManeuvers, key);
      }
      for (const event of trace.passEvents) m[event]++;
      const viable = trace.proposals.some(proposal => proposal.accepted && proposal.speedLimit >= 3);
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
    field = next;
  }
  return {
    trackId, condition, count, seed: 17, ticks: packTicks, offTicks, contactTicks, contacts,
    maxPenetrationMetres: Number(maxPenetration.toFixed(3)), maxClosingMps: Number(maxClosingMps.toFixed(3)),
    minDistanceMetres: Math.round(Math.min(...progress)),
    medianDistanceMetres: Math.round([...progress].sort((a, b) => a - b)[Math.floor(count / 2)]),
    bots: metrics.map(({ openBlock, openViableBlock, viableTicksInBlock, wasOff, lap, lapStartTick, intervalManeuvers, intervals, ...m }, i) => ({
      slot: i, metres: Math.round(progress[i]), ...m, ...(recordIntervals && { intervals })
    }))
  };
}

const originalRandom = Math.random;
const originalLog = console.log;
const originalClock = Object.getOwnPropertyDescriptor(performance, 'now');
let scenarios, packs;
try {
  console.log = console.error; // Keep legacy diagnostics out of the JSON report.
  scenarios = trackIds.flatMap(trackId => ['dry', 'wet'].flatMap(condition =>
    seeds.map(seed => simulate(trackId, condition, seed))));
  packs = [[21, 'dry', 19], [8, 'wet', 19], [16, 'dry', 10], [14, 'wet', 10]]
    .map(scenario => simulatePack(...scenario));
} finally {
  Math.random = originalRandom;
  console.log = originalLog;
  if (originalClock) Object.defineProperty(performance, 'now', originalClock);
  else delete performance.now;
}
console.log(JSON.stringify({ mode, ticksPerSecond, scenarios, packs }, null, 2));
