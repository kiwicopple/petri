// Canvas 2D renderer (PLAN.md §13 render order + visual identity). Browser-only.

import {
  BLOOM_RADIUS,
  PELLET_RADIUS,
  THORN_MASS,
  pelletColor,
  radius,
  zoom as zoomFor,
} from "@shared/game.ts";
import { skinUrl } from "../skins.ts";
import type { GameSession } from "./session.ts";
import type { Pellet } from "./world.ts";
import { EJECT_TWEEN_MS } from "./world.ts";
import type { Point } from "./sim.ts";

const BG = "#04070d";
const SLIDE_INNER = "#0d1626";
const SLIDE_OUTER = "#070c16";
const HEX_SIZE = 40;
const THORN_COLOR = "#9b4dff";
const NAME_MIN_RADIUS = 18;
const SKIN_MIN_RADIUS = 20;

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

// ---- colour helpers ----
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [200, 200, 200];
}
const rgba = (hex: string, a: number) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};
/** Colour mixed toward white by k, with alpha a. */
const lighten = (hex: string, k: number, a = 1) => {
  const [r, g, b] = hexToRgb(hex);
  const f = (c: number) => Math.round(c + (255 - c) * k);
  return `rgba(${f(r)},${f(g)},${f(b)},${a})`;
};

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

// ---- skin image cache ----
type SkinEntry = { img: HTMLImageElement; ok: boolean; failed: boolean };
class SkinCache {
  private map = new Map<string, SkinEntry>();
  get(url: string | null): HTMLImageElement | null {
    if (!url) return null;
    let e = this.map.get(url);
    if (!e) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      e = { img, ok: false, failed: false };
      const entry = e;
      img.onload = () => (entry.ok = true);
      img.onerror = () => (entry.failed = true); // missing preset etc.: just draw without a skin
      img.src = url;
      this.map.set(url, e);
    }
    return e.ok ? e.img : null;
  }
}

interface MotionState {
  x: number;
  y: number;
  v: number; // smoothed speed px/s
  ang: number; // motion direction
}

