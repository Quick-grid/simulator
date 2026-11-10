// Carro GT3: modelo plano com pneus, transferência de peso e perda progressiva de aderência.

import { ctx } from './canvas.js';
import {
  MAX_INTERNAL_SPEED, MAX_SPEED_KMH, NUM_CHECKPOINTS,
  FORCA_TRACAO, RESISTENCIA_AR, TAXA_SUAVIZACAO_ACEL,
  TAXA_SUAVIZACAO_FREIO, FORCA_FREIO_MAX,
  GEAR_SPEEDS, GEAR_POWER, GT3_WHEELBASE, GT3_BASE_GRIP, GT3_AERO_GRIP,
  GT3_TC_SLIP_LIMIT, GT3_ABS_SLIP_LIMIT, GT3_REAR_LATERAL_DEMAND,
  GT3_TOP_SPEED, GT3_REAR_SLIDE_GRIP_LOSS, GT3_OVERSTEER_GAIN, GT3_YAW_RECOVERY_LOSS, GT3_MAX_YAW_RATE, GRAVEL_HANDLING, DRIFT_CONTROL
} from './constants.js';
import { Particle, SparkParticle } from './particles.js';
import { state } from './game.js';
import { BotBrain } from './ai.js';
import { drawCarAppearance } from './carAppearance.js';
import { playerSteering } from './raceSettings.js';
import { WAKE_TUNING } from './aerodynamics.js';
import { getStartingGrid } from './startingGrid.js';
import { BOOST_TUNING, updateBoost } from './boost.js';

export class Car {
  constructor(color, name, isBot, index, isAuto = true) {
    this.color = color;
    this.name = name;        // Nome interno para display/HUD (NÃO exposto no dataset)
    this.isBot = isBot;
    this.gridSlot = index;
    this.isAuto = isBot ? true : isAuto;
    this.radius = 1.6; // Metros
    // participantId anônimo para dataset de ML — nunca contém nome/email/conta
    const anonUuid = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID().slice(0, 8)
      : (Math.random() * 0xffff | 0).toString(16).padStart(4, '0');
    this.participantId = `p_${index}_${anonUuid}`;

    const { trackPath, botDifficulty } = state;

    const slot = getStartingGrid(trackPath, state.selectedTrackData?.trackWidth || 24)[index];
    this.angle = slot.angle;
    this.x = slot.x;
    this.y = slot.y;
    this.z = slot.z;

    this.vx = 0; this.vy = 0;
    this.gear = 1;
    this.maxGear = 6;
    this.rpm = 1000;
    this.aceleracao_atual = 0.0;
    this.brakePressure = 0.0; // Pressão hidráulica progressiva do freio
    this.steerAmount = 0.0;
    this.yawRate = 0.0;
    this.rearSlip = 0.0;
    this.wakeIntensity = 0;
    this.boostCharge = 1;
    this.boostCarry = false;
    this.boostCooldown = 0;
    this.boostActive = false;
    this.boostNeedsRelease = false;
    this.lastBoostRequested = false;
    this.lastGearShiftRequest = 0;
    this.pendingManualGearShiftRequest = 0;
    this.pendingManualShiftSnapshot = null;
    this.tcActive = false;
    this.absActive = false;
    this.tyreTemp = 74;
    this.tyreWear = 0;
    this.brakeTemp = 180;

    this.currentLap = 1;
    this.nextCheckpoint = 1;
    this.pathIndex = slot.pathIndex;
    this.finished = false;
    this.rank = index + 1;
    this.progress = 0;

    this.physicsState = 'NORMAL';
    this.currentSurface = 'TARMAC'; // 'TARMAC' | 'KERB' | 'GRAVEL'

    if (isBot) {
      const diffMult = botDifficulty === 'pro' ? 1.0 : (botDifficulty === 'medium' ? 0.90 : 0.80);
      this.botSkill = diffMult * (0.98 + Math.random() * 0.05);

      this.baseOffset = (Math.random() - 0.5) * 5.0;
      this.currentLaneOffset = this.baseOffset;
      this.targetOffset = this.baseOffset;
      this.aggression = 0.75 + Math.random() * 0.25;

      // Cérebro de Machine Learning & Tática
      this.brain = new BotBrain(this);
    }

    this.raceStartTime = 0;
    this.totalRaceTime = 0;
    this.lapStartTime = 0;
    this.currentLapTime = 0;
  }

  shiftUp() { if (this.gear < this.maxGear) this.gear++; }
  shiftDown() { if (this.gear > 1) this.gear--; }

