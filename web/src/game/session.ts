// GameSession: one life in one room, drivable by the browser or by headless bots. DOM-free.
//
//   const join = await actions.join(client, name, skin);
//   const s = await GameSession.start({ client, join, name, skin, onDeath, onLeaderboard });
//   s.setTarget(x, y); s.split(); s.eject();
//   ...  await s.stop();            // leave_game + unsubscribe
//
// Loops: state broadcast 15 Hz and player_sync 10 Hz always run on injected timers. The 60 Hz
// fixed-step sim either runs on its own timer (`driveSim: "interval"`, default — bots) or is
// advanced by the caller via `tick(now)` (`driveSim: "external"` — browser rAF).

import type { SupabaseClient } from "@supabase/supabase-js";
import { EJECT_MIN_MASS, MAX_CELLS, MIN_SPLIT_MASS, NET_STATE_HZ, NET_SYNC_HZ, mergeDelay, radius } from "@shared/game.ts";
import type { Id, JoinResult, LeaderboardPayload, PlayerDiedPayload, ServerCell } from "../types.ts";
import { toMs } from "../types.ts";
import * as actions from "../net/actions.ts";
import { RoomConnection } from "../net/room.ts";
import { SyncLoop } from "../net/sync.ts";
import { PendingClaims, detectCellEats, detectPellets, detectThorns } from "./detect.ts";
import { SIM_STEP_MS, centroid, findMergePairs, launch, stepCells, type Point } from "./sim.ts";
import { World, type OwnCell } from "./world.ts";

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimers: Timers = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
};

export interface DeathInfo {
  /** "eaten": killed by a player; "dead": server says dead without a player_died event; "left": removed (stale/kicked). */
  reason: "eaten" | "dead" | "left";
  killerId: string | null;
  killerName: string | null;
  peakMass: number;
  kills: number;
  survivedSeconds: number;
}

export interface SessionOptions {
  client: SupabaseClient;
  join: JoinResult;
  name: string;
  skin: string | null;
  /** Clock in epoch ms (default Date.now). */
  now?: () => number;
  timers?: Timers;
  /** "interval" (default): sim runs on its own 60 Hz timer. "external": call tick(now) yourself. */
  driveSim?: "interval" | "external";
  onDeath?: (info: DeathInfo) => void;
  onLeaderboard?: (top: LeaderboardPayload["top"]) => void;
  /** RPC / channel errors (already throttled per `where` to 1 per second). */
  onError?: (where: string, err: unknown) => void;
}

const MAX_FRAME_MS = 250;
const DEATH_EVENT_WAIT_MS = 1500;
const MERGE_RETRY_MS = 500;

export class GameSession {
  readonly world: World;
  readonly client: SupabaseClient;
  readonly claims = new PendingClaims();
  readonly room: RoomConnection;
  readonly sync: SyncLoop;
  /** World-space steering target (mouse or bot). */
  target: Point;
  alive = true;
  /** Fraction of a sim step left in the accumulator (0..1), for render interpolation. */
  simAlpha = 0;
  deathInfo: DeathInfo | null = null;

  private opts: SessionOptions;
  private now: () => number;
  private timers: Timers;
  private handles: unknown[] = [];
  private acc = 0;
  private lastTick = 0;
  private eatDebounce = new Map<string, number>();
  private mergeTried = new Map<string, number>();
  private inFlightEats = new Set<Id>();
  private deathTimer: unknown = null;
  private lastErrorAt = new Map<string, number>();
  private splitBusy = false;
  private ejectBusy = false;

  private constructor(opts: SessionOptions) {
    this.opts = opts;
    this.client = opts.client;
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? defaultTimers;
    this.world = new World(opts.join, opts.name, opts.skin, this.now());
    this.target = { x: opts.join.cell.x, y: opts.join.cell.y };
    this.room = new RoomConnection(this.client, this.world, {
      now: this.now,
      onPlayerDied: (e) => this.onPlayerDied(e),
      onPelletsEaten: (e) => {
        for (const id of e.ids ?? []) this.claims.confirm(id);
      },
      onLeaderboard: (e) => this.opts.onLeaderboard?.(e.top),
      onError: (w, err) => this.reportError(w, err),
    });
    this.sync = new SyncLoop(this.client, this.world, this.claims, {
      now: this.now,
      onStatus: (s) => this.onSyncStatus(s),
      onError: (err) => this.reportError("player_sync", err),
    });
  }

