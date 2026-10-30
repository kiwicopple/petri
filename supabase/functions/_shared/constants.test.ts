// Asserts the SQL mirror (public.gc() + formula functions, migration 0002) matches game.ts.
// Needs the local Supabase DB; skips when it is unreachable.
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import * as G from "./game.ts";

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function connect(): Promise<pg.Client | null> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query("select public.gc()");
    return client;
  } catch {
    await client.end().catch(() => {});
    return null;
  }
}

const db = await connect();
if (!db) console.warn(`constants.test.ts: local DB unreachable at ${DB_URL}; skipping SQL/TS constant checks`);

/** Every exported UPPER_CASE constant from game.ts (numbers + PALETTE). */
const tsConstants: Record<string, unknown> = Object.fromEntries(
  Object.entries(G).filter(([k, v]) => /^[A-Z][A-Z0-9_]*$/.test(k) && (typeof v === "number" || Array.isArray(v))),
);

describe.skipIf(!db)("SQL constants mirror game.ts", () => {
  afterAll(async () => {
    await db?.end();
  });

  it("gc() equals the TS constants exactly", async () => {
    const { rows } = await db!.query<{ gc: Record<string, unknown> }>("select public.gc() as gc");
    expect(rows[0].gc).toEqual(tsConstants);
  });

  it("formula functions match", async () => {
    const masses = [1, 10, 20, 36, 100, 150, 1000, 20000];
    for (const m of masses) {
      const { rows } = await db!.query(
        `select public.cell_radius($1) as r, public.cell_speed($1) as s, public.merge_delay($1) as md,
                public.pos_tolerance($1, 0.1, 0.5) as t_young, public.pos_tolerance($1, 0.1, 5) as t_old`,
        [m],
      );
      const r = rows[0];
      expect(r.r).toBeCloseTo(G.radius(m), 9);
      expect(r.s).toBeCloseTo(G.speed(m), 9);
      expect(r.md).toBeCloseTo(G.mergeDelay(m), 9);
      expect(r.t_young).toBeCloseTo(G.posTolerance(m, 0.1, 0.5), 9);
      expect(r.t_old).toBeCloseTo(G.posTolerance(m, 0.1, 5), 9);
    }
  });

  it("eat predicates match", async () => {
    const cases: Array<[number, number]> = [[25, 20], [24.99, 20], [100, 80], [100, 81]];
    for (const [e, v] of cases) {
      const { rows } = await db!.query("select public.can_eat($1, $2) as ok", [e, v]);
      expect(rows[0].ok).toBe(G.canEat(e, v));
    }
    const overlaps: Array<[number, number, number]> = [[50, 100, 100], [65, 100, 100], [66, 100, 100]];
    for (const [d, re, rv] of overlaps) {
      const { rows } = await db!.query("select public.eat_overlap_ok($1, $2, $3) as ok", [d, re, rv]);
      expect(rows[0].ok).toBe(G.eatOverlapOk(d, re, rv));
    }
  });
});