  recordManualGearShiftRequest(direction) {
    if (this.isBot || this.isAuto || (direction !== -1 && direction !== 1)) return false;
    if (!this.pendingManualShiftSnapshot) {
      this.pendingManualShiftSnapshot = { gear: this.gear, rpm: this.rpm };
    }
    this.pendingManualGearShiftRequest = Math.max(-1,
      Math.min(1, this.pendingManualGearShiftRequest + direction));
    return true;
  }

  // Cálculo de Distância Perpendicular Contínua Ponto-a-Segmento (Elimina Britas Invisíveis)
  getTrackDistanceAndSegment() {
    const { trackPath } = state;
    if (!trackPath || trackPath.length === 0) return { lateralDist: 0, closestIdx: 0, segmentIdx: 0, segmentT: 0 };

    let totalP = trackPath.length;
    let minPerpDist = Infinity;
    let bestIdx = this.pathIndex;
    let bestSegIdx = this.pathIndex;
    let bestSegT = 0;
    let searchRange = 45;

    for (let i = -searchRange; i <= searchRange; i++) {
      let idx1 = (this.pathIndex + i + totalP) % totalP;
      let idx2 = (idx1 + 1) % totalP;
      let p1 = trackPath[idx1];
      let p2 = trackPath[idx2];

      let segX = p2.x - p1.x;
      let segY = p2.y - p1.y;
      let segLenSq = segX * segX + segY * segY;

      if (segLenSq === 0) continue;

      let t = Math.max(0, Math.min(1, ((this.x - p1.x) * segX + (this.y - p1.y) * segY) / segLenSq));
      let projX = p1.x + t * segX;
      let projY = p1.y + t * segY;

      // Compare squared distances; take one square root after finding the winner.
      let dx = this.x - projX, dy = this.y - projY;
      let dist = dx * dx + dy * dy;
      if (dist < minPerpDist) {
        minPerpDist = dist;
        bestIdx = t > 0.5 ? idx2 : idx1;
        bestSegIdx = idx1;
        bestSegT = t;
      }
    }

    return { lateralDist: Math.sqrt(minPerpDist), closestIdx: bestIdx, segmentIdx: bestSegIdx, segmentT: bestSegT };
  }