  /** Build the world, subscribe + load the room, start loops. */
  static async start(opts: SessionOptions): Promise<GameSession> {
    const s = new GameSession(opts);
    try {
      await s.room.connect();
    } catch (err) {
      await s.room.close().catch(() => {});
      throw err;
    }
    s.lastTick = s.now();
    const t = s.timers;
    s.handles.push(t.setInterval(() => s.room.sendState(), Math.round(1000 / NET_STATE_HZ)));
    s.handles.push(t.setInterval(() => s.sync.tick(), Math.round(1000 / NET_SYNC_HZ)));
    if ((opts.driveSim ?? "interval") === "interval") {
      s.handles.push(t.setInterval(() => s.tick(), Math.round(SIM_STEP_MS)));
    }
    s.sync.tick();
    return s;
  }

  get playerId(): string {
    return this.world.self.playerId;
  }

  get syncRtt(): number {
    return this.sync.rtt;
  }

  setTarget(x: number, y: number): void {
    this.target = { x, y };
  }

  /** Mass-weighted centroid of own cells (or the target if none). */
  centre(): Point {
    return centroid(this.world.myCells.values()) ?? { ...this.target };
  }

  /** Advance the fixed-step sim to `now`, run detection, fire eat/merge claims. */
  tick(now = this.now()): void {
    if (!this.alive) return;
    const frame = Math.min(MAX_FRAME_MS, Math.max(0, now - this.lastTick));
    this.lastTick = now;
    this.acc += frame;
    const w = this.world;
    const cells = w.ownCellList();
    const dt = SIM_STEP_MS / 1000;
    let simNow = now - this.acc;
    while (this.acc >= SIM_STEP_MS) {
      simNow += SIM_STEP_MS;
      stepCells(cells, this.target, dt, simNow, w.self.worldSize);
      this.detectPelletsAndThorns(cells, simNow);
      this.acc -= SIM_STEP_MS;
    }
    this.simAlpha = this.acc / SIM_STEP_MS;

    w.sampleRemotes(now);
    this.detectEats(cells, now);
    this.tryMerges(cells, now);
    for (const id of this.claims.expire(now)) w.setPelletHidden(id, false);
    w.gc(now);
  }

  private detectPelletsAndThorns(cells: OwnCell[], now: number): void {
    const w = this.world;
    for (const p of detectPellets(cells, w.pelletGrid, this.claims)) {
      if (this.claims.claim(p.id, now)) p.hidden = true;
    }
    if (w.thorns.size) {
      for (const t of detectThorns(cells, w.thorns.values(), this.claims)) {
        if (this.claims.claim(t.id, now)) t.hidden = true;
      }
    }
  }

  private detectEats(cells: OwnCell[], now: number): void {
    const w = this.world;
    const remote = w.remoteCells.filter((c) => c.alpha >= 0.5 && !this.inFlightEats.has(c.id));
    for (const { eater, victim } of detectCellEats(cells, remote, now, this.eatDebounce)) {
      const e = eater as OwnCell;
      this.inFlightEats.add(victim.id);
      actions
        .eatCell(this.client, e.id, victim.id, Math.round(e.x * 10) / 10, Math.round(e.y * 10) / 10)
        .then((res) => {
          if (!res || !res.ok || !this.alive) return;
          const t = this.now();
          w.hideRemoteCell(victim.id, t);
          const mine = w.myCells.get(e.id);
          if (mine && typeof res.eater_mass === "number") {
            mine.mass = res.eater_mass;
            mine.massSetAt = t;
            w.notePeak();
          }
        })
        .catch((err) => this.reportError("eat_cell", err))
        .finally(() => this.inFlightEats.delete(victim.id));
    }
  }

