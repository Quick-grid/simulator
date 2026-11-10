// ========== ADVANCED BOT AI & REINFORCEMENT LEARNING ENGINE ==========
// Sistema de Machine Learning (Actor-Critic / Q-Learning tabular com aprendizado online)
// Condução no limite do carro (late braking, trail braking, saída forte com tração total)
// Defesa de posição realista da F1/GT3 (proteção da linha interna sem fechar deslealmente)

import { NUM_CHECKPOINTS, MAX_INTERNAL_SPEED, BOT_DRIVER_MODE } from './constants.js';
import { state } from './game.js';
import { BOT_TICK_HZ, driveGt3, racePosition, trackOffsetPoint } from './ai/gt3Driver.js';
import { RacePlanner } from './ai/racePlanner.js';
import { GT3_DRIVER_VERSION, PilotRun } from './ai/pilotMemory.js';

// ── DRIVER MODE FEATURE FLAG & BASELINE ──────────────────────────────────────
if (typeof window !== 'undefined') {
  window.BOT_DRIVER_MODE = window.BOT_DRIVER_MODE || BOT_DRIVER_MODE.DETERMINISTIC;
  window.AI_VERSION = window.BOT_DRIVER_MODE === BOT_DRIVER_MODE.LEGACY ? 'CONTROL_TRACE_V1' : GT3_DRIVER_VERSION;
}
let hasLoggedAiVersion = false;
export let debugBotTarget = null; // preenchido pelo primeiro bot a cada frame

export class BotBrain {
  constructor(car) {
    this.car = car;
    this.name = car.name;
    this.driver = typeof window !== 'undefined' && window.BOT_DRIVER_MODE === BOT_DRIVER_MODE.LEGACY
      ? 'legacy' : 'gt3';
    this.planner = new RacePlanner();
    this.tick = 0;

    // Hiperparâmetros de Aprendizado por Reforço (RL)
    this.learningRate = 0.14;
    this.discountFactor = 0.88;

    // Tabela de Políticas Aprendidas por Setor/Checkpoint (0 a NUM_CHECKPOINTS - 1)
    this.sectors = [];
    for (let i = 0; i < NUM_CHECKPOINTS; i++) {
      this.sectors.push({
        apexOffset: 0.0,      // Offset ótimo aprendido (metros) para o apex
        brakeBias: 0.0,       // Ajuste fino do ponto de frenagem (-4m a +3m)
        exitThrottle: 1.0,    // Agressividade no acelerador na saída (0.90 a 1.0)
        defendBias: 0.0,      // Offset preferido para defender posição
        qValue: 0.0,          // Estimativa de valor do estado
        visitCount: 0
      });
    }

    // Monitoramento de Setor em Tempo Real
    this.currentSectorIdx = 0;
    this.sectorEntryTime = performance.now();
    this.sectorEntrySpeed = 0;
    this.sectorEntryRank = car.rank || 1;
    this.hadOfftrack = false;
    this.wasAttacked = false;

    // Estado Tático e Dinâmico
    this.defending = false;
    this.defendCooldown = 0;
    this.defendOffset = 0;
    this.overtakeOffset = 0;
    this.overtakeSide = 0;          // -1: esquerda (+normal), 1: direita (-normal), 0: neutro
    this.overtakeHoldFrames = 0;     // Histerese temporal para evitar chattering
    this.lastSlipAngle = 0;
    this.lastCrossTrack = 0;
    this.lastSurface = 'TARMAC';
    this.offTrackReason = 'NONE';
  }

  // Carregar Modelo de IA do localStorage ou Backend
  importModel(savedData) {
    if (!savedData || !Array.isArray(savedData.sectors)) return;
    for (let i = 0; i < Math.min(this.sectors.length, savedData.sectors.length); i++) {
      const src = savedData.sectors[i];
      if (src) {
        this.sectors[i].apexOffset = typeof src.apexOffset === 'number' ? src.apexOffset : 0;
        this.sectors[i].brakeBias = typeof src.brakeBias === 'number' ? src.brakeBias : 0;
        this.sectors[i].exitThrottle = typeof src.exitThrottle === 'number' ? src.exitThrottle : 1.0;
        this.sectors[i].defendBias = typeof src.defendBias === 'number' ? src.defendBias : 0;
        this.sectors[i].qValue = typeof src.qValue === 'number' ? src.qValue : 0;
      }
    }
  }