interface DrawCell {
  kind: "cell";
  id: number;
  x: number;
  y: number;
  mass: number;
  color: string;
  name: string;
  skin: string | null;
  alpha: number;
  own: boolean;
}
interface DrawThorn {
  kind: "thorn";
  id: number;
  x: number;
  y: number;
  mass: number;
}

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  readonly camera: Camera = { x: 3000, y: 3000, zoom: 0.6 };
  width = 0; // CSS px
  height = 0;
  dpr = 1;

  private skins = new SkinCache();
  private glowSprites = new Map<string, HTMLCanvasElement>();
  private hexPattern: CanvasPattern | null = null;
  private thornSprite: HTMLCanvasElement;
  private motion = new Map<number, MotionState>();
  private bloomPos: Point[] = [];
  private lastFrame = 0;
  private idleBlobs: { x: number; y: number; r: number; c: string; vx: number; vy: number; ph: number }[] = [];

  constructor(
    readonly canvas: HTMLCanvasElement,
    private supabaseUrl: string,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.thornSprite = this.buildThornSprite();
    this.resize();
  }

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
  }

  /** Viewport-size factor so bigger windows see proportionally more. */
  private screenScale(): number {
    return Math.max(this.width / 1600, this.height / 900);
  }

  screenToWorld(sx: number, sy: number): Point {
    const c = this.camera;
    return { x: c.x + (sx - this.width / 2) / c.zoom, y: c.y + (sy - this.height / 2) / c.zoom };
  }

  private glow(color: string): HTMLCanvasElement {
    let s = this.glowSprites.get(color);
    if (!s) {
      const [c, g] = makeCanvas(64, 64);
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, rgba(color, 0.9));
      grad.addColorStop(0.25, rgba(color, 0.45));
      grad.addColorStop(1, rgba(color, 0));
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      this.glowSprites.set(color, c);
      s = c;
    }
    return s;
  }

  private buildThornSprite(): HTMLCanvasElement {
    const size = 256;
    const [c, g] = makeCanvas(size, size);
    const cx = size / 2;
    const R = size * 0.4; // body radius maps to radius(THORN_MASS)
    const spikes = 26;
    // halo
    const halo = g.createRadialGradient(cx, cx, R * 0.6, cx, cx, size / 2);
    halo.addColorStop(0, rgba(THORN_COLOR, 0.35));
    halo.addColorStop(1, rgba(THORN_COLOR, 0));
    g.fillStyle = halo;
    g.fillRect(0, 0, size, size);
    // spiky body
    g.beginPath();
    for (let i = 0; i <= spikes * 2; i++) {
      const a = (i / (spikes * 2)) * Math.PI * 2;
      const rr = i % 2 === 0 ? R * 1.18 : R * 0.9;
      const x = cx + Math.cos(a) * rr;
      const y = cx + Math.sin(a) * rr;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    const body = g.createRadialGradient(cx - R * 0.3, cx - R * 0.3, R * 0.1, cx, cx, R * 1.1);
    body.addColorStop(0, "#d8a6ff");
    body.addColorStop(0.45, "#8a3fe0");
    body.addColorStop(1, "#3a1170");
    g.fillStyle = body;
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = "#e3c2ff";
    g.stroke();
    // pores
    g.fillStyle = "rgba(40,6,80,0.45)";
    for (let i = 0; i < 9; i++) {
      const a = i * 2.4;
      const d = R * (0.25 + 0.45 * ((i * 37) % 10) / 10);
      g.beginPath();
      g.arc(cx + Math.cos(a) * d, cx + Math.sin(a) * d, R * 0.07, 0, Math.PI * 2);
      g.fill();
    }
    return c;
  }

  private ensureHexPattern(): CanvasPattern | null {
    if (this.hexPattern) return this.hexPattern;
    const s = HEX_SIZE;
    const w = Math.round(3 * s);
    const h = Math.round(Math.sqrt(3) * s);
    const [c, g] = makeCanvas(w, h);
    g.strokeStyle = "rgba(120,170,255,1)";
    g.lineWidth = 1.2;
    const hex = (cx: number, cy: number) => {
      g.beginPath();
      g.moveTo(cx + s, cy);
      g.lineTo(cx + s / 2, cy + h / 2);
      g.lineTo(cx - s / 2, cy + h / 2);
      g.lineTo(cx - s, cy);
      g.lineTo(cx - s / 2, cy - h / 2);
      g.lineTo(cx + s / 2, cy - h / 2);
      g.closePath();
      g.stroke();
    };
    for (let i = -1; i <= 2; i++) {
      for (let j = -1; j <= 1; j++) hex(i * 1.5 * s, j * h + (Math.abs(i) % 2 ? h / 2 : 0));
    }
    this.hexPattern = this.ctx.createPattern(c, "repeat");
    return this.hexPattern;
  }

  private beginWorld(): void {
    const { ctx, camera: cam, dpr } = this;
    const z = cam.zoom * dpr;
    ctx.setTransform(z, 0, 0, z, (this.width / 2) * dpr - cam.x * z, (this.height / 2) * dpr - cam.y * z);
  }

  private beginScreen(): void {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private viewRect(margin = 0): [number, number, number, number] {
    const c = this.camera;
    const hw = this.width / 2 / c.zoom + margin;
    const hh = this.height / 2 / c.zoom + margin;
    return [c.x - hw, c.y - hh, c.x + hw, c.y + hh];
  }

  private drawSlide(worldSize: number, now: number): void {
    const { ctx } = this;
    this.beginScreen();
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, this.width, this.height);
    this.beginWorld();
    const W = worldSize;
    const corner = W * 0.12;
    const dish = new Path2D();
    dish.roundRect(0, 0, W, W, corner);
    const grad = ctx.createRadialGradient(W / 2, W / 2, W * 0.05, W / 2, W / 2, W * 0.75);
    grad.addColorStop(0, SLIDE_INNER);
    grad.addColorStop(1, SLIDE_OUTER);
    ctx.fillStyle = grad;
    ctx.fill(dish);

    const pat = this.ensureHexPattern();
    if (pat) {
      ctx.save();
      ctx.clip(dish);
      ctx.globalAlpha = Math.min(0.07, Math.max(0.025, this.camera.zoom * 0.08));
      ctx.fillStyle = pat;
      const [x0, y0, x1, y1] = this.viewRect(HEX_SIZE * 2);
      ctx.fillRect(Math.max(0, x0), Math.max(0, y0), Math.min(W, x1) - Math.max(0, x0), Math.min(W, y1) - Math.max(0, y0));
      ctx.restore();
    }
    // dish rim: soft glowing edge
    ctx.save();
    ctx.lineWidth = Math.max(6, 3 / this.camera.zoom);
    ctx.strokeStyle = `rgba(130,200,255,${0.18 + 0.04 * Math.sin(now / 900)})`;
    ctx.shadowColor = "rgba(120,200,255,0.6)";
    ctx.shadowBlur = 24;
    ctx.stroke(dish);
    ctx.restore();
  }

  private drawBlooms(blooms: [number, number][], dt: number): void {
    const { ctx } = this;
    while (this.bloomPos.length < blooms.length) {
      const b = blooms[this.bloomPos.length];
      this.bloomPos.push({ x: b[0], y: b[1] });
    }
    this.bloomPos.length = blooms.length;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const k = Math.min(1, dt * 1.5);
    blooms.forEach(([bx, by], i) => {
      const p = this.bloomPos[i];
      p.x += (bx - p.x) * k;
      p.y += (by - p.y) * k;
      const R = BLOOM_RADIUS * 1.4;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
      g.addColorStop(0, "rgba(110,255,170,0.16)");
      g.addColorStop(0.5, "rgba(80,220,200,0.07)");
      g.addColorStop(1, "rgba(60,180,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(p.x - R, p.y - R, R * 2, R * 2);
    });
    ctx.restore();
  }

  private drawPellets(pellets: Iterable<Pellet>, now: number): void {
    const { ctx } = this;
    const [x0, y0, x1, y1] = this.viewRect(40);
    const R = PELLET_RADIUS * 2.4;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const p of pellets) {
      if (p.hidden || p.kind !== "food") continue;
      if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
      const pulse = 1 + 0.15 * Math.sin(now / 380 + p.id * 1.7);
      const r = R * pulse;
      ctx.drawImage(this.glow(pelletColor(p.id)), p.x - r, p.y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  private drawEjecta(pellets: Iterable<Pellet>, now: number): void {
    const { ctx } = this;
    const [x0, y0, x1, y1] = this.viewRect(200);
    for (const p of pellets) {
      if (p.hidden || p.kind !== "ejecta") continue;
      let x = p.x;
      let y = p.y;
      if (p.from && p.tweenStart !== undefined) {
        const f = Math.min(1, (now - p.tweenStart) / EJECT_TWEEN_MS);
        const e = 1 - (1 - f) * (1 - f) * (1 - f);
        x = p.from[0] + (p.x - p.from[0]) * e;
        y = p.from[1] + (p.y - p.from[1]) * e;
        if (f >= 1) p.from = undefined;
      }
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const r = radius(p.mass);
      const col = pelletColor(p.id);
      ctx.globalAlpha = 0.6;
      ctx.drawImage(this.glow(col), x - r * 1.6, y - r * 1.6, r * 3.2, r * 3.2);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(col, 0.55);
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, r * 0.08);
      ctx.strokeStyle = lighten(col, 0.4);
      ctx.stroke();
    }
  }

  private updateMotion(id: number, x: number, y: number, dt: number, next: Map<number, MotionState>): MotionState {
    const prev = this.motion.get(id);
    let st: MotionState;
    if (prev && dt > 0) {
      const dx = x - prev.x;
      const dy = y - prev.y;
      const inst = Math.hypot(dx, dy) / dt;
      const k = Math.min(1, dt * 8);
      st = {
        x,
        y,
        v: prev.v + (Math.min(inst, 1500) - prev.v) * k,
        ang: inst > 5 ? Math.atan2(dy, dx) : prev.ang,
      };
    } else {
      st = { x, y, v: 0, ang: 0 };
    }
    next.set(id, st);
    return st;
  }

  /** Wobbly membrane outline: vertex jitter grows with speed, slight stretch along motion. */
  private cellPath(c: DrawCell, m: MotionState, t: number): Path2D {
    const r = radius(c.mass);
    const screenR = r * this.camera.zoom;
    const n = Math.max(14, Math.min(72, Math.round(screenR / 2.5)));
    const ph = (c.id % 97) * 0.37;
    const amp = 0.012 + Math.min(0.045, m.v / 6000);
    const stretch = Math.min(0.06, m.v / 5000);
    const path = new Path2D();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const wob =
        Math.sin(a * 3 + t * 2.1 + ph) * 0.6 + Math.sin(a * 5 - t * 3.3 + ph * 2) * 0.3 + Math.sin(a * 8 + t * 4.7) * 0.1;
      const rr = r * (1 + amp * wob + stretch * Math.cos(2 * (a - m.ang)) * 0.5);
      const x = c.x + Math.cos(a) * rr;
      const y = c.y + Math.sin(a) * rr;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    path.closePath();
    return path;
  }

  private drawCell(c: DrawCell, m: MotionState, t: number): void {
    const { ctx } = this;
    const r = radius(c.mass);
    const screenR = r * this.camera.zoom;
    ctx.globalAlpha = c.alpha;
    if (screenR < 2) {
      ctx.fillStyle = c.color;
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(r, 1.5 / this.camera.zoom), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }
    // bloom glow
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.35 * c.alpha;
    const G = r * 1.9;
    ctx.drawImage(this.glow(c.color), c.x - G, c.y - G, G * 2, G * 2);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = c.alpha;

    const path = this.cellPath(c, m, t);
    // translucent cytoplasm
    if (screenR > 10) {
      const g = ctx.createRadialGradient(c.x - r * 0.25, c.y - r * 0.3, r * 0.05, c.x, c.y, r);
      g.addColorStop(0, lighten(c.color, 0.45, 0.32));
      g.addColorStop(0.7, rgba(c.color, 0.42));
      g.addColorStop(1, rgba(c.color, 0.62));
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = rgba(c.color, 0.5);
    }
    ctx.fill(path);

    const img = r > SKIN_MIN_RADIUS ? this.skins.get(skinUrl(this.supabaseUrl, c.skin)) : null;
    if (img) {
      ctx.save();
      ctx.clip(path);
      ctx.globalAlpha = 0.85 * c.alpha;
      ctx.drawImage(img, c.x - r, c.y - r, r * 2, r * 2);
      ctx.restore();
    } else if (screenR > 14) {
      // organelles: a nucleus and a few vacuoles drifting inside
      const ph = (c.id % 61) * 0.9;
      ctx.fillStyle = rgba(c.color, 0.55);
      ctx.beginPath();
      ctx.arc(c.x + Math.cos(t * 0.4 + ph) * r * 0.18, c.y + Math.sin(t * 0.33 + ph) * r * 0.18, r * 0.26, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      for (let i = 0; i < 3; i++) {
        const a = ph + i * 2.1 + t * 0.15;
        ctx.beginPath();
        ctx.arc(c.x + Math.cos(a) * r * 0.55, c.y + Math.sin(a) * r * 0.55, r * 0.09, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // membrane
    ctx.lineWidth = Math.max(1.5 / this.camera.zoom, r * 0.06);
    ctx.strokeStyle = lighten(c.color, 0.35);
    ctx.stroke(path);
    if (screenR > 20) {
      ctx.lineWidth = Math.max(0.8 / this.camera.zoom, r * 0.015);
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
  }

  private drawThorn(th: DrawThorn, t: number): void {
    const { ctx } = this;
    const r = radius(th.mass);
    const S = r / 0.4 / 2; // sprite half-size so body radius == r
    ctx.save();
    ctx.translate(th.x, th.y);
    ctx.rotate(t * 0.15 + (th.id % 17));
    ctx.drawImage(this.thornSprite, -S, -S, S * 2, S * 2);
    ctx.restore();
  }

  private drawLabel(c: DrawCell): void {
    const r = radius(c.mass);
    if (r <= NAME_MIN_RADIUS || r * this.camera.zoom < 9) return;
    const { ctx } = this;
    ctx.globalAlpha = c.alpha;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const fs = Math.max(10, r * 0.34);
    ctx.font = `600 ${fs}px system-ui, -apple-system, Segoe UI, sans-serif`;
    if (c.name) {
      ctx.lineWidth = fs * 0.16;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.strokeText(c.name, c.x, c.y);
      ctx.fillStyle = "#f4f8ff";
      ctx.fillText(c.name, c.x, c.y);
    }
    const ms = Math.max(8, r * 0.22);
    ctx.font = `500 ${ms}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.fillStyle = "rgba(235,245,255,0.75)";
    ctx.fillText(String(Math.round(c.mass)), c.x, c.y + (c.name ? fs * 0.85 : 0));
    ctx.globalAlpha = 1;
  }

  private updateCamera(session: GameSession, dt: number): void {
    const w = session.world;
    let tr = 0;
    for (const c of w.myCells.values()) tr += radius(c.mass);
    const cen = session.alive ? session.centre() : null;
    const cam = this.camera;
    const k = Math.min(1, dt * 6);
    if (cen) {
      cam.x += (cen.x - cam.x) * k;
      cam.y += (cen.y - cam.y) * k;
    }
    if (tr > 0) {
      const target = zoomFor(tr) * this.screenScale();
      cam.zoom += (target - cam.zoom) * Math.min(1, dt * 2.5);
    }
  }

  /** Snap camera on session start. */
  focus(p: Point, mass = 20): void {
    this.camera.x = p.x;
    this.camera.y = p.y;
    this.camera.zoom = zoomFor(radius(mass)) * this.screenScale();
  }

  /** Draw the full game scene for one frame (excluding the HUD). */
  drawGame(session: GameSession, now: number): void {
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 1 / 60;
    this.lastFrame = now;
    const t = now / 1000;
    const w = session.world;
    this.updateCamera(session, dt);

    this.drawSlide(w.self.worldSize, now);
    this.beginWorld();
    this.drawBlooms(w.blooms, dt);
    this.drawPellets(w.pellets.values(), now);
    this.drawEjecta(w.pellets.values(), now);

    // cells + thorns, sorted by mass ascending
    const [x0, y0, x1, y1] = this.viewRect(0);
    const items: (DrawCell | DrawThorn)[] = [];
    const inView = (x: number, y: number, r: number) => x + r >= x0 && x - r <= x1 && y + r >= y0 && y - r <= y1;
    const a = session.simAlpha;
    for (const c of w.myCells.values()) {
      const x = c.prevX + (c.x - c.prevX) * a;
      const y = c.prevY + (c.y - c.prevY) * a;
      if (!inView(x, y, radius(c.mass) * 1.2)) continue;
      items.push({ kind: "cell", id: c.id, x, y, mass: c.mass, color: w.self.color, name: w.self.name, skin: w.self.skin, alpha: 1, own: true });
    }
    for (const c of w.remoteCells) {
      if (!inView(c.x, c.y, radius(c.mass) * 1.2)) continue;
      const rp = w.remotePlayers.get(c.playerId);
      items.push({
        kind: "cell",
        id: c.id,
        x: c.x,
        y: c.y,
        mass: c.mass,
        color: rp?.color ?? "#888",
        name: rp?.name ?? "",
        skin: rp?.skin ?? null,
        alpha: Math.max(0, Math.min(1, c.alpha)),
        own: false,
      });
    }
    for (const th of w.thorns.values()) {
      if (th.hidden || !inView(th.x, th.y, radius(THORN_MASS) * 1.3)) continue;
      items.push({ kind: "thorn", id: th.id, x: th.x, y: th.y, mass: th.mass || THORN_MASS });
    }
    items.sort((p, q) => p.mass - q.mass);

    const next = new Map<number, MotionState>();
    const cells: [DrawCell, MotionState][] = [];
    for (const it of items) {
      if (it.kind === "thorn") this.drawThorn(it, t);
      else {
        const m = this.updateMotion(it.id, it.x, it.y, dt, next);
        this.drawCell(it, m, t);
        cells.push([it, m]);
      }
    }
    this.motion = next;
    for (const [c] of cells) this.drawLabel(c);
    this.beginScreen();
  }

  /** Animated background for the menu. */
  drawIdle(now: number): void {
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 1 / 60;
    this.lastFrame = now;
    const W = 6000;
    if (this.idleBlobs.length === 0) {
      const cols = ["#e0457b", "#2fa4e7", "#1fc2b0", "#7b4fd1", "#f2d43d", "#3fcf6e", "#ef5b3a"];
      for (let i = 0; i < 14; i++) {
        this.idleBlobs.push({
          x: 2400 + Math.random() * 1200,
          y: 2600 + Math.random() * 800,
          r: 20 + Math.random() * 220,
          c: cols[i % cols.length],
          vx: (Math.random() - 0.5) * 30,
          vy: (Math.random() - 0.5) * 30,
          ph: Math.random() * 10,
        });
      }
      this.camera.x = 3000;
      this.camera.y = 3000;
    }
    this.camera.zoom = 0.7 * this.screenScale();
    this.drawSlide(W, now);
    this.beginWorld();
    const t = now / 1000;
    this.drawBlooms([[3000 + Math.cos(t * 0.1) * 250, 3000 + Math.sin(t * 0.13) * 180]], dt);
    const next = new Map<number, MotionState>();
    this.idleBlobs.forEach((b, i) => {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (Math.abs(b.x - 3000) > 900) b.vx = -b.vx;
      if (Math.abs(b.y - 3000) > 600) b.vy = -b.vy;
      const mass = (b.r / 10) ** 2;
      const id = -1 - i;
      const m = this.updateMotion(id, b.x, b.y, dt, next);
      this.drawCell({ kind: "cell", id: 1000 + i, x: b.x, y: b.y, mass, color: b.c, name: "", skin: null, alpha: 0.5, own: false }, m, t + b.ph);
    });
    this.motion = next;
    this.beginScreen();
  }
}