  private tryMerges(cells: OwnCell[], now: number): void {
    if (cells.length < 2) return;
    for (const [a, b] of findMergePairs(cells, now)) {
      const key = `${a.id}:${b.id}`;
      const last = this.mergeTried.get(key);
      if (last !== undefined && now - last < MERGE_RETRY_MS) continue;
      this.mergeTried.set(key, now);
      actions
        .mergeCells(this.client, a.id, b.id)
        .then((res) => {
          if (!res?.ok || !this.alive) return;
          const t = this.now();
          const w = this.world;
          const keepId = res.cell?.id ?? a.id;
          const goneId = keepId === a.id ? b.id : a.id;
          const keep = w.myCells.get(keepId);
          const gone = w.myCells.get(goneId);
          if (keep) {
            keep.mass = res.cell?.mass ?? keep.mass + (gone?.mass ?? 0);
            keep.massSetAt = t;
            if (res.cell?.merge_after != null) keep.mergeAfter = toMs(res.cell.merge_after, keep.mergeAfter);
          }
          w.removeOwnCell(goneId, t);
        })
        .catch((err) => this.reportError("merge_cells", err));
    }
    if (this.mergeTried.size > 64) {
      for (const [k, t] of this.mergeTried) if (now - t > MERGE_RETRY_MS) this.mergeTried.delete(k);
    }
  }

  private aimDir(): Point {
    const c = this.centre();
    const dx = this.target.x - c.x;
    const dy = this.target.y - c.y;
    const d = Math.hypot(dx, dy);
    return d > 1e-3 ? { x: dx / d, y: dy / d } : { x: 1, y: 0 };
  }

  /** Split every cell ≥ MIN_SPLIT_MASS toward the target. New cells get the launch velocity. */
  async split(): Promise<void> {
    const w = this.world;
    if (!this.alive || this.splitBusy) return;
    const cells = w.ownCellList();
    if (cells.length >= MAX_CELLS || !cells.some((c) => c.mass >= MIN_SPLIT_MASS)) return;
    const dir = this.aimDir();
    this.splitBusy = true;
    try {
      const res = await actions.split(this.client, w.self.playerId, dir.x, dir.y);
      if (!this.alive || !res) return;
      const rd = res.dir;
      const d = Array.isArray(rd) ? { x: rd[0], y: rd[1] } : rd && typeof rd === "object" ? rd : dir;
      this.applySplit(res.cells ?? [], d);
    } catch (err) {
      this.reportError("split", err);
    } finally {
      this.splitBusy = false;
    }
  }

  /** Exposed for tests/bots: add split children next to their (local) parents with launch velocity. */
  applySplit(newCells: ServerCell[], dir: Point): void {
    const w = this.world;
    const now = this.now();
    const used = new Set<Id>();
    const parents = w.ownCellList().filter((c) => c.mass >= MIN_SPLIT_MASS * 0.9);
    const sorted = [...newCells].sort((a, b) => b.mass - a.mass);
    for (const nc of sorted) {
      if (w.myCells.has(nc.id)) continue; // already added by a racing sync
      // Server tells us the parent; otherwise guess the nearest unused splittable cell.
      let parent: OwnCell | null = nc.parent != null ? (w.myCells.get(nc.parent) ?? null) : null;
      if (parent && used.has(parent.id)) parent = null;
      if (!parent && nc.parent == null) {
        let best = Infinity;
        for (const p of parents) {
          if (used.has(p.id)) continue;
          const d = Math.hypot(p.x - nc.x, p.y - nc.y);
          if (d < best) {
            best = d;
            parent = p;
          }
        }
      }
      const mergeAfter = toMs(nc.merge_after, now + mergeDelay(nc.mass) * 1000);
      let at: Point | undefined;
      if (parent) {
        used.add(parent.id);
        parent.mass = nc.mass;
        parent.massSetAt = now;
        parent.mergeAfter = Math.max(parent.mergeAfter, mergeAfter);
        const r = radius(nc.mass);
        at = { x: parent.x + dir.x * r, y: parent.y + dir.y * r };
      }
      const c = w.addOwnCell({ ...nc, merge_after: mergeAfter, born: nc.born ?? now }, now, at);
      launch(c, dir.x, dir.y);
    }
  }