  // Exportar Modelo de IA para Persistência
  exportModel() {
    return {
      name: this.name,
      sectors: this.sectors.map(s => ({
        apexOffset: Math.round(s.apexOffset * 100) / 100,
        brakeBias: Math.round(s.brakeBias * 100) / 100,
        exitThrottle: Math.round(s.exitThrottle * 100) / 100,
        defendBias: Math.round(s.defendBias * 100) / 100,
        qValue: Math.round(s.qValue * 100) / 100
      }))
    };
  }

  // Atualização de Aprendizado ao Cruzar Checkpoint
  onCheckpointCrossed(checkpointIdx, currentSpeed, currentRank, isGravel) {
    if (this.run) this.pendingCheckpoint = checkpointIdx;
    if (this.driver !== 'legacy') return;
    const prevSectorIdx = (checkpointIdx - 1 + NUM_CHECKPOINTS) % NUM_CHECKPOINTS;
    const sector = this.sectors[prevSectorIdx];
    const now = performance.now();
    const dt = (now - this.sectorEntryTime) / 1000;

    if (this.sectorEntryTime > 0 && dt > 0.25) {
      // 1. Função de Recompensa (Reward Function)
      let reward = 0;

      // Recompensa por Tempo de Setor
      const baseSectorTime = 4.2;
      const timeDiff = baseSectorTime - dt;
      reward += timeDiff * 3.5;

      // Recompensa de Velocidade Média
      const speedRatio = currentSpeed / MAX_INTERNAL_SPEED;
      reward += speedRatio * 4.0;

      // Punição Severa de Off-Track (Brita/Grama)
      if (isGravel || this.hadOfftrack) {
        reward -= 8.0;
      } else {
        reward += 2.0;
      }

      // Recompensa de Disputa de Posição
      if (currentRank < this.sectorEntryRank) {
        reward += 4.5;
      } else if (currentRank === this.sectorEntryRank && this.wasAttacked) {
        reward += 3.0;
      } else if (currentRank > this.sectorEntryRank) {
        reward -= 3.0;
      }

      // 2. Atualização Temporal Difference (TD-Learning)
      const nextQ = this.sectors[checkpointIdx % NUM_CHECKPOINTS].qValue;
      const tdError = reward + this.discountFactor * nextQ - sector.qValue;
      sector.qValue += this.learningRate * tdError;
      sector.visitCount++;

      // 3. Atualização de Parâmetros da Política
      if (reward > 0) {
        sector.apexOffset = sector.apexOffset * (1 - this.learningRate) + (this.car.currentLaneOffset) * this.learningRate;
        if (speedRatio > 0.88) {
          sector.brakeBias = Math.min(3.5, sector.brakeBias + 0.15 * this.learningRate);
        }
        sector.exitThrottle = Math.min(1.0, sector.exitThrottle + 0.02);
      } else {
        sector.apexOffset *= 0.75;
        sector.brakeBias = Math.max(-5.0, sector.brakeBias - 0.35 * this.learningRate);
        sector.exitThrottle = Math.max(0.90, sector.exitThrottle - 0.03);
      }

      sector.apexOffset = Math.max(-6.5, Math.min(6.5, sector.apexOffset));
    }

    this.currentSectorIdx = checkpointIdx % NUM_CHECKPOINTS;
    this.sectorEntryTime = now;
    this.sectorEntrySpeed = currentSpeed;
    this.sectorEntryRank = currentRank;
    this.hadOfftrack = isGravel;
    this.wasAttacked = false;
  }

