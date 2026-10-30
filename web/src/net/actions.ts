// RPC + edge-function wrappers (PLAN.md §8, §11). DOM-free; the client is injected.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  EatCellResponse,
  EjectResponse,
  Id,
  JoinResult,
  MergeResponse,
  SplitResponse,
  SyncResponse,
} from "../types.ts";

export class RpcError extends Error {
  constructor(
    readonly fn: string,
    readonly cause: unknown,
  ) {
    super(`${fn}: ${describeError(cause)}`);
  }
}

export function describeError(e: unknown): string {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  const o = e as { message?: string; code?: string; details?: string };
  return [o.code, o.message, o.details].filter(Boolean).join(" ") || JSON.stringify(e);
}

async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new RpcError(fn, error);
  return data as T;
}

/** Invoke the `join` edge function: validates name, matchmakes, spawns. */
export async function join(client: SupabaseClient, name: string, skin: string | null): Promise<JoinResult> {
  const { data, error } = await client.functions.invoke("join", { body: { name, skin } });
  if (error) {
    // FunctionsHttpError carries the Response in `context`; surface its body if present.
    let detail = describeError(error);
    const ctx = (error as { context?: { text?: () => Promise<string> } }).context;
    if (ctx && typeof ctx.text === "function") {
      try {
        detail = (await ctx.text()) || detail;
      } catch {
        /* ignore */
      }
    }
    throw new RpcError("join", detail);
  }
  const res = (typeof data === "string" ? JSON.parse(data) : data) as JoinResult;
  if (!res || !res.player_id || !res.cell) throw new RpcError("join", `unexpected response ${JSON.stringify(data)}`);
  return res;
}

export const playerSync = (client: SupabaseClient, playerId: string, cells: { id: Id; x: number; y: number }[], eaten: Id[]) =>
  rpc<SyncResponse>(client, "player_sync", { p_player: playerId, p_cells: cells, p_eaten: eaten });

export const eatCell = (client: SupabaseClient, eater: Id, victim: Id, ex: number, ey: number) =>
  rpc<EatCellResponse>(client, "eat_cell", { p_eater: eater, p_victim: victim, p_ex: ex, p_ey: ey });

export const split = (client: SupabaseClient, playerId: string, dx: number, dy: number) =>
  rpc<SplitResponse>(client, "split", { p_player: playerId, p_dx: dx, p_dy: dy });

export const eject = (client: SupabaseClient, playerId: string, dx: number, dy: number) =>
  rpc<EjectResponse>(client, "eject", { p_player: playerId, p_dx: dx, p_dy: dy });

export const mergeCells = (client: SupabaseClient, a: Id, b: Id) =>
  rpc<MergeResponse>(client, "merge_cells", { p_a: a, p_b: b });

export const leaveGame = (client: SupabaseClient, playerId: string) =>
  rpc<void>(client, "leave_game", { p_player: playerId });
