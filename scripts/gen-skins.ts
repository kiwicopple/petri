// Generates 8 original 256x256 preset skin PNGs into supabase/skins/presets/<name>.png.
// Run: npm run gen-skins
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const SIZE = 256;
const C = SIZE / 2;
const R = C - 2;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "skins", "presets");

type RGB = [number, number, number];
/** Shade a point given polar coords (d = distance from centre, a = angle, x/y = offsets). */
type Shader = (d: number, a: number, x: number, y: number) => RGB;

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a: RGB, b: RGB, t: number): RGB => {
  const k = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
};
const blob = (cx: number, cy: number, r: number, x: number, y: number) => Math.hypot(x - cx, y - cy) <= r;

// Deterministic PRNG so output is reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function spots(seed: number, n: number, minR: number, maxR: number, maxDist: number) {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    const ang = r() * Math.PI * 2;
    const dist = Math.sqrt(r()) * maxDist;
    return { x: C + Math.cos(ang) * dist, y: C + Math.sin(ang) * dist, r: minR + r() * (maxR - minR) };
  });
}

const shaders: Record<string, Shader> = {
  // Soft green blob with nucleus and scattered vacuoles.
  amoeba: (() => {
    const vac = spots(1, 9, 6, 16, R * 0.7);
    return (d, _a, x, y): RGB => {
      let c = mix(hex("#9be37a"), hex("#4fa84a"), d / R);
      if (d > R - 5) c = hex("#2f7a35");
      for (const v of vac) if (blob(v.x, v.y, v.r, x, y)) c = mix(hex("#d8f7c4"), hex("#9be37a"), Math.hypot(x - v.x, y - v.y) / v.r);
      if (d < 34) c = mix(hex("#2d5e8a"), hex("#5b9bd5"), d / 34);
      return c;
    };
  })(),
  // Diatom: radial ribs on amber glass.
  diatom: (d, a): RGB => {
    const ribs = Math.abs(Math.sin(a * 12)) ;
    let c = mix(hex("#f6c453"), hex("#b9791f"), ribs * 0.6 + (d / R) * 0.3);
    if (d < 22) c = hex("#6b3f10");
    if (Math.abs(d - R * 0.55) < 3) c = hex("#fff1c4");
    if (d > R - 6) c = hex("#7a4a12");
    return c;
  },
  // Spore: dark purple with speckles and a bright core.
  spore: (() => {
    const dots = spots(7, 40, 2, 5, R * 0.9);
    return (d, _a, x, y): RGB => {
      let c = mix(hex("#7b3fa0"), hex("#2c1245"), d / R);
      for (const s of dots) if (blob(s.x, s.y, s.r, x, y)) c = hex("#e5b8ff");
      if (d < 40) c = mix(hex("#fff3a8"), hex("#e08a2a"), d / 40);
      if (d > R - 4) c = hex("#1c0a2e");
      return c;
    };
  })(),
  // Virus: red capsid with hexagon-ish grid and spiky ring of studs.
  virus: (d, a, x, y): RGB => {
    let c = mix(hex("#ff6b6b"), hex("#a31f34"), d / R);
    const g = 32;
    const line = Math.min(((x % g) + g) % g, ((y % g) + g) % g);
    if (line < 2 && d < R * 0.78) c = mix(c, hex("#ffd0d0"), 0.55);
    if (d > R * 0.8 && d < R * 0.95 && Math.cos(a * 16) > 0.55) c = hex("#ffe3e3");
    if (d > R - 5) c = hex("#6e0f22");
    return c;
  },
  // Paramecium: slipper-shaped cell with cilia ring and oral groove.
  paramecium: (d, a, x, y): RGB => {
    let c = mix(hex("#9fd8ee"), hex("#4a9ac0"), d / R);
    if (d > R - 22 && d < R - 4 && Math.sin(a * 60) > 0) c = hex("#e6f7ff");
    if (d > R - 4) c = hex("#2a6f93");
    if (blob(C - 30, C + 20, 26, x, y)) c = hex("#256a8c");
    if (blob(C + 38, C - 28, 18, x, y)) c = hex("#f0c27a");
    if (blob(C + 38, C - 28, 8, x, y)) c = hex("#c4803a");
    return c;
  },
  // Algae: green concentric rings with chloroplast spots.
  algae: (() => {
    const chl = spots(3, 14, 8, 14, R * 0.7);
    return (d, _a, x, y): RGB => {
      let c = Math.floor(d / 18) % 2 === 0 ? hex("#3fae5c") : hex("#2b8a47");
      for (const s of chl) if (blob(s.x, s.y, s.r, x, y)) c = hex("#b6f08a");
      if (d < 16) c = hex("#14502a");
      if (d > R - 5) c = hex("#14502a");
      return c;
    };
  })(),
  // Yeast: cream cell with budding blob, scars and mottled texture.
  yeast: (() => {
    const mot = spots(11, 50, 2, 4, R * 0.85);
    return (d, _a, x, y): RGB => {
      let c = mix(hex("#f7e7c0"), hex("#d9b877"), d / R);
      for (const s of mot) if (blob(s.x, s.y, s.r, x, y)) c = hex("#c79a52");
      if (blob(C + 58, C - 52, 34, x, y)) c = mix(hex("#fff4d6"), hex("#e2c283"), Math.hypot(x - C - 58, y - C + 52) / 34);
      if (Math.abs(Math.hypot(x - C - 58, y - C + 52) - 34) < 2.5) c = hex("#a77d38");
      if (d > R - 5) c = hex("#a77d38");
      return c;
    };
  })(),
  // Tardigrade: teal body with segmented bands and tiny claws marks.
  tardigrade: (d, a, x, y): RGB => {
    let c = mix(hex("#5fd0c5"), hex("#217f87"), d / R);
    const band = Math.abs(((y - 10) % 40) - 20);
    if (band < 3 && d < R - 8) c = mix(c, hex("#0f4e5a"), 0.7);
    if (blob(C - 30, C - 62, 12, x, y) || blob(C + 30, C - 62, 12, x, y)) c = hex("#0c2f38");
    if (d > R - 5) c = hex("#0f4e5a");
    if (d > R - 14 && Math.cos(a * 8) > 0.9) c = hex("#c9fff7");
    return c;
  },
};

mkdirSync(OUT, { recursive: true });
for (const [name, shade] of Object.entries(shaders)) {
  const png = new PNG({ width: SIZE, height: SIZE });
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x + 0.5 - C;
      const dy = y + 0.5 - C;
      const d = Math.hypot(dx, dy);
      const i = (y * SIZE + x) * 4;
      if (d > R) {
        png.data[i + 3] = 0; // transparent outside the circle
        continue;
      }
      const [r, g, b] = shade(d, Math.atan2(dy, dx), x + 0.5, y + 0.5);
      png.data[i] = Math.round(r);
      png.data[i + 1] = Math.round(g);
      png.data[i + 2] = Math.round(b);
      // 1.5px anti-aliased rim
      png.data[i + 3] = Math.round(255 * Math.min(1, Math.max(0, (R - d) / 1.5 + 0.5)));
    }
  }
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, PNG.sync.write(png));
  console.log("wrote", file);
}
