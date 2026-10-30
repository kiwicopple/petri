// In-game HUD drawn on the canvas in screen space (PLAN.md §13). Browser-only.

import { radius } from "@shared/game.ts";
import type { GameSession } from "../game/session.ts";
import type { Camera } from "../game/render.ts";

const FONT = "system-ui, -apple-system, Segoe UI, sans-serif";
const MINIMAP = 200;

export interface HudStats {
  fps: number;
}

export class Hud {
  debug = false;

  toggleDebug(): void {
    this.debug = !this.debug;
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, s: GameSession, cam: Camera, stats: HudStats): void {
    this.drawLeaderboard(ctx, w, s);
    this.drawScore(ctx, h, s);
    this.drawMinimap(ctx, w, h, s, cam);
    if (this.debug) this.drawDebug(ctx, s, stats);
  }

  private panel(ctx: CanvasRenderingContext2D, x: number, y: number, pw: number, ph: number): void {
    ctx.fillStyle = "rgba(8,14,26,0.62)";
    ctx.strokeStyle = "rgba(130,200,255,0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, pw, ph, 10);
    ctx.fill();
    ctx.stroke();
  }

  private drawLeaderboard(ctx: CanvasRenderingContext2D, w: number, s: GameSession): void {
    const top = s.world.leaderboard.slice(0, 10);
    const pw = 220;
    const rowH = 20;
    const ph = 40 + Math.max(1, top.length) * rowH;
    const x = w - pw - 14;
    const y = 14;
    this.panel(ctx, x, y, pw, ph);
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.font = `700 15px ${FONT}`;
    ctx.fillStyle = "#cfe6ff";
    ctx.fillText("Leaderboard", x + pw / 2, y + 18);
    ctx.font = `500 13px ${FONT}`;
    if (top.length === 0) {
      ctx.fillStyle = "rgba(200,220,255,0.5)";
      ctx.fillText("waiting for tick…", x + pw / 2, y + 40);
      return;
    }
    top.forEach(([pid, name, mass], i) => {
      const ry = y + 40 + i * rowH;
      const me = pid === s.playerId;
      if (me) {
        ctx.fillStyle = "rgba(255,210,90,0.12)";
        ctx.fillRect(x + 6, ry - rowH / 2, pw - 12, rowH);
      }
      ctx.fillStyle = me ? "#ffd75a" : "#e8f1ff";
      ctx.textAlign = "left";
      const label = `${i + 1}. ${name || "Cell"}`;
      ctx.fillText(label.length > 20 ? label.slice(0, 19) + "…" : label, x + 12, ry);
      ctx.textAlign = "right";
      ctx.fillStyle = me ? "#ffd75a" : "rgba(200,220,255,0.7)";
      ctx.fillText(String(Math.round(mass)), x + pw - 12, ry);
    });
  }

  private drawScore(ctx: CanvasRenderingContext2D, h: number, s: GameSession): void {
    const mass = Math.round(s.world.totalMass());
    const cells = s.world.myCells.size;
    const pw = 190;
    const ph = 54;
    const x = 14;
    const y = h - ph - 14;
    this.panel(ctx, x, y, pw, ph);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `700 20px ${FONT}`;
    ctx.fillStyle = "#e8f1ff";
    ctx.fillText(`Mass ${mass}`, x + 14, y + 20);
    ctx.font = `500 12px ${FONT}`;
    ctx.fillStyle = "rgba(200,220,255,0.65)";
    ctx.fillText(`${cells} cell${cells === 1 ? "" : "s"} · peak ${Math.round(s.world.peakMass)} · kills ${s.world.kills}`, x + 14, y + 40);
  }

  private drawMinimap(ctx: CanvasRenderingContext2D, w: number, h: number, s: GameSession, cam: Camera): void {
    const W = s.world.self.worldSize;
    const x = w - MINIMAP - 14;
    const y = h - MINIMAP - 14;
    const k = MINIMAP / W;
    this.panel(ctx, x, y, MINIMAP, MINIMAP);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, MINIMAP, MINIMAP, 10);
    ctx.clip();
    // blooms
    ctx.globalCompositeOperation = "lighter";
    for (const [bx, by] of s.world.blooms) {
      const g = ctx.createRadialGradient(x + bx * k, y + by * k, 0, x + bx * k, y + by * k, 22);
      g.addColorStop(0, "rgba(110,255,170,0.45)");
      g.addColorStop(1, "rgba(110,255,170,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x + bx * k - 22, y + by * k - 22, 44, 44);
    }
    ctx.globalCompositeOperation = "source-over";
    // viewport
    ctx.strokeStyle = "rgba(200,230,255,0.35)";
    ctx.lineWidth = 1;
    const vw = (w / cam.zoom) * k;
    const vh = (h / cam.zoom) * k;
    ctx.strokeRect(x + cam.x * k - vw / 2, y + cam.y * k - vh / 2, vw, vh);
    // own cells
    ctx.fillStyle = s.world.self.color;
    for (const c of s.world.myCells.values()) {
      ctx.beginPath();
      ctx.arc(x + c.x * k, y + c.y * k, Math.max(2.5, radius(c.mass) * k), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawDebug(ctx: CanvasRenderingContext2D, s: GameSession, stats: HudStats): void {
    const lines = [
      `FPS ${stats.fps.toFixed(0)}`,
      `sync RTT ${s.syncRtt.toFixed(0)} ms`,
      `players ${s.world.playerCount()}`,
      `remote cells ${s.world.remoteCells.length}`,
      `pellets ${s.world.pellets.size} · thorns ${s.world.thorns.size}`,
      `pending claims ${s.claims.size}`,
      `room ${s.world.self.roomId.slice(0, 8)}`,
    ];
    const pw = 210;
    const ph = 12 + lines.length * 17;
    this.panel(ctx, 14, 14, pw, ph);
    ctx.font = `500 12px ui-monospace, Menlo, monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#9fe8c4";
    lines.forEach((l, i) => ctx.fillText(l, 24, 14 + 14 + i * 17));
  }
}