  // Tomada de Decisão em Tempo Real a 60 FPS
  computeInputs(projection) {
    if (this.driver === 'legacy') return this.computeLegacyInputs();
    const { trackPath, selectedTrackData, trackCondition, totalTrackLength, cars } = state;
    if (!trackPath.length) return { throttleInput: 0, brakeInput: 1, steerInput: 0 };
    const position = racePosition(this.car, trackPath, projection);
    const width = selectedTrackData?.trackWidth || 24;
    const tick = ++this.tick;
    const debug = typeof window !== 'undefined' && window.DEBUG_BOT_AI && !debugBotTarget;
    const trace = this.raceTrace && { tick, position, proposals: [] };
    const inputs = driveGt3(this.car, trackPath, width, trackCondition, position,
      (preferred, desiredSpeed, lateralBudget, recovering, approachingBend) => this.planner.plan({
        ego: position, field: state.botField ?? cars.map(car => racePosition(car, trackPath)),
        length: totalTrackLength, width, preferred, desiredSpeed, lateralBudget, tick, recovering, approachingBend, trace,
        trackPoint: (distance, offset) => trackOffsetPoint(trackPath, distance, offset)
      }), debug, trace);
    if (trace) this.raceTrace(trace);
    if (inputs.debug) debugBotTarget = inputs.debug;
    this.maneuver = inputs.plan?.action;
    this.run?.record({
      ...inputs, position, maneuver: this.maneuver, surface: this.car.currentSurface,
      speed: Math.hypot(this.car.vx, this.car.vy) * BOT_TICK_HZ, rearSlip: this.car.rearSlip
    });
    return inputs;
  }

  startPilotRun(pilotId, context) {
    if (this.driver === 'gt3') this.run = new PilotRun(pilotId, context);
  }

  finishPilotTick() {
    if (this.pendingCheckpoint === undefined) return;
    this.run.checkpoint(this.pendingCheckpoint);
    this.pendingCheckpoint = undefined;
  }

