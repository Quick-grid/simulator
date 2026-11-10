import { BOT_TICK_HZ, REJOIN_LOOKAHEAD } from './gt3Driver.js';
import { GT3_WHEELBASE, MAX_INTERNAL_SPEED } from '../constants.js';

const HORIZON = 2.8; // seconds
const STEP = 0.2;
const LATERAL_SPEED = 4.5; // m/s
const PASS_LOCK_TICKS = 420;
const ABORT_TICKS = 24;
const RELEASE_TICKS = 36;
const RELEASE_SPEED = 5.5; // m/s
const RELEASE_HORIZON = 1.6; // seconds
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function signedRaceGap(from, to, length) {
  return ((to - from + length / 2) % length + length) % length - length / 2;
}

function travel(speed, target, time) {
  const acceleration = target >= speed ? 6 : -20;
  const ramp = Math.min(time, Math.abs((target - speed) / acceleration));
  return speed * ramp + 0.5 * acceleration * ramp ** 2 + target * (time - ramp);
}

function sweptConflict(a, b, longitudinal, lateral) {
  // Slab intersection tests both axes over the same interval, including
  // crossings between samples where both endpoints appear clear.
  let entry = 0, exit = 1;
  for (const [start, end, clearance] of [[a.s, b.s, longitudinal], [a.d, b.d, lateral]]) {
    const change = end - start;
    if (Math.abs(change) < 1e-8) {
      if (Math.abs(start) >= clearance) return false;
      continue;
    }
    const t1 = (-clearance - start) / change, t2 = (clearance - start) / change;
    entry = Math.max(entry, Math.min(t1, t2));
    exit = Math.min(exit, Math.max(t1, t2));
    if (entry >= exit) return false;
  }
  return true;
}

function sweptDistanceSquared(x, y, dx, dy) {
  const fraction = clamp(-(x * dx + y * dy) / (dx ** 2 + dy ** 2 || 1), 0, 1);
  return (x + dx * fraction) ** 2 + (y + dy * fraction) ** 2;
}

// Release from standstill is checked in world coordinates. Curvilinear
// rectangles are a useful reserve at race pace but can overlap across a bend
// while the actual cars have room to separate.
function canRoll(ego, opponents, trackPoint, offset, speedLimit, edge, diagnostic) {
  let { x, y, angle, s } = ego;
  let speed = Math.hypot(ego.vx, ego.vy);
  let yaw = (ego.yawRate ?? 0) * BOT_TICK_HZ;
  let steering = ego.steerAmount ?? 0;
  let roadOffset = ego.d;
  const step = 1 / BOT_TICK_HZ;
  const initialOffset = Math.abs(ego.d);
  const roadLimit = Math.max(edge + ego.radius + 0.65, initialOffset + 0.08);
  for (let i = 0; i < Math.round(RELEASE_HORIZON * BOT_TICK_HZ); i++) {
    const target = trackPoint(s + REJOIN_LOOKAHEAD, offset);
    const headingError = Math.atan2(Math.sin(Math.atan2(target.y - y, target.x - x) - angle),
      Math.cos(Math.atan2(target.y - y, target.x - x) - angle));
    const pursuit = 2 * Math.sin(headingError) / Math.max(3, Math.hypot(target.x - x, target.y - y));
    const range = 0.32 - 0.20 * Math.min(1, speed / (MAX_INTERNAL_SPEED * BOT_TICK_HZ));
    const demand = Math.abs(headingError) > Math.PI / 2 ? Math.sign(headingError)
      : (Math.atan(pursuit * GT3_WHEELBASE) + (pursuit * speed - yaw) * 0.12 * step) / range;
    steering += (clamp(demand, -1, 1) - steering) * 0.36;
    const desiredYaw = speed * Math.tan(steering * range) / GT3_WHEELBASE;
    // Match the on-road low-speed yaw damping. Instant steering on a stopped
    // car overstates how much road it can use to turn back toward its lane.
    yaw += (desiredYaw - yaw) * 0.075;
    yaw *= 0.98 * Math.min(1, speed / 9);
    speed += clamp(speedLimit - speed, -9 * step, 6 * step);
    const dx = Math.cos(angle) * speed * step, dy = Math.sin(angle) * speed * step;
    for (const other of opponents) {
      const ox = x - other.x - other.vx * step * i;
      const oy = y - other.y - other.vy * step * i;
      const clearance = ego.radius + other.radius + 0.20;
      const initial = (ego.x - other.x) ** 2 + (ego.y - other.y) ** 2;
      const predicted = sweptDistanceSquared(ox, oy, dx - other.vx * step, dy - other.vy * step);
      if (predicted < Math.min(clearance ** 2, initial) - 0.005) {
        if (diagnostic) Object.assign(diagnostic, { rejection: 'world-traffic', opponent: other.id, time: (i + 1) * step });
        return false;
      }
    }
    x += dx;
    y += dy;
    angle += yaw * step;
    const before = trackPoint(s, 0);
    const ahead = trackPoint(s + 1, 0);
    const bend = Math.atan2(Math.sin(ahead.angle - before.angle), Math.cos(ahead.angle - before.angle));
    s += (dx * Math.cos(before.angle) + dy * Math.sin(before.angle)) / clamp(1 - roadOffset * bend, 0.4, 2.5);
    const centre = trackPoint(s, 0);
    roadOffset = (y - centre.y) * Math.cos(centre.angle) - (x - centre.x) * Math.sin(centre.angle);
    if (Math.abs(roadOffset) > roadLimit) {
      if (diagnostic) Object.assign(diagnostic, { rejection: 'road-edge', time: (i + 1) * step });
      return false;
    }
  }
  if (Math.abs(roadOffset) < Math.max(edge, initialOffset - 0.05)) return true;
  if (diagnostic) diagnostic.rejection = 'no-inward-progress';
  return false;
}

