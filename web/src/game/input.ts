// Mouse -> world target, Space = split, W = eject, ` = debug overlay. Browser-only.

export interface InputHandlers {
  onSplit: () => void;
  onEject: () => void;
  onToggleDebug: () => void;
}

const EJECT_REPEAT_MS = 110;

export class Input {
  /** Mouse position in CSS pixels relative to the viewport. */
  mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  enabled = false;
  private ejectHeld = false;
  private lastEject = 0;
  private ac = new AbortController();

  constructor(
    target: HTMLElement,
    private h: InputHandlers,
  ) {
    const opts = { signal: this.ac.signal };
    target.addEventListener("mousemove", (e) => this.setMouse(e.clientX, e.clientY), opts);
    target.addEventListener(
      "touchmove",
      (e) => {
        const t = e.touches[0];
        if (t) this.setMouse(t.clientX, t.clientY);
      },
      { ...opts, passive: true },
    );
    window.addEventListener("keydown", (e) => this.onKey(e, true), opts);
    window.addEventListener("keyup", (e) => this.onKey(e, false), opts);
    window.addEventListener("blur", () => (this.ejectHeld = false), opts);
  }

  private setMouse(x: number, y: number): void {
    this.mouse.x = x;
    this.mouse.y = y;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    if (down && (e.key === "`" || e.code === "Backquote")) {
      this.h.onToggleDebug();
      e.preventDefault();
      return;
    }
    if (!this.enabled) return;
    if (e.code === "Space") {
      e.preventDefault();
      if (down && !e.repeat) this.h.onSplit();
    } else if (e.code === "KeyW") {
      this.ejectHeld = down;
      if (down) this.fireEject(performance.now());
    }
  }

  private fireEject(now: number): void {
    if (now - this.lastEject < EJECT_REPEAT_MS) return;
    this.lastEject = now;
    this.h.onEject();
  }

  /** Call once per frame: repeats eject while W is held. */
  update(now: number): void {
    if (this.enabled && this.ejectHeld) this.fireEject(now);
  }

  dispose(): void {
    this.ac.abort();
  }
}
