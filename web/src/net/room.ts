// Room channel: join, presence, broadcast handlers, state send, initial load (PLAN.md §9).
// DOM-free; the Supabase client is injected.

import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type {
  BloomsPayload,
  CellEatenPayload,
  CellRow,
  CellTuple,
  EjectedPayload,
  LeaderboardPayload,
  PelletRow,
  PelletsEatenPayload,
  PelletsSpawnedPayload,
  PlayerDiedPayload,
  PlayerLeftPayload,
  PlayerRow,
  PresenceMeta,
  StatePayload,
} from "../types.ts";
import type { World } from "../game/world.ts";

const round1 = (v: number) => Math.round(v * 10) / 10;
const PAGE = 1000; // PostgREST default max_rows

export interface RoomHooks {
  now: () => number;
  /** Any player_died event (self or other). */
  onPlayerDied?: (e: PlayerDiedPayload) => void;
  onCellEaten?: (e: CellEatenPayload) => void;
  onPelletsEaten?: (e: PelletsEatenPayload) => void;
  onLeaderboard?: (e: LeaderboardPayload) => void;
  onError?: (where: string, err: unknown) => void;
}

type Buffered = { event: string; payload: unknown };

export class RoomConnection {
  channel: RealtimeChannel | null = null;
  private loading = true;
  private buffered: Buffered[] = [];
  private pendingMeta = new Set<string>();
  closed = false;

  constructor(
    private client: SupabaseClient,
    private world: World,
    private hooks: RoomHooks,
  ) {}

  get topic(): string {
    return `room:${this.world.self.roomId}`;
  }

  /** Subscribe (buffering pellet events), load the snapshot via REST, flush, track presence. */
  async connect(timeoutMs = 10000): Promise<void> {
    const { self } = this.world;
    const ch = this.client.channel(this.topic, {
      config: { private: true, broadcast: { self: false, ack: false }, presence: { key: self.playerId } },
    });
    this.channel = ch;

    ch.on("broadcast", { event: "state" }, (m) => this.onState(m.payload as StatePayload));
    for (const ev of ["pellets_spawned", "pellets_eaten", "ejected", "cell_eaten", "player_died", "player_left", "leaderboard", "blooms"]) {
      ch.on("broadcast", { event: ev }, (m) => this.onDbEvent(ev, m.payload));
    }
    ch.on("presence", { event: "sync" }, () => this.onPresenceSync());
    ch.on("presence", { event: "leave" }, ({ key, currentPresences }) => {
      if (key && key !== self.playerId && (!currentPresences || currentPresences.length === 0)) {
        this.world.removeRemote(key);
      }
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      ch.subscribe((status, err) => {
        if (settled) {
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") this.hooks.onError?.("channel", err ?? status);
          return;
        }
        if (status === "SUBSCRIBED") {
          settled = true;
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          settled = true;
          reject(new Error(`channel ${this.topic}: ${status}${err ? ` ${err.message}` : ""}`));
        }
      }, timeoutMs);
    });

    try {
      await this.loadInitial();
    } finally {
      this.loading = false;
      const buf = this.buffered;
      this.buffered = [];
      for (const b of buf) this.applyDbEvent(b.event, b.payload);
    }

    const meta: PresenceMeta = { player_id: self.playerId, name: self.name, color: self.color, skin: self.skin };
    const res = await ch.track(meta);
    if (res !== "ok") this.hooks.onError?.("presence.track", res);
  }

  private async loadInitial(): Promise<void> {
    const roomId = this.world.self.roomId;
    const pellets: PelletRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.client
        .from("pellets")
        .select("id,kind,x,y,mass")
        .eq("room_id", roomId)
        .order("id")
        .range(from, from + PAGE - 1);
      if (error) throw error;
      pellets.push(...((data ?? []) as PelletRow[]));
      if (!data || data.length < PAGE) break;
    }
    const [players, cells] = await Promise.all([
      this.client.from("players").select("id,name,color,skin").eq("room_id", roomId).eq("status", "alive"),
      this.client.from("cells").select("id,player_id,x,y,mass").eq("room_id", roomId),
    ]);
    if (players.error) throw players.error;
    if (cells.error) throw cells.error;