  update() {
    const { trackPath, selectedTrackData, cars, keys, gameMode, floatingNotices, particles, skidMarks } = state;
    if (!trackPath || trackPath.length === 0) return;

    if (this.finished) {
      this.boostActive = false;
      this.vx *= 0.94; this.vy *= 0.94;
      this.x += this.vx; this.y += this.vy;
      return;
    }

    // Manual shifts are edge-triggered before this physics tick. Retain their
    // pre-effect state for the V3 State(t) snapshot without changing gameplay.
    const manualGearShiftRequest = !this.isBot && !this.isAuto
      ? this.pendingManualGearShiftRequest : 0;
    const manualShiftSnapshot = manualGearShiftRequest !== 0
      ? this.pendingManualShiftSnapshot : null;
    this.pendingManualGearShiftRequest = 0;
    this.pendingManualShiftSnapshot = null;

    let speed = Math.hypot(this.vx, this.vy); // Metros por frame
    const trackWidth = (selectedTrackData && selectedTrackData.trackWidth) || 24;

    // RPM & Câmbio Automático
    let minG = GEAR_SPEEDS[this.gear - 1];
    let maxG = GEAR_SPEEDS[this.gear];
    let gearRatio = Math.max(0, (speed - minG) / ((maxG - minG) || 1));
    let rawRpm = Math.min(8500, 1000 + (gearRatio * 7500));
    this.rpm += (rawRpm - this.rpm) * 0.15;

    if (this.isAuto) {
      if ((this.rpm > 7000 || gearRatio > 0.85) && this.gear < this.maxGear) this.shiftUp();
      else if (this.rpm < 2300 && this.gear > 1 && speed < GEAR_SPEEDS[this.gear - 1] * 1.02) this.shiftDown();
    }

    // Identificação Perpendicular de Superfície & Projeção Contínua no Segmento (O(1) reuso)
    const { lateralDist, closestIdx, segmentIdx, segmentT } = this.getTrackDistanceAndSegment();
    this.pathIndex = closestIdx;
    let currentPathPoint = trackPath[this.pathIndex];
    this.z = currentPathPoint.z || 0;

    let halfTrack = trackWidth * 0.5;

    const escapeType = (selectedTrackData && selectedTrackData.escapeType) || 'gravel_asphalt';
    if (lateralDist <= halfTrack) {
      this.currentSurface = 'TARMAC';
    } else if (lateralDist <= halfTrack + 2.0) {
      this.currentSurface = 'KERB';
    } else if (escapeType !== 'walls' && escapeType !== 'barriers' && lateralDist <= halfTrack + 5.0) {
      this.currentSurface = 'RUNOFF';
    } else {
      this.currentSurface = 'GRAVEL';
    }

    let headingX = Math.cos(this.angle);
    let headingY = Math.sin(this.angle);
    let rightX = -Math.sin(this.angle);
    let rightY = Math.cos(this.angle);

    // =========================================================================
    // ML TELEMETRY — PRE-PHYSICS SNAPSHOT (observation_t)
    // Capturar estado ANTES da integração física para garantir causalidade:
    //   sample = { observation(t), action(t) }  — NÃO { observation(t+1), action(t) }
    // Apenas primitives escalares — sem deep clone do objeto Car.
    // =========================================================================
    const fwdVelPre = this.vx * headingX + this.vy * headingY;
    const latVelPre = this.vx * rightX + this.vy * rightY;
    const cp = trackPath[this.pathIndex];
    const carCenterOffsetPre = (this.x - cp.x) * cp.normalX + (this.y - cp.y) * cp.normalY;
    let headingErrorPre = this.angle - cp.angle;
    while (headingErrorPre < -Math.PI) headingErrorPre += Math.PI * 2;
    while (headingErrorPre > Math.PI) headingErrorPre -= Math.PI * 2;

    // Cálculo de Distância Física Contínua ao Longo da Pista (ML1.4)
    // distanceAlongTrackMeters = cumulativeDistance(segmentIdx) + segmentT * segmentLength(segmentIdx)
    const segPoint = trackPath[segmentIdx] || cp;
    const segCumDist = (segPoint.cumulativeDistance !== undefined)
      ? segPoint.cumulativeDistance
      : (segmentIdx * (segPoint.segmentLength || 1.5));
    const segLen = segPoint.segmentLength || 1.5;
    const totalTrackLen = state.totalTrackLength || (trackPath.length * 1.5);

    let distAlongTrack = segCumDist + (segmentT || 0) * segLen;
    if (totalTrackLen > 0) {
      // Normalização com wrap estrito em [0, totalTrackLen)
      distAlongTrack = ((distAlongTrack % totalTrackLen) + totalTrackLen) % totalTrackLen;
    }
    const continuousTrackProgress = totalTrackLen > 0 ? (distAlongTrack / totalTrackLen) : 0;

    this.mlObservation = {
      // RAW PHYSICS — capturados antes de qualquer modificação neste tick
      speed,
      forwardVelocity: fwdVelPre,
      lateralVelocity: latVelPre,
      heading: this.angle,
      yawRate: this.yawRate,
      slipAngle: Math.atan2(latVelPre, Math.abs(fwdVelPre) + 0.001),
      steeringAngle: this.steerAmount,
      // TRACK GEOMETRY — baseado em pathIndex e distância física contínua interpolada (ML1.4)
      pathIndex: this.pathIndex,
      trackProgress: continuousTrackProgress,
      currentCurvature: cp.effectiveCurvature !== undefined ? cp.effectiveCurvature : (cp.curvature || 0),
      targetSpeed: cp.safeBrakingLimit || cp.targetSpeed || 1.35,
      distanceToLeftEdge: halfTrack - carCenterOffsetPre,
      distanceToRightEdge: halfTrack + carCenterOffsetPre,
      surface: this.currentSurface,
      // DERIVED PHYSICS
      headingError: headingErrorPre,
      crossTrackError: carCenterOffsetPre - (this.currentLaneOffset || 0),
      // EVENT FLAGS pertencem ao observation_t (estado no instante da decisão)
      offTrack: (this.currentSurface === 'GRAVEL' || this.currentSurface === 'RUNOFF'),
      collision: Boolean(this.hasContact),
      spin: Math.abs(Math.atan2(latVelPre, Math.abs(fwdVelPre) + 0.001)) > 0.40,
      isRecovering: (this.currentSurface === 'GRAVEL' || this.currentSurface === 'RUNOFF')
    };

    this.mlObservationV3 = {
      ...this.mlObservation,
      slope: currentPathPoint.slope || 0,
      gear: manualShiftSnapshot?.gear ?? this.gear,
      rpm: manualShiftSnapshot?.rpm ?? this.rpm,
      engineAcceleration: this.aceleracao_atual,
      brakePressure: this.brakePressure,
      automaticTransmission: this.isAuto,
      boostActive: this.boostActive,
      boostCharge: this.boostCharge,
      boostCooldownSeconds: this.boostCooldown,
      boostNeedsRelease: this.boostNeedsRelease,
      boostCarry: this.boostCarry,
      rearSlip: this.rearSlip,
      tyreTemperatureCelsius: this.tyreTemp,
      tyreWear: this.tyreWear,
      wakeIntensity: this.wakeIntensity || 0,
      wakeSpeedAllowanceKmh: this.wakeSpeedAllowance || 0,
      trackCondition: state.trackCondition === 'wet' ? 'wet' : 'dry'
    };

    let throttleInput = 0, brakeInput = 0, steerInput = 0;

    // === BARREIRA FÍSICA DA PISTA (PÓS CAIXA DE BRITA) ===
    // Bloqueia a saída do mapa além da caixa de brita (ou após o muro em circuitos urbanos)
    const barrierLimit = (escapeType === 'walls' || escapeType === 'barriers') ? (halfTrack + 3.0) : (halfTrack + 11.2);

    if (lateralDist > barrierLimit) {
      const penetration = lateralDist - barrierLimit;
      const cp = trackPath[this.pathIndex];
      // Vetor normal apontando de volta ao centro da pista
      const sideSign = ((this.x - cp.x) * cp.normalX + (this.y - cp.y) * cp.normalY) > 0 ? -1 : 1;

      // Força de empuxo elástico do guardrail/muro
      const wallPush = Math.min(0.22, 0.05 + penetration * 0.08);
      this.vx += cp.normalX * sideSign * wallPush;
      this.vy += cp.normalY * sideSign * wallPush;

      // Amortecimento / atrito de impacto na barreira
      this.vx *= 0.84;
      this.vy *= 0.84;

      // Faíscas de impacto no guardrail em alta velocidade
      if (speed > 0.25 && Math.random() < 0.4) {
        particles.push(new SparkParticle(this.x, this.y, -this.vx * 0.6, -this.vy * 0.6));
      }
    }

    if (this.isBot) {
      // --- CONTROLE INTELIGENTE VIA MACHINE LEARNING (BotBrain) ---
      if (this.brain) {
        const inputs = this.brain.computeInputs({ segmentIdx, segmentT });
        throttleInput = inputs.throttleInput;
        brakeInput = inputs.brakeInput;
        steerInput = inputs.steerInput;
      }
    } else {
      // --- CONTROLE DO JOGADOR HUMANO ---
      if (keys['KeyW']) throttleInput = 1.0;
      if (keys['KeyS']) brakeInput = 1.0; // Freio progressivo ao segurar 'S'

      let steerTarget = 0;
      if (keys['KeyA'] || keys['ArrowLeft']) steerTarget = -1.0;
      if (keys['KeyD'] || keys['ArrowRight']) steerTarget = 1.0;

      this.steerAmount = playerSteering(this.steerAmount, steerTarget, speed / MAX_INTERNAL_SPEED);

      this.steerAmount = Math.max(-1, Math.min(1, this.steerAmount));
      steerInput = this.steerAmount;
    }

    // =========================================================================
    // ML TELEMETRY — FINAL ACTION(t) — gravado APÓS filtros/rampa, ANTES da física
    // Esta é a ação REAL aplicada ao carro: observation_t + action_t = sample ML correto.
    // =========================================================================
    this.lastThrottleInput = throttleInput;
    this.lastBrakeInput = brakeInput;
    this.lastSteerInput = steerInput;
    this.lastBoostRequested = !this.isBot && Boolean(keys.Space);
    this.lastGearShiftRequest = manualGearShiftRequest;
    // Sinalizar que o mlObservation deste tick já tem a action correspondente disponível
    this.mlObservationReady = true;

    // --- FREIO PROGRESSIVO SUAVE & APROVEITAMENTO DE INÉRCIA ---
    if (brakeInput > 0) {
      this.brakePressure += (brakeInput - this.brakePressure) * TAXA_SUAVIZACAO_FREIO;
    } else {
      this.brakePressure *= 0.80; // Alívio rápido do freio ao soltar
      if (this.brakePressure < 0.01) this.brakePressure = 0;
    }

    // Aceleração do motor. O limite final é aplicado no pneu traseiro abaixo.
    let slope = currentPathPoint.slope || 0;
    let gravityEffect = -slope * 0.035;

    let aceleracao_alvo = 0;
    if (throttleInput > 0 && (speed < GEAR_SPEEDS[this.gear] || this.gear === 6)) {
      // Curva de torque: a saída de curva é forte, porém sem o salto brusco da versão anterior.
      const gearTopSpeed = GEAR_SPEEDS[this.gear];
      const rpmTorque = Math.max(0.42, 1 - (speed / Math.max(gearTopSpeed, 0.01)) * 0.42);
      aceleracao_alvo = throttleInput * GEAR_POWER[this.gear] * rpmTorque + gravityEffect;
    } else {
      aceleracao_alvo = gravityEffect * 0.5; // Inércia pura quando sem acelerador!
    }

    this.aceleracao_atual += (aceleracao_alvo - this.aceleracao_atual) * TAXA_SUAVIZACAO_ACEL;

    const wake = Math.max(0, Math.min(1, this.wakeIntensity || 0));
    let arrasto = (speed * speed) * RESISTENCIA_AR * (1 - wake * WAKE_TUNING.dragLoss);
    const boostSpeedLimit = MAX_INTERNAL_SPEED * BOOST_TUNING.maxSpeedKmh / MAX_SPEED_KMH;
    updateBoost(this, this.lastBoostRequested,
      throttleInput > 0 && brakeInput === 0 && fwdVelPre >= 0 && this.currentSurface === 'TARMAC' && speed < boostSpeedLimit,
      state.racePhase === 'racing' && !state.isPaused && !this.isBot);
    if (this.boostActive) this.boostCarry = true;
    else if (speed <= GT3_TOP_SPEED || fwdVelPre <= 0 || brakeInput > 0 || this.currentSurface !== 'TARMAC') this.boostCarry = false;
    // Only preserve earned boost momentum. Braking and off-road losses are unchanged.
    const boostCoast = this.boostCarry && !this.boostActive
      ? Math.min(1, Math.max(0, (speed - GT3_TOP_SPEED) * MAX_SPEED_KMH / MAX_INTERNAL_SPEED / BOOST_TUNING.coastBlendKmh)) : 0;
    arrasto *= 1 - boostCoast * (1 - BOOST_TUNING.coastAeroFactor);
    const wakeTarget = fwdVelPre > 0 ? wake * WAKE_TUNING.extraSpeedKmh : 0;
    const allowance = this.wakeSpeedAllowance || 0;
    this.wakeSpeedAllowance = allowance + Math.max(-WAKE_TUNING.unlockKmhPerSecond / 60,
      Math.min(WAKE_TUNING.unlockKmhPerSecond / 60, wakeTarget - allowance));
    let engineAccelFinal = this.aceleracao_atual * (this.boostActive ? BOOST_TUNING.power : 1)
      * (1 + wake * WAKE_TUNING.accelerationGain) - Math.sign(fwdVelPre) * arrasto;
    const engineSpeedLimit = this.boostActive ? boostSpeedLimit
      : GT3_TOP_SPEED + MAX_INTERNAL_SPEED * this.wakeSpeedAllowance / MAX_SPEED_KMH;
    // Separate engine limits; releasing boost preserves momentum instead of clipping speed.
    if (engineAccelFinal > 0) engineAccelFinal = Math.min(engineAccelFinal, Math.max(0, engineSpeedLimit - speed));
    // Corta só a força positiva do motor; não trunca a velocidade de colisões/descidas.
    if (fwdVelPre >= engineSpeedLimit) engineAccelFinal = Math.min(engineAccelFinal, -arrasto);

    // --- PNEUS GT3: círculo de aderência, carga aerodinâmica e transferência ---
    // A asa dá mais aderência apenas em velocidade; em baixa o carro pode rodar.
    let fwdVel = this.vx * headingX + this.vy * headingY;
    let latVel = this.vx * rightX + this.vy * rightY;
    let speedKmh = (speed / MAX_INTERNAL_SPEED) * MAX_SPEED_KMH;
    const wetTrack = state.trackCondition === 'wet';
    const targetTyreTemp = wetTrack ? 62 : 92;
    const tyreTempWindow = Math.max(0, 1 - Math.abs(this.tyreTemp - targetTyreTemp) / (wetTrack ? 42 : 58));
    const tyreCondition = (0.80 + tyreTempWindow * 0.20) * (1 - this.tyreWear * 0.22);
    const weatherGrip = wetTrack ? 0.74 : 1;
    let surfaceGrip = this.currentSurface === 'GRAVEL' ? 0.28 :
      (this.currentSurface === 'RUNOFF' ? 0.74 : (this.currentSurface === 'KERB' ? 0.84 : 1.0));
    surfaceGrip *= tyreCondition * weatherGrip;
    let aeroGrip = GT3_AERO_GRIP * Math.min(1.35, (speed / MAX_INTERNAL_SPEED) ** 2)
      * (1 - wake * WAKE_TUNING.downforceLoss);
    let totalGrip = (GT3_BASE_GRIP + aeroGrip) * surfaceGrip;

    // Frear desloca carga para frente; acelerar descarrega a frente e sobrecarrega a traseira.
    let frontLoad = 0.51 + this.brakePressure * 0.13 - throttleInput * 0.07;
    let rearLoad = 1.0 - frontLoad;
    let frontGrip = totalGrip * frontLoad;
    let rearGrip = totalGrip * rearLoad;
    // Relação de direção menos nervosa: ainda permite hairpins, mas é estável em apoio rápido.
    let steerAngle = steerInput * (0.32 - 0.20 * Math.min(1, speed / MAX_INTERNAL_SPEED));
    const gravelManeuver = this.currentSurface === 'GRAVEL'
      ? Math.max(0, 1 - speed / GRAVEL_HANDLING.maneuverSpeed) : 0;
    steerAngle += steerInput * GRAVEL_HANDLING.extraSteer * gravelManeuver;
    let desiredYawRate = fwdVel * Math.tan(steerAngle) / GT3_WHEELBASE;

    // O eixo dianteiro é responsável pelo giro. Se ele satura, o carro abre a trajetória.
    let frontLatDemand = Math.abs(desiredYawRate * fwdVel) * 0.52 + Math.abs(latVel) * 0.035;
    let frontUse = Math.min(1, frontLatDemand / Math.max(frontGrip, 0.001));
    let yawAuthority = 1 - Math.max(0, frontUse - 0.72) * 1.9;
    yawAuthority = Math.max(0.10, yawAuthority);
    // RWD: toda a força motriz consome apenas o círculo de aderência traseiro.
    // O giro já existente também exige aderência: contraesterçar não apaga a rodada.
    const rearAxleLateralVelocity = latVel - this.yawRate * GT3_WHEELBASE * 0.5;
    const rearDemand = Math.max(Math.abs(desiredYawRate * fwdVel), Math.abs(this.yawRate * fwdVel)) * GT3_REAR_LATERAL_DEMAND
      + Math.abs(rearAxleLateralVelocity) * 0.045 * Math.min(1, speed / 0.35);
    const rearDemandRatio = rearDemand / Math.max(rearGrip, 0.001);
    let rearLateralUse = Math.min(0.96, rearDemandRatio);
    let rearLongLimit = rearGrip * Math.sqrt(Math.max(0.04, 1 - rearLateralUse ** 2));
    let driveRequest = Math.max(0, engineAccelFinal);
    this.tcActive = driveRequest > rearLongLimit && throttleInput > 0.25;
    let driveAccel = Math.min(driveRequest, rearLongLimit * (this.tcActive ? 1.03 : 1));
    let excessDrive = Math.max(0, driveRequest - rearLongLimit);
    const targetRearSlip = Math.min(1.5, excessDrive / Math.max(rearGrip, 0.001)
      + Math.max(0, rearDemandRatio - 1) * 0.65);
    this.rearSlip += (targetRearSlip - this.rearSlip) * (targetRearSlip > this.rearSlip ? 0.16 : 0.07);
    const sliding = Math.min(1, this.rearSlip);
    const rearGripRetention = 1 - sliding * GT3_REAR_SLIDE_GRIP_LOSS;
    driveAccel *= rearGripRetention;

    // Menos estabilização automática quando o eixo traseiro desliza.
    this.yawRate += (desiredYawRate * yawAuthority - this.yawRate)
      * (0.075 + 0.12 * frontUse) * (1 - sliding * GT3_YAW_RECOVERY_LOSS);

    let brakeRequest = this.brakePressure * FORCA_FREIO_MAX;
    let brakeLimit = totalGrip * (1 - Math.min(0.45, Math.abs(latVel) / 0.45));
    this.absActive = brakeRequest > brakeLimit * (1 + GT3_ABS_SLIP_LIMIT);
    let brakeAccel = Math.min(brakeRequest, brakeLimit * (this.absActive ? 1.04 : 1));

    // S brakes to a stop before requesting reverse. Drag opposes signed motion.
    const reverseLimit = MAX_INTERNAL_SPEED * 50 / MAX_SPEED_KMH;
    const reversing = !this.isBot && this.lastBrakeInput > 0 && throttleInput === 0 && fwdVel <= 0;
    const signedBrake = reversing
      ? -Math.min(brakeAccel * 0.35, rearLongLimit, Math.max(0, reverseLimit + fwdVel))
      : -Math.sign(fwdVel) * Math.min(brakeAccel, Math.abs(fwdVel));
    let longitudinalDelta = driveAccel + signedBrake - Math.max(0, -engineAccelFinal);
    // A hard safety bound only on reverse; retain sideways slide and forward momentum.
    longitudinalDelta = Math.max(longitudinalDelta, -reverseLimit - fwdVel);
    this.vx += headingX * longitudinalDelta;
    this.vy += headingY * longitudinalDelta;

    // Relaxamento lateral limitado: ao exceder o grip, a velocidade transversal persiste.
    let lateralCapacity = Math.max(0.012, frontGrip + rearGrip * rearGripRetention - Math.abs(driveAccel - brakeAccel) * 0.55);
    let lateralCorrection = Math.min(Math.abs(latVel), lateralCapacity) * 0.38;
    this.vx -= rightX * Math.sign(latVel) * lateralCorrection;
    this.vy -= rightY * Math.sign(latVel) * lateralCorrection;

    // A deriva no eixo traseiro mantém o sentido do giro até recuperar aderência.
    const rearAxleSlipAngle = Math.atan2(latVel - this.yawRate * GT3_WHEELBASE * 0.5, Math.abs(fwdVel) + 0.05);
    const boundedRearAngle = Math.max(-0.35, Math.min(0.35, rearAxleSlipAngle));
    // Countersteering gives the front axle authority while the rear is sliding.
    // No auto-straightening: wrong/neutral steering retains the existing spin dynamics.
    const bodySlip = Math.atan2(latVel, Math.max(0.001, fwdVel));
    const countersteer = fwdVel > 0 && steerInput * bodySlip > 0
      ? Math.min(1, Math.abs(bodySlip) / DRIFT_CONTROL.slipWindow) * Math.abs(steerInput)
        * Math.max(0, Math.min(1, (DRIFT_CONTROL.fadeAngle - Math.abs(bodySlip)) / DRIFT_CONTROL.fadeRange)) : 0;
    let oversteerTorque = -boundedRearAngle * sliding * GT3_OVERSTEER_GAIN * Math.min(1, speed / 0.45);
    this.yawRate += oversteerTorque * (1 - countersteer * DRIFT_CONTROL.oversteerRelief);
    this.yawRate += (desiredYawRate * yawAuthority - this.yawRate)
      * countersteer * DRIFT_CONTROL.yawResponse * Math.min(1, frontGrip / 0.02);
    // Evita ganho angular ilimitado e dissipa a rodada quando o carro para.
    this.yawRate *= 0.98 * Math.min(1, speed / 0.15);
    // At crawling speed, follow the rolling wheels instead of damping away all steering.
    // The kinematic target is zero at rest; gravel remains loose at racing speed.
    this.yawRate += (desiredYawRate - this.yawRate) * gravelManeuver;
    this.yawRate = Math.max(-GT3_MAX_YAW_RATE, Math.min(GT3_MAX_YAW_RATE, this.yawRate));
    this.angle += this.yawRate;

    // Temperatura e desgaste: travar, deslizar e abusar da zebra superaquecem os pneus.
    const tyreWork = Math.abs(latVel) * 15 + throttleInput * speed * 3 + this.brakePressure * 9 + this.rearSlip * 18;
    const cooling = (wetTrack ? 0.055 : 0.020) * (this.tyreTemp - targetTyreTemp);
    this.tyreTemp = Math.max(35, Math.min(145, this.tyreTemp + tyreWork * 0.028 - cooling));
    this.tyreWear = Math.min(1, this.tyreWear + (tyreWork * (wetTrack ? 0.000012 : 0.000020)));
    this.brakeTemp = Math.max(90, Math.min(950, this.brakeTemp + this.brakePressure * speed * 18 - (this.brakeTemp - 160) * 0.012));

    if ((this.rearSlip > GT3_TC_SLIP_LIMIT || Math.abs(latVel) > lateralCapacity * 3.5) && speed > 0.22) {
      this.physicsState = this.rearSlip > GT3_TC_SLIP_LIMIT ? 'OVERSTEER' : 'UNDERSTEER';

      // Partículas apenas para o jogador humano ou 1 em cada 4 frames para bots (performance)
      const emitParticle = !this.isBot || (Math.random() < 0.25);
      if (emitParticle) {
        if (this.currentSurface === 'GRAVEL') {
          particles.push(new Particle(
            this.x - headingX * 2.2, this.y - headingY * 2.2,
            (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3,
            '#8a7752', 18, 0.4
          ));
        } else {
          particles.push(new Particle(
            this.x - headingX * 2.0, this.y - headingY * 2.0,
            (Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1,
            '#dcdcdc', 14, 0.3
          ));
        }
      }

      // Skidmarks apenas para jogador ou bots próximos (performance)
      if (!this.isBot || Math.random() < 0.3) {
        skidMarks.push({
          x: this.x - headingX * 1.5, y: this.y - headingY * 1.5,
          life: 180, opacity: (this.currentSurface === 'GRAVEL' ? 0.6 : 0.4)
        });
      }

    } else {
      this.physicsState = 'NORMAL';
    }

    // Faíscas de titânio do assoalho em alta velocidade nas retas ou compressões
    if (speedKmh > 270 && Math.random() < 0.25) {
      particles.push(new SparkParticle(this.x - headingX * 2.6, this.y - headingY * 2.6, -headingX * 0.4, -headingY * 0.4));
    }

    // INÉRCIA ALTA NO ASFALTO (drag = 0.9975 -> Rola livremente aproveitando todo o embalo!)
    let drag = 0.9975;
    drag += boostCoast * (BOOST_TUNING.coastRollingDrag - drag);
    if (this.currentSurface === 'KERB') drag = 0.993;
    if (this.currentSurface === 'RUNOFF') drag = 0.989;
    if (this.currentSurface === 'GRAVEL') drag = GRAVEL_HANDLING.lowSpeedDrag
      + (GRAVEL_HANDLING.highSpeedDrag - GRAVEL_HANDLING.lowSpeedDrag)
      * Math.min(1, speed / GRAVEL_HANDLING.dragBlendSpeed);

    this.vx *= drag; this.vy *= drag;
    this.x += this.vx; this.y += this.vy;

    // Cronometragem
    if (!this.isBot && !this.finished) {
      let now = performance.now();
      if (this.raceStartTime === 0) this.raceStartTime = now;
      if (this.lapStartTime === 0) this.lapStartTime = now;

      this.currentLapTime = (now - this.lapStartTime) / 1000;
      this.totalRaceTime = (now - this.raceStartTime) / 1000;

      if (gameMode === 'ghost') {
        const frame = { x: Math.round(this.x * 10) / 10, y: Math.round(this.y * 10) / 10, a: Math.round(this.angle * 100) / 100 };
        state.currentLapPath.push(frame); state.currentRacePath.push(frame);
      }
    }

    this.updateCheckpoints();
  }

  getKmh() { return Math.round((Math.hypot(this.vx, this.vy) / MAX_INTERNAL_SPEED) * MAX_SPEED_KMH); }

  updateCheckpoints() {
    if (this.finished) return;

    const { trackPath, totalLaps, selectedTrack, gameMode, finishedCarsOrder } = state;
    if (!trackPath || trackPath.length === 0) return;

    const totalPoints = trackPath.length;
    const cpInterval = Math.floor(totalPoints / NUM_CHECKPOINTS);

    let targetPointIdx = (this.nextCheckpoint * cpInterval) % totalPoints;
    let cpPoint = trackPath[targetPointIdx];
    let distToCp = Math.hypot(cpPoint.x - this.x, cpPoint.y - this.y);

    if (distToCp < 28) {
      // === REINFORCEMENT LEARNING: Atualizar Modelo de Aprendizado do Bot ===
      if (this.isBot && this.brain) {
        const speed = Math.hypot(this.vx, this.vy);
        const isGravel = (this.currentSurface === 'GRAVEL');
        this.brain.onCheckpointCrossed(this.nextCheckpoint, speed, this.rank, isGravel);
      }

      if (this.nextCheckpoint === 0) {
        if (!this.isBot) {
          state.onPlayerLapCompleted?.(this);
          if (state.bestLapTime === null || this.currentLapTime < state.bestLapTime) {
            state.bestLapTime = this.currentLapTime;
            if (gameMode === 'ghost') state.bestLapPath = [...state.currentLapPath];
            try {
              localStorage.setItem(`cr_f1_t${selectedTrack}_l${totalLaps}_best_lap_time`, state.bestLapTime.toString());
              if (gameMode === 'ghost') localStorage.setItem(`cr_f1_t${selectedTrack}_l${totalLaps}_best_lap_path`, JSON.stringify(state.bestLapPath));
            } catch (e) { }
          }
          state.currentLapPath = []; state.ghostLapFrameIndex = 0;
          this.lapStartTime = performance.now();
        }

        this.currentLap++;
        this.nextCheckpoint = 1;

        if (this.currentLap > totalLaps) {
          this.finished = true;
          this.totalRaceTime = (performance.now() - this.raceStartTime) / 1000;
          finishedCarsOrder.push(this);

          if (!this.isBot) {
            if (state.bestRaceTime === null || this.totalRaceTime < state.bestRaceTime) {
              state.bestRaceTime = this.totalRaceTime;
              if (gameMode === 'ghost') state.bestRacePath = [...state.currentRacePath];
              try {
                localStorage.setItem(`cr_f1_t${selectedTrack}_l${totalLaps}_best_race_time`, state.bestRaceTime.toString());
                if (gameMode === 'ghost') localStorage.setItem(`cr_f1_t${selectedTrack}_l${totalLaps}_best_race_path`, JSON.stringify(state.bestRacePath));
              } catch (e) { }
            }
          }
          state.startFinishTimer();
        }
      } else {
        this.nextCheckpoint = (this.nextCheckpoint + 1) % NUM_CHECKPOINTS;
      }
    }

    this.progress = (this.currentLap * 1000000) + (this.nextCheckpoint * 50000) - distToCp;
  }

  draw(pose = this) {
    drawCarAppearance(ctx, this, pose);
  }
}
