// Death screen: stats + play again (PLAN.md §13). Browser-only.

import type { DeathInfo } from "../game/session.ts";
import { el, injectStyles } from "./style.ts";

export interface DeathHandlers {
  onPlayAgain: () => void;
  onMenu: () => void;
}

const fmtTime = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);

export class DeathScreen {
  readonly root: HTMLDivElement;
  private title: HTMLHeadingElement;
  private sub: HTMLDivElement;
  private stats: HTMLDivElement;
  private again: HTMLButtonElement;
  private menu: HTMLButtonElement;
  private err: HTMLDivElement;
  private h: DeathHandlers | null = null;

  constructor() {
    injectStyles();
    this.title = el("h2", {}, "Consumed");
    this.sub = el("div", { class: "pt-note" });
    this.stats = el("div", { class: "pt-stats" });
    this.again = el("button", { class: "pt-btn" }, "Play again");
    this.menu = el("button", { class: "pt-btn ghost" }, "Main menu");
    this.err = el("div", { class: "pt-err" });
    this.again.addEventListener("click", () => this.h?.onPlayAgain());
    this.menu.addEventListener("click", () => this.h?.onMenu());
    this.root = el(
      "div",
      { class: "pt-overlay", hidden: "" },
      el("div", { class: "pt-card pt-death" }, this.title, this.sub, this.stats, this.again, this.menu, this.err),
    );
    document.body.appendChild(this.root);
  }

  show(info: DeathInfo, h: DeathHandlers): void {
    this.h = h;
    this.title.textContent = info.reason === "eaten" ? "Consumed" : info.reason === "left" ? "Removed from dish" : "Dissolved";
    this.sub.textContent =
      info.reason === "eaten" ? `eaten by ${info.killerName || "a larger cell"}` : info.reason === "left" ? "connection went stale" : "";
    const stat = (v: string, label: string) => el("div", { class: "pt-stat" }, el("b", {}, v), el("span", {}, label));
    this.stats.replaceChildren(
      stat(String(Math.round(info.peakMass)), "peak mass"),
      stat(String(info.kills), "kills"),
      stat(fmtTime(info.survivedSeconds), "survived"),
      stat(info.killerName || "—", "killer"),
    );
    this.setBusy(false);
    this.setError("");
    this.root.hidden = false;
    setTimeout(() => this.again.focus(), 0);
  }

  hide(): void {
    this.root.hidden = true;
  }

  setBusy(busy: boolean): void {
    this.again.disabled = busy;
    this.menu.disabled = busy;
    this.again.textContent = busy ? "Joining…" : "Play again";
  }

  setError(msg: string): void {
    this.err.textContent = msg;
  }
}
