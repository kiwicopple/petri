// Boot: anonymous auth -> menu -> game -> death -> play again (PLAN.md §13). Browser-only.

import { supabase, signIn } from "./supabase.ts";
import * as actions from "./net/actions.ts";
import { GameSession, type DeathInfo } from "./game/session.ts";
import { Renderer } from "./game/render.ts";
import { Input } from "./game/input.ts";
import { Hud } from "./ui/hud.ts";
import { Menu } from "./ui/menu.ts";
import { DeathScreen } from "./ui/death.ts";
import { el, injectStyles } from "./ui/style.ts";

const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY: string = import.meta.env.VITE_SUPABASE_ANON_KEY;

type Mode = "menu" | "playing" | "dead";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const renderer = new Renderer(canvas, SUPABASE_URL);
const hud = new Hud();
const deathScreen = new DeathScreen();
injectStyles();
const hint = el("div", { class: "pt-hint", hidden: "" }, "mouse steer · space split · W eject · ` debug");
document.body.appendChild(hint);

let mode: Mode = "menu";
let session: GameSession | null = null;
let accessToken: string | null = null;
let last = { name: "", skin: null as string | null };
let fps = 60;
let lastFrame = performance.now();

const input = new Input(canvas, {
  onSplit: () => void session?.split(),
  onEject: () => void session?.eject(),
  onToggleDebug: () => hud.toggleDebug(),
});

const menu = new Menu({
  client: supabase,
  supabaseUrl: SUPABASE_URL,
  onPlay: (name, skin) => void startGame(name, skin, "menu"),
});

function setMode(m: Mode): void {
  mode = m;
  input.enabled = m === "playing";
  hint.hidden = m !== "playing";
  canvas.style.cursor = m === "playing" ? "crosshair" : "default";
}

async function startGame(name: string, skin: string | null, from: "menu" | "death"): Promise<void> {
  last = { name, skin };
  const busy = (b: boolean) => (from === "menu" ? menu.setBusy(b) : deathScreen.setBusy(b));
  const fail = (msg: string) => (from === "menu" ? menu.setError(msg) : deathScreen.setError(msg));
  busy(true);
  try {
    if (session) await session.stop({ leave: session.alive });
    session = null;
    const join = await actions.join(supabase, name, skin);
    const s = await GameSession.start({
      client: supabase,
      join,
      name: name || "Cell",
      skin,
      driveSim: "external",
      onDeath: (info) => onDeath(s, info),
      onError: (where, err) => console.warn(`[petri] ${where}:`, actions.describeError(err)),
    });
    session = s;
    renderer.focus({ x: join.cell.x, y: join.cell.y }, join.cell.mass);
    menu.hide();
    deathScreen.hide();
    setMode("playing");
  } catch (err) {
    console.error(err);
    fail(`Could not join: ${actions.describeError(err)}`);
    busy(false);
  }
}

function onDeath(s: GameSession, info: DeathInfo): void {
  if (s !== session) return;
  setMode("dead");
  deathScreen.show(info, {
    onPlayAgain: () => void startGame(last.name, last.skin, "death"),
    onMenu: () => {
      deathScreen.hide();
      session = null;
      setMode("menu");
      menu.show();
    },
  });
}

function frame(now: number): void {
  const dtMs = now - lastFrame;
  lastFrame = now;
  if (dtMs > 0) fps += (1000 / dtMs - fps) * 0.05;

  const s = session;
  if (s && mode !== "menu") {
    if (mode === "playing") {
      const target = renderer.screenToWorld(input.mouse.x, input.mouse.y);
      s.setTarget(target.x, target.y);
      input.update(now);
    }
    const wall = Date.now();
    s.tick(wall);
    renderer.drawGame(s, wall);
    hud.draw(renderer.ctx, renderer.width, renderer.height, s, renderer.camera, { fps });
  } else {
    renderer.drawIdle(now);
  }
  requestAnimationFrame(frame);
}

/** Best-effort leave_game on tab close (fetch keepalive survives unload; supabase-js does not). */
function leaveOnUnload(): void {
  const s = session;
  if (!s || !s.alive || !accessToken) return;
  void fetch(`${SUPABASE_URL}/rest/v1/rpc/leave_game`, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json", apikey: ANON_KEY, Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ p_player: s.playerId }),
  }).catch(() => {});
}

async function boot(): Promise<void> {
  window.addEventListener("resize", () => renderer.resize());
  window.addEventListener("pagehide", leaveOnUnload);
  supabase.auth.onAuthStateChange((_e, sess) => {
    accessToken = sess?.access_token ?? null;
  });
  requestAnimationFrame(frame);
  setMode("menu");
  try {
    // Sign in before showing the menu: room_list / top_scores / the scores feed need `authenticated`.
    const sess = await signIn();
    accessToken = sess?.access_token ?? null;
    menu.setUser(sess?.user?.id ?? null);
    menu.show();
  } catch (err) {
    console.error(err);
    menu.show();
    menu.setBusy(true);
    menu.setError(`Sign-in failed: ${actions.describeError(err)} — is \`supabase start\` running?`);
  }
}

void boot();