  computeLegacyInputs() {
    if (!hasLoggedAiVersion) {
      hasLoggedAiVersion = true;
      console.log('[AI CONTROL TRACE V1 ACTIVE] Speed profile, dynamic stability, and track-aware traffic loaded.');
    }

    const car = this.car;
    const { trackPath, selectedTrackData, cars } = state;
    if (!trackPath || trackPath.length === 0) return { throttleInput: 1.0, brakeInput: 0, steerInput: 0 };

    const speed = Math.hypot(car.vx, car.vy);
    const speedRatio = speed / MAX_INTERNAL_SPEED;
    const trackWidth = (selectedTrackData && selectedTrackData.trackWidth) || 24;
    const halfW = trackWidth * 0.5;
    const usableHalfW = halfW - 2.0;

    const cp = trackPath[car.pathIndex] || trackPath[0];
    const currentSector = this.sectors[this.currentSectorIdx] || this.sectors[0];

    const headingX = Math.cos(car.angle);
    const headingY = Math.sin(car.angle);
    const rightX = -headingY;
    const rightY = headingX;

    const fwdVel = car.vx * headingX + car.vy * headingY;
    const latVel = car.vx * rightX + car.vy * rightY;
    const slipAngle = Math.atan2(latVel, Math.abs(fwdVel) + 0.001);
    const slipAngleDeg = slipAngle * (180 / Math.PI);
    const slipAngleRate = (slipAngleDeg - (this.lastSlipAngle || 0)) * 60.0;
    this.lastSlipAngle = slipAngleDeg;

    // Distâncias para o centro e para as bordas utilizáveis
    const carCenterOffset = (car.x - cp.x) * cp.normalX + (car.y - cp.y) * cp.normalY;
    const distToOuterEdge = Math.max(0, usableHalfW - Math.abs(carCenterOffset));
    const latVelTowardEdge = latVel * Math.sign(carCenterOffset || 1);

    // =========================================================================
    // 1. ANÁLISE DE TRÁFEGO, PELOTÃO (CROWDING) & ESPAÇO REAL NAS BORDAS
    // =========================================================================
    let carAhead = null;
    let minDistFront = 50.0;
    let carAheadSpeed = 0;
    let carAheadOffset = 0;
    let slipstreamActive = false;

    let carBehind = null;
    let minDistBehind = 35.0;
    let carBehindLat = 0;

    let carsNearbyCount = 0; // Quantos carros disputam a mesma curva no pelotão

    for (let other of cars) {
      if (other === car || other.finished) continue;

      const dx = other.x - car.x;
      const dy = other.y - car.y;
      const fwdD = dx * headingX + dy * headingY;
      const latD = dx * rightX + dy * rightY;
      const absLat = Math.abs(latD);

      if (Math.abs(fwdD) < 22.0 && absLat < 7.0) {
        carsNearbyCount++;
      }

      if (fwdD > 0 && fwdD < minDistFront && absLat < 7.5) {
        carAhead = other;
        minDistFront = fwdD;
        carAheadSpeed = Math.hypot(other.vx, other.vy);
        carAheadOffset = (other.x - cp.x) * cp.normalX + (other.y - cp.y) * cp.normalY;
        slipstreamActive = (fwdD < 18.0 && absLat < 3.2);
      }

      if (fwdD < 0 && fwdD > -minDistBehind && absLat < 7.0) {
        carBehind = other;
        minDistBehind = -fwdD;
        carBehindLat = latD;
      }
    }

    // =========================================================================
    // 2. CONTROLE DE VELOCIDADE BASEADO NO SPEED PROFILE GLOBAL FÍSICO
    // =========================================================================
    const safeLimit = (cp.safeBrakingLimit || cp.targetSpeed || MAX_INTERNAL_SPEED) * (car.botSkill || 1.0);
    let baseTargetSpeed = safeLimit * (currentSector.exitThrottle || 1.0);
    if (slipstreamActive) baseTargetSpeed = Math.min(MAX_INTERNAL_SPEED, baseTargetSpeed * 1.10);

    let trafficBraking = false;
    let carAheadDelta = 0;
    if (carAhead && minDistFront < 10.0 && carAheadSpeed < speed * 0.94) {
      trafficBraking = true;
      carAheadDelta = (speed - carAheadSpeed);
    }

    let throttleInput = 1.0;
    let brakeInput = 0.0;
    let speedLimiterReason = 'FLAT_OUT';
    let brakeReason = 'NONE';

    const previewIdx = (car.pathIndex + 12) % trackPath.length;
    const previewLimit = trackPath[previewIdx].safeBrakingLimit || trackPath[previewIdx].targetSpeed || MAX_INTERNAL_SPEED;
    const isAcceleratingZone = previewLimit >= safeLimit - 0.01;
    const brakeTolerance = isAcceleratingZone ? 1.04 : 1.02;

    if (trafficBraking) {
      brakeInput = Math.min(1.0, 0.40 + carAheadDelta * 2.2);
      throttleInput = 0.0;
      brakeReason = 'TRAFFIC';
      speedLimiterReason = 'TRAFFIC_SLOWDOWN';
    } else if (speed > baseTargetSpeed * brakeTolerance && (!isAcceleratingZone || speed > safeLimit * 1.08)) {
      const excess = (speed - baseTargetSpeed) / Math.max(baseTargetSpeed, 0.01);
      brakeInput = Math.min(1.0, 0.40 + excess * 2.6 + (currentSector.brakeBias || 0) * 0.04);
      throttleInput = speed > baseTargetSpeed * 1.06 ? 0.0 : 0.15;
      brakeReason = (cp.smoothedCurvature || cp.curvature || 0) > 0.02 ? 'CURVATURE_OVERSPEED' : 'UPCOMING_BRAKING_ZONE';
      speedLimiterReason = 'BRAKING_PROFILE';
    } else {
      throttleInput = currentSector.exitThrottle || 1.0;
      brakeInput = 0.0;
      brakeReason = 'NONE';
      speedLimiterReason = (baseTargetSpeed >= MAX_INTERNAL_SPEED * 0.98) ? 'FLAT_OUT' : 'ACCELERATION_ZONE';
    }

    // --- TRAIL BRAKING NO TURN-IN ---
    if (brakeInput > 0 && Math.abs(car.steerAmount || 0) > 0.06) {
      const trailFactor = Math.max(0.20, 1.0 - Math.abs(car.steerAmount) * 0.70);
      brakeInput *= trailFactor;
      speedLimiterReason = 'TRAIL_BRAKING';
    }

    // =========================================================================
    // 3. ENVELOPE DE ESTABILIDADE DINÂMICA & PREDIÇÃO DE BORDA (TIME-TO-EDGE)
    // =========================================================================
    const steerAngle = (car.steerAmount || 0) * (0.32 - 0.20 * Math.min(1, speed / MAX_INTERNAL_SPEED));
    const desiredYawRate = (fwdVel * Math.tan(steerAngle)) / 2.70;
    const yawError = (car.yawRate || 0) - desiredYawRate;

    let stabilityState = 'STABLE';
    let tractionFactor = 1.0;

    // 1. Slip Control (TCS com análise de taxa de crescimento de deriva)
    const maxAcceptableSlipDeg = (Math.abs(cp.curvature || 0) > 0.015) ? 6.5 : 4.2;
    if (Math.abs(slipAngleDeg) > maxAcceptableSlipDeg) {
      const slipExcess = Math.abs(slipAngleDeg) - maxAcceptableSlipDeg;
      tractionFactor = Math.max(0.20, Math.min(1.0, 1.0 - (slipExcess / 5.5)));
      stabilityState = 'CONTROLLED_SLIP';
    }
    if (Math.abs(slipAngleDeg) > 4.5 && slipAngleRate > 14.0) {
      tractionFactor = Math.min(tractionFactor, Math.max(0.15, 1.0 - (slipAngleRate / 35.0)));
      stabilityState = 'OVERSTEER_RISK';
    }

    // 2. Prevenção de Understeer (Frente saturando e abrindo trajetória em direção à borda)
    if (Math.abs(slipAngleDeg) > 3.8 && latVelTowardEdge > 0.030) {
      const understeerFactor = Math.max(0.12, Math.min(1.0, 1.0 - (latVelTowardEdge / 0.12)));
      tractionFactor = Math.min(tractionFactor, understeerFactor);
      stabilityState = 'UNDERSTEER_RISK';
    }

    // 3. Prevenção de Oversteer (Traseira soltando / excesso de rotação angular)
    if ((car.rearSlip || 0) > 0.06 || (yawError * Math.sign(desiredYawRate || 1) > 0.035)) {
      const oversteerFactor = Math.max(0.10, Math.min(1.0, 1.0 - ((car.rearSlip || 0) / 0.12)));
      tractionFactor = Math.min(tractionFactor, oversteerFactor);
      stabilityState = 'OVERSTEER_RISK';
    }

    // 4. Previsão Preditiva de Saída de Pista: Time-to-Edge (ttc)
    if (latVelTowardEdge > 0.008) {
      const latVelMps = latVelTowardEdge * 60.0;
      const timeToEdgeSec = distToOuterEdge / Math.max(0.01, latVelMps);

      if (timeToEdgeSec < 0.45) {
        const edgePredictFactor = Math.max(0.0, Math.min(1.0, timeToEdgeSec / 0.45));
        tractionFactor = Math.min(tractionFactor, edgePredictFactor);
        stabilityState = 'EDGE_RISK';

        if (timeToEdgeSec < 0.16 || distToOuterEdge < 0.60) {
          brakeInput = Math.max(brakeInput, 0.35);
          brakeReason = 'EDGE_INTERVENTION';
        }
      }
    }

    // Modulação progressiva do acelerador
    if (brakeInput === 0) {
      const exitProgress = 0.75 + 0.25 * (1.0 - Math.min(1.0, Math.abs(car.steerAmount || 0) * 1.2));
      throttleInput = Math.max(throttleInput, exitProgress * (currentSector.exitThrottle || 1.0));
      throttleInput *= tractionFactor;
    }

    if (stabilityState !== 'STABLE') {
      speedLimiterReason = stabilityState;
    }

    // =========================================================================
    // 4. TRAJETÓRIA ÓTIMA (RACING LINE) & ULTRAPASSAGEM TRACK-AWARE (SEM ÊXODO)
    // =========================================================================
    let look1 = Math.floor(7 + speedRatio * 14);
    let look2 = Math.floor(18 + speedRatio * 18);
    let pAhead1 = trackPath[(car.pathIndex + look1) % trackPath.length];
    let pAhead2 = trackPath[(car.pathIndex + look2) % trackPath.length];

    let curvDiff1 = Math.sin(pAhead1.angle - cp.angle);
    let curvDiff2 = Math.sin(pAhead2.angle - cp.angle);
    let geometricApexShift = Math.max(-usableHalfW, Math.min(usableHalfW,
      curvDiff1 * 5.4 + curvDiff2 * 3.4));

    // Racing line geométrica base
    let racingLineOffset = (car.baseOffset - geometricApexShift) * 0.60 + (currentSector.apexOffset || 0) * 0.40;

    let tacticalOffset = 0;

    // --- DEFESA DE POSIÇÃO ---
    if (carBehind && minDistBehind < 26.0) {
      this.wasAttacked = true;
      if ((cp.curvature || 0) > 0.010) {
        const insideSide = (pAhead1.angle - cp.angle) >= 0 ? 1 : -1;
        tacticalOffset = insideSide * (halfW * 0.35);
      } else {
        const blockSide = carBehindLat >= 0 ? 1 : -1;
        tacticalOffset = blockSide * Math.min(halfW * 0.30, minDistBehind * 0.25);
      }
    }

    // --- ULTRAPASSAGEM INTELIGENTE TRACK-AWARE COM HISTERESE ---
    if (carAhead && minDistFront < 32.0) {
      // Espaço asfaltado utilizável dos dois lados do carro à frente
      const spaceOnLeft = usableHalfW - carAheadOffset - 2.0;
      const spaceOnRight = usableHalfW + carAheadOffset - 2.0;

      const isTightPackInCorner = (Math.abs(cp.curvature || 0) > 0.012) && (carsNearbyCount >= 3);

      if (isTightPackInCorner) {
        // No meio de pelotão em curva fechada: mantém linha na esteira sem forçar 3 carros na borda externa
        tacticalOffset = (carAheadOffset * 0.65);
        speedLimiterReason = 'TRAFFIC_CROWDING';
      } else {
        // Atualização de intenção de ultrapassagem com histerese (mínimo 25 frames de persistência)
        if (this.overtakeHoldFrames <= 0) {
          if (spaceOnLeft >= 2.6 && spaceOnLeft >= spaceOnRight) {
            this.overtakeSide = 1; // Ultrapassar pela esquerda (+normal)
            this.overtakeHoldFrames = 28;
          } else if (spaceOnRight >= 2.6) {
            this.overtakeSide = -1; // Ultrapassar pela direita (-normal)
            this.overtakeHoldFrames = 28;
          } else {
            this.overtakeSide = 0; // Sem espaço suficiente: fica atrás
            this.overtakeHoldFrames = 15;
          }
        } else {
          this.overtakeHoldFrames--;
        }

        if (this.overtakeSide !== 0) {
          const passSide = this.overtakeSide;
          const targetClearance = passSide > 0 ? (carAheadOffset + 2.8) : (carAheadOffset - 2.8);
          tacticalOffset = passSide > 0 ? Math.min(usableHalfW - 0.8, targetClearance) : Math.max(-usableHalfW + 0.8, targetClearance);
        }
      }
    } else {
      this.overtakeHoldFrames = 0;
      this.overtakeSide = 0;
    }

    // HIERARQUIA ESTREITA: Racing Line + Tática com restrição geométrica rígida
    let targetLane = racingLineOffset + tacticalOffset;

    // Em curvas de alta aceleração lateral, assegura margem interna de segurança
    const curveEdgeMargin = Math.min(1.6, Math.abs(cp.curvature || 0) * 65.0);
    const maxSafeOffset = usableHalfW - curveEdgeMargin;
    targetLane = Math.max(-maxSafeOffset, Math.min(maxSafeOffset, targetLane));

    const smoothRate = (carBehind || carAhead) ? 0.12 : 0.08;
    car.currentLaneOffset += (targetLane - car.currentLaneOffset) * smoothRate;
    car.currentLaneOffset = Math.max(-maxSafeOffset, Math.min(maxSafeOffset, car.currentLaneOffset));
    car.targetOffset = targetLane;

    // =========================================================================
    // 4. ESTERÇO PURO-PURSUIT COM AMORTECIMENTO DE GUINADA (Zero Zig-Zag)
    // =========================================================================
    const isOffTrack = (car.currentSurface === 'GRAVEL' || car.currentSurface === 'RUNOFF');

    const normalLookaheadDist = 14.0 + speedRatio * 38.0;
    const effectiveLookaheadDist = isOffTrack ? 8.0 : normalLookaheadDist;

    if (isOffTrack) {
      car.currentLaneOffset *= 0.85;
    }

    let steerPtIdx = car.pathIndex;
    let accumSteerDist = 0;
    for (let si = 1; si <= 300; si++) {
      const siIdx = (car.pathIndex + si) % trackPath.length;
      accumSteerDist += trackPath[siIdx].segmentLength || 1.5;
      steerPtIdx = siIdx;
      if (accumSteerDist >= effectiveLookaheadDist) break;
    }
    const steerPoint = trackPath[steerPtIdx];
    const steerTargetX = steerPoint.x + steerPoint.normalX * car.currentLaneOffset;
    const steerTargetY = steerPoint.y + steerPoint.normalY * car.currentLaneOffset;

    const targetLateralOffset = Math.abs(
      (steerTargetX - steerPoint.x) * steerPoint.normalX +
      (steerTargetY - steerPoint.y) * steerPoint.normalY
    );
    const targetSurface = targetLateralOffset <= halfW ? 'TARMAC' : (targetLateralOffset <= halfW + 2.0 ? 'KERB' : 'GRAVEL');

    const dxTarget = steerTargetX - car.x;
    const dyTarget = steerTargetY - car.y;
    const distTarget = Math.max(3.0, Math.hypot(dxTarget, dyTarget));

    let alpha = Math.atan2(dyTarget, dxTarget) - car.angle;
    while (alpha < -Math.PI) alpha += Math.PI * 2;
    while (alpha >  Math.PI) alpha -= Math.PI * 2;

    const reqCurvature = (2.0 * Math.sin(alpha)) / distTarget;
    const steerRatio = 0.32 - 0.20 * Math.min(1.0, speedRatio);
    const targetWheelAngle = Math.atan(reqCurvature * 2.70); // GT3_WHEELBASE = 2.70m
    const rawSteerInput = targetWheelAngle / steerRatio;

    // Amortecimento de Guinada (Yaw Damping anti-zig-zag)
    const yawDamping = (car.yawRate || 0) * 0.22 / steerRatio;
    const targetSteerCommand = Math.max(-1.0, Math.min(1.0, rawSteerInput - yawDamping));

    car.steerAmount = (car.steerAmount || 0) + (targetSteerCommand - (car.steerAmount || 0)) * 0.28;
    const steerInput = Math.max(-1.0, Math.min(1.0, car.steerAmount));

    const crossTrackError = (car.x - cp.x) * cp.normalX + (car.y - cp.y) * cp.normalY - car.currentLaneOffset;

    // Telemetria para o debug overlay visual (apenas se DEBUG_BOT_AI estiver ativo)
    if (typeof window !== 'undefined' && window.DEBUG_BOT_AI && !debugBotTarget) {
      debugBotTarget = {
        car,
        cp,
        steerPoint,
        steerTargetX,
        steerTargetY,
        currentLaneOffset: car.currentLaneOffset,
        targetLane,
        usableHalfW,
        halfW,
        targetSurface,
        headingSteer: rawSteerInput,
        lateralSteer: -yawDamping,
        steerInput,
        crossTrackError,
        isOffTrack,
        targetSpeed: baseTargetSpeed,
        speedLimiterReason,
        brakeReason,
        throttleInput,
        brakeInput,
        slipAngleDeg,
        actualYawRate: car.yawRate || 0,
        desiredYawRate,
        tractionFactor,
        distToOuterEdge,
        stabilityState
      };
    }

    return { throttleInput, brakeInput, steerInput };
  }
}

