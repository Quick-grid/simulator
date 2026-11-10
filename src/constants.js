// ========== GT3 REAL-SCALE CONSTANTS (METRIC 1:1 SYSTEM) ==========
// 1 unidade = 1 metro do mundo real

import { TELEMETRY_LINEAGE_VERSIONS } from './ml/lineage/baselineManifest.js';

// Referência de conversão e dos perfis de pista; não é o limitador do motor.
export const MAX_SPEED_KMH = 285;
export const MAX_INTERNAL_SPEED = 1.35;
export const GT3_TOP_SPEED = MAX_INTERNAL_SPEED * 320 / MAX_SPEED_KMH;
export const GRAVEL_HANDLING = Object.freeze({ lowSpeedDrag: 0.985, highSpeedDrag: 0.88,
  dragBlendSpeed: 0.5, maneuverSpeed: 0.18, extraSteer: 0.35 });
export const TRACK_WIDTH = 24;          // 24 metros de largura média FIA ampliada
export const NUM_CHECKPOINTS = 16;       // Checkpoints para circuitos de 4 a 7 km
export const BOT_DRIVER_MODE = {
  DETERMINISTIC: 'DETERMINISTIC', // Controlador GT3 determinístico ativo
  LEGACY: 'LEGACY',              // Controlador anterior, selecionável antes da largada
  ML_SHADOW: 'ML_SHADOW',         // Modo Sombra: ML avalia o estado em paralelo sem assumir controle
  ML: 'ML'                        // Modo ML Ativo: ML atua nos comandos com fallback determinístico
};

// ========== ML VERSION METADATA (FASE ML2.0 DATA LINEAGE) ==========
export const TELEMETRY_VERSIONS = TELEMETRY_LINEAGE_VERSIONS;

// Janela de desempenho GT3: slicks, downforce moderado e ajudas permitidas.
// As unidades são metros/frame²; a simulação usa 60 FPS fixos.
export const FORCA_TRACAO = 0.045;
export const RESISTENCIA_AR = 0.00105;
// Entrega de torque mais progressiva, típica de um GT3 com controle de tração.
export const TAXA_SUAVIZACAO_ACEL = 0.028;
export const TAXA_SUAVIZACAO_FREIO = 0.12;
export const FORCA_FREIO_MAX = 0.020;
export const GT3_WHEELBASE = 2.70;
export const GT3_BASE_GRIP = 0.047;
export const GT3_AERO_GRIP = 0.030;
// Eixo traseiro chega ao limite antes da frente em curvas exigentes.
export const GT3_REAR_LATERAL_DEMAND = 0.60;
export const GT3_REAR_SLIDE_GRIP_LOSS = 0.45;
export const GT3_OVERSTEER_GAIN = 0.035;
export const GT3_YAW_RECOVERY_LOSS = 0.65;
export const GT3_MAX_YAW_RATE = 0.10;
export const DRIFT_CONTROL = Object.freeze({ slipWindow: 0.25, fadeAngle: 1.05,
  fadeRange: 0.4, yawResponse: 0.16, oversteerRelief: 0.65 });
export const GT3_TC_SLIP_LIMIT = 0.105;
export const GT3_ABS_SLIP_LIMIT = 0.165;

// Esterço Progressivo GT3
export const VELOCIDADE_ESTERCO_BASE = 0.8;
export const TAXA_ESTERCO_SUBIDA = 0.1;
export const TAXA_ESTERCO_RETORNO = 0.12;

// Potência e cinco primeiras relações preservadas; sexta alongada para 320 km/h.
export const GEAR_SPEEDS = [0, 0.25, 0.46, 0.68, 0.90, 1.13, 1.72];
export const GEAR_POWER = [0, 0.028, 0.024, 0.021, 0.018, 0.016, 0.014];

// Pilotos Adversários da F1 / GT3 com Capacidades e Cores Reais (Grid Completo de 20 Pilotos)
export const BOT_CONFIGS = [
  { pilotId: 'senna', color: '#ffd700', name: 'A. Senna' },
  { pilotId: 'verstappen', color: '#3388ff', name: 'M. Verstappen' },
  { pilotId: 'hamilton', color: '#ff33ff', name: 'L. Hamilton' },
  { pilotId: 'leclerc', color: '#e10600', name: 'C. Leclerc' },
  { pilotId: 'alonso', color: '#00e5ff', name: 'F. Alonso' },
  { pilotId: 'norris', color: '#ff8000', name: 'L. Norris' },
  { pilotId: 'russell', color: '#00d2be', name: 'G. Russell' },
  { pilotId: 'sainz', color: '#ff3b30', name: 'C. Sainz' },
  { pilotId: 'piastri', color: '#ff9500', name: 'O. Piastri' },
  { pilotId: 'perez', color: '#005aff', name: 'S. Perez' },
  { pilotId: 'gasly', color: '#2b7fff', name: 'P. Gasly' },
  { pilotId: 'ocon', color: '#ff69b4', name: 'E. Ocon' },
  { pilotId: 'tsunoda', color: '#5ac8fa', name: 'Y. Tsunoda' },
  { pilotId: 'albon', color: '#00a3e0', name: 'A. Albon' },
  { pilotId: 'bottas', color: '#34c759', name: 'V. Bottas' },
  { pilotId: 'hulkenberg', color: '#af52de', name: 'N. Hulkenberg' },
  { pilotId: 'stroll', color: '#5856d6', name: 'L. Stroll' },
  { pilotId: 'ricciardo', color: '#ffcc00', name: 'D. Ricciardo' },
  { pilotId: 'schumacher', color: '#ff2d55', name: 'M. Schumacher' },
  { pilotId: 'prost', color: '#007aff', name: 'A. Prost' }
];
