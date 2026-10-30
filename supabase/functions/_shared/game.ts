// Shared game constants and formulas (PLAN.md §6).
// Pure TS: no Deno/DOM APIs, no URL imports. Mirrored in SQL (0002_game_constants.sql).

// ---- World ----
export const WORLD_SIZE = 6000;
export const START_MASS = 20;

export const radius = (m: number): number => 10 * Math.sqrt(m);
/** Movement speed in px/s. */
export const speed = (m: number): number => Math.max(50, 600 * Math.pow(m, -0.35));

// ---- Pellets ----
export const PELLET_MASS = 1;
export const PELLET_RADIUS = 6; // rendering + eat tolerance
export const PELLET_TARGET = 1200;
export const PELLET_MAX_PER_TICK = 150;

// ---- Eating ----
export const EAT_RATIO = 1.25;
export const EAT_OVERLAP = 0.35; // eater must cover: dist <= rEater - EAT_OVERLAP * rVictim

export const canEat = (eaterMass: number, victimMass: number): boolean =>
  eaterMass >= EAT_RATIO * victimMass;

export const eatOverlapOk = (dist: number, rEater: number, rVictim: number): boolean =>
  dist <= rEater - EAT_OVERLAP * rVictim;

// ---- Splitting / merging ----
export const MIN_SPLIT_MASS = 36;
export const MAX_CELLS = 16;
export const SPLIT_SPEED = 900; // px/s initial launch velocity
export const SPLIT_DECAY = 6; // v *= exp(-SPLIT_DECAY * dt)

/** Seconds before a split cell of mass m may re-merge. */
export const mergeDelay = (m: number): number => 12 + 0.02 * m;

// ---- Ejecting ----
export const EJECT_MIN_MASS = 35;
export const EJECT_COST = 16;
export const EJECT_MASS = 12;
export const EJECT_DISTANCE = 420;

// ---- Decay / caps ----
export const DECAY_THRESHOLD = 150;
export const DECAY_RATE = 0.002; // fraction of mass lost per second above threshold
export const MAX_CELL_MASS = 20000;

// ---- Thorns ----
export const THORN_COUNT = 25;
export const THORN_MASS = 100;
export const THORN_BURST_RATIO = 1.3; // cell mass must exceed THORN_BURST_RATIO * THORN_MASS

// ---- Blooms (Petri twist) ----
export const BLOOM_COUNT = 3;
export const BLOOM_RADIUS = 300;
export const BLOOM_FRACTION = 0.4;

// ---- Networking ----
export const NET_STATE_HZ = 15;
export const NET_SYNC_HZ = 10;
export const INTERP_DELAY_MS = 100;
export const STALE_PLAYER_S = 5;

/**
 * Max plausible displacement (px) of a cell over dt seconds.
 * 1.3 * speed * dt + 40 px, plus the split launch allowance if the cell is < 1 s old.
 */
export const posTolerance = (mass: number, dt: number, cellAgeS: number): number =>
  1.3 * speed(mass) * dt + 40 + (cellAgeS < 1 ? SPLIT_SPEED * 0.6 : 0);

// ---- Camera ----
export const ZOOM_MIN = 0.15;
export const ZOOM_MAX = 1.2;

export const zoom = (totalRadius: number): number => {
  const z = 1 / (0.3 + Math.sqrt(totalRadius) / 25);
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
};

// ---- Colours (microscope-stain palette) ----
export const PALETTE: readonly string[] = [
  "#e0457b", // eosin pink
  "#b5338a", // magenta stain
  "#7b4fd1", // gentian violet
  "#4a6cf7", // methylene blue
  "#2fa4e7", // cyan dye
  "#1fc2b0", // malachite teal
  "#3fcf6e", // fast green
  "#9be03a", // chlorophyll
  "#f2d43d", // safranin yellow
  "#f59a2b", // orange G
  "#ef5b3a", // carmine
  "#c9a0ff", // pale lilac
];

/** Deterministic palette colour for a pellet id (Knuth multiplicative hash). */
export const pelletColor = (id: number): string => {
  const h = Math.imul(Math.floor(id) | 0, 2654435761) >>> 0;
  return PALETTE[h % PALETTE.length];
};
