// Shared DOM overlay styles for menu + death screen. Browser-only.

const CSS = `
.pt-overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  font-family: system-ui, -apple-system, Segoe UI, sans-serif; color: #e8f1ff; z-index: 10;
  background: radial-gradient(ellipse at center, rgba(4,8,16,0.25), rgba(2,4,10,0.75)); }
.pt-overlay[hidden] { display: none; }
.pt-card { background: rgba(9,16,30,0.82); border: 1px solid rgba(130,200,255,0.2); border-radius: 18px;
  box-shadow: 0 0 60px rgba(60,160,255,0.15), inset 0 0 30px rgba(120,200,255,0.05); backdrop-filter: blur(6px);
  padding: 26px 28px; }
.pt-menu { display: grid; grid-template-columns: 340px 280px; gap: 20px; max-width: 96vw; max-height: 92vh; }
.pt-menu .pt-side { display: flex; flex-direction: column; gap: 16px; min-height: 0; }
.pt-title { font-size: 54px; font-weight: 800; letter-spacing: 2px; margin: 0;
  background: linear-gradient(90deg,#e0457b,#7b4fd1,#2fa4e7,#1fc2b0); -webkit-background-clip: text;
  background-clip: text; color: transparent; text-shadow: 0 0 30px rgba(120,200,255,0.25); }
.pt-sub { margin: 2px 0 18px; color: rgba(200,220,255,0.6); font-size: 13px; }
.pt-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: rgba(200,220,255,0.55); margin: 14px 0 6px; }
.pt-input { width: 100%; box-sizing: border-box; padding: 11px 14px; font-size: 17px; border-radius: 10px;
  border: 1px solid rgba(130,200,255,0.3); background: rgba(0,0,0,0.35); color: #fff; outline: none; }
.pt-input:focus { border-color: #2fa4e7; box-shadow: 0 0 0 3px rgba(47,164,231,0.25); }
.pt-skins { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
.pt-skin { aspect-ratio: 1; border-radius: 50%; border: 2px solid rgba(130,200,255,0.18); background: rgba(255,255,255,0.04);
  cursor: pointer; overflow: hidden; display: flex; align-items: center; justify-content: center; font-size: 11px;
  color: rgba(220,235,255,0.75); position: relative; padding: 0; }
.pt-skin img { width: 100%; height: 100%; object-fit: cover; }
.pt-skin.sel { border-color: #ffd75a; box-shadow: 0 0 14px rgba(255,215,90,0.45); }
.pt-skin:hover { border-color: rgba(130,200,255,0.6); }
.pt-btn { margin-top: 18px; width: 100%; padding: 13px; font-size: 18px; font-weight: 700; border: 0; border-radius: 12px;
  color: #04121c; cursor: pointer; background: linear-gradient(90deg,#1fc2b0,#2fa4e7); box-shadow: 0 0 24px rgba(47,164,231,0.35); }
.pt-btn:disabled { opacity: 0.55; cursor: wait; }
.pt-btn.ghost { background: transparent; color: #cfe6ff; border: 1px solid rgba(130,200,255,0.35); box-shadow: none; margin-top: 10px; font-size: 15px; }
.pt-err { color: #ff8a8a; font-size: 13px; min-height: 18px; margin-top: 8px; }
.pt-note { color: rgba(200,220,255,0.5); font-size: 12px; margin-top: 6px; }
.pt-list { list-style: none; margin: 0; padding: 0; font-size: 13px; overflow-y: auto; }
.pt-list li { display: flex; justify-content: space-between; gap: 8px; padding: 5px 2px; border-bottom: 1px solid rgba(130,200,255,0.08); }
.pt-list li span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pt-list .dim { color: rgba(200,220,255,0.5); }
.pt-panel { padding: 16px 18px; min-height: 0; display: flex; flex-direction: column; }
.pt-panel h3 { margin: 0 0 8px; font-size: 14px; letter-spacing: 1px; color: #cfe6ff; }
.pt-scores { flex: 1; }
.pt-death { text-align: center; min-width: 320px; }
.pt-death h2 { margin: 0 0 6px; font-size: 34px; color: #ff7a9a; }
.pt-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 18px 0 4px; }
.pt-stat { background: rgba(255,255,255,0.04); border-radius: 10px; padding: 10px; }
.pt-stat b { display: block; font-size: 22px; }
.pt-stat span { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: rgba(200,220,255,0.55); }
.pt-hint { position: fixed; bottom: 10px; left: 50%; transform: translateX(-50%); color: rgba(200,220,255,0.4);
  font: 12px system-ui, sans-serif; pointer-events: none; }
`;

let injected = false;
export function injectStyles(): void {
  if (injected) return;
  injected = true;
  const el = document.createElement("style");
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** Tiny element helper. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, string>> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}