    for (const p of pellets) this.world.addPellet(p);
    for (const p of (players.data ?? []) as PlayerRow[]) this.world.upsertRemote(p);
    this.world.seedRemoteCells((cells.data ?? []) as CellRow[], this.hooks.now());
  }

  private onState(s: StatePayload): void {
    if (this.closed) return;
    const rp = this.world.applyState(s, this.hooks.now());
    if (rp && !rp.known) this.fetchMeta(rp.id);
  }

  /** Lazily fetch name/colour for a player we saw in a broadcast before presence. */
  private fetchMeta(id: string): void {
    if (this.pendingMeta.has(id)) return;
    this.pendingMeta.add(id);
    void this.client
      .from("players")
      .select("id,name,color,skin")
      .eq("id", id)
      .maybeSingle()
      .then(({ data }) => {
        const rp = this.world.remotePlayers.get(id);
        if (data && rp && !rp.known) this.world.upsertRemote(data as PlayerRow);
        setTimeout(() => this.pendingMeta.delete(id), 3000);
      });
  }

  private onPresenceSync(): void {
    if (!this.channel || this.closed) return;
    const state = this.channel.presenceState<PresenceMeta>();
    for (const [key, metas] of Object.entries(state)) {
      if (key === this.world.self.playerId) continue;
      const m = metas[metas.length - 1];
      if (m && m.name !== undefined) {
        this.world.upsertRemote({ id: m.player_id ?? key, name: m.name, color: m.color, skin: m.skin ?? null });
      }
    }
  }

  private onDbEvent(event: string, payload: unknown): void {
    if (this.closed) return;
    if (this.loading && (event === "pellets_spawned" || event === "pellets_eaten" || event === "ejected")) {
      this.buffered.push({ event, payload });
      return;
    }
    this.applyDbEvent(event, payload);
  }

  private applyDbEvent(event: string, payload: unknown): void {
    const now = this.hooks.now();
    const w = this.world;
    try {
      switch (event) {
        case "pellets_spawned":
          w.applyPelletsSpawned(payload as PelletsSpawnedPayload);
          break;
        case "pellets_eaten": {
          const e = payload as PelletsEatenPayload;
          w.applyPelletsEaten(e);
          this.hooks.onPelletsEaten?.(e);
          break;
        }
        case "ejected":
          w.applyEjected(payload as EjectedPayload, now);
          break;
        case "cell_eaten": {
          const e = payload as CellEatenPayload;
          w.applyCellEaten(e, now);
          this.hooks.onCellEaten?.(e);
          break;
        }
        case "player_died": {
          const e = payload as PlayerDiedPayload;
          if (e.player_id !== w.self.playerId) w.removeRemote(e.player_id);
          this.hooks.onPlayerDied?.(e);
          break;
        }
        case "player_left": {
          const e = payload as PlayerLeftPayload;
          if (e.player_id !== w.self.playerId) w.removeRemote(e.player_id);
          break;
        }
        case "leaderboard": {
          const e = payload as LeaderboardPayload;
          w.applyLeaderboard(e);
          this.hooks.onLeaderboard?.(e);
          break;
        }
        case "blooms":
          w.applyBlooms(payload as BloomsPayload);
          break;
      }
    } catch (err) {
      this.hooks.onError?.(`event:${event}`, err);
    }
  }

  /** Broadcast own cell positions (15 Hz). */
  sendState(): void {
    const ch = this.channel;
    if (!ch || this.closed || this.world.myCells.size === 0) return;
    const c: CellTuple[] = [];
    for (const cell of this.world.myCells.values()) c.push([cell.id, round1(cell.x), round1(cell.y), round1(cell.mass)]);
    const payload: StatePayload = { p: this.world.self.playerId, t: this.hooks.now(), c };
    void ch.send({ type: "broadcast", event: "state", payload }).then((r) => {
      if (r !== "ok") this.hooks.onError?.("broadcast.state", r);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const ch = this.channel;
    this.channel = null;
    if (!ch) return;
    try {
      await ch.untrack();
    } catch {
      /* ignore */
    }
    await this.client.removeChannel(ch);
  }
}
