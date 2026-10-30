// Headless bot swarm (PLAN.md §14). Each bot is a full GameSession driven by simple steering.
//
//   npm run bots -- --count 20 --duration 180
//
// Flags: --count N (default 15), --room auto (join always matchmakes; other values are ignored),
//        --duration S (exit after S seconds with a summary; default: run until SIGINT).

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { EAT_RATIO } from "@shared/game.ts";
import { join, describeError } from "../web/src/net/actions.ts";
import { GameSession, type DeathInfo } from "../web/src/game/session.ts";

// ---- CLI / env ----

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const COUNT = Math.max(1, Number(arg("count", "15")) || 15);
const DURATION = Number(arg("duration", "0")) || 0;
const ROOM = arg("room", "auto");
if (ROOM !== "auto") console.warn(`--room ${ROOM}: join always matchmakes; ignoring`);

function loadEnv(): { url: string; key: string } {
  const env: Record<string, string> = {};
  try {
    const text = readFileSync(new URL("../web/.env.local", import.meta.url), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* fall through to process.env */
  }
  const url = env.VITE_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing (web/.env.local)");
  return { url, key };
}
const { url: SUPABASE_URL, key: SUPABASE_KEY } = loadEnv();

// ---- stats ----

const RPC_NAMES = new Set(["player_sync", "eat_cell", "split", "eject", "merge_cells", "leave_game"]);
const RATE_RE = /rate.?limit|too many|exceeded|limit/i;
const stats = {
  deaths: 0,
  kills: 0,
  starts: 0,
  rpcErrors: new Map<string, number>(),
  otherErrors: new Map<string, number>(),
  eatResults: new Map<string, number>(),
  rateLimit: 0,
  rttSum: 0,
  rttN: 0,
  peaks: [] as number[],
};
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a: unknown[]) => console.log(ts(), ...a);
const shortMsg = (s: string) => s.replace(/\s+/g, " ").slice(0, 120);

function noteRateLimit(where: string, detail: string): void {
  stats.rateLimit++;
  log(`RATE-LIMIT [${where}] ${shortMsg(detail)}`);
}