// ── OVERLAY VISUAL DE DEBUG ───────────────────────────────────────────────────
export function drawBotDebugOverlay(ctx) {
  if (typeof window === 'undefined' || !window.DEBUG_BOT_AI) return;
  const dbg = debugBotTarget;
  debugBotTarget = null; // reset para o próximo frame
  if (!dbg) return;

  const { car, cp, steerPoint, steerTargetX, steerTargetY,
          currentLaneOffset, targetLane, usableHalfW, halfW,
          targetSurface, headingSteer, lateralSteer, steerInput, crossTrackError, isOffTrack,
          targetSpeed, speedLimiterReason, brakeReason, throttleInput, brakeInput,
          slipAngleDeg, actualYawRate, desiredYawRate, tractionFactor, distToOuterEdge, stabilityState } = dbg;

  ctx.save();

  // BRANCO: Linha branca REAL da pista
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 0.35;
  ctx.beginPath();
  state.trackPath.forEach((p, i) => {
    const lx = p.x + p.normalX * halfW;
    const ly = p.y + p.normalY * halfW;
    i === 0 ? ctx.moveTo(lx, ly) : ctx.lineTo(lx, ly);
  });
  ctx.closePath();
  ctx.stroke();

  ctx.beginPath();
  state.trackPath.forEach((p, i) => {
    const rx = p.x - p.normalX * halfW;
    const ry = p.y - p.normalY * halfW;
    i === 0 ? ctx.moveTo(rx, ry) : ctx.lineTo(rx, ry);
  });
  ctx.closePath();
  ctx.stroke();

  // VERMELHO: borda esquerda dirigível da IA
  ctx.strokeStyle = '#ff2222';
  ctx.lineWidth = 0.25;
  ctx.setLineDash([1.5, 1.5]);
  ctx.beginPath();
  state.trackPath.forEach((p, i) => {
    const lx = p.x + p.normalX * usableHalfW;
    const ly = p.y + p.normalY * usableHalfW;
    i === 0 ? ctx.moveTo(lx, ly) : ctx.lineTo(lx, ly);
  });
  ctx.closePath();
  ctx.stroke();

  // MAGENTA: borda direita dirigível da IA
  ctx.strokeStyle = '#ff22ff';
  ctx.beginPath();
  state.trackPath.forEach((p, i) => {
    const rx = p.x - p.normalX * usableHalfW;
    const ry = p.y - p.normalY * usableHalfW;
    i === 0 ? ctx.moveTo(rx, ry) : ctx.lineTo(rx, ry);
  });
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  // AZUL: ponto da centerline mais próximo (cp)
  ctx.fillStyle = '#2299ff';
  ctx.beginPath();
  ctx.arc(cp.x, cp.y, 0.6, 0, Math.PI * 2);
  ctx.fill();

  // CIANO: projeção perpendicular do carro na centerline
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 0.2;
  ctx.beginPath();
  ctx.moveTo(car.x, car.y);
  ctx.lineTo(cp.x, cp.y);
  ctx.stroke();

  // VERDE: racing line target
  const racingX = steerPoint.x + steerPoint.normalX * targetLane;
  const racingY = steerPoint.y + steerPoint.normalY * targetLane;
  ctx.fillStyle = '#22ff44';
  ctx.beginPath();
  ctx.arc(racingX, racingY, 0.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#22ff44';
  ctx.lineWidth = 0.2;
  ctx.beginPath();
  ctx.moveTo(cp.x, cp.y);
  ctx.lineTo(racingX, racingY);
  ctx.stroke();

  // AMARELO / LARANJA: steerTarget real
  ctx.fillStyle = isOffTrack ? '#ff8800' : '#ffee00';
  ctx.beginPath();
  ctx.arc(steerTargetX, steerTargetY, 0.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = isOffTrack ? '#ff8800bb' : '#ffee0088';
  ctx.lineWidth = 0.22;
  ctx.beginPath();
  ctx.moveTo(car.x, car.y);
  ctx.lineTo(steerTargetX, steerTargetY);
  ctx.stroke();

  // BRANCO: posição do bot
  ctx.strokeStyle = isOffTrack ? '#ff3333' : '#ffffff';
  ctx.lineWidth = 0.35;
  ctx.beginPath();
  ctx.arc(car.x, car.y, 1.8, 0, Math.PI * 2);
  ctx.stroke();

  // Texto de status flutuante acima do bot
  const targetKmh = Math.round(((targetSpeed || 1.35) / 1.35) * 285);
  ctx.save();
  ctx.translate(car.x, car.y - 4.2);
  ctx.scale(0.045, 0.045);
  ctx.fillStyle = isOffTrack ? '#ff4444' : (stabilityState !== 'STABLE' ? '#ffaa00' : '#ffffff');
  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`[${car.currentSurface}] | vTgt:${targetKmh}km/h | thr:${(throttleInput || 0).toFixed(2)} brk:${(brakeInput || 0).toFixed(2)} | ST:${stabilityState || 'STABLE'}`, 0, -18);
  ctx.fillStyle = '#00ffff';
  ctx.fillText(`SLIP:${(slipAngleDeg || 0).toFixed(1)}° | YAW:${(actualYawRate || 0).toFixed(2)}/${(desiredYawRate || 0).toFixed(2)} | TC:${(tractionFactor || 1).toFixed(2)} | EDGE:${(distToOuterEdge || 0).toFixed(1)}m`, 0, -2);
  ctx.fillStyle = '#ffff55';
  ctx.fillText(`rawSteer:${headingSteer.toFixed(2)} yawDamp:${lateralSteer.toFixed(2)} steer:${steerInput.toFixed(2)} (xTrk:${crossTrackError.toFixed(1)}m)`, 0, 14);
  ctx.restore();

  ctx.restore();
}
