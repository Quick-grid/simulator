import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Car } from '../src/car.js';
import { handleCarCollisions, integrateOfflineCars, state } from '../src/game.js';
import { generateTrackPath } from '../src/track.js';
import { sampleTrackDistance } from '../src/brakingBoards.js';
import { BOT_CONFIGS } from '../src/constants.js';
import { driveGt3, racePosition } from '../src/ai/gt3Driver.js';
import { PilotRun } from '../src/ai/pilotMemory.js';
import { followingPace, RacePlanner } from '../src/ai/racePlanner.js';

const racer = (id, s, d, speed, lateralSpeed = 0) => ({ id, s, d, speed, lateralSpeed, radius: 1.6 });
const base = { length: 2000, width: 20, preferred: 0, desiredSpeed: 48, lateralBudget: 6, tick: 1, recovering: false };

test('side-by-side cars keep their own corridor, including across the finish line', () => {
  const ego = racer('ego', 1999, -3, 38);
  const neighbor = racer('neighbor', 1, 2, 38);
  const plan = new RacePlanner().plan({ ...base, ego, field: [ego, neighbor], desiredSpeed: 38 });
  assert.equal(plan.action, 'hold');
  assert.equal(plan.offset, ego.d);
  assert.equal(plan.speedLimit, 38);
});

test('a multi-car pack blocks both passes and preserves following distance', () => {
  const ego = racer('ego', 100, 0, 38);
  const field = [ego, racer('center', 128, 0, 33), racer('left', 120, -4.7, 34), racer('right', 122, 4.7, 34)];
  const plan = new RacePlanner().plan({ ...base, ego, field });
  assert.equal(plan.action, 'follow');
  assert.equal(plan.offset, 0);
  assert.ok(plan.speedLimit < base.desiredSpeed);
});

test('lateral motion predicted from another car rules out a future crossing', () => {
  const ego = racer('ego', 100, 0, 40);
  const leader = racer('leader', 140, 0, 30);
  const field = [ego, leader, racer('crossing', 125, -8, 32, 4.5)];
  const plan = new RacePlanner().plan({ ...base, ego, field });
  assert.equal(plan.action, 'prepare');
  assert.ok(plan.offset > 0);
});

test('a narrow road leaves insufficient room to pass without crossing a boundary', () => {
  const ego = racer('ego', 100, 0, 36);
  const plan = new RacePlanner().plan({ ...base, width: 10, ego, field: [ego, racer('leader', 140, 0, 30)] });
  assert.equal(plan.action, 'follow');
  assert.equal(plan.offset, 0);
});

test('overtake commitment holds its side, brakes when blocked and does not weave on abort', () => {
  const planner = new RacePlanner();
  const ego = racer('ego', 100, 0, 40);
  const leader = racer('leader', 143, 0, 32);
  const first = planner.plan({ ...base, ego, field: [ego, leader] });
  assert.equal(first.action, 'prepare');
  const offset = first.offset;
  const moving = racer('ego', 107, Math.sign(offset), 42);
  const continued = planner.plan({ ...base, ego: moving, field: [moving, leader], tick: 12 });
  assert.equal(continued.action, 'prepare');
  assert.equal(continued.offset, offset);
  const clear = racer('ego', 121, offset, 35);
  assert.equal(planner.plan({ ...base, ego: clear, field: [clear, leader], tick: 50 }).action, 'overtake');
  const intruder = racer('intruder', 115, offset, 22);
  const abort = planner.plan({ ...base, ego: moving, field: [moving, leader, intruder], tick: 51 });
  assert.equal(abort.action, 'abort');
  assert.equal(abort.offset, moving.d);
  assert.ok(abort.speedLimit < base.desiredSpeed);
  assert.equal(planner.plan({ ...base, ego: moving, field: [moving, leader], tick: 52 }).action, 'abort');
});

test('defense commits to the occupied lane without cutting in front of a car alongside', () => {
  const ego = racer('ego', 100, 2.5, 31);
  const rear = racer('rear', 82, 2.5, 34);
  const planner = new RacePlanner();
  const defense = planner.plan({ ...base, ego, field: [ego, rear], desiredSpeed: 31 });
  assert.equal(defense.action, 'defend');
  assert.equal(defense.offset, 2.5);
  const neighbor = racer('neighbor', 101, -2.5, 31);
  const hold = planner.plan({ ...base, ego, field: [ego, neighbor], desiredSpeed: 31, tick: 20 });
  assert.equal(hold.offset, 2.5);
});

