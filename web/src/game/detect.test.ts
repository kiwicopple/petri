import { describe, expect, it } from "vitest";
import { radius, THORN_MASS } from "@shared/game.ts";
import {
  EAT_DEBOUNCE_MS,
  PendingClaims,
  canEatCell,
  detectCellEats,
  detectPellets,
  detectThorns,
  pelletOverlap,
  thornHit,
} from "./detect.ts";
import { SpatialGrid } from "./spatial.ts";

const c = (id: number, x: number, y: number, mass: number) => ({ id, x, y, mass });

describe("pellet overlap", () => {
  it("is true when the pellet centre is inside the cell", () => {
    const cell = c(1, 0, 0, 20); // r ≈ 44.7
    expect(pelletOverlap(cell, { x: 40, y: 0 })).toBe(true);
    expect(pelletOverlap(cell, { x: 46, y: 0 })).toBe(false);
  });

  it("detectPellets claims each overlapped pellet once and skips hidden/pending", () => {
    const grid = new SpatialGrid<{ id: number; x: number; y: number; hidden?: boolean }>(64);
    const p1 = { id: 1, x: 10, y: 0 };
    const p2 = { id: 2, x: 500, y: 500 };
    const p3 = { id: 3, x: -10, y: 0, hidden: true };
    for (const p of [p1, p2, p3]) grid.set(p.id, p);
    const claims = new PendingClaims();
    const hit = detectPellets([c(1, 0, 0, 20)], grid, claims);
    expect(hit.map((p) => p.id)).toEqual([1]);
    claims.claim(1, 0);
    expect(detectPellets([c(1, 0, 0, 20)], grid, claims)).toEqual([]);
  });
});

describe("PendingClaims", () => {
  it("drains queued ids, confirms, requeues and expires after 1 s", () => {
    const pc = new PendingClaims();
    expect(pc.claim(5, 0)).toBe(true);
    expect(pc.claim(5, 10)).toBe(false);
    pc.claim(6, 0);
    expect(pc.drain()).toEqual([5, 6]);
    expect(pc.drain()).toEqual([]);
    pc.confirm(5);
    pc.requeue([5, 6]);
    expect(pc.drain()).toEqual([6]);
    expect(pc.expire(999)).toEqual([]);
    expect(pc.expire(1000)).toEqual([6]);
    expect(pc.size).toBe(0);
  });
});

describe("cell eat rule", () => {
  it("requires eater mass >= 1.25 × victim", () => {
    expect(canEatCell(c(1, 0, 0, 125), c(2, 0, 0, 100))).toBe(true);
    expect(canEatCell(c(1, 0, 0, 124), c(2, 0, 0, 100))).toBe(false);
  });

  it("requires dist <= r_eater − 0.35 r_victim", () => {
    const eater = c(1, 0, 0, 400); // r = 200
    const vm = 100; // r = 100 → limit 165
    expect(canEatCell(eater, c(2, 165, 0, vm))).toBe(true);
    expect(canEatCell(eater, c(2, 166, 0, vm))).toBe(false);
  });

  it("detectCellEats claims once per victim and debounces 500 ms per pair", () => {
    const own = [c(1, 0, 0, 400), c(2, 10, 0, 400)];
    const victims = [c(10, 50, 0, 20), c(11, 3000, 0, 20)];
    const deb = new Map<string, number>();
    const first = detectCellEats(own, victims, 0, deb);
    expect(first).toHaveLength(1);
    expect(first[0].victim.id).toBe(10);
    // pair (1,10) debounced → next eater gets a shot
    const second = detectCellEats(own, victims, 100, deb);
    expect(second.map((e) => [e.eater.id, e.victim.id])).toEqual([[2, 10]]);
    expect(detectCellEats(own, victims, 200, deb)).toEqual([]);
    expect(detectCellEats(own, victims, EAT_DEBOUNCE_MS, deb)).toHaveLength(1);
  });

  it("does not claim bigger or equal cells", () => {
    expect(detectCellEats([c(1, 0, 0, 100)], [c(2, 1, 0, 100)], 0, new Map())).toEqual([]);
  });
});

describe("thorns", () => {
  it("only burst cells heavier than 130", () => {
    const thorn = { x: 0, y: 0 };
    expect(thornHit(c(1, 0, 0, 130), thorn)).toBe(false);
    expect(thornHit(c(1, 0, 0, 131), thorn)).toBe(true);
  });

  it("require overlap", () => {
    const big = c(1, 0, 0, 400);
    expect(thornHit(big, { x: radius(400) - 1, y: 0 })).toBe(true);
    expect(thornHit(big, { x: radius(400) + 1, y: 0 })).toBe(false);
  });

  it("detectThorns ignores small cells and pending thorns", () => {
    const thorns = [{ id: 7, x: 0, y: 0 }];
    const claims = new PendingClaims();
    expect(detectThorns([c(1, 0, 0, THORN_MASS)], thorns, claims)).toEqual([]);
    expect(detectThorns([c(1, 0, 0, 200)], thorns, claims).map((t) => t.id)).toEqual([7]);
    claims.claim(7, 0);
    expect(detectThorns([c(1, 0, 0, 200)], thorns, claims)).toEqual([]);
  });
});
