import { describe, expect, it } from "vitest";
import { SPLIT_SPEED, SPLIT_DECAY, radius, speed } from "@shared/game.ts";
import {
  applyCorrection,
  applyLaunch,
  centroid,
  findMergePairs,
  launch,
  moveToward,
  resolveOwnCollisions,
  stepCells,
  type SimCell,
} from "./sim.ts";

const cell = (id: number, x: number, y: number, mass: number, mergeAfter = 0): SimCell => ({
  id,
  x,
  y,
  mass,
  vx: 0,
  vy: 0,
  mergeAfter,
  prevX: x,
  prevY: y,
  corr: null,
});

describe("movement toward target", () => {
  it("moves exactly speed(mass) * dt toward a far target", () => {
    const c = cell(1, 1000, 1000, 20);
    const dt = 1 / 60;
    moveToward(c, { x: 3000, y: 1000 }, dt);
    expect(c.x - 1000).toBeCloseTo(speed(20) * dt, 6);
    expect(c.y).toBe(1000);
  });

  it("moves diagonally at the same speed", () => {
    const c = cell(1, 0, 0, 100);
    moveToward(c, { x: 3000, y: 3000 }, 0.1);
    expect(Math.hypot(c.x, c.y)).toBeCloseTo(speed(100) * 0.1, 6);
    expect(c.x).toBeCloseTo(c.y, 9);
  });

  it("never overshoots and slows down near the target", () => {
    const c = cell(1, 100, 100, 20);
    moveToward(c, { x: 105, y: 100 }, 1);
    expect(c.x).toBeLessThanOrEqual(105);
    expect(c.x).toBeGreaterThan(100);
  });

  it("stepCells over one second covers ~speed px for a single cell", () => {
    const c = cell(1, 500, 500, 50);
    for (let i = 0; i < 60; i++) stepCells([c], { x: 5000, y: 500 }, 1 / 60, 0, 6000);
    expect(c.x - 500).toBeCloseTo(speed(50), 3);
  });

  it("clamps to world bounds", () => {
    const c = cell(1, 5, 5, 20);
    for (let i = 0; i < 60; i++) stepCells([c], { x: -1000, y: -1000 }, 1 / 60, 0, 6000);
    expect(c.x).toBe(0);
    expect(c.y).toBe(0);
  });
});

describe("split launch", () => {
  it("starts at SPLIT_SPEED along the direction", () => {
    const c = cell(1, 0, 0, 40);
    launch(c, 3, 4);
    expect(Math.hypot(c.vx, c.vy)).toBeCloseTo(SPLIT_SPEED, 6);
    expect(c.vx / c.vy).toBeCloseTo(3 / 4, 6);
  });

  it("decays as v *= exp(-SPLIT_DECAY * dt)", () => {
    const c = cell(1, 0, 0, 40);
    launch(c, 1, 0);
    const dt = 1 / 60;
    applyLaunch(c, dt);
    expect(c.x).toBeCloseTo(SPLIT_SPEED * dt, 6);
    expect(c.vx).toBeCloseTo(SPLIT_SPEED * Math.exp(-SPLIT_DECAY * dt), 6);
    for (let i = 0; i < 29; i++) applyLaunch(c, dt);
    expect(c.vx).toBeCloseTo(SPLIT_SPEED * Math.exp(-SPLIT_DECAY * 0.5), 3);
  });

  it("travels about SPLIT_SPEED / SPLIT_DECAY in total and then stops", () => {
    const c = cell(1, 0, 0, 40);
    launch(c, 1, 0);
    for (let i = 0; i < 300; i++) applyLaunch(c, 1 / 60);
    expect(c.vx).toBe(0);
    // discrete sum of a geometric series ~ continuous integral v0/k
    expect(c.x).toBeGreaterThan((SPLIT_SPEED / SPLIT_DECAY) * 0.95);
    expect(c.x).toBeLessThan((SPLIT_SPEED / SPLIT_DECAY) * 1.1);
  });
});

describe("soft collision between own cells", () => {
  it("pushes overlapping cells apart before merge_after", () => {
    const now = 1000;
    const a = cell(1, 100, 100, 50, now + 10_000);
    const b = cell(2, 110, 100, 50, now + 10_000);
    const before = Math.hypot(b.x - a.x, b.y - a.y);
    for (let i = 0; i < 30; i++) resolveOwnCollisions([a, b], 1 / 60, now);
    const after = Math.hypot(b.x - a.x, b.y - a.y);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(radius(50) * 2 * 0.9);
  });

  it("moves the lighter cell more", () => {
    const now = 0;
    const heavy = cell(1, 100, 100, 200, 1e12);
    const light = cell(2, 120, 100, 20, 1e12);
    resolveOwnCollisions([heavy, light], 1 / 60, now);
    expect(Math.abs(light.x - 120)).toBeGreaterThan(Math.abs(heavy.x - 100));
  });

  it("does not push apart after merge_after (pulls together instead)", () => {
    const now = 50_000;
    const a = cell(1, 100, 100, 50, now - 1);
    const b = cell(2, 140, 100, 50, now - 1);
    resolveOwnCollisions([a, b], 1 / 60, now);
    expect(b.x - a.x).toBeLessThan(40);
  });

  it("separates exactly coincident cells", () => {
    const a = cell(1, 100, 100, 50, 1e12);
    const b = cell(2, 100, 100, 50, 1e12);
    resolveOwnCollisions([a, b], 1 / 60, 0);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(0);
  });
});

describe("merge pairs, centroid, correction", () => {
  it("finds pairs overlapping > 50% of the smaller radius, heavier first", () => {
    const now = 10;
    const a = cell(1, 0, 0, 100, 0);
    const b = cell(2, 30, 0, 50, 0);
    const far = cell(3, 1000, 0, 50, 0);
    const pairs = findMergePairs([b, a, far], now);
    expect(pairs).toHaveLength(1);
    expect(pairs[0][0].id).toBe(1);
    expect(pairs[0][1].id).toBe(2);
  });

  it("ignores pairs before merge_after", () => {
    const a = cell(1, 0, 0, 100, 1000);
    const b = cell(2, 10, 0, 50, 0);
    expect(findMergePairs([a, b], 500)).toHaveLength(0);
  });

  it("computes a mass-weighted centroid", () => {
    expect(centroid([cell(1, 0, 0, 30), cell(2, 100, 0, 10)])).toEqual({ x: 25, y: 0 });
    expect(centroid([])).toBeNull();
  });

  it("blends a correction in over its duration", () => {
    const c = cell(1, 0, 0, 20);
    c.corr = { dx: 30, dy: 0, left: 0.15 };
    for (let i = 0; i < 9; i++) applyCorrection(c, 1 / 60);
    expect(c.x).toBeCloseTo(30, 6);
    expect(c.corr).toBeNull();
  });
});
