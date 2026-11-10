import { canvas, ctx } from './canvas.js';
import { BOT_CONFIGS } from './constants.js';
import { racePosition } from './ai/gt3Driver.js';
import { F1_TRACKS } from './f1Tracks.js';
import { Car } from './car.js';
import { generateTrackPath, drawTrack } from './track.js';
import { updateHUD, showVictoryScreen, drawGhosts } from './ui.js';
import { mainCamera } from './camera.js';
import { drawMinimap } from './minimap.js';
import { fetchTrackRecords, saveTrackRecords } from './api.js';
import { drawBotDebugOverlay } from './ai.js';
import { mlTelemetry, mlTelemetryV3, onlineUploader, telemetryPerformance } from './ml/telemetry/index.js';
import { getRenderBounds, withinRenderBounds } from './renderGeometry.js';
import { raceStart, renderStartLights } from './raceStart.js';
import { getCarSprite } from './carAppearance.js';
import { renderPoses } from './renderPose.js';
import { normalizeLaps, normalizeBots, excludePauseTime } from './raceSettings.js';
import { updateAerodynamicWake } from './aerodynamics.js';
import { getPilotName } from './auth.js';

// ========== SHARED GAME STATE ==========
export const state = {
  keys: {},
  cars: [],
  botField: null,
  finishedCarsOrder: [],
  trackPath: [],
  rawWaypoints: [],
  particles: [],
  skidMarks: [],
  floatingNotices: [],
  totalLaps: 3,
  selectedTrack: 21, // Padrão: Interlagos, Brasil 🇧🇷
  selectedTrackData: F1_TRACKS.find(t => t.id === 21) || F1_TRACKS[0],
  botDifficulty: 'pro',
  isRunning: false,
  isPaused: false,
  pausedAt: null,
  racePhase: 'idle',
  raceFinished: false,
  gameMode: 'race',
  transmissionMode: 'auto',
  trackCondition: 'dry',
  onlineSession: null,

  bestLapTime: null,
  bestLapPath: [],
  currentLapPath: [],
  ghostLapFrameIndex: 0,
  bestRaceTime: null,
  bestRacePath: [],
  currentRacePath: [],
  ghostRaceFrameIndex: 0,

  timerSeconds: 45,
  timerInterval: null,
  firstFinishedCar: false,
  onPlayerLapCompleted(car) { mlTelemetry.recordCompletedLap(car); },

  startFinishTimer() {
    if (!this.firstFinishedCar && this.gameMode !== 'ghost') {
      this.firstFinishedCar = true;
      this.timerSeconds = 45;
      this.finishDeadline = performance.now() + 45000;
      if (typeof document !== 'undefined') {
        const timerBox = document.getElementById('timer-box');
        if (timerBox) {
          timerBox.style.display = 'block';
          timerBox.innerText = `⏱️ TEMPO RESTANTE: ${this.timerSeconds}s`;
        }
      }

      this.timerInterval = setInterval(() => {
        if (this.isPaused || !this.isRunning) return;
        this.timerSeconds = Math.max(0, Math.ceil((this.finishDeadline - performance.now()) / 1000));
        if (typeof document !== 'undefined') {
          const timerBox = document.getElementById('timer-box');
          if (timerBox) {
            timerBox.innerText = `⏱️ TEMPO RESTANTE: ${this.timerSeconds}s`;
          }
        }
        if (this.timerSeconds <= 0) {
          clearInterval(this.timerInterval); this.timerInterval = null;
          finishRaceByTimeout();
        }
      }, 1000);
    }
  }
};