// ---- one bot ----

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class Bot {
  readonly client: SupabaseClient;
  session: GameSession | null = null;
  peak = 0;
  private steer: ReturnType<typeof setInterval> | null = null;
  private rtt: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lastSplit = 0;

  constructor(readonly n: number) {
    this.client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: {
        params: { eventsPerSecond: 50 },
        logger: (kind: string, msg: string, data?: unknown) => this.onRealtimeLog(kind, msg, data),
      },
    });
    this.instrument();
  }

  private get tag(): string {
    return `bot${String(this.n).padStart(2, "0")}`;
  }

  /** Count every RPC error exactly and tally eat_cell ok:false reasons (benign). */
  private instrument(): void {
    const orig = this.client.rpc.bind(this.client) as (fn: string, args?: unknown, opts?: unknown) => PromiseLike<{
      data: unknown;
      error: { code?: string; message?: string } | null;
    }>;
    (this.client as unknown as { rpc: unknown }).rpc = (fn: string, args?: unknown, opts?: unknown) => {
      const p = orig(fn, args, opts);
      return Promise.resolve(p).then((res) => {
        if (res.error) {
          const detail = describeError(res.error);
          bump(stats.rpcErrors, `${fn}: ${shortMsg(res.error.code ?? detail)}`);
          if (RATE_RE.test(detail)) noteRateLimit(`${this.tag} rpc ${fn}`, detail);
          else log(`${this.tag} RPC-ERROR ${fn}: ${shortMsg(detail)}`);
        } else if (fn === "eat_cell") {
          const d = res.data as { ok?: boolean; reason?: string } | null;
          bump(stats.eatResults, d?.ok ? "ok" : (d?.reason ?? "no-reason"));
        }
        return res;
      });
    };
  }

  private onRealtimeLog(kind: string, msg: string, data?: unknown): void {
    const text = `${msg} ${data === undefined ? "" : safeJson(data)}`;
    if (/system/i.test(msg) || /"status":"error"/.test(text) || /error/i.test(kind)) {
      if (kind === "push" || kind === "transport") return;
      if (/"status":"ok"/.test(text) && !/error/i.test(text)) return;
      if (RATE_RE.test(text)) noteRateLimit(`${this.tag} realtime`, text);
      else if (/"status":"error"|error/i.test(text)) {
        bump(stats.otherErrors, `realtime: ${shortMsg(msg)}`);
        log(`${this.tag} REALTIME-ERROR ${shortMsg(text)}`);
      }
    }
  }

  async signIn(): Promise<void> {
    const res = await this.client.auth.signInAnonymously();
    if (res.error) throw res.error;
    await this.client.realtime.setAuth();
  }

  /** Join + start a session. Throws on failure. */
  private async spawn(): Promise<void> {
    const name = `Bot${this.n}`;
    const jr = await join(this.client, name, null);
    const s = await GameSession.start({
      client: this.client,
      join: jr,
      name,
      skin: null,
      onDeath: (info) => this.onDeath(info),
      onError: (where, err) => this.onError(where, err),
    });
    this.session = s;
    stats.starts++;
    this.steer = setInterval(() => this.think(), 100);
    this.rtt = setInterval(() => {
      if (s.alive && s.syncRtt > 0) {
        stats.rttSum += s.syncRtt;
        stats.rttN++;
      }
    }, 2000);
  }

  /** Run the join/respawn loop until stopped. */
  async run(): Promise<void> {
    let fails = 0;
    while (!this.stopped) {
      try {
        await this.spawn();
        fails = 0;
        await this.untilDead();
      } catch (err) {
        fails++;
        const detail = describeError(err);
        bump(stats.otherErrors, `spawn: ${shortMsg(detail)}`);
        if (RATE_RE.test(detail)) noteRateLimit(`${this.tag} spawn`, detail);
        else log(`${this.tag} SPAWN-ERROR ${shortMsg(detail)}`);
        this.teardown();
        await sleep(Math.min(10000, 1000 * fails));
      }
    }
  }

  private deathWaiter: (() => void) | null = null;
  private untilDead(): Promise<void> {
    return new Promise((resolve) => {
      this.deathWaiter = resolve;
    });
  }

  private onDeath(info: DeathInfo): void {
    stats.deaths++;
    stats.kills += info.kills;
    stats.peaks.push(info.peakMass);
    this.peak = Math.max(this.peak, info.peakMass);
    log(
      `${this.tag} died (${info.reason}) by ${info.killerName ?? "?"} peak=${Math.round(info.peakMass)} kills=${info.kills} survived=${info.survivedSeconds}s`,
    );
    this.teardown(true);
    if (this.stopped) return;
    setTimeout(() => this.deathWaiter?.(), 3000);
  }

  private onError(where: string, err: unknown): void {
    const detail = describeError(err);
    if (RATE_RE.test(detail)) {
      noteRateLimit(`${this.tag} ${where}`, detail);
      return;
    }
    // RPC errors are counted exactly by the rpc wrapper; count everything else (channel, presence, broadcast, events) here.
    if (!RPC_NAMES.has(where)) bump(stats.otherErrors, `${where}: ${shortMsg(detail)}`);
    log(`${this.tag} ERROR [${where}] ${shortMsg(detail)}`);
  }

  private teardown(dead = false): void {
    if (this.steer) clearInterval(this.steer);
    if (this.rtt) clearInterval(this.rtt);
    this.steer = this.rtt = null;
    const s = this.session;
    if (s && !dead) void s.stop({ leave: false }).catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.steer) clearInterval(this.steer);
    if (this.rtt) clearInterval(this.rtt);
    this.steer = this.rtt = null;
    const s = this.session;
    if (s) {
      if (s.alive) {
        stats.peaks.push(s.world.peakMass);
        this.peak = Math.max(this.peak, s.world.peakMass);
        stats.kills += s.world.kills;
      }
      await s.stop({ leave: true }).catch(() => {});
    }
    this.deathWaiter?.();
  }

  /** Steering per PLAN.md §14. */
  private think(): void {
    const s = this.session;
    if (!s || !s.alive) return;
    const w = s.world;
    const mine = [...w.myCells.values()];
    if (!mine.length) return;
    const c = s.centre();
    const mass = Math.max(...mine.map((m) => m.mass));
    const total = mine.reduce((a, m) => a + m.mass, 0);

    // 1. Flee: nearest threatening cell within 500 px.
    let threat: { x: number; y: number } | null = null;
    let threatD = 500;
    // 2. Chase: nearest edible cell within 400 px.
    let prey: { x: number; y: number; mass: number } | null = null;
    let preyD = 400;
    for (const rc of w.remoteCells) {
      if (rc.alpha < 0.5) continue;
      const d = Math.hypot(rc.x - c.x, rc.y - c.y);
      if (rc.mass >= EAT_RATIO * mass * 0.95 && d < threatD) {
        threat = rc;
        threatD = d;
      } else if (mass >= EAT_RATIO * 1.05 * rc.mass && d < preyD) {
        prey = rc;
        preyD = d;
      }
    }

    if (threat) {
      const dx = c.x - threat.x;
      const dy = c.y - threat.y;
      const d = Math.hypot(dx, dy) || 1;
      let tx = c.x + (dx / d) * 600;
      let ty = c.y + (dy / d) * 600;
      const ws = w.self.worldSize;
      // Don't flee into a wall: bias toward the centre when near an edge.
      if (tx < 150 || tx > ws - 150 || ty < 150 || ty > ws - 150) {
        tx = (tx + ws / 2) / 2;
        ty = (ty + ws / 2) / 2;
      }
      s.setTarget(clamp(tx, 0, ws), clamp(ty, 0, ws));
      return;
    }
    if (prey) {
      s.setTarget(prey.x, prey.y);
      const now = Date.now();
      if (preyD < 250 && prey.mass < total * 0.4 && now - this.lastSplit > 1500) {
        this.lastSplit = now;
        void s.split();
      }
      return;
    }

    // 3. Nearest pellet (expanding search), else nearest bloom.
    let best: { x: number; y: number } | null = null;
    for (const r of [250, 700, 1600]) {
      let bd = Infinity;
      w.pelletGrid.queryCircle(c.x, c.y, r, (p) => {
        if (p.hidden) return;
        const d = Math.hypot(p.x - c.x, p.y - c.y);
        if (d < bd) {
          bd = d;
          best = p;
        }
      });
      if (best) break;
    }
    if (!best) {
      let bd = Infinity;
      for (const [bx, by] of w.blooms) {
        const d = Math.hypot(bx - c.x, by - c.y);
        if (d < bd) {
          bd = d;
          best = { x: bx, y: by };
        }
      }
    }
    // Avoid thorns when big enough to burst.
    if (mass > 130 && best) {
      for (const t of w.thorns.values()) {
        if (Math.hypot(t.x - (best as { x: number }).x, t.y - (best as { y: number }).y) < 120) {
          best = null;
          break;
        }
      }
    }
    if (best) s.setTarget((best as { x: number; y: number }).x, (best as { x: number; y: number }).y);
    else {
      const ws = w.self.worldSize;
      s.setTarget(ws / 2 + (Math.random() - 0.5) * 2000, ws / 2 + (Math.random() - 0.5) * 2000);
    }
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

// ---- main ----

const bots: Bot[] = [];
let finished = false;

function fmtMap(m: Map<string, number>): string {
  if (!m.size) return "none";
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join("; ");
}

function summary(): void {
  const rpcTotal = [...stats.rpcErrors.values()].reduce((a, b) => a + b, 0);
  const otherTotal = [...stats.otherErrors.values()].reduce((a, b) => a + b, 0);
  const peaks = stats.peaks.map(Math.round).sort((a, b) => b - a);
  console.log("\n===== bots summary =====");
  console.log(`bots: ${bots.length}  sessions started: ${stats.starts}`);
  console.log(`deaths: ${stats.deaths}  kills: ${stats.kills}`);
  console.log(`RPC errors: ${rpcTotal} (${fmtMap(stats.rpcErrors)})`);
  console.log(`other errors (channel/spawn/realtime): ${otherTotal} (${fmtMap(stats.otherErrors)})`);
  console.log(`rate-limit errors: ${stats.rateLimit}`);
  console.log(`eat_cell results (benign ok:false are not errors): ${fmtMap(stats.eatResults)}`);
  console.log(`avg syncRtt: ${stats.rttN ? (stats.rttSum / stats.rttN).toFixed(1) : "n/a"} ms (${stats.rttN} samples)`);
  console.log(
    `peak masses: max=${peaks[0] ?? 0} median=${peaks[Math.floor(peaks.length / 2)] ?? 0} top10=[${peaks.slice(0, 10).join(", ")}]`,
  );
}

async function shutdown(code = 0): Promise<void> {
  if (finished) return;
  finished = true;
  log("stopping bots...");
  await Promise.race([Promise.all(bots.map((b) => b.stop())), sleep(8000)]);
  summary();
  process.exit(code);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

async function main(): Promise<void> {
  log(`starting ${COUNT} bots against ${SUPABASE_URL}${DURATION ? ` for ${DURATION}s` : ""}`);
  if (DURATION) setTimeout(() => void shutdown(), DURATION * 1000);
  const status = setInterval(() => {
    const alive = bots.filter((b) => b.session?.alive).length;
    const mass = bots.reduce((a, b) => a + (b.session?.alive ? b.session.world.totalMass() : 0), 0);
    log(
      `status: alive=${alive}/${bots.length} deaths=${stats.deaths} kills=${stats.kills} rpcErr=${[...stats.rpcErrors.values()].reduce((a, c) => a + c, 0)} rateLimit=${stats.rateLimit} avgMass=${alive ? Math.round(mass / alive) : 0}`,
    );
  }, 15000);
  status.unref();

  for (let i = 0; i < COUNT && !finished; i++) {
    const bot = new Bot(i + 1);
    bots.push(bot);
    void (async () => {
      for (let attempt = 1; !finished; attempt++) {
        try {
          await bot.signIn();
          break;
        } catch (err) {
          bump(stats.otherErrors, `signIn: ${shortMsg(describeError(err))}`);
          log(`bot${i + 1} SIGNIN-ERROR ${shortMsg(describeError(err))}`);
          await sleep(1000 * attempt);
        }
      }
      if (!finished) await bot.run();
    })();
    await sleep(200);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
