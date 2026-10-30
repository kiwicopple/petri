// Snapshot buffer for one remote player (PLAN.md §13). DOM-free.
// Snapshots are stamped in the local clock (sender time + estimated offset) and sampled
// INTERP_DELAY_MS in the past with linear interpolation. Past the newest snapshot we
// extrapolate for up to EXTRAPOLATE_MAX_MS, then freeze.

import { INTERP_DELAY_MS } from "@shared/game.ts";
import type { CellTuple, Id } from "../types.ts";

export const EXTRAPOLATE_MAX_MS = 150;
const KEEP_MS = 1000;
const MAX_SNAPSHOTS = 32;

interface Snapshot {
  t: number; // local clock ms
  cells: Map<Id, [number, number, number]>; // id -> [x, y, mass]
}

export interface InterpCell {
  id: Id;
  x: number;
  y: number;
  mass: number;
  /** 0..1, for fade-in / fade-out of cells appearing or vanishing between snapshots. */
  alpha: number;
}

export class SnapshotBuffer {
  private snaps: Snapshot[] = [];
  /** Estimated (local - sender) clock offset in ms. Tracks the minimum observed transit. */
  private offset: number | null = null;
  lastRecv = 0;

  get length(): number {
    return this.snaps.length;
  }

  /** Newest snapshot time in the local clock, or -Infinity when empty. */
  get latestTime(): number {
    return this.snaps.length ? this.snaps[this.snaps.length - 1].t : -Infinity;
  }

  /**
   * Add a snapshot. `senderT` is the sender's Date.now(); `recvNow` the local receive time.
   * Pass senderT === recvNow to stamp it directly in the local clock (initial DB state, tests).
   */
  push(senderT: number, cells: CellTuple[], recvNow: number): void {
    const sample = recvNow - senderT;
    if (this.offset === null || sample < this.offset) this.offset = sample;
    else this.offset += Math.min(sample - this.offset, 0.5); // slow upward relaxation (clock drift)
    const t = senderT + this.offset;
    this.lastRecv = recvNow;

    const map = new Map<Id, [number, number, number]>();
    for (const c of cells) map.set(c[0], [c[1], c[2], c[3]]);
    const snap: Snapshot = { t, cells: map };

    // Insert keeping time order; drop exact-duplicate timestamps.
    let i = this.snaps.length;
    while (i > 0 && this.snaps[i - 1].t > t) i--;
    if (i > 0 && this.snaps[i - 1].t === t) this.snaps[i - 1] = snap;
    else this.snaps.splice(i, 0, snap);

    const newest = this.latestTime;
    while (this.snaps.length > 2 && (this.snaps[0].t < newest - KEEP_MS || this.snaps.length > MAX_SNAPSHOTS)) {
      this.snaps.shift();
    }
  }

  /** Forget a cell everywhere (eaten / merged) so it does not linger in old snapshots. */
  removeCell(id: Id): void {
    for (const s of this.snaps) s.cells.delete(id);
  }

  clear(): void {
    this.snaps = [];
  }

  /** Sample cell states for local time `now`, rendered `delay` ms in the past. */
  sample(now: number, delay = INTERP_DELAY_MS): InterpCell[] {
    const snaps = this.snaps;
    const n = snaps.length;
    if (n === 0) return [];
    const rt = now - delay;

    if (n === 1 || rt <= snaps[0].t) {
      // Before the buffer starts, or nothing to interpolate/extrapolate from: hold the oldest.
      const out: InterpCell[] = [];
      for (const [id, [x, y, mass]] of snaps[0].cells) out.push({ id, x, y, mass, alpha: 1 });
      return out;
    }

    const last = snaps[n - 1];
    if (rt >= last.t) {
      // Extrapolate from the last two snapshots, capped, then freeze.
      const prev = snaps[n - 2];
      const span = last.t - prev.t;
      const ahead = Math.min(rt - last.t, EXTRAPOLATE_MAX_MS);
      const out: InterpCell[] = [];
      for (const [id, [x, y, mass]] of last.cells) {
        const p = prev.cells.get(id);
        if (p && span > 0) {
          const vx = (x - p[0]) / span;
          const vy = (y - p[1]) / span;
          out.push({ id, x: x + vx * ahead, y: y + vy * ahead, mass, alpha: 1 });
        } else {
          out.push({ id, x, y, mass, alpha: 1 });
        }
      }
      return out;
    }

    // Bracketing pair a.t <= rt < b.t
    let j = n - 1;
    while (j > 0 && snaps[j - 1].t > rt) j--;
    const a = snaps[j - 1];
    const b = snaps[j];
    const span = b.t - a.t;
    const f = span > 0 ? (rt - a.t) / span : 1;
    const out: InterpCell[] = [];
    for (const [id, [ax, ay, am]] of a.cells) {
      const bc = b.cells.get(id);
      if (bc) {
        out.push({
          id,
          x: ax + (bc[0] - ax) * f,
          y: ay + (bc[1] - ay) * f,
          mass: am + (bc[2] - am) * f,
          alpha: 1,
        });
      } else {
        out.push({ id, x: ax, y: ay, mass: am, alpha: 1 - f }); // vanishing
      }
    }
    for (const [id, [bx, by, bm]] of b.cells) {
      if (!a.cells.has(id)) out.push({ id, x: bx, y: by, mass: bm, alpha: f }); // appearing
    }
    return out;
  }
}
