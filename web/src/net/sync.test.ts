import { describe, expect, it } from "vitest";
import { World } from "../game/world.ts";
import { reconcile } from "./sync.ts";

const join = {
  player_id: "me",
  room_id: "room",
  world_size: 6000,
  color: "#ff0000",
  cell: { id: 1, x: 100, y: 100, mass: 20 },
};

describe("reconcile (player_sync response)", () => {
  it("takes server mass, adds unknown server cells and drops cells the server doesn't have", () => {
    const w = new World(join, "me", null, 0);
    w.addOwnCell({ id: 2, x: 200, y: 100, mass: 10 }, 0);
    const status = reconcile(
      w,
      {
        status: "alive",
        cells: [
          { id: 1, x: 100, y: 100, mass: 33, merge_after: "2023-11-14T22:13:25.000Z" },
          { id: 3, x: 300, y: 100, mass: 7, merge_after: 1_700_000_009_000, born: 1_700_000_000 },
        ],
        corrections: [],
      },
      { sentAt: 50, sent: new Map() },
      100,
    );
    expect(status).toBe("alive");
    expect([...w.myCells.keys()].sort()).toEqual([1, 3]);
    expect(w.myCells.get(1)!.mass).toBe(33);
    expect(w.myCells.get(1)!.mergeAfter).toBe(Date.parse("2023-11-14T22:13:25.000Z")); // ISO
    expect(w.myCells.get(3)!.mergeAfter).toBe(1_700_000_009_000); // epoch ms
    expect(w.myCells.get(3)!.born).toBe(1_700_000_000_000); // epoch seconds → ms
  });

  it("keeps cells added after the request was sent and ignores stale views of removed cells", () => {
    const w = new World(join, "me", null, 0);
    w.addOwnCell({ id: 2, x: 200, y: 100, mass: 10 }, 60); // e.g. split child, after sentAt
    w.removeOwnCell(1, 55); // merged away after the request went out
    reconcile(w, { status: "alive", cells: [{ id: 1, x: 100, y: 100, mass: 20 }], corrections: [] }, { sentAt: 50, sent: new Map() }, 100);
    expect([...w.myCells.keys()]).toEqual([2]);
  });

  it("does not overwrite mass set locally after the request was sent", () => {
    const w = new World(join, "me", null, 0);
    const c = w.myCells.get(1)!;
    c.mass = 80;
    c.massSetAt = 70;
    reconcile(w, { status: "alive", cells: [{ id: 1, x: 100, y: 100, mass: 20 }], corrections: [] }, { sentAt: 50, sent: new Map() }, 100);
    expect(c.mass).toBe(80);
  });

  it("schedules a blend for clamped cells relative to the reported position", () => {
    const w = new World(join, "me", null, 0);
    reconcile(
      w,
      { status: "alive", cells: [{ id: 1, x: 120, y: 100, mass: 20 }], corrections: [1] },
      { sentAt: 50, sent: new Map([[1, { x: 150, y: 100 }]]) },
      100,
    );
    expect(w.myCells.get(1)!.corr).toMatchObject({ dx: -30, dy: 0 });
  });

  it("returns non-alive status without touching cells", () => {
    const w = new World(join, "me", null, 0);
    expect(reconcile(w, { status: "dead", cells: [], corrections: [] }, { sentAt: 0, sent: new Map() }, 1)).toBe("dead");
    expect(w.myCells.size).toBe(1);
  });
});