function trajectory(ego, target, speedLimit, lateralBudget) {
  const delta = target - ego.d;
  const duration = Math.max(1, 1.5 * Math.abs(delta) / LATERAL_SPEED,
    Math.sqrt(6 * Math.abs(delta) / lateralBudget));
  let rate = clamp(ego.lateralSpeed, -LATERAL_SPEED, LATERAL_SPEED);
  let offset = ego.d;
  const offsets = [offset];
  for (let i = 0; i < Math.round(HORIZON / STEP); i++) {
    const error = target - offset;
    const targetRate = Math.sign(error) * Math.min(LATERAL_SPEED, Math.sqrt(2 * lateralBudget * Math.abs(error)));
    const nextRate = rate + clamp(targetRate - rate, -lateralBudget * STEP, lateralBudget * STEP);
    offset += (rate + nextRate) * STEP * 0.5;
    offsets.push(offset);
    rate = nextRate;
  }
  return {
    offset: target,
    speedLimit,
    duration,
    steeringOffsetAt(time) {
      const u = clamp(time / duration, 0, 1);
      return ego.d + delta * u ** 2 * (3 - 2 * u);
    },
    offsetAt(time) {
      return offsets[Math.round(time / STEP)];
    }
  };
}

function isSafe(candidate, ego, opponents, edge, diagnostic, laneHold) {
  let lastOffset = ego.d;
  let lastS = 0;
  const bound = Math.max(edge, Math.abs(ego.d));
  for (let step = 1; step <= Math.round(HORIZON / STEP); step++) {
    const time = step * STEP;
    const s = travel(ego.speed, candidate.speedLimit, time);
    const d = candidate.offsetAt(time);
    if (Math.abs(d) > bound + 1e-6) {
      if (diagnostic) Object.assign(diagnostic, { rejection: 'lateral-envelope', time });
      return false;
    }

    for (const other of opponents) {
      const previous = time - STEP;
      const lateralVelocity = clamp(other.lateralSpeed, -LATERAL_SPEED, LATERAL_SPEED);
      const envelope = ego.radius + other.radius;
      const separation = at => other.d + lateralVelocity * Math.min(at, 1);
      const a = { s: lastS - other.gap - other.speed * previous, d: lastOffset - separation(previous) };
      const b = { s: s - other.gap - other.speed * time, d: d - separation(time) };
      const halfLength = envelope + 1.8;
      const halfWidth = envelope + 0.4 + time * 0.10;
      if (!sweptConflict(a, b, halfLength, halfWidth)) continue;
      // An established lane is owned by the leading car. Braking it because a
      // rear car is projected to close makes the same-lane conflict worse.
      if (laneHold && other.gap < -halfLength && Math.abs(candidate.offset - ego.d) < 0.25) continue;
      const initialD = ego.d - other.d;
      const initialInside = Math.abs(other.gap) < halfLength && Math.abs(initialD) < envelope + 0.42;
      // Within the reserve, slow cars may open an existing safe gap. They
      // still have to respect the full swept footprint and cannot squeeze in.
      if (initialInside && candidate.speedLimit <= 8 && Math.abs(ego.speed) < 8 && Math.abs(other.speed) < 8
        && sweptDistanceSquared(a.s, a.d, b.s - a.s, b.d - a.d)
          >= Math.max((envelope + 0.20) ** 2, other.gap ** 2 + initialD ** 2) - 0.015) continue;
      if (diagnostic) Object.assign(diagnostic, {
        rejection: 'traffic', time, opponent: other.id, gap: other.gap, ds: a.s, dd: a.d
      });
      return false;
    }
    lastS = s;
    lastOffset = d;
  }
  return true;
}

