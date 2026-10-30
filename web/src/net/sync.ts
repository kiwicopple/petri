// 10 Hz player_sync loop + reconciliation (PLAN.md §8, §13). DOM-free.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Id, SyncResponse } from "../types.ts";
import { toMs } from "../types.ts";
import type { World } from "../game/world.ts";
import type { PendingClaims } from "../game/detect.ts";
import { CORRECTION_BLEND_S } from "../game/sim.ts";
import { playerSync } from "./actions.ts";

const round1 = (v: number) => Math.round(v * 10) / 10;

export interface SyncContext {
  /** Local time the request was sent. */
  sentAt: number;
  /** Positions reported in the request, by cell id. */
  sent: Map<Id, { x: number; y: number }>;
}

/**
 * Apply a player_sync response to the world. The server cell set is the truth: drop local cells
 * it doesn't know (unless they were added after the request went out), add unknown server cells
 * (thorn burst), take mass, and blend clamped positions back over 150 ms.
 * Returns the player status.
 */
export function reconcile(world: World, resp: SyncResponse, ctx: SyncContext, now: number): string {
  const status = resp?.status ?? "alive";
  if (status !== "alive") return status;
  const server = new Map<Id, (typeof resp.cells)[number]>();
  for (const c of resp.cells ?? []) server.set(c.id, c);

  for (const local of world.ownCellList()) {
    if (!server.has(local.id) && local.addedAt < ctx.sentAt) world.removeOwnCell(local.id, now);
  }

  for (const sc of server.values()) {
    const local = world.myCells.get(sc.id);
    if (!local) {
      const removedAt = world.removedOwn.get(sc.id);
      if (removedAt !== undefined && removedAt >= ctx.sentAt - 1500) continue; // stale view of a merge/eat
      world.addOwnCell(sc, now);
      continue;
    }
    if (local.massSetAt <= ctx.sentAt) local.mass = sc.mass;
    local.mergeAfter = toMs(sc.merge_after, local.mergeAfter);
    if (sc.born != null) local.born = toMs(sc.born, local.born);
  }

  for (const id of resp.corrections ?? []) {
    const local = world.myCells.get(id);
    const sc = server.get(id);
    const sent = ctx.sent.get(id);
    if (!local || !sc || !sent) continue;
    const dx = sc.x - sent.x;
    const dy = sc.y - sent.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    local.corr = { dx, dy, left: CORRECTION_BLEND_S };
  }
  world.notePeak();
  return status;
}

export interface SyncLoopOptions {
  now: () => number;
  onStatus: (status: string) => void;
  onError: (err: unknown) => void;
}

/** Only one request in flight; eaten ids queued meanwhile go out with the next call. */
export class SyncLoop {
  inFlight = false;
  rtt = 0;
  lastOkAt = 0;
  stopped = false;

  constructor(
    private client: SupabaseClient,
    private world: World,
    private claims: PendingClaims,
    private opts: SyncLoopOptions,
  ) {}

  tick(): void {
    if (this.inFlight || this.stopped) return;
    const now = this.opts.now();
    const sent = new Map<Id, { x: number; y: number }>();
    const cells: { id: Id; x: number; y: number }[] = [];
    for (const c of this.world.myCells.values()) {
      const x = round1(c.x);
      const y = round1(c.y);
      sent.set(c.id, { x, y });
      cells.push({ id: c.id, x, y });
    }
    const eaten = this.claims.drain();
    this.inFlight = true;
    playerSync(this.client, this.world.self.playerId, cells, eaten)
      .then((resp) => {
        if (this.stopped) return;
        const t = this.opts.now();
        this.rtt = this.rtt ? this.rtt * 0.8 + (t - now) * 0.2 : t - now;
        this.lastOkAt = t;
        const status = reconcile(this.world, resp, { sentAt: now, sent }, t);
        this.opts.onStatus(status);
      })
      .catch((err) => {
        this.claims.requeue(eaten);
        if (!this.stopped) this.opts.onError(err);
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  stop(): void {
    this.stopped = true;
  }
}
