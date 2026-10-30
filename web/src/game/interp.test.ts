import { describe, expect, it } from "vitest";
import { INTERP_DELAY_MS } from "@shared/game.ts";
import { EXTRAPOLATE_MAX_MS, SnapshotBuffer } from "./interp.ts";

/** Push with sender clock == local clock (offset 0). */
const push = (b: SnapshotBuffer, t: number, cells: [number, number, number, number][]) => b.push(t, cells, t);

describe("SnapshotBuffer", () => {
  it("returns nothing when empty", () => {
    expect(new SnapshotBuffer().sample(1000)).toEqual([]);
  });

  it("interpolates linearly INTERP_DELAY_MS in the past", () => {
    const b = new SnapshotBuffer();
    push(b, 1000, [[1, 0, 0, 20]]);
    push(b, 1100, [[1, 100, 50, 30]]);
    const [c] = b.sample(1050 + INTERP_DELAY_MS);
    expect(c.x).toBeCloseTo(50);
    expect(c.y).toBeCloseTo(25);
    expect(c.mass).toBeCloseTo(25);
    expect(c.alpha).toBe(1);
  });

  it("holds the oldest snapshot before the buffer starts", () => {
    const b = new SnapshotBuffer();
    push(b, 1000, [[1, 10, 10, 20]]);
    push(b, 1066, [[1, 20, 10, 20]]);
    const [c] = b.sample(900);
    expect(c.x).toBe(10);
  });

  it("extrapolates past the newest snapshot using the last velocity", () => {
    const b = new SnapshotBuffer();
    push(b, 1000, [[1, 0, 0, 20]]);
    push(b, 1100, [[1, 100, 0, 20]]); // 1 px/ms
    const [c] = b.sample(1100 + 50 + INTERP_DELAY_MS);
    expect(c.x).toBeCloseTo(150);
  });

  it("caps extrapolation at 150 ms, then freezes", () => {
    const b = new SnapshotBuffer();
    push(b, 1000, [[1, 0, 0, 20]]);
    push(b, 1100, [[1, 100, 0, 20]]);
    const capped = b.sample(1100 + EXTRAPOLATE_MAX_MS + INTERP_DELAY_MS)[0].x;
    expect(capped).toBeCloseTo(100 + EXTRAPOLATE_MAX_MS);
    expect(b.sample(1100 + 1000 + INTERP_DELAY_MS)[0].x).toBeCloseTo(capped);
    expect(b.sample(1100 + 5000 + INTERP_DELAY_MS)[0].x).toBeCloseTo(capped);
  });

  it("freezes a single snapshot", () => {
    const b = new SnapshotBuffer();
    push(b, 1000, [[1, 5, 6, 20]]);
    expect(b.sample(99999)[0]).toMatchObject({ x: 5, y: 6 });
  });

  it("fades appearing and vanishing cells", () => {
    const b = new SnapshotBuffer();
    push(b, 1000, [[1, 0, 0, 20], [2, 50, 50, 20]]);
    push(b, 1100, [[1, 10, 0, 20], [3, 80, 80, 20]]);
    const out = b.sample(1025 + INTERP_DELAY_MS);
    const byId = new Map(out.map((c) => [c.id, c]));
    expect(byId.get(1)!.alpha).toBe(1);
    expect(byId.get(2)!.alpha).toBeCloseTo(0.75);
    expect(byId.get(3)!.alpha).toBeCloseTo(0.25);
  });

  it("handles out-of-order packets", () => {
    const b = new SnapshotBuffer();
    push(b, 1000, [[1, 0, 0, 20]]);
    push(b, 1200, [[1, 200, 0, 20]]);
    push(b, 1100, [[1, 100, 0, 20]]);
    expect(b.sample(1150 + INTERP_DELAY_MS)[0].x).toBeCloseTo(150);
  });

  it("maps sender clock to local clock via the minimum transit offset", () => {
    const b = new SnapshotBuffer();
    // sender clock is 5000 ms behind; transit 20 ms then 40 ms
    b.push(1000, [[1, 0, 0, 20]], 6020);
    b.push(1100, [[1, 100, 0, 20]], 6140);
    // local time of snapshot 2 is ~1100 + 5020 = 6120 (offset relaxes upward by <= 0.5 ms per packet)
    const [c] = b.sample(6070 + INTERP_DELAY_MS);
    expect(c.x).toBeCloseTo(50, 0);
  });

  it("removeCell drops a cell from all snapshots", () => {
    const b = new SnapshotBuffer();
    push(b, 1000, [[1, 0, 0, 20], [2, 5, 5, 20]]);
    push(b, 1100, [[1, 10, 0, 20], [2, 5, 5, 20]]);
    b.removeCell(2);
    expect(b.sample(1050 + INTERP_DELAY_MS).map((c) => c.id)).toEqual([1]);
  });
});