export function followingPace(egoSpeed, leadSpeed, gap, clearance, desiredSpeed) {
  const room = gap - clearance - 0.45;
  const headway = 0.35 * Math.max(0, leadSpeed, egoSpeed);
  const pace = leadSpeed + (room - headway) * 1.15;
  const closingLimit = Math.sqrt(Math.max(0, leadSpeed) ** 2 + 2 * 11 * Math.max(0, room));
  return clamp(Math.min(pace, closingLimit), 0, desiredSpeed);
}

export class RacePlanner {
  commitment = null;
  abortUntil = 0;
  blockedTicks = 0;
  releaseUntil = 0;
  waiting = 'clear';

  plan({ ego, field, length, width, preferred, desiredSpeed, lateralBudget, tick, recovering, approachingBend,
    tightDistance, trace, trackPoint }) {
    const edge = Math.max(0, width / 2 - ego.radius - 0.4);
    const opponents = field.filter(other => other.id !== ego.id)
      .map(other => ({ ...other, gap: signedRaceGap(ego.s, other.s, length) }))
      .filter(other => other.gap <= Math.max(105, (ego.speed - other.speed) * HORIZON + 12)
        && other.gap >= -Math.max(36, (other.speed - ego.speed) * HORIZON + 12));
    const crowded = opponents.filter(other => Math.abs(other.gap) < 48).length >= 3;
    const queue = approachingBend && opponents.some(other => Math.abs(other.gap) < 75);
    if (queue && crowded) desiredSpeed = Math.min(desiredSpeed, 48);
    const path = (offset, speedLimit) => trajectory(ego, clamp(offset, -edge, edge), speedLimit, lateralBudget);
    const safe = (candidate, maneuver, laneHold = false) => {
      const diagnostic = trace && { maneuver, offset: candidate.offset, speedLimit: candidate.speedLimit };
      const accepted = isSafe(candidate, ego, opponents, edge, diagnostic, laneHold);
      if (trace) trace.proposals.push({ ...diagnostic, accepted });
      return accepted;
    };
    const leader = opponents.reduce((nearest, other) => other.gap > 0
      && (queue || Math.abs(other.d - ego.d) < ego.radius + other.radius + 1.05)
      && (!nearest || other.gap < nearest.gap) ? other : nearest, null);
    const follower = opponents.some(other => other.gap < -9 && other.gap > -28
      && other.speed > ego.speed + 2 && Math.abs(other.d - ego.d) < ego.radius + other.radius + 0.8);
    const alongside = opponents.some(other => Math.abs(other.gap) < ego.radius + other.radius + 2);
    this.blockedTicks = Math.abs(ego.speed) < 2 && desiredSpeed > 6 ? this.blockedTicks + 1 : 0;
    if (trace) Object.assign(trace, { opponents, leader: leader?.id, alongside, desiredSpeed, lateralBudget, passEvents: [] });
    const select = (candidate, action, waiting = 'clear') => {
      if (trace) Object.assign(trace, { blockReason: waiting, previousBlockReason: this.waiting,
        previousAction: this.action, priority: trace.priority ?? null });
      this.waiting = waiting;
      this.action = action;
      return { ...candidate, action };
    };
    let followingSpeed = leader
      ? followingPace(ego.speed, leader.speed, leader.gap, ego.radius + leader.radius + 1.8, desiredSpeed)
      : desiredSpeed;
    // Queue on the approach, where the car can stop straight. Entering a
    // hairpin on the bumper ahead can leave too little rolling speed to steer.
    const heldAtEntry = this.entryLeader === leader?.id;
    const waitingAtEntry = leader && tightDistance > 7 && tightDistance < 42
      && leader.gap < (heldAtEntry ? 28 : 23) && leader.speed < (heldAtEntry ? 25 : 21);
    this.entryLeader = waitingAtEntry ? leader.id : null;
    if (waitingAtEntry) {
      followingSpeed = Math.min(followingSpeed, Math.sqrt(2 * 13 * Math.max(0, tightDistance - 11)));
    }

    const correctingBend = approachingBend && Math.abs(ego.d) > 3 && Math.sign(ego.d) * ego.lateralSpeed > 1.5;
    const rollingSpeed = Math.hypot(ego.vx, ego.vy);
    const tryRelease = () => {
      const priorityRival = opponents.find(other => Math.abs(other.speed) < 3
        && Math.abs(other.gap) < 8 && Math.abs(other.d - ego.d) < ego.radius + other.radius + 1
        && (other.gap > 0 || (other.gap === 0 && other.order < ego.order)));
      if (trace) trace.priority = { slot: ego.order, yieldsTo: priorityRival?.order ?? null };
      const targets = priorityRival ? [ego.d] : [preferred, ego.d, ego.d - 2.5, ego.d + 2.5];
      const continuing = this.releaseUntil > tick;
      if (continuing && !priorityRival) targets.unshift(this.releaseOffset);
      const rollingPace = approachingBend || recovering ? 13.5 : RELEASE_SPEED;
      const worldOpponents = field.filter(other => other.id !== ego.id
        && (other.x - ego.x) ** 2 + (other.y - ego.y) ** 2 < 42 ** 2);
      for (const offset of new Set(targets.map(target => clamp(target, -edge, edge)))) {
        for (const pace of [Math.min(desiredSpeed, continuing ? this.releasePace : rollingPace),
          Math.min(desiredSpeed, approachingBend ? 9.5 : 3.5)]) {
          if (pace < 2) continue;
          const diagnostic = trace && { maneuver: 'release', offset, speedLimit: pace };
          const accepted = canRoll(ego, worldOpponents, trackPoint, offset, pace, edge, diagnostic);
          if (trace) trace.proposals.push({ ...diagnostic, accepted });
          if (accepted) {
            this.releaseOffset = offset;
            this.releasePace = pace;
            if (!continuing) this.releaseUntil = tick + RELEASE_TICKS;
            if (this.commitment?.action === 'overtake') trace?.passEvents.push('aborted');
            this.commitment = null;
            return select({ offset, speedLimit: pace }, 'rejoin', 'recovering');
          }
        }
      }
      this.releaseUntil = 0;
      return null;
    };
    const checkedRelease = trackPoint && !waitingAtEntry && rollingSpeed < 18 && (this.releaseUntil > tick
      || this.blockedTicks >= 24 || correctingBend || (recovering && Math.abs(ego.speed) < 8));
    if (checkedRelease) {
      const release = tryRelease();
      if (release) return release;
    }

    if (this.commitment?.action === 'overtake') {
      const { target, rival, until } = this.commitment;
      const opponent = opponents.find(other => other.id === rival);
      if (!opponent || opponent.gap < -9) {
        trace?.passEvents.push(opponent ? 'completed' : 'aborted');
        this.commitment = null;
      } else {
        if (!recovering && tick < until) {
          const alongsideClear = Math.abs(ego.d - opponent.d) > ego.radius + opponent.radius + 0.6;
          const paceLimit = alongsideClear ? Math.min(desiredSpeed, opponent.speed + 11) : followingSpeed;
          for (const pace of [paceLimit, Math.min(paceLimit, Math.max(followingSpeed, opponent.speed + 3))]) {
            const committed = path(target, pace);
            if (safe(committed, 'committed-pass')) return select(committed, alongsideClear ? 'overtake' : 'prepare');
          }
        }
        this.commitment = null;
        this.abortUntil = tick + ABORT_TICKS;
        trace?.passEvents.push('aborted');
      }
    }

    if (opponents.length === 0) {
      this.commitment = null;
      return select({ offset: preferred, speedLimit: desiredSpeed }, 'cruise');
    }
    const aborting = tick < this.abortUntil;
    const canPrepare = !recovering && !aborting && !alongside && !crowded && !queue && leader && ego.speed > leader.speed + 3
      && desiredSpeed > leader.speed + 3 && leader.gap > 10 && leader.gap < 62;
    if (canPrepare) {
      const separation = ego.radius + leader.radius + 1.35;
      const options = [-1, 1].map(side => leader.d + side * separation)
        .filter(offset => Math.abs(offset) <= edge)
        .sort((a, b) => Math.abs(a - ego.d) - Math.abs(b - ego.d));
      for (const offset of options) {
        const candidate = path(offset, followingSpeed);
        if (safe(candidate, 'pass')) {
          this.commitment = { action: 'overtake', target: offset, rival: leader.id, until: tick + PASS_LOCK_TICKS };
          trace?.passEvents.push('accepted');
          return select(candidate, 'prepare');
        }
      }
    }

    if (!aborting && !recovering && !leader && !queue && (follower || this.commitment?.action === 'defend')) {
      const target = this.commitment?.target ?? ego.d;
      const until = this.commitment?.until ?? tick + 75;
      const defend = path(target, desiredSpeed);
      if (tick < until && safe(defend, 'defend', true)) {
        this.commitment = { action: 'defend', target, until };
        return select(defend, 'defend');
      }
    }
    this.commitment = null;
    if (recovering && (!trackPoint || Math.abs(ego.speed) >= 12)) {
      const rejoin = path(preferred, Math.min(followingSpeed, 8));
      if (safe(rejoin, 'rejoin')) return select(rejoin, 'rejoin');
    }
    const ownLane = path(ego.d, followingSpeed);
    const preparation = canPrepare && edge >= ego.radius + leader.radius + 1.35;
    if (queue && !aborting && !alongside) {
      for (const scale of [1, 0.75, 0.5]) {
        const line = path(preferred, followingSpeed * scale);
        if (line.speedLimit > 2 && safe(line, 'bend-line')) {
          return select({ ...line, cornerSetup: true }, leader ? 'follow' : 'hold',
            waitingAtEntry ? 'waiting-at-entry' : leader ? 'following' : 'clear');
        }
      }
    }
    if (!recovering && !aborting && !leader && !alongside && Math.abs(ego.d) > edge * 0.8) {
      const normalLine = path(preferred, desiredSpeed);
      if (safe(normalLine, 'preferred')) return select(normalLine, 'hold');
    }
    if (followingSpeed > 2 && safe(ownLane, 'follow', true)) {
      return select(ownLane, aborting ? 'abort' : preparation ? 'prepare' : leader ? 'follow' : 'hold',
        waitingAtEntry ? 'waiting-at-entry' : preparation ? 'waiting-to-pass' : leader ? 'following' : 'clear');
    }

    for (const scale of [0.78, 0.56, 0.36, 0.18]) {
      const pace = followingSpeed * scale;
      const yieldLane = path(ego.d, pace);
      if (safe(yieldLane, 'yield', true)) return select(yieldLane, aborting ? 'abort' : 'yield',
        waitingAtEntry ? 'waiting-at-entry' : pace > 2 ? 'following' : 'no-checked-corridor');
    }
    // The lateral reserve can reject a road correction even with clear road
    // around the car. Only allow this fallback outside a close pack.
    if (trackPoint && !waitingAtEntry && !checkedRelease && approachingBend && rollingSpeed < 22
      && ego.d * ego.lateralSpeed > 1 && opponents.every(other => other.gap < -24 || other.gap > 55)) {
      const release = tryRelease();
      if (release) return release;
    }
    return select(path(ego.d, 0), aborting ? 'abort' : 'yield', waitingAtEntry ? 'waiting-at-entry' : 'no-checked-corridor');
  }
}