function runPass(useCurve) {
  if (useCurve) {
    const count = 760, radius = 180, step = 2 * Math.PI / count;
    const segmentLength = 2 * radius * Math.sin(step / 2);
    const trackPath = Array.from({ length: count }, (_, i) => {
      const angle = i * step, heading = angle + Math.PI / 2 + step / 2;
      return { x: radius * Math.cos(angle), y: radius * Math.sin(angle), angle: heading,
        segmentLength, cumulativeDistance: i * segmentLength,
        normalX: -Math.sin(heading), normalY: Math.cos(heading), smoothedCurvature: 1 / radius };
    });
    Object.assign(state, { trackPath, totalTrackLength: segmentLength * count, selectedTrackData: { trackWidth: 24 } });
  } else {
    generateTrackPath(16);
  }
  Object.assign(state, { selectedTrack: 16, botDifficulty: 'pro', trackCondition: 'dry', gameMode: 'race',
    totalLaps: 2, firstFinishedCar: true, keys: {}, particles: [], skidMarks: [], floatingNotices: [], finishedCarsOrder: [] });
  const { trackPath, selectedTrackData } = state;
  const ego = new Car('#f00', 'ego', true, 0);
  const pace = new Car('#fff', 'pace', true, 1);
  function place(car, s, speed) {
    const pose = sampleTrackDistance(trackPath, s);
    Object.assign(car, { x: pose.x, y: pose.y, angle: pose.angle,
      vx: Math.cos(pose.angle) * speed / 60, vy: Math.sin(pose.angle) * speed / 60,
      pathIndex: trackPath.findLastIndex(p => p.cumulativeDistance <= s), baseOffset: 0, botSkill: 1 });
  }
  place(ego, 45, 40);
  place(pace, 86, 29);
  state.cars = [ego, pace];
  pace.brain.computeInputs = projection => driveGt3(pace, trackPath, selectedTrackData.trackWidth,
    'dry', racePosition(pace, trackPath, projection), () => ({ offset: 0, speedLimit: 29 }));
  let nearest = Infinity;
  let attempted = false, passed = false;
  for (let tick = 0; tick < 420; tick++) {
    integrateOfflineCars();
    const separation = Math.hypot(ego.x - pace.x, ego.y - pace.y);
    nearest = Math.min(nearest, separation);
    handleCarCollisions();
    attempted ||= ego.brain.maneuver === 'overtake';
    if (racePosition(ego, trackPath).s - racePosition(pace, trackPath).s > 9) {
      passed = true;
      break;
    }
  }
  assert.ok(attempted && passed, 'a safe pass completes on track');
  assert.ok(nearest >= ego.radius + pace.radius, `closest approach was ${nearest} m`);
  assert.equal(ego.currentSurface, 'TARMAC');
}

test('the GT3 controller passes a slower car using actual steering, braking and collision physics', () => {
  runPass(false);
});

test('a wide bend allows a pass through the actual physics envelope', () => {
  runPass(true);
});

test('following uses closure and allows a slow restart before an obstacle clears completely', () => {
  assert.ok(followingPace(0, 0, 6.26, 5, 45) > 0);
  assert.equal(followingPace(2, 0, 4.8, 5, 45), 0);
  assert.ok(followingPace(40, 25, 20, 5, 60) < 27);
  assert.ok(followingPace(20, 25, 32, 5, 60) > 25);
});

test('entry to a tight bend gives the slower car priority and preserves a checked braking corridor', () => {
  const ego = racer('ego', 100, 0, 38);
  const slower = racer('slower', 123, 0, 19);
  const plan = new RacePlanner().plan({ ...base, ego, field: [ego, slower], approachingBend: true });
  assert.ok(['follow', 'yield'].includes(plan.action));
  assert.ok(plan.speedLimit < ego.speed);
});

test('a faster car closing from the rear does not stop a car holding its line in a bend', () => {
  const ego = racer('ego', 100, -4.5, 5, 1.1);
  const rear = racer('rear', 85.5, -1.25, 17);
  const plan = new RacePlanner().plan({ ...base, ego, field: [ego, rear], approachingBend: true,
    desiredSpeed: 17.5, lateralBudget: 1.4 });
  assert.ok(plan.speedLimit >= ego.speed);
});

