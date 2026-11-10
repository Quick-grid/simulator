import { sampleTrackDistance } from '../brakingBoards.js';
import { FORCA_FREIO_MAX, GT3_WHEELBASE, MAX_INTERNAL_SPEED } from '../constants.js';

export const BOT_TICK_HZ = 60;
const profiles = new WeakMap();
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

export function racePosition(car, path, projection) {
  let { segmentIdx, segmentT } = projection ?? {};
  if (segmentIdx === undefined) {
    // The cached segment is at most a few samples behind the next physics tick.
    let nearest = Infinity;
    for (let i = -3; i <= 3; i++) {
      const idx = ((car.pathIndex + i) % path.length + path.length) % path.length;
      const a = path[idx], b = path[(idx + 1) % path.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = clamp(((car.x - a.x) * dx + (car.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
      const distance = (car.x - a.x - t * dx) ** 2 + (car.y - a.y - t * dy) ** 2;
      if (distance < nearest) {
        nearest = distance;
        segmentIdx = idx;
        segmentT = t;
      }
    }
  }
  const a = path[segmentIdx], b = path[(segmentIdx + 1) % path.length];
  const x = a.x + (b.x - a.x) * segmentT, y = a.y + (b.y - a.y) * segmentT;
  return {
    index: segmentIdx,
    s: a.cumulativeDistance + a.segmentLength * segmentT,
    d: (car.x - x) * a.normalX + (car.y - y) * a.normalY,
    speed: BOT_TICK_HZ * (car.vx * a.normalY - car.vy * a.normalX),
    lateralSpeed: BOT_TICK_HZ * (car.vx * a.normalX + car.vy * a.normalY),
    radius: car.radius,
    order: car.gridSlot,
    x: car.x, y: car.y, angle: car.angle,
    vx: car.vx * BOT_TICK_HZ, vy: car.vy * BOT_TICK_HZ,
    id: car.participantId
  };
}

export function trackOffsetPoint(path, distance, offset) {
  const sample = sampleTrackDistance(path, distance);
  return {
    x: sample.x - Math.sin(sample.angle) * offset,
    y: sample.y + Math.cos(sample.angle) * offset,
    angle: sample.angle
  };
}

function getSpeedProfile(path, wet) {
  let cached = profiles.get(path);
  if (!cached) profiles.set(path, cached = new Map());
  if (cached.has(wet)) return cached.get(wet);
  const count = path.length;
  const curvature = new Float64Array(count);
  const speeds = new Float64Array(count);
  const bendDistance = new Float64Array(count);
  const brake = FORCA_FREIO_MAX * (wet ? 0.43 : 0.55);
  const length = path.at(-1).cumulativeDistance + path.at(-1).segmentLength;
  for (let i = 0; i < count; i++) {
    const p = path[i];
    // Blend the physical profile's local curvature with a signed heading window.
    const before = path[(i - 3 + count) % count], after = path[(i + 3) % count];
    const span = (after.cumulativeDistance - before.cumulativeDistance + length) % length;
    const turn = angleDelta(after.angle, before.angle) / Math.max(1, span);
    curvature[i] = Math.max(Math.abs(turn), (p.smoothedCurvature ?? 0) * 0.74);
    const lateralBudget = wet ? 0.013 : 0.018;
    const cornerSpeed = Math.sqrt(lateralBudget / Math.max(0.001, curvature[i] - 0.001));
    speeds[i] = Math.min(MAX_INTERNAL_SPEED * (wet ? 0.94 : 1.02), cornerSpeed);
  }
  // Repeat the backwards pass for braking zones that straddle the finish line.
  let distanceToBend = Infinity;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = count - 1; i >= 0; i--) {
      const entrySpeed = Math.sqrt(speeds[(i + 1) % count] ** 2 + 2 * brake * path[i].segmentLength);
      speeds[i] = Math.min(speeds[i], entrySpeed);
      distanceToBend = curvature[i] > 0.048 ? 0 : distanceToBend + path[i].segmentLength;
      bendDistance[i] = distanceToBend;
    }
  }
  const profile = { speeds, curvature, bendDistance };
  cached.set(wet, profile);
  return profile;
}

export function driveGt3(car, path, width, condition, position, chooseManeuver, debug = false, trace) {
  const speed = Math.hypot(car.vx, car.vy);
  const wet = condition === 'wet';
  const { speeds, curvature, bendDistance } = getSpeedProfile(path, wet);
  const { d, lateralSpeed, index } = position;
  const edge = Math.max(0, width / 2 - car.radius - 0.4);
  const recovering = Math.abs(d) > edge || car.currentSurface !== 'TARMAC';
  const predictedOffset = d + lateralSpeed * 0.4;
  const edgeRisk = Math.max(0, Math.abs(predictedOffset) - edge + 1);

  // Evaluate the envelope where the car will be when the brake pressure builds.
  let preview = index;
  let distance = 0;
  const previewDistance = speed * 10;
  while (distance < previewDistance && distance < 24) {
    distance += path[preview].segmentLength;
    preview = (preview + 1) % path.length;
  }
  const turn = Math.max(curvature[index], curvature[preview]);
  const offsetRadiusMargin = Math.sqrt(Math.max(0.50, 1 - turn * Math.max(0, Math.abs(d) - 1.5)));
  let speedLimit = Math.min(speeds[index], speeds[preview]) * Math.min(1, car.botSkill) * offsetRadiusMargin;
  if (recovering) speedLimit = Math.min(speedLimit, car.currentSurface === 'GRAVEL' ? 0.17 : 0.32);
  else if (edgeRisk > 0) speedLimit *= Math.max(0.45, 1 - edgeRisk * 0.13);

  const preferred = recovering || edgeRisk > 0 ? 0 : clamp(car.baseOffset * 0.30, -edge, edge);
  const lateralBudget = (wet ? 4 : 6) / (1 + turn * 20);
  if (trace) Object.assign(trace, { envelopeSpeed: speedLimit * BOT_TICK_HZ, curvature: turn, recovering });
  const approachingBend = bendDistance[index] < Math.max(100, position.speed * 4.8);
  const plan = chooseManeuver?.(preferred, speedLimit * BOT_TICK_HZ, lateralBudget, recovering, approachingBend);
  speedLimit = Math.min(speedLimit, (plan?.speedLimit ?? Infinity) / BOT_TICK_HZ);
  const lookahead = recovering ? 9 : Math.max(6, clamp(8 + 18 * speed, 8, 28) / (1 + turn * 12));
  const steerPoint = sampleTrackDistance(path, position.s + lookahead);
  const steeringPreview = clamp(lookahead / Math.max(1, position.speed), 0.35, 0.80);
  const targetOffset = clamp(plan?.steeringOffsetAt?.(steeringPreview) ?? plan?.offset ?? preferred, -edge, edge);
  const normalX = -Math.sin(steerPoint.angle), normalY = Math.cos(steerPoint.angle);
  const steerTargetX = steerPoint.x + normalX * targetOffset;
  const steerTargetY = steerPoint.y + normalY * targetOffset;
  const dx = steerTargetX - car.x, dy = steerTargetY - car.y;
  const fwd = car.vx * Math.cos(car.angle) + car.vy * Math.sin(car.angle);
  const lateral = -car.vx * Math.sin(car.angle) + car.vy * Math.cos(car.angle);
  const slip = Math.atan2(lateral, Math.max(0.10, fwd));
  const headingError = angleDelta(Math.atan2(dy, dx), car.angle + slip * 0.32);
  const pursuit = 2 * Math.sin(headingError) / Math.max(3, Math.hypot(dx, dy));
  const steerRange = 0.32 - 0.20 * Math.min(1, speed / MAX_INTERNAL_SPEED);
  const desiredYawRate = pursuit * Math.max(0, fwd);
  const yawCorrection = (desiredYawRate - car.yawRate) * 0.12 / steerRange;
  const headingSteer = Math.atan(pursuit * GT3_WHEELBASE) / steerRange;
  const steering = Math.abs(headingError) > Math.PI / 2
    ? Math.sign(headingError)
    : headingSteer + yawCorrection;
  car.steerAmount += (clamp(steering, -1, 1) - car.steerAmount) * 0.36;

  const headingLimited = Math.abs(headingError) > 0.65 && speedLimit > 0.25;
  if (headingLimited) speedLimit = 0.25;
  const excess = speed - speedLimit;
  const stopping = speedLimit <= 0.001;
  const brakeInput = stopping ? 1 : excess > 0.005 ? clamp(excess * 6 + 0.13, 0, 1) : 0;
  const traction = clamp(1 - car.rearSlip * 2 - Math.max(0, Math.abs(slip) - 0.065) * 3, 0.25, 1);
  const throttleInput = brakeInput > 0 ? 0 : clamp(-excess * 11 + 0.16, 0, 1) * traction;
  car.currentLaneOffset = targetOffset;
  car.targetOffset = targetOffset;
  const inputs = { steerInput: car.steerAmount, throttleInput, brakeInput, plan };
  if (trace) {
    const targetSpeed = speedLimit * BOT_TICK_HZ;
    Object.assign(trace, {
      speed: speed * BOT_TICK_HZ, targetSpeed, brakeInput, action: plan?.action,
      limit: stopping ? 'traffic-stop' : headingLimited ? 'heading'
        : targetSpeed < trace.envelopeSpeed - 0.01 ? 'traffic-pace' : recovering ? 'edge-recovery' : 'track-envelope'
    });
  }
  if (debug) {
    inputs.debug = {
      car, cp: path[index], steerPoint: { ...steerPoint, normalX, normalY }, steerTargetX, steerTargetY,
      currentLaneOffset: targetOffset, targetLane: plan?.offset ?? preferred, usableHalfW: edge, halfW: width / 2,
      targetSurface: 'TARMAC', headingSteer, lateralSteer: yawCorrection, steerInput: inputs.steerInput,
      crossTrackError: d - targetOffset, isOffTrack: recovering, targetSpeed: speedLimit,
      speedLimiterReason: plan?.action ?? 'cruise', brakeReason: brakeInput > 0 ? 'SPEED_ENVELOPE' : 'NONE',
      throttleInput, brakeInput, slipAngleDeg: slip * 180 / Math.PI, actualYawRate: car.yawRate, desiredYawRate,
      tractionFactor: traction, distToOuterEdge: Math.max(0, edge - Math.abs(d)),
      stabilityState: recovering ? 'RECOVERY' : edgeRisk > 0 ? 'EDGE_RISK' : 'STABLE'
    };
  }
  return inputs;
}
