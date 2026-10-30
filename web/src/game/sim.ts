// Local fixed-step physics for the player's own cells (PLAN.md §6 "Own-cell behaviour"). DOM-free.

import { radius, speed, SPLIT_SPEED, SPLIT_DECAY } from "@shared/game.ts";
import type { Id } from "../types.ts";

export const SIM_HZ = 60;
export const SIM_STEP_MS = 1000 / SIM_HZ;

/** Fraction of the overlap resolved per second by the soft collision (scaled by dt). */
const SOFT_STIFFNESS = 14;
/** Max push speed from soft collision, px/s (kept well inside the server's 40 px/sync slack). */
const SOFT_MAX_PUSH = 360;
/** Pull speed between own cells that are allowed to merge, px/s. */
const MERGE_PULL = 70;
/** Server-side correction blend duration, seconds. */
export const CORRECTION_BLEND_S = 0.15;

export interface Point {
  x: number;
  y: number;
}

export interface SimCell {
  id: Id;
  x: number;
  y: number;
  mass: number;
  /** Decaying launch velocity (split), px/s. */
  vx: number;
  vy: number;
  /** Epoch ms after which the cell may merge with siblings. */
  mergeAfter: number;
  /** Previous-step position, for render interpolation. */
  prevX: number;
  prevY: number;
  /** Pending server correction being blended in. */
  corr?: { dx: number; dy: number; left: number } | null;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Distance within which a cell slows down as it reaches the target. */
export const arriveRadius = (mass: number): number => Math.max(20, radius(mass) * 0.5);

/** Move one cell toward the target at speed(mass), slowing within arriveRadius. */
export function moveToward(c: SimCell, target: Point, dt: number): void {
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-3) return;
  const s = speed(c.mass) * Math.min(1, d / arriveRadius(c.mass));
  const step = Math.min(d, s * dt);
  c.x += (dx / d) * step;
  c.y += (dy / d) * step;
}

/** Apply and decay the split launch velocity: v *= exp(-SPLIT_DECAY * dt). */
export function applyLaunch(c: SimCell, dt: number): void {
  if (c.vx === 0 && c.vy === 0) return;
  c.x += c.vx * dt;
  c.y += c.vy * dt;
  const k = Math.exp(-SPLIT_DECAY * dt);
  c.vx *= k;
  c.vy *= k;
  if (Math.hypot(c.vx, c.vy) < 1) {
    c.vx = 0;
    c.vy = 0;
  }
}

/** Give a freshly split cell its launch velocity along (dx, dy). */
export function launch(c: SimCell, dx: number, dy: number, v = SPLIT_SPEED): void {
  const d = Math.hypot(dx, dy) || 1;
  c.vx = (dx / d) * v;
  c.vy = (dy / d) * v;
}

const canMergeNow = (a: SimCell, b: SimCell, now: number) => now >= a.mergeAfter && now >= b.mergeAfter;

/**
 * Own-cell interactions: before merge_after cells push apart (soft collision, lighter cell moves
 * more); after it, they drift toward each other so a merge can happen.
 */
export function resolveOwnCollisions(cells: SimCell[], dt: number, now: number): void {
  const n = cells.length;
  const maxPush = SOFT_MAX_PUSH * dt;
  for (let i = 0; i < n; i++) {
    const a = cells[i];
    for (let j = i + 1; j < n; j++) {
      const b = cells[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d = Math.hypot(dx, dy);
      if (d < 1e-6) {
        // Coincident: separate along an arbitrary but deterministic axis.
        const ang = ((Number(a.id) * 7 + Number(b.id) * 13) % 360) * (Math.PI / 180);
        dx = Math.cos(ang);
        dy = Math.sin(ang);
        d = 1e-6;
      }
      const nx = dx / d;
      const ny = dy / d;
      const ra = radius(a.mass);
      const rb = radius(b.mass);
      const total = a.mass + b.mass;
      if (!canMergeNow(a, b, now)) {
        const overlap = ra + rb - d;
        if (overlap <= 0) continue;
        const push = Math.min(overlap * Math.min(1, SOFT_STIFFNESS * dt), maxPush * 2);
        const pa = push * (b.mass / total);
        const pb = push * (a.mass / total);
        a.x -= nx * pa;
        a.y -= ny * pa;
        b.x += nx * pb;
        b.y += ny * pb;
      } else if (d > 1) {
        const pull = Math.min(d, MERGE_PULL * dt);
        const pa = pull * (b.mass / total);
        const pb = pull * (a.mass / total);
        a.x += nx * pa;
        a.y += ny * pa;
        b.x -= nx * pb;
        b.y -= ny * pb;
      }
    }
  }
}

/** Blend a pending server correction in over CORRECTION_BLEND_S. */
export function applyCorrection(c: SimCell, dt: number): void {
  const k = c.corr;
  if (!k) return;
  const f = k.left <= dt + 1e-9 ? 1 : dt / k.left;
  const mx = k.dx * f;
  const my = k.dy * f;
  c.x += mx;
  c.y += my;
  k.dx -= mx;
  k.dy -= my;
  k.left -= dt;
  if (k.left <= 1e-9) c.corr = null;
}

/** One fixed simulation step for all own cells. `now` is epoch ms (for merge timers). */
export function stepCells(cells: SimCell[], target: Point, dt: number, now: number, worldSize: number): void {
  for (const c of cells) {
    c.prevX = c.x;
    c.prevY = c.y;
    moveToward(c, target, dt);
    applyLaunch(c, dt);
    applyCorrection(c, dt);
  }
  resolveOwnCollisions(cells, dt, now);
  for (const c of cells) {
    c.x = clamp(c.x, 0, worldSize);
    c.y = clamp(c.y, 0, worldSize);
  }
}

/**
 * Pairs of own cells eligible to merge: both past merge_after and overlapping by more than
 * 50 % of the smaller radius. Returned as [keep, absorb] with the heavier cell first.
 */
export function findMergePairs(cells: SimCell[], now: number): [SimCell, SimCell][] {
  const out: [SimCell, SimCell][] = [];
  const used = new Set<Id>();
  for (let i = 0; i < cells.length; i++) {
    const a = cells[i];
    if (used.has(a.id) || now < a.mergeAfter) continue;
    for (let j = i + 1; j < cells.length; j++) {
      const b = cells[j];
      if (used.has(b.id) || now < b.mergeAfter) continue;
      const ra = radius(a.mass);
      const rb = radius(b.mass);
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (ra + rb - d > 0.5 * Math.min(ra, rb)) {
        const pair: [SimCell, SimCell] = a.mass >= b.mass ? [a, b] : [b, a];
        out.push(pair);
        used.add(a.id);
        used.add(b.id);
        break;
      }
    }
  }
  return out;
}

/** Mass-weighted centroid; null for no cells. */
export function centroid(cells: Iterable<{ x: number; y: number; mass: number }>): Point | null {
  let sx = 0;
  let sy = 0;
  let m = 0;
  for (const c of cells) {
    sx += c.x * c.mass;
    sy += c.y * c.mass;
    m += c.mass;
  }
  return m > 0 ? { x: sx / m, y: sy / m } : null;
}

export function totalMass(cells: Iterable<{ mass: number }>): number {
  let m = 0;
  for (const c of cells) m += c.mass;
  return m;
}
