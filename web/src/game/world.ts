// Entity stores for one game session (PLAN.md §13). DOM-free.

import { PALETTE, mergeDelay } from "@shared/game.ts";
import type {
  BloomsPayload,
  CellEatenPayload,
  CellRow,
  EjectedPayload,
  Id,
  JoinResult,
  LeaderboardPayload,
  PelletRow,
  PelletsEatenPayload,
  PelletsSpawnedPayload,
  PlayerRow,
  ServerCell,
  StatePayload,
} from "../types.ts";
import { toMs } from "../types.ts";
import { SnapshotBuffer, type InterpCell } from "./interp.ts";
import type { SimCell } from "./sim.ts";
import { SpatialGrid } from "./spatial.ts";

/** How long ids of removed cells are remembered so late packets can't resurrect them. */
const TOMBSTONE_MS = 3000;
export const EJECT_TWEEN_MS = 300;

export interface OwnCell extends SimCell {
  /** Epoch ms the server says the cell was created. */
  born: number;
  /** Local time the cell was added to the store (reconciliation grace). */
  addedAt: number;
  /** Local time mass was last set from a non-sync source (eat/split/eject/merge). */
  massSetAt: number;
}

export interface Pellet {
  id: Id;
  x: number;
  y: number;
  mass: number;
  kind: PelletRow["kind"];
  hidden: boolean;
  /** Ejecta tween source + start time. */
  from?: [number, number];
  tweenStart?: number;
}

export interface RemotePlayer {
  id: string;
  name: string;
  color: string;
  skin: string | null;
  buffer: SnapshotBuffer;
  /** True when name/colour came from presence or the players table. */
  known: boolean;
}

export interface RemoteCell extends InterpCell {
  playerId: string;
}

export interface SelfInfo {
  playerId: string;
  roomId: string;
  worldSize: number;
  name: string;
  color: string;
  skin: string | null;
}

/** Deterministic fallback colour for a player we have no metadata for yet. */
export function colorForId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return PALETTE[(h >>> 0) % PALETTE.length];
}

export class World {
  readonly self: SelfInfo;
  readonly myCells = new Map<Id, OwnCell>();
  readonly remotePlayers = new Map<string, RemotePlayer>();
  readonly pellets = new Map<Id, Pellet>(); // food + ejecta
  readonly thorns = new Map<Id, Pellet>();
  readonly pelletGrid = new SpatialGrid<Pellet>(128);
  blooms: [number, number][] = [];
  leaderboard: [string, string, number][] = [];
  /** Latest interpolated sample of every remote cell (refreshed by sampleRemotes). */
  remoteCells: RemoteCell[] = [];
  /** Removed cell ids (any player) -> removal time. */
  readonly tombstones = new Map<Id, number>();
  /** Own cell ids removed locally (merge/eaten) -> time, so a stale sync can't re-add them. */
  readonly removedOwn = new Map<Id, number>();

  peakMass = 0;
  kills = 0;
  readonly spawnedAt: number;

  constructor(join: JoinResult, name: string, skin: string | null, now: number) {
    this.self = {
      playerId: join.player_id,
      roomId: join.room_id,
      worldSize: join.world_size,
      name: join.name || name,
      color: join.color,
      skin: join.skin !== undefined ? join.skin : skin,
    };
    this.spawnedAt = now;
    this.addOwnCell({ merge_after: now, born: now, ...join.cell }, now);
  }

  // ---- own cells ----

  addOwnCell(sc: ServerCell, now: number, at?: { x: number; y: number }): OwnCell {
    const x = at?.x ?? sc.x;
    const y = at?.y ?? sc.y;
    const c: OwnCell = {
      id: sc.id,
      x,
      y,
      prevX: x,
      prevY: y,
      mass: sc.mass,
      vx: 0,
      vy: 0,
      mergeAfter: toMs(sc.merge_after, now + mergeDelay(sc.mass) * 1000),
      born: toMs(sc.born, now),
      addedAt: now,
      massSetAt: now,
      corr: null,
    };
    this.myCells.set(c.id, c);
    this.removedOwn.delete(c.id);
    this.notePeak();
    return c;
  }

  removeOwnCell(id: Id, now: number): void {
    if (this.myCells.delete(id)) this.removedOwn.set(id, now);
    this.tombstones.set(id, now);
  }

  ownCellList(): OwnCell[] {
    return [...this.myCells.values()];
  }

  totalMass(): number {
    let m = 0;
    for (const c of this.myCells.values()) m += c.mass;
    return m;
  }

  notePeak(): void {
    this.peakMass = Math.max(this.peakMass, this.totalMass());
  }

  // ---- pellets ----

  addPellet(row: Pick<PelletRow, "id" | "x" | "y" | "mass" | "kind">): Pellet {
    const existing = this.pellets.get(row.id) ?? this.thorns.get(row.id);
    if (existing) return existing;
    const p: Pellet = { id: row.id, x: row.x, y: row.y, mass: row.mass, kind: row.kind, hidden: false };
    if (p.kind === "thorn") this.thorns.set(p.id, p);
    else {
      this.pellets.set(p.id, p);
      this.pelletGrid.set(p.id, p);
    }
    return p;
  }

  removePellet(id: Id): void {
    if (this.pellets.delete(id)) this.pelletGrid.delete(id);
    this.thorns.delete(id);
  }

