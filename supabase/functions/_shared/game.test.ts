import { describe, expect, it } from "vitest";
import {
  EAT_RATIO,
  PALETTE,
  SPLIT_SPEED,
  START_MASS,
  canEat,
  eatOverlapOk,
  mergeDelay,
  pelletColor,
  posTolerance,
  radius,
  speed,
  zoom,
} from "@shared/game.ts";
import { sanitizeName } from "@shared/names.ts";

describe("radius", () => {
  it("is 10 * sqrt(m)", () => {
    expect(radius(100)).toBe(100);
    expect(radius(START_MASS)).toBeCloseTo(44.72, 2);
  });
});

describe("speed", () => {
  it("is ~210 px/s at mass 20", () => {
    expect(speed(20)).toBeCloseTo(600 * Math.pow(20, -0.35), 6);
    expect(speed(20)).toBeGreaterThan(209);
    expect(speed(20)).toBeLessThan(212);
  });
  it("is ~53.5 px/s at mass 1000 (above the floor)", () => {
    expect(speed(1000)).toBeCloseTo(600 * Math.pow(1000, -0.35), 6);
    expect(speed(1000)).toBeGreaterThan(53);
    expect(speed(1000)).toBeLessThan(54);
  });
  it("never drops below 50", () => {
    expect(speed(20000)).toBe(50);
  });
});

describe("canEat / eatOverlapOk", () => {
  it("requires 1.25x mass", () => {
    expect(canEat(125, 100)).toBe(true);
    expect(canEat(124.9, 100)).toBe(false);
    expect(canEat(100 * EAT_RATIO, 100)).toBe(true);
  });
  it("requires covering 65% of the victim radius", () => {
    expect(eatOverlapOk(100 - 0.35 * 40, 100, 40)).toBe(true);
    expect(eatOverlapOk(100 - 0.35 * 40 + 0.1, 100, 40)).toBe(false);
  });
});

describe("mergeDelay", () => {
  it("is 12s + 0.02s per mass", () => {
    expect(mergeDelay(0)).toBe(12);
    expect(mergeDelay(100)).toBeCloseTo(14, 9);
    expect(mergeDelay(1000)).toBeCloseTo(32, 9);
  });
});

describe("zoom", () => {
  it("clamps to [0.15, 1.2]", () => {
    expect(zoom(0)).toBe(1.2);
    expect(zoom(1e9)).toBe(0.15);
  });
  it("decreases as radius grows", () => {
    expect(zoom(500)).toBeGreaterThan(zoom(5000));
    expect(zoom(500)).toBeCloseTo(1 / (0.3 + Math.sqrt(500) / 25), 9);
  });
});

describe("posTolerance", () => {
  it("adds split launch allowance for young cells", () => {
    const old = posTolerance(20, 0.1, 5);
    const young = posTolerance(20, 0.1, 0.5);
    expect(old).toBeCloseTo(1.3 * speed(20) * 0.1 + 40, 9);
    expect(young - old).toBeCloseTo(SPLIT_SPEED * 0.6, 9);
  });
});

describe("pelletColor", () => {
  it("is deterministic and in the palette", () => {
    for (let i = 0; i < 200; i++) {
      expect(PALETTE).toContain(pelletColor(i));
      expect(pelletColor(i)).toBe(pelletColor(i));
    }
    expect(new Set(Array.from({ length: 200 }, (_, i) => pelletColor(i))).size).toBeGreaterThan(6);
  });
});

describe("sanitizeName", () => {
  it("trims, strips control chars and caps at 16 chars", () => {
    expect(sanitizeName("  Bob\u0000\u0007  ")).toBe("Bob");
    expect(sanitizeName("a".repeat(40))).toHaveLength(16);
  });
  it("falls back to Cell", () => {
    expect(sanitizeName("")).toBe("Cell");
    expect(sanitizeName("   ")).toBe("Cell");
    expect(sanitizeName(undefined)).toBe("Cell");
    expect(sanitizeName("f_u_c_k")).toBe("Cell");
    expect(sanitizeName("Sh1t")).toBe("Cell");
  });
});