// ========== RECORDS & BACKEND SYNC ==========
async function loadRecords(trackId, laps) {
  state.bestLapTime = null; state.bestLapPath = [];
  state.bestRaceTime = null; state.bestRacePath = [];

  // Tentar buscar do backend
  const backendData = await fetchTrackRecords(trackId, laps);
  if (backendData && (backendData.bestLapTime || backendData.bestRaceTime)) {
    if (backendData.bestLapTime) {
      state.bestLapTime = backendData.bestLapTime;
      state.bestLapPath = backendData.bestLapPath || [];
    }
    if (backendData.bestRaceTime) {
      state.bestRaceTime = backendData.bestRaceTime;
      state.bestRacePath = backendData.bestRacePath || [];
    }
    return;
  }

  // Fallback no localStorage
  try {
    const sLapTime = localStorage.getItem(`cr_f1_t${trackId}_l${laps}_best_lap_time`);
    const sLapPath = localStorage.getItem(`cr_f1_t${trackId}_l${laps}_best_lap_path`);
    const sRaceTime = localStorage.getItem(`cr_f1_t${trackId}_l${laps}_best_race_time`);
    const sRacePath = localStorage.getItem(`cr_f1_t${trackId}_l${laps}_best_race_path`);
    if (Number(sLapTime) > 0 && Number.isFinite(Number(sLapTime))) state.bestLapTime = Number(sLapTime);
    if (Number(sRaceTime) > 0 && Number.isFinite(Number(sRaceTime))) state.bestRaceTime = Number(sRaceTime);
    try { state.bestLapPath = sLapPath ? JSON.parse(sLapPath) : []; } catch {}
    try { state.bestRacePath = sRacePath ? JSON.parse(sRacePath) : []; } catch {}
  } catch (e) { }
}

export function syncRecordToBackend() {
  saveTrackRecords({
    trackId: state.selectedTrack,
    laps: state.totalLaps,
    bestLapTime: state.bestLapTime,
    bestLapPath: state.bestLapPath,
    bestRaceTime: state.bestRaceTime,
    bestRacePath: state.bestRacePath,
    playerName: state.cars[0] ? state.cars[0].name : 'Piloto'
  });
}

function finishPilotRuns(reason) {
  for (const car of state.cars) car.brain?.run?.finish(reason);
}

export function integrateOfflineCars() {
  updateAerodynamicWake(state.cars);
  state.botField = state.cars.some(car => car.brain?.driver === 'gt3')
    ? state.cars.map(car => racePosition(car, state.trackPath)) : null;
  try {
    state.cars.forEach(car => car.update());
  } finally {
    state.botField = null;
  }
}

// ========== COLLISIONS ==========
export function handleCarCollisions() {
  if (state.gameMode === 'ghost') return;
  for (let i = 0; i < state.cars.length; i++) {
    for (let j = i + 1; j < state.cars.length; j++) {
      let c1 = state.cars[i], c2 = state.cars[j];
      let dx = c2.x - c1.x, dy = c2.y - c1.y, dist = Math.hypot(dx, dy);
      let minDist = c1.radius + c2.radius;

      if (dist < minDist && dist > 0) {
        if (!c1.finished || c1.brain?.pendingCheckpoint === 0) c1.brain?.run?.contact();
        if (!c2.finished || c2.brain?.pendingCheckpoint === 0) c2.brain?.run?.contact();
        let nx = dx / dist, ny = dy / dist, overlap = minDist - dist;
        c1.x -= nx * overlap * 0.5; c1.y -= ny * overlap * 0.5;
        c2.x += nx * overlap * 0.5; c2.y += ny * overlap * 0.5;

        // Impulso inelástico: preserva parte do momento sem transformar contato em "pinball".
        let rvx = c2.vx - c1.vx, rvy = c2.vy - c1.vy;
        let normalSpeed = rvx * nx + rvy * ny;
        if (normalSpeed < 0) {
          const restitution = 0.18;
          const impulse = -(1 + restitution) * normalSpeed * 0.5;
          c1.vx -= impulse * nx; c1.vy -= impulse * ny;
          c2.vx += impulse * nx; c2.vy += impulse * ny;
          const impactYaw = impulse * 0.08;
          c1.yawRate -= impactYaw * ((nx * Math.sin(c1.angle)) - (ny * Math.cos(c1.angle)));
          c2.yawRate += impactYaw * ((nx * Math.sin(c2.angle)) - (ny * Math.cos(c2.angle)));
        }
      }
    }
  }
}

function updateRanks() {
  let sorted = [...state.cars].sort((a, b) => b.progress - a.progress);
  sorted.forEach((car, index) => car.rank = index + 1);
}

function checkRaceEnd() {
  if (state.cars.every(c => c.finished) && !state.raceFinished) {
    if (state.timerInterval) clearInterval(state.timerInterval);
    state.raceFinished = true;
    if (mlTelemetry.enabled) mlTelemetry.stop();
    if (mlTelemetryV3.enabled) mlTelemetryV3.stop();
    finishPilotRuns('completed');
    syncRecordToBackend();
    showVictoryScreen();
  }
}