  setPelletHidden(id: Id, hidden: boolean): void {
    const p = this.pellets.get(id) ?? this.thorns.get(id);
    if (p) p.hidden = hidden;
  }

  applyPelletsSpawned(e: PelletsSpawnedPayload): void {
    for (const [id, x, y, mass, kind] of e.p ?? []) this.addPellet({ id, x, y, mass, kind: kind ?? "food" });
  }

  applyPelletsEaten(e: PelletsEatenPayload): void {
    for (const id of e.ids ?? []) this.removePellet(id);
  }

  applyEjected(e: EjectedPayload, now: number): void {
    const p = this.addPellet({ id: e.id, x: e.to[0], y: e.to[1], mass: e.mass, kind: "ejecta" });
    p.from = [e.from[0], e.from[1]];
    p.tweenStart = now;
  }

  // ---- remote players ----

  upsertRemote(meta: Pick<PlayerRow, "id" | "name" | "color" | "skin">): RemotePlayer | null {
    if (meta.id === this.self.playerId) return null;
    let rp = this.remotePlayers.get(meta.id);
    if (!rp) {
      rp = { id: meta.id, name: meta.name, color: meta.color, skin: meta.skin, buffer: new SnapshotBuffer(), known: true };
      this.remotePlayers.set(meta.id, rp);
    } else {
      rp.name = meta.name;
      rp.color = meta.color;
      rp.skin = meta.skin;
      rp.known = true;
    }
    return rp;
  }

  private ensureRemote(id: string): RemotePlayer {
    let rp = this.remotePlayers.get(id);
    if (!rp) {
      rp = { id, name: "", color: colorForId(id), skin: null, buffer: new SnapshotBuffer(), known: false };
      this.remotePlayers.set(id, rp);
    }
    return rp;
  }

  removeRemote(id: string): void {
    this.remotePlayers.delete(id);
    this.remoteCells = this.remoteCells.filter((c) => c.playerId !== id);
  }

  /** Seed a remote player's buffer with DB cell positions (initial load). */
  seedRemoteCells(cells: CellRow[], now: number): void {
    const byPlayer = new Map<string, CellRow[]>();
    for (const c of cells) {
      if (c.player_id === this.self.playerId) continue;
      const list = byPlayer.get(c.player_id) ?? [];
      list.push(c);
      byPlayer.set(c.player_id, list);
    }
    for (const [pid, list] of byPlayer) {
      const rp = this.ensureRemote(pid);
      if (rp.buffer.length > 0) continue; // live data already arrived
      rp.buffer.push(now, list.map((c) => [c.id, c.x, c.y, c.mass]), now);
    }
  }

  /** Incoming peer `state` broadcast. Returns the player (possibly newly created / unknown). */
  applyState(s: StatePayload, now: number): RemotePlayer | null {
    if (!s || s.p === this.self.playerId || !Array.isArray(s.c)) return null;
    const rp = this.ensureRemote(s.p);
    const cells = this.tombstones.size ? s.c.filter((c) => !this.tombstones.has(c[0])) : s.c;
    rp.buffer.push(typeof s.t === "number" ? s.t : now, cells, now);
    return rp;
  }

  applyCellEaten(e: CellEatenPayload, now: number): void {
    this.tombstones.set(e.victim_cell, now);
    if (e.victim_player === this.self.playerId) {
      this.removeOwnCell(e.victim_cell, now);
    } else {
      this.remotePlayers.get(e.victim_player)?.buffer.removeCell(e.victim_cell);
      this.remoteCells = this.remoteCells.filter((c) => c.id !== e.victim_cell);
    }
    if (e.eater_player === this.self.playerId) {
      const c = this.myCells.get(e.eater_cell);
      if (c && typeof e.eater_mass === "number") {
        c.mass = e.eater_mass;
        c.massSetAt = now;
        this.notePeak();
      }
    }
  }

  /** Optimistically hide a remote cell we just ate. */
  hideRemoteCell(id: Id, now: number): void {
    this.tombstones.set(id, now);
    for (const rp of this.remotePlayers.values()) rp.buffer.removeCell(id);
    this.remoteCells = this.remoteCells.filter((c) => c.id !== id);
  }

  applyLeaderboard(e: LeaderboardPayload): void {
    this.leaderboard = Array.isArray(e.top) ? e.top : [];
  }

  applyBlooms(e: BloomsPayload): void {
    this.blooms = Array.isArray(e.b) ? e.b : [];
  }

  /** Refresh `remoteCells` with interpolated positions for time `now`. */
  sampleRemotes(now: number): RemoteCell[] {
    const out: RemoteCell[] = [];
    for (const rp of this.remotePlayers.values()) {
      for (const c of rp.buffer.sample(now)) {
        if (this.tombstones.has(c.id)) continue;
        (c as RemoteCell).playerId = rp.id;
        out.push(c as RemoteCell);
      }
    }
    this.remoteCells = out;
    return out;
  }

  /** Expire tombstones and removed-own markers. */
  gc(now: number): void {
    for (const [id, t] of this.tombstones) if (now - t > TOMBSTONE_MS) this.tombstones.delete(id);
    for (const [id, t] of this.removedOwn) if (now - t > TOMBSTONE_MS) this.removedOwn.delete(id);
  }

  /** Number of players in the room including self. */
  playerCount(): number {
    return this.remotePlayers.size + 1;
  }
}
