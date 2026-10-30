// Local overlap detection -> eat claims (PLAN.md §13). DOM-free.

import { radius, canEat, eatOverlapOk, THORN_MASS, THORN_BURST_RATIO } from "@shared/game.ts";
import type { Id } from "../types.ts";
import type { SpatialGrid } from "./spatial.ts";

export const PELLET_CONFIRM_MS = 1000;
export const EAT_DEBOUNCE_MS = 500;

export interface Circle {
  id: Id;
  x: number;
  y: number;
  mass: number;
}

export interface PelletLike {
  id: Id;
  x: number;
  y: number;
  hidden?: boolean;
}

/** A pellet is eaten when its centre lies inside the cell. */
export function pelletOverlap(cell: Circle, p: { x: number; y: number }): boolean {
  const r = radius(cell.mass);
  const dx = p.x - cell.x;
  const dy = p.y - cell.y;
  return dx * dx + dy * dy <= r * r;
}

/** Thorns only burst cells heavier than THORN_BURST_RATIO × THORN_MASS (130) whose body covers them. */
export function thornHit(cell: Circle, thorn: { x: number; y: number }): boolean {
  if (!(cell.mass > THORN_BURST_RATIO * THORN_MASS)) return false;
  return pelletOverlap(cell, thorn);
}

/** The server's eat rule: mass ratio and overlap. */
export function canEatCell(eater: Circle, victim: Circle): boolean {
  if (!canEat(eater.mass, victim.mass)) return false;
  const d = Math.hypot(victim.x - eater.x, victim.y - eater.y);
  return eatOverlapOk(d, radius(eater.mass), radius(victim.mass));
}

/**
 * Optimistic pellet claims: hidden immediately, queued for the next player_sync, unhidden if not
 * confirmed (pellets_eaten) within PELLET_CONFIRM_MS.
 */
export class PendingClaims {
  private pending = new Map<Id, number>();
  private queue: Id[] = [];

  get size(): number {
    return this.pending.size;
  }
  has(id: Id): boolean {
    return this.pending.has(id);
  }

  /** Returns false if already claimed. */
  claim(id: Id, now: number): boolean {
    if (this.pending.has(id)) return false;
    this.pending.set(id, now);
    this.queue.push(id);
    return true;
  }

  confirm(id: Id): void {
    this.pending.delete(id);
  }

  /** Take every queued id for the next sync call. */
  drain(): Id[] {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  /** Put ids back (failed sync) if they are still pending. */
  requeue(ids: Id[]): void {
    for (const id of ids) if (this.pending.has(id)) this.queue.push(id);
  }

  /** Ids whose claim timed out; they are removed from the pending set. */
  expire(now: number, ttl = PELLET_CONFIRM_MS): Id[] {
    const out: Id[] = [];
    for (const [id, t] of this.pending) {
      if (now - t >= ttl) {
        this.pending.delete(id);
        out.push(id);
      }
    }
    if (out.length) {
      const gone = new Set(out);
      this.queue = this.queue.filter((id) => !gone.has(id));
    }
    return out;
  }

  clear(): void {
    this.pending.clear();
    this.queue = [];
  }
}

/** Visible pellets overlapped by any own cell (not yet claimed). */
export function detectPellets<P extends PelletLike>(
  cells: Iterable<Circle>,
  grid: SpatialGrid<P>,
  claims: PendingClaims,
): P[] {
  const out: P[] = [];
  for (const c of cells) {
    const r = radius(c.mass);
    grid.queryCircle(c.x, c.y, r, (p) => {
      if (p.hidden || claims.has(p.id)) return;
      out.push(p);
    });
  }
  return out;
}

/** Thorns that would burst one of the given own cells. */
export function detectThorns<P extends PelletLike>(
  cells: Iterable<Circle>,
  thorns: Iterable<P>,
  claims: PendingClaims,
): P[] {
  const out: P[] = [];
  const list = [...cells];
  for (const t of thorns) {
    if (t.hidden || claims.has(t.id)) continue;
    if (list.some((c) => thornHit(c, t))) out.push(t);
  }
  return out;
}

export interface EatClaim {
  eater: Circle;
  victim: Circle;
}

/**
 * Remote cells our cells can eat right now. At most one claim per victim per call, and each
 * eater/victim pair is debounced for EAT_DEBOUNCE_MS (the `debounce` map is mutated).
 */
export function detectCellEats(
  own: Circle[],
  remote: Iterable<Circle>,
  now: number,
  debounce: Map<string, number>,
): EatClaim[] {
  const out: EatClaim[] = [];
  if (own.length === 0) return out;
  for (const v of remote) {
    for (const e of own) {
      const re = radius(e.mass);
      if (Math.abs(v.x - e.x) > re || Math.abs(v.y - e.y) > re) continue;
      if (!canEatCell(e, v)) continue;
      const key = `${e.id}:${v.id}`;
      const last = debounce.get(key);
      if (last !== undefined && now - last < EAT_DEBOUNCE_MS) continue;
      debounce.set(key, now);
      out.push({ eater: e, victim: v });
      break; // one claim per victim
    }
  }
  if (debounce.size > 256) {
    for (const [k, t] of debounce) if (now - t >= EAT_DEBOUNCE_MS) debounce.delete(k);
  }
  return out;
}
