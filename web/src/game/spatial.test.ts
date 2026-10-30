import { describe, expect, it } from "vitest";
import { SpatialGrid } from "./spatial.ts";

type P = { id: number; x: number; y: number };

const ids = (g: SpatialGrid<P>, x: number, y: number, r: number) => {
  const out: number[] = [];
  g.queryCircle(x, y, r, (p) => out.push(p.id));
  return out.sort((a, b) => a - b);
};

describe("SpatialGrid", () => {
  it("finds points within a circle across bucket boundaries", () => {
    const g = new SpatialGrid<P>(100);
    const pts: P[] = [
      { id: 1, x: 99, y: 99 },
      { id: 2, x: 101, y: 101 },
      { id: 3, x: 300, y: 300 },
      { id: 4, x: 150, y: 100 },
    ];
    for (const p of pts) g.set(p.id, p);
    expect(g.size).toBe(4);
    expect(ids(g, 100, 100, 5)).toEqual([1, 2]);
    expect(ids(g, 100, 100, 60)).toEqual([1, 2, 4]);
    expect(ids(g, 0, 0, 10)).toEqual([]);
  });

  it("matches brute force on random data", () => {
    const g = new SpatialGrid<P>(64);
    const pts: P[] = [];
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 500; i++) {
      const p = { id: i, x: rnd() * 2000, y: rnd() * 2000 };
      pts.push(p);
      g.set(i, p);
    }
    for (let q = 0; q < 20; q++) {
      const x = rnd() * 2000;
      const y = rnd() * 2000;
      const r = rnd() * 300;
      const brute = pts.filter((p) => Math.hypot(p.x - x, p.y - y) <= r).map((p) => p.id).sort((a, b) => a - b);
      expect(ids(g, x, y, r)).toEqual(brute);
    }
  });

  it("moves and deletes items", () => {
    const g = new SpatialGrid<P>(50);
    const p = { id: 1, x: 10, y: 10 };
    g.set(1, p);
    p.x = 500;
    p.y = 500;
    g.set(1, p);
    expect(ids(g, 10, 10, 20)).toEqual([]);
    expect(ids(g, 500, 500, 1)).toEqual([1]);
    expect(g.delete(1)).toBe(true);
    expect(g.delete(1)).toBe(false);
    expect(g.size).toBe(0);
    expect(ids(g, 500, 500, 1)).toEqual([]);
  });

  it("supports negative coordinates and queryRect", () => {
    const g = new SpatialGrid<P>(32);
    g.set(1, { id: 1, x: -40, y: -40 });
    g.set(2, { id: 2, x: 10, y: 10 });
    const out: number[] = [];
    g.queryRect(-50, -50, 0, 0, (p) => out.push(p.id));
    expect(out).toEqual([1]);
    g.clear();
    expect(g.size).toBe(0);
  });
});