test('tight-turn entry waits upstream and releases with hysteresis as the leader clears', () => {
  const ego = racer('ego', 100, 0, 5);
  const planner = new RacePlanner();
  const atEntry = { ...base, ego, approachingBend: true, tightDistance: 11, desiredSpeed: 25 };
  const choose = (gap, tick) => planner.plan({ ...atEntry, tick, field: [ego, racer('leader', 100 + gap, 0, 12)] });
  assert.equal(choose(22, 1).speedLimit, 0);
  assert.equal(choose(26, 2).speedLimit, 0);
  assert.ok(choose(30, 3).speedLimit > 10);
});

test('a stationary rear car yields while the front car releases a soft-margin impasse', () => {
  const fixed = (id, x, order) => ({ ...racer(id, x, 0, 0), x, y: 0, vx: 0, vy: 0, angle: 0, order });
  const front = fixed('front', 100, 0), rear = fixed('rear', 95.4, 1);
  const trackPoint = (s, d) => ({ x: s, y: d, angle: 0 });
  const frontPlanner = new RacePlanner(), rearPlanner = new RacePlanner();
  let leading, trailing;
  for (let tick = 1; tick <= 35; tick++) {
    const context = { ...base, tick, trackPoint, field: [rear, front] };
    leading = frontPlanner.plan({ ...context, ego: front });
    trailing = rearPlanner.plan({ ...context, ego: rear });
  }
  assert.equal(leading.action, 'rejoin');
  assert.ok(leading.speedLimit > 0 && leading.speedLimit <= 6);
  assert.equal(trailing.speedLimit, 0);
});

test('release requires a swept physical corridor and rejects an obstructed escape', () => {
  const stopped = (id, x, y, order) => ({ ...racer(id, x, y, 0), x, y, vx: 0, vy: 0, angle: 0, order });
  const ego = stopped('ego', 100, 0, 0);
  const obstacles = [stopped('ahead', 103.35, 0, 1), stopped('left', 101, -3.15, 2), stopped('right', 101, 3.15, 3)];
  const planner = new RacePlanner();
  let plan;
  for (let tick = 1; tick <= 35; tick++) plan = planner.plan({ ...base, tick, ego, field: [ego, ...obstacles],
    trackPoint: (s, d) => ({ x: s, y: d, angle: 0 }) });
  assert.equal(plan.action, 'yield');
  assert.equal(plan.speedLimit, 0);
});

test('pilot memory records complete sectors, laps and events on simulation ticks in its own schema', () => {
  const map = new Map();
  const storage = { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) };
  const context = { trackId: 16, condition: 'wet', difficulty: 'pro' };
  assert.equal(new Set(BOT_CONFIGS.map(bot => bot.pilotId)).size, BOT_CONFIGS.length);
  const sample = { position: { d: -2 }, surface: 'TARMAC', speed: 42, rearSlip: 0.04,
    throttleInput: 0.3, brakeInput: 0, steerInput: 0.2, maneuver: 'cruise' };
  const run = new PilotRun('hamilton', context);
  run.record(sample);
  run.checkpoint(1);
  for (let checkpoint = 2; checkpoint <= 16; checkpoint++) {
    for (let tick = 0; tick < 60; tick++) run.record(sample);
    if (checkpoint === 3) {
      run.record({ ...sample, surface: 'RUNOFF', maneuver: 'abort' });
      run.contact();
      run.contact();
    }
    run.checkpoint(checkpoint % 16);
  }
  run.finish('completed', storage);
  run.finish('menu', storage);
  const [saved] = Array.from(map.values(), JSON.parse);
  const [result] = saved.runs;
  assert.equal(saved.version, 1);
  assert.equal(saved.scope, 'BOT_PILOT');
  assert.equal(saved.context.pilotId, 'hamilton');
  assert.match(saved.context.physicsFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(result.ticks, 902);
  assert.equal(result.completedLaps, 1);
  assert.equal(result.laps[0].clean, false);
  assert.equal(result.sectors[0].complete, false);
  assert.equal(result.bestCleanSectorTicks[1], 60);
  assert.equal(result.bestCleanSectorTicks[2], undefined);
  assert.equal(result.sectors[1].seconds, 1);
  assert.equal(result.sectors[1].trajectory.meanOffsetMetres, -2);
  assert.equal(result.events.filter(event => event.type === 'contact').length, 1);
  assert.ok(result.events.some(event => event.surface === 'RUNOFF'));
  const other = new PilotRun('hamilton', { ...context, condition: 'dry' });
  other.record(sample);
  other.finish('menu', storage);
  assert.equal(map.size, 2);
});