function finishRaceByTimeout() {
  if (!state.raceFinished) {
    state.raceFinished = true;
    if (mlTelemetry.enabled) mlTelemetry.stop();
    if (mlTelemetryV3.enabled) mlTelemetryV3.stop();
    state.cars.forEach(car => {
      if (!car.finished) {
        car.finished = true;
        state.finishedCarsOrder.push(car);
      }
    });
    finishPilotRuns('timeout');
    syncRecordToBackend();
    showVictoryScreen();
  }
}

// ========== RESIZE ==========
export function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  if (state.isRunning && state.isPaused) gameLoop(performance.now(), true);
}

// ========== MENU ACTIONS ==========
export function toggleModeUI() {
  const mode = document.getElementById('gameMode').value;
  document.getElementById('botOptionsGroup').style.display = mode === 'ghost' ? 'none' : 'block';
}

export function clearRecords() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('cr_f1_')) localStorage.removeItem(key);
    }
    state.bestLapTime = null; state.bestLapPath = [];
    state.bestRaceTime = null; state.bestRacePath = [];
    window.dispatchEvent(new Event('quick-grid:records-cleared'));
  } catch (e) { }
}

export function backToMenu() {
  cancelAnimationFrame(animationFrameId);
  finishPilotRuns('menu');
  animationFrameId = null;
  renderPoses.reset();
  raceStart.reset();
  renderStartLights();
  state.racePhase = 'idle';
  state.isPaused = false;
  state.pausedAt = null;
  state.keys = {};
  state.finishDeadline = null;
  if (mlTelemetry.enabled) mlTelemetry.stop();
  if (mlTelemetryV3.enabled) mlTelemetryV3.stop();
  if (state.timerInterval) clearInterval(state.timerInterval);
  document.getElementById('timer-box').style.display = 'none';
  physicsAccumulator = 0;
  lastFrameTime = performance.now();
  document.getElementById('shift-alert').style.display = 'none';
  document.getElementById('physics-alert').style.display = 'none';
  document.getElementById('win-screen').style.display = 'none';
  document.getElementById('menu').style.display = 'block';
  state.isRunning = false;
  state.onlineSession = null;
  document.getElementById('race-shortcuts').hidden = true;
  window.dispatchEvent(new Event('quick-grid:menu'));
}

export function pauseGame(now = performance.now()) {
  if (state.onlineSession) { state.keys = {}; state.onlineSession.menu(); return false; }
  if (!state.isRunning || state.isPaused || state.raceFinished) return false;
  state.isPaused = true; state.pausedAt = now; state.keys = {};
  for (const car of state.cars) car.boostActive = false;
  cancelAnimationFrame(animationFrameId); animationFrameId = null;
  return true;
}

export function resumeGame(now = performance.now()) {
  if (!state.isRunning || !state.isPaused) return false;
  const elapsed = Math.max(0, now - state.pausedAt);
  excludePauseTime(state, raceStart, mlTelemetry, elapsed);
  if (mlTelemetryV3.lastSampleTime > 0) mlTelemetryV3.lastSampleTime += elapsed;
  state.isPaused = false; state.pausedAt = null; state.keys = {};
  lastFrameTime = now;
  telemetryPerformance.lastFrameTimestamp = null;
  animationFrameId = requestAnimationFrame(gameLoop);
  return true;
}

let lastRaceSettings;
export async function restartGame() {
  if (state.onlineSession) { state.onlineSession.menu(); return; }
  if (!lastRaceSettings) return;
  const settings = { ...lastRaceSettings };
  backToMenu();
  document.getElementById('menu').style.display = 'none';
  await startGame(settings);
}