  /** Eject mass toward the target from every cell ≥ EJECT_MIN_MASS. */
  async eject(): Promise<void> {
    const w = this.world;
    if (!this.alive || this.ejectBusy) return;
    if (!w.ownCellList().some((c) => c.mass >= EJECT_MIN_MASS)) return;
    const dir = this.aimDir();
    this.ejectBusy = true;
    try {
      const res = await actions.eject(this.client, w.self.playerId, dir.x, dir.y);
      if (!this.alive || !res) return;
      const now = this.now();
      for (const c of res.cells ?? []) {
        const mine = w.myCells.get(c.id);
        if (mine) {
          mine.mass = c.mass;
          mine.massSetAt = now;
        }
      }
    } catch (err) {
      this.reportError("eject", err);
    } finally {
      this.ejectBusy = false;
    }
  }

  private onPlayerDied(e: PlayerDiedPayload): void {
    if (e.player_id === this.world.self.playerId) {
      this.die({
        reason: "eaten",
        killerId: e.killer_id ?? null,
        killerName: e.killer_name ?? null,
        peakMass: Number(e.peak_mass) || this.world.peakMass,
        kills: Number(e.kills) || this.world.kills,
        survivedSeconds: Number(e.survived_seconds) || this.localSurvived(),
      });
    } else if (e.killer_id === this.world.self.playerId) {
      this.world.kills++;
    }
  }

  private onSyncStatus(status: string): void {
    if (status === "alive" || !this.alive) return;
    if (status === "left") {
      this.die(this.localDeath("left"));
      return;
    }
    // Dead: prefer the player_died event (has killer + server stats); fall back after a grace period.
    this.stopLoops();
    if (this.deathTimer === null) {
      this.deathTimer = this.timers.setInterval(() => this.die(this.localDeath("dead")), DEATH_EVENT_WAIT_MS);
    }
  }

  private localSurvived(): number {
    return Math.round((this.now() - this.world.spawnedAt) / 1000);
  }

  private localDeath(reason: DeathInfo["reason"]): DeathInfo {
    return {
      reason,
      killerId: null,
      killerName: null,
      peakMass: this.world.peakMass,
      kills: this.world.kills,
      survivedSeconds: this.localSurvived(),
    };
  }

  private die(info: DeathInfo): void {
    if (this.deathInfo) return;
    this.deathInfo = info;
    this.alive = false;
    this.stopLoops();
    void this.room.close();
    this.opts.onDeath?.(info);
  }

  private stopLoops(): void {
    for (const h of this.handles) this.timers.clearInterval(h);
    this.handles = [];
    this.sync.stop();
    if (this.deathTimer !== null && this.deathInfo) {
      this.timers.clearInterval(this.deathTimer);
      this.deathTimer = null;
    }
  }

  private reportError(where: string, err: unknown): void {
    const now = this.now();
    const last = this.lastErrorAt.get(where) ?? 0;
    if (now - last < 1000) return;
    this.lastErrorAt.set(where, now);
    this.opts.onError?.(where, err);
  }

  /** End the session. With `leave` (default) calls leave_game if still alive. Idempotent. */
  async stop({ leave = true }: { leave?: boolean } = {}): Promise<void> {
    const wasAlive = this.alive;
    this.alive = false;
    if (this.deathTimer !== null) {
      this.timers.clearInterval(this.deathTimer);
      this.deathTimer = null;
    }
    this.stopLoops();
    if (leave && wasAlive) {
      await actions.leaveGame(this.client, this.world.self.playerId).catch((err) => this.reportError("leave_game", err));
    }
    await this.room.close().catch(() => {});
  }
}
