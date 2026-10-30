// Wire/row types for the client (PLAN.md §7–9).
// Hand-written minimal shapes; swap for generated `db.types.ts` once it exists.
// DOM-free: imported by bots under Node.

export type Id = number; // bigint ids arrive as JSON numbers

/** Value accepted as a timestamp from the server: epoch ms (number) or ISO string. */
export type TimeLike = number | string | null | undefined;

// ---- REST rows ----
export interface PelletRow {
  id: Id;
  room_id?: string;
  kind: "food" | "ejecta" | "thorn";
  x: number;
  y: number;
  mass: number;
}

export interface PlayerRow {
  id: string;
  room_id?: string;
  name: string;
  color: string;
  skin: string | null;
  status?: "alive" | "dead" | "left";
}

export interface CellRow {
  id: Id;
  player_id: string;
  x: number;
  y: number;
  mass: number;
  merge_after?: TimeLike;
  created_at?: TimeLike;
}

export interface RoomListRow {
  id: string;
  name: string;
  max_players: number;
  player_count: number;
}

export interface TopScoreRow {
  name: string;
  peak_mass: number;
  kills: number;
  survived_seconds: number;
  created_at: string;
}

// ---- Edge function `join` → spawn_player (§8) ----
export interface JoinResult {
  player_id: string;
  room_id: string;
  world_size: number;
  color: string;
  /** Sanitised name / validated skin as stored by spawn_player (optional). */
  name?: string;
  skin?: string | null;
  cell: { id: Id; x: number; y: number; mass: number; merge_after?: TimeLike; born?: TimeLike };
}

// ---- RPC returns (§8) ----
export interface ServerCell {
  id: Id;
  x: number;
  y: number;
  mass: number;
  merge_after?: TimeLike;
  born?: TimeLike;
  /** split(): id of the cell this one was split from. */
  parent?: Id;
}

export interface SyncResponse {
  status: "alive" | "dead" | "left" | string;
  cells: ServerCell[];
  corrections: Id[];
}

export interface SplitResponse {
  cells: ServerCell[];
  dir?: [number, number] | { x: number; y: number } | null;
}

export interface EjectResponse {
  cells: { id: Id; mass: number }[];
}

export type EatCellResponse = { ok: true; eater_mass: number } | { ok: false; reason?: string };

export interface MergeResponse {
  ok: boolean;
  cell?: ServerCell;
  reason?: string;
}

// ---- Realtime payloads (§9) ----
/** [cellId, x, y, mass] */
export type CellTuple = [Id, number, number, number];

export interface StatePayload {
  p: string;
  t: number;
  c: CellTuple[];
}

export interface PresenceMeta {
  player_id: string;
  name: string;
  color: string;
  skin: string | null;
}

export interface PelletsSpawnedPayload {
  p: [Id, number, number, number, PelletRow["kind"]][];
}
export interface PelletsEatenPayload {
  ids: Id[];
  by: string;
}
export interface EjectedPayload {
  id: Id;
  from: [number, number];
  to: [number, number];
  mass: number;
  by: string;
}
export interface CellEatenPayload {
  eater_cell: Id;
  eater_player: string;
  eater_mass: number;
  victim_cell: Id;
  victim_player: string;
}
export interface PlayerDiedPayload {
  player_id: string;
  killer_id: string | null;
  killer_name: string | null;
  peak_mass: number;
  kills: number;
  survived_seconds: number;
}
export interface PlayerLeftPayload {
  player_id: string;
}
export interface LeaderboardPayload {
  top: [string, string, number][];
}
export interface BloomsPayload {
  b: [number, number][];
}

/** Parse a server timestamp (epoch ms, epoch seconds, or ISO string) to epoch ms. */
export function toMs(v: TimeLike, fallback = 0): number {
  if (v == null) return fallback;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return fallback;
    return v < 1e11 ? v * 1000 : v; // seconds vs ms heuristic
  }
  const n = Number(v);
  if (v.trim() !== "" && Number.isFinite(n)) return toMs(n, fallback);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : fallback;
}