export async function startGame(settings) {
  if (state.isRunning || state.racePhase === 'loading') return;
  state.racePhase = 'loading';
  try {
    state.onlineSession = settings?.onlineSession || null;
    const value = id => settings?.[id] ?? document.getElementById(id).value;
    state.gameMode = value('gameMode');
    state.transmissionMode = value('transMode');
    state.trackCondition = value('trackCondition');
    state.selectedTrack = parseInt(value('trackSelect'));
    state.totalLaps = normalizeLaps(value('lapCount'));
    document.getElementById('lapCount').value = state.totalLaps;
    state.botDifficulty = value('botDifficulty');
    lastRaceSettings = Object.fromEntries(['gameMode', 'transMode', 'trackCondition', 'trackSelect', 'botDifficulty', 'botCount'].map(id => [id, value(id)]));
    lastRaceSettings.lapCount = state.totalLaps;
    state.isPaused = false; state.pausedAt = null; state.keys = {}; state.finishDeadline = null;

    resizeCanvas();
    generateTrackPath(state.selectedTrack);
    if (!state.onlineSession) await loadRecords(state.selectedTrack, state.totalLaps);

    state.cars = []; state.particles = []; state.skidMarks = []; state.floatingNotices = [];
    renderPoses.reset();
    state.finishedCarsOrder = [];
    state.raceFinished = false;
    state.firstFinishedCar = false;

    state.currentLapPath = []; state.currentRacePath = [];
    state.ghostLapFrameIndex = 0; state.ghostRaceFrameIndex = 0;

    if (state.timerInterval) clearInterval(state.timerInterval);
    document.getElementById('timer-box').style.display = 'none';

    const numBots = (state.gameMode === 'race') ? normalizeBots(value('botCount')) : 0;

    // Carro do Jogador (P1): posicionado no ÚLTIMO slot do grid (index = numBots)
    if (state.onlineSession) {
      const session = state.onlineSession;
      const grid = session.players.map((p, slot) => {
        const car = new Car(p.color, p.name, false, slot, p.auto); car.id = p.id; return car;
      });
      state.cars = [grid.find(c => c.id === session.id), ...grid.filter(c => c.id !== session.id)];
    } else state.cars.push(new Car('#ff2222', getPilotName(), false, numBots, state.transmissionMode === 'auto'));

    // Bots / Adversários: posicionados nos slots 0 até numBots - 1 (à frente do jogador)
    if (state.gameMode === 'race' && !state.onlineSession) {
      for (let i = 0; i < numBots; i++) {
        const bCfg = BOT_CONFIGS[i % BOT_CONFIGS.length];
        const botCar = new Car(bCfg.color, bCfg.name, true, i, true);
        botCar.brain.startPilotRun(bCfg.pilotId, {
          trackId: state.selectedTrack, condition: state.trackCondition, difficulty: state.botDifficulty
        });
        state.cars.push(botCar);
      }
    }

    // Centralizar câmera imediatamente no jogador (P1)
    if (state.cars.length > 0) {
      mainCamera.x = state.cars[0].x;
      mainCamera.y = state.cars[0].y;
    }

    document.getElementById('menu').style.display = 'none';
    // Build body artwork while preparing the grid, not at the first racing frame.
    state.cars.forEach(getCarSprite);
    cancelAnimationFrame(animationFrameId);
    physicsAccumulator = 0;
    lastFrameTime = performance.now();
    if (state.onlineSession) { raceStart.reset(); state.racePhase = 'loading'; }
    else { raceStart.begin(lastFrameTime); state.racePhase = 'countdown'; }
    state.isRunning = true;
    document.getElementById('race-shortcuts').hidden = false;
    gameLoop();
  } catch (error) {
    backToMenu();
    throw error;
  }
}

// ========== GAME LOOP ==========
let lastFrameTime = performance.now();
let physicsAccumulator = 0;
let animationFrameId = null;
const PHYSICS_STEP_MS = 1000 / 60;

function gameLoop(now = performance.now(), presentPaused = false) {
  animationFrameId = null;
  if (!state.isRunning || (state.isPaused && !presentPaused)) return;
  const frameStart = performance.now();
  const online = state.onlineSession;
  if (online) online.frame(now);

  if (!online && state.racePhase === 'countdown' && !state.isPaused) {
    if (!document.hidden && raceStart.update(now)) {
      state.racePhase = 'racing';
      for (const car of state.cars) {
        car.raceStartTime = now;
        car.lapStartTime = now;
        if (car.brain) car.brain.sectorEntryTime = now;
      }
      if (onlineUploader.consentEnabled) mlTelemetry.start({ trackId: state.selectedTrack, scope: 'PLAYER_ONLY', onlineOnly: true });
    }
    // No pre-start driving, tyre work, collisions, timing or catch-up burst at lights-out.
    physicsAccumulator = 0;
    lastFrameTime = now;
  }
  const racing = state.racePhase === 'racing' && !state.isPaused;
  renderStartLights(raceStart, state.isPaused ? state.pausedAt : now);

  // Física fixa a 60 Hz: o carro tem a mesma resposta em telas de 60, 120 ou 144 Hz.
  if (racing && !online) physicsAccumulator += Math.min(100, now - lastFrameTime);
  lastFrameTime = now;
  let physicsTickTime = now - physicsAccumulator; // Timestamp do início dos ticks acumulados
  while (physicsAccumulator >= PHYSICS_STEP_MS) {
    // Capture ALL cars before advancing any of them; collisions still run on
    // the authoritative positions, never on the interpolated presentation.
    state.cars.forEach(car => renderPoses.capture(car));
    integrateOfflineCars();
    handleCarCollisions();
    for (const car of state.cars) car.brain?.finishPilotTick();
    physicsAccumulator -= PHYSICS_STEP_MS;
    physicsTickTime += PHYSICS_STEP_MS;
    // Capturar telemetria DENTRO do tick físico: state(t) e action(t) são do mesmo frame.
    // lastThrottleInput/lastBrakeInput/lastSteerInput são gravados NESTE update (sem atraso de frame).
    const collectorStart = performance.now();
    mlTelemetry.update(physicsTickTime, state);
    mlTelemetryV3.update(physicsTickTime, state);
    telemetryPerformance.recordCollector(performance.now() - collectorStart);
  }
  if (racing && !online) updateRanks();

  const playerCar = state.cars[0];
  const renderAlpha = physicsAccumulator / PHYSICS_STEP_MS;
  const samplePose = car => online ? online.samplePose(car, now) : renderPoses.sample(car, renderAlpha);
  if (!state.isPaused) mainCamera.update(samplePose(playerCar), canvas);

  // 2. Limpar Tela
  ctx.fillStyle = '#060a08';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 3. Renderizar Espaço de Mundo (Com transformações da Câmera)
  mainCamera.apply(ctx, canvas);

  // Desenhar Pista de Mundo
  drawTrack(canvas);
  const actorBounds = getRenderBounds(mainCamera, canvas, 4);
  const noticeBounds = getRenderBounds(mainCamera, canvas, 50);

  // Marcas de Pneu / Skidmarks (em escala métrica de 0.35m de pneu)
  for (let i = state.skidMarks.length - 1; i >= 0; i--) {
    let sm = state.skidMarks[i];
    if (withinRenderBounds(sm, actorBounds)) {
      ctx.save();
      ctx.globalAlpha = sm.opacity * (sm.life / 180);
      ctx.fillStyle = '#0a0a0a';
      ctx.beginPath(); ctx.arc(sm.x, sm.y, 0.35, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    if (racing) sm.life--;
    if (sm.life <= 0) state.skidMarks.splice(i, 1);
  }

  // Partículas (Fumaça, Brita, Faíscas)
  for (let i = state.particles.length - 1; i >= 0; i--) {
    if (racing) state.particles[i].update();
    if (withinRenderBounds(state.particles[i], actorBounds)) state.particles[i].draw();
    if (state.particles[i].life <= 0) state.particles.splice(i, 1);
  }

  // Avisos flutuantes de Pet / Punição
  for (let i = state.floatingNotices.length - 1; i >= 0; i--) {
    if (racing) state.floatingNotices[i].update();
    if (withinRenderBounds(state.floatingNotices[i], noticeBounds)) state.floatingNotices[i].draw();
    if (state.floatingNotices[i].life <= 0) state.floatingNotices.splice(i, 1);
  }

  // Fantasmas e Carros
  if (state.racePhase === 'racing') drawGhosts(racing);
  state.cars.forEach(car => {
    const pose = samplePose(car);
    if (withinRenderBounds(pose, actorBounds)) car.draw(pose);
  });
  drawBotDebugOverlay(ctx); // Debug overlay (ativo apenas se window.DEBUG_BOT_AI = true)

  mainCamera.restore(ctx);

  // 4. Renderizar Elementos de Tela / HUD Fixos
  drawMinimap(ctx, canvas, state);
  updateHUD();
  if (racing && !online) checkRaceEnd();

  if (!state.isPaused) telemetryPerformance.recordFrame(performance.now() - frameStart, now);

  if (state.isRunning && !state.isPaused) animationFrameId = requestAnimationFrame(gameLoop);
}
