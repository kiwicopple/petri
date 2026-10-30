# Petri: a multiplayer cell-eating arena built on Supabase

An original browser game in the .io "blob" genre. Players control cells in a petri dish. They eat nutrients and smaller players to grow, split to chase, and avoid bigger cells. The backend is **Supabase only**, running locally via the Supabase CLI.

---

## 1. Goals and non-goals

**Goals**
- Smooth real-time multiplayer for about 40 players per room, running locally.
- Use as many Supabase primitives as reasonable, each where it actually fits.
- Server-authoritative over everything that matters for fairness: mass, eating, death, score.
- Implementable in one pass from this document. Sections 6 and 7 are the contract between backend and frontend.

**Non-goals (v1)**
- Production deployment, global scale, mobile controls, accounts beyond anonymous sign-in.
- Copying agar.io branding, art, UI or exact tuning.

---

## 2. Supabase primitives used

| Primitive | Used for |
|---|---|
| **Auth (anonymous sign-ins)** | Each browser gets a real `auth.uid()` with no signup. All RLS and RPCs key off it. |
| **Postgres tables + RLS** | Rooms, players, cells, pellets, scores. Clients can read, but every write goes through RPCs. |
| **Postgres functions (RPC, `security definer`)** | The referee: `player_sync`, `eat_cell`, `split`, `eject`, `merge_cells`, `leave_game`. Row locks give atomic, race-free eating. |
| **Realtime Broadcast (client → client)** | High-frequency movement (15 Hz) of each player's cells. |
| **Realtime Broadcast from the database (`realtime.send`)** | Authoritative events: pellets spawned/eaten, cell eaten, player died, leaderboard. |
| **Realtime Presence** | Who is in the room (name, colour, skin). Fast disconnect detection. Lobby counts. |
| **Realtime Authorization** | Private channels. RLS on `realtime.messages` restricts topics to signed-in users. |
| **Realtime Postgres Changes** | Live all-time high-score board on the menu (`scores` inserts). |
| **pg_cron (sub-minute)** | 1 s world tick: respawn pellets, drift nutrient blooms, mass decay, stale-player cleanup, leaderboard broadcast. |
| **Edge Functions (Deno)** | `join`: name validation and profanity filter, matchmaking (pick or create room), safe spawn via a service-role RPC. |
| **Storage** | `skins` bucket. Preset skins are seeded from disk; users can upload custom skins, with RLS by user folder plus size and MIME limits. |
| **pgTAP (`supabase test db`)** | Tests for RPC rules, races and RLS. |
| **Type generation** | `supabase gen types typescript --local` for the frontend. |

---

## 3. The key decision: who simulates the game?

Real agar-style games run a dedicated authoritative server loop at 20–40 Hz. Supabase has no long-running process primitive:
- Edge Functions have wall-clock and CPU limits.
- pg_cron's minimum interval is 1 s.

So the design is a **hybrid "client moves, Postgres referees"** model:

1. **Movement is client-simulated.** Each client integrates its own cells' positions toward the mouse at 60 Hz, using shared physics code. It broadcasts them peer-to-peer over Realtime Broadcast at 15 Hz. Other clients interpolate.
2. **Postgres is the authority for discrete state.** Mass, which cells exist, which pellets exist, deaths and scores live only in Postgres, and change only through RPCs that lock rows.
3. **Positions are sanity-checked.** Every 100 ms each client calls `player_sync` with its cell positions. Postgres clamps any move faster than `speed(mass) × dt × 1.3` (with an allowance for split launches) and stores the result. Eat validation uses these stored positions with a staleness tolerance.
4. **pg_cron handles slow world processes** at 1 Hz: respawns, decay, cleanup and the leaderboard.

Trade-off: a modified client could move slightly better than allowed within tolerance, and it decides *when* to claim an eat. It cannot gain mass, eat something it isn't overlapping, or survive being eaten. That is fine for a local or friendly game. Section 13 describes a stricter alternative.

---

## 4. Tech stack

- **Frontend:** Vite + TypeScript + **Canvas 2D**, no framework. Menus are plain DOM. Canvas 2D handles about 1,500 pellets and about 600 cells with viewport culling.
- **Shared game logic:** `supabase/functions/_shared/game.ts`. Pure TS with no Deno or DOM APIs. The edge function imports it, and so do the Vite app and bot script via relative path or Vite alias.
- **Backend:** Supabase CLI (`supabase start`) with Postgres 15+, pg_cron, Realtime, Storage, Edge Runtime.
- **Tests:** Vitest for shared physics and client logic, pgTAP for the database.
- **Bots:** `scripts/bots.ts`, run with `tsx`. Headless supabase-js clients that speak exactly the same protocol as browsers. They also serve as the load test.

---

## 5. Repository layout

```
/
├─ PLAN.md
├─ package.json                 # workspace scripts (dev, bots, test, gen-types)
├─ web/
│  ├─ index.html
│  ├─ vite.config.ts            # alias @shared -> ../supabase/functions/_shared
│  ├─ .env.local                # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (from `supabase status`)
│  └─ src/
│     ├─ main.ts                # boot: auth -> menu
│     ├─ supabase.ts            # createClient (realtime params), signInAnonymously
│     ├─ db.types.ts            # generated
│     ├─ net/
│     │  ├─ room.ts             # channel join, presence, broadcast handlers, send loop
│     │  ├─ sync.ts             # 10 Hz player_sync loop + reconciliation
│     │  └─ actions.ts          # split / eject / eat_cell / merge RPC wrappers
│     ├─ game/
│     │  ├─ world.ts            # entity stores: myCells, remotePlayers, pellets, thorns
│     │  ├─ sim.ts              # local fixed-step physics for own cells
│     │  ├─ interp.ts           # snapshot buffer, render remote 100 ms in the past
│     │  ├─ detect.ts           # local overlap detection -> eat claims
│     │  ├─ spatial.ts          # uniform grid for pellet/cell lookup
│     │  ├─ render.ts           # grid, pellets, thorns, cells, skins, names, culling, zoom
│     │  └─ input.ts            # mouse -> world target, Space = split, W = eject
│     └─ ui/
│        ├─ menu.ts             # name, skin picker/upload, room list, high scores (postgres_changes)
│        ├─ hud.ts              # leaderboard, mass, minimap, ping/FPS debug
│        └─ death.ts            # stats + play again
├─ supabase/
│  ├─ config.toml
│  ├─ seed.sql                  # rooms
│  ├─ skins/                    # preset skin PNGs (seeded into the bucket)
│  ├─ migrations/
│  │  ├─ 0001_schema.sql        # tables, indexes, RLS, grants
│  │  ├─ 0002_game_constants.sql# SQL mirror of shared constants + formula functions
│  │  ├─ 0003_rpc.sql           # spawn_player, player_sync, eat_cell, split, eject, merge_cells, leave_game
│  │  ├─ 0004_realtime.sql      # realtime.messages policies, publication for scores
│  │  ├─ 0005_tick.sql          # game_tick() + cron.schedule
│  │  └─ 0006_storage.sql       # storage.objects policies for skins
│  ├─ functions/
│  │  ├─ _shared/game.ts        # constants + formulas (single source for TS)
│  │  ├─ _shared/names.ts       # name sanitiser / blocklist
│  │  └─ join/index.ts
│  └─ tests/
│     └─ game.test.sql          # pgTAP
└─ scripts/
   ├─ bots.ts
   └─ dev-realtime-limits.sql   # raise local Realtime tenant limits (see §11)
```

---

## 6. Game rules and constants (`_shared/game.ts`, mirrored in SQL)

| Constant | Value | Notes |
|---|---|---|
| `WORLD_SIZE` | 6000 | Square dish. Coordinates 0..6000. Rendered as a circle-ish dish with a square bound. |
| `START_MASS` | 20 | |
| `radius(m)` | `10 * sqrt(m)` | |
| `speed(m)` px/s | `max(50, 600 * m^-0.35)` | Mass 20 ≈ 210 px/s. Mass 1000 ≈ 54 px/s. |
| `PELLET_MASS` | 1 | radius 6 for rendering |
| `PELLET_TARGET` | 1200 / room | topped up by tick, max 150 inserts per tick |
| `EAT_RATIO` | 1.25 | eater.mass ≥ 1.25 × victim.mass |
| `EAT_OVERLAP` | dist ≤ r_eater − 0.35 × r_victim | |
| `MIN_SPLIT_MASS` | 36 | |
| `MAX_CELLS` | 16 | |
| `SPLIT_SPEED` | 900 px/s initial, decays as `v *= exp(-6 * dt)` | |
| `MERGE_DELAY(m)` | `12 s + 0.02 s × m` | stored as `cells.merge_after` |
| `EJECT_MIN_MASS` / `EJECT_COST` / `EJECT_MASS` | 35 / 16 / 12 | ejecta travel 420 px, server computes the landing point |
| `DECAY` | mass > 150 loses 0.2 %/s | applied by tick |
| `MAX_CELL_MASS` | 20000 | |
| `THORN_COUNT` / `THORN_MASS` | 25 / 100 | hazard: cells > 1.3 × 100 that overlap a thorn burst into up to `MAX_CELLS` pieces |
| `BLOOM_COUNT` | 3 / room | **Petri twist:** drifting nutrient blooms. A bloom centre moves slowly each tick and 40 % of respawned pellets spawn within 300 px of a bloom. This creates moving hotspots players fight over. |
| `NET_STATE_HZ` / `NET_SYNC_HZ` | 15 / 10 | |
| `INTERP_DELAY_MS` | 100 | |
| `POS_TOLERANCE` | 1.3 × speed × dt + 40 px | plus `SPLIT_SPEED × 0.6 s` if the cell is < 1 s old |
| `STALE_PLAYER_S` | 5 | no `player_sync` for 5 s → removed by tick |

**Own-cell behaviour (client sim):** each cell moves toward the mouse target at `speed(mass)`, plus any decaying launch velocity. Before `merge_after`, a player's own cells push apart (soft collision). After it, if two own cells overlap by more than 50 % of the smaller radius, the client calls `merge_cells`.

**Camera:** follows the mass-weighted centroid. Zoom = `clamp(1 / (0.3 + sqrt(totalRadius)/25), 0.15, 1.2)`, lerped.

SQL mirror: `0002_game_constants.sql` defines `public.gc()` returning jsonb, plus immutable helpers `public.cell_radius(m)`, `public.cell_speed(m)`, `public.merge_delay(m)`. A Vitest test (`constants.test.ts`) calls `select gc()` against the local DB and asserts equality with the TS constants.

---

## 7. Data model (`0001_schema.sql`)

```sql
create table rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  max_players int not null default 40,
  world_size int not null default 6000,
  pellet_target int not null default 1200,
  blooms jsonb not null default '[]',        -- [{x,y,vx,vy}]
  created_at timestamptz default now()
);

create table players (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  room_id uuid not null references rooms on delete cascade,
  name text not null,
  color text not null,                       -- hex from palette
  skin text,                                 -- storage path or null
  status text not null default 'alive' check (status in ('alive','dead','left')),
  kills int not null default 0,
  peak_mass real not null default 0,
  spawned_at timestamptz not null default now(),
  ended_at timestamptz,
  last_sync_at timestamptz not null default now(),
  killed_by uuid references players
);
create unique index one_alive_player_per_user on players(user_id) where status = 'alive';
create index on players(room_id) where status = 'alive';

create table cells (
  id bigint generated always as identity primary key,
  player_id uuid not null references players on delete cascade,
  room_id uuid not null references rooms on delete cascade,
  x real not null, y real not null,
  mass real not null,
  merge_after timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index on cells(room_id);
create index on cells(player_id);

create table pellets (
  id bigint generated always as identity primary key,
  room_id uuid not null references rooms on delete cascade,
  kind text not null default 'food' check (kind in ('food','ejecta','thorn')),
  x real not null, y real not null,
  mass real not null default 1,
  created_at timestamptz not null default now()
);
create index on pellets(room_id, kind);

create table scores (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users on delete set null,
  player_id uuid,
  name text not null,
  peak_mass real not null,
  kills int not null,
  survived_seconds int not null,
  created_at timestamptz not null default now()
);
create view top_scores with (security_invoker = true) as
  select name, peak_mass, kills, survived_seconds, created_at
  from scores order by peak_mass desc limit 20;
create view room_list with (security_invoker = true) as
  select r.id, r.name, r.max_players,
         (select count(*) from players p where p.room_id = r.id and p.status='alive') as player_count
  from rooms r;
```

**RLS:** enable on all tables. `authenticated` gets `select` on all of them, and on the views. Revoke `insert/update/delete` from `anon` and `authenticated`. Every write goes through `security definer` functions with `set search_path = ''` and fully qualified names.

Pellet colour is not stored. Clients derive it from `id` (a hash into a palette).

---

## 8. Database API (`0003_rpc.sql`)

All functions are `security definer` and `set search_path = ''`. Each checks ownership via `players.user_id = auth.uid()`. **Locking rule, to avoid deadlocks:** whenever a function locks cells it does so with `... order by id for update`. The tick uses `for update skip locked`.

| Function | Caller | Behaviour | Returns |
|---|---|---|---|
| `spawn_player(p_user uuid, p_room uuid, p_name text, p_skin text)` | service_role only (edge fn) | Marks any previous alive player for this user as `left`. Inserts the player with a random palette colour. Picks a safe spawn: 12 random points, keep the one farthest from any cell with mass ≥ START_MASS × 1.25. Inserts one cell. | `{player_id, room_id, world_size, color, cell:{id,x,y,mass}}` |
| `player_sync(p_player uuid, p_cells jsonb, p_eaten bigint[])` | owner, 10 Hz | (1) Lock own cells. For each reported `{id,x,y}`, clamp the move to `POS_TOLERANCE` since `synced_at` and to world bounds. Update `x,y,synced_at`. Unknown ids are ignored. (2) `delete from pellets where id = any(p_eaten) and room_id = … and kind in ('food','ejecta') and exists(own cell within radius + 6 + 40 px) returning *`. Credit each eaten pellet to the nearest own cell. (3) **Thorns** in `p_eaten`: if the overlapping own cell has mass > 1.3 × THORN_MASS, delete the thorn and burst the cell into up to `MAX_CELLS − count` pieces (equal mass, positions on a ring, `merge_after` set). (4) Update `peak_mass` and `last_sync_at`. (5) If any pellets were eaten: `realtime.send({ids, by}, 'pellets_eaten', 'room:'||room_id, true)`. | `{status, cells:[{id,x,y,mass,merge_after,born}], corrections:[ids clamped]}` |
| `eat_cell(p_eater bigint, p_victim bigint, p_ex real, p_ey real)` | owner of eater | Lock both cells in id order. Require same room, different players, eater owned by caller, `eater.mass ≥ EAT_RATIO × victim.mass`. Apply plausibility clamp to the reported eater position. Check `dist ≤ r_e − 0.35 r_v + tolerance`, where tolerance = `speed(victim) × min(0.3, now − victim.synced_at) + 30`. On success: eater mass += victim mass (capped), delete the victim cell. If the victim player has no cells left, set status `dead`, `ended_at`, `killed_by`, increment the killer's `kills`, insert into `scores`, and send `player_died`. Always send `cell_eaten` on success. | `{ok, eater_mass}` or `{ok:false, reason}` |
| `split(p_player uuid, p_dx real, p_dy real)` | owner | Lock cells. For each cell with mass ≥ MIN_SPLIT_MASS while count < MAX_CELLS (largest first): halve the mass, insert a new cell at `pos + dir × r`, and set `merge_after = now() + merge_delay` on both. | `{cells:[…new…], dir}`. The client applies `SPLIT_SPEED` to the new cells. |
| `eject(p_player uuid, p_dx real, p_dy real)` | owner | For each cell with mass ≥ EJECT_MIN_MASS: subtract EJECT_COST, insert an `ejecta` pellet at `pos + dir × (r + 420)` (clamped), then send `ejected` with from/to. | `{cells:[{id,mass}]}` |
| `merge_cells(p_a bigint, p_b bigint)` | owner | Both owned, both past `merge_after`, overlap check with tolerance. Then a.mass += b.mass and b is deleted. | `{ok, cell}` |
| `leave_game(p_player uuid)` | owner | Status `left`, delete cells, insert into scores if peak > START_MASS, send `player_left`. | void |

Grant `execute` to `authenticated` on all of these except `spawn_player`, which is service_role only.

---

## 9. Realtime protocol (the contract)

**Channel:** `supabase.channel('room:' + roomId, { config: { private: true, broadcast: { self: false, ack: false }, presence: { key: playerId } } })`

**Client config:** `createClient(url, key, { realtime: { params: { eventsPerSecond: 50 } } })`. Call `supabase.realtime.setAuth()` after anonymous sign-in, before subscribing.

**Presence payload** (`channel.track`): `{ player_id, name, color, skin }`. On `leave`, remove that player's remote cells immediately.

### Client → peers (Broadcast)
| Event | Rate | Payload |
|---|---|---|
| `state` | 15 Hz | `{ p: playerId, t: Date.now(), c: [[cellId, x, y, mass], ...] }`. Integers rounded to 1 decimal. Mass is the latest server value. |

### Database → clients (`realtime.send(payload, event, 'room:'||room_id, true)`)
| Event | Sent by | Payload |
|---|---|---|
| `pellets_spawned` | `game_tick` | `{ p: [[id, x, y, mass, kind], ...] }` |
| `pellets_eaten` | `player_sync` | `{ ids: [...], by: playerId }` |
| `ejected` | `eject` | `{ id, from: [x,y], to: [x,y], mass, by }`. Clients tween over 300 ms. |
| `cell_eaten` | `eat_cell` | `{ eater_cell, eater_player, eater_mass, victim_cell, victim_player }` |
| `player_died` | `eat_cell` | `{ player_id, killer_id, killer_name, peak_mass, kills, survived_seconds }` |
| `player_left` | `leave_game`, `game_tick` | `{ player_id }` |
| `leaderboard` | `game_tick` (1 Hz) | `{ top: [[playerId, name, totalMass], ...10] }` |
| `blooms` | `game_tick` (1 Hz) | `{ b: [[x,y], ...] }` (rendered as a soft glow) |

### Initial state on join
After `join` returns, the client:
1. Selects `pellets where room_id = …`, then players and cells for the room. These are REST reads, allowed by RLS.
2. Subscribes to the channel. Pellet events that arrive during the load are buffered and applied after it.
3. Tracks presence.
4. Starts the state, sync and render loops.

### Realtime Authorization (`0004_realtime.sql`)
```sql
create policy "room members read" on realtime.messages for select to authenticated
  using ( realtime.topic() like 'room:%' and extension in ('broadcast','presence') );
create policy "room members write" on realtime.messages for insert to authenticated
  with check ( realtime.topic() like 'room:%' and extension in ('broadcast','presence') );
alter publication supabase_realtime add table public.scores;  -- menu high-score feed
```
(Stricter option: require an alive `players` row for `auth.uid()` whose `'room:'||room_id = realtime.topic()`. Use it if the simple version works end to end.)

---

## 10. World tick (`0005_tick.sql`)

```sql
create extension if not exists pg_cron;
select cron.schedule('petri-tick', '1 seconds', $$ select public.game_tick() $$);
```

`game_tick()` runs for each room that has at least one alive player:
1. **Stale cleanup:** players with `status='alive' and last_sync_at < now() - 5s` → `left`, delete their cells, send `player_left`.
2. **Decay:** `update cells set mass = mass * 0.998 where mass > 150 and id in (select id from cells where room_id=… order by id for update skip locked)`.
3. **Blooms:** move each bloom by its velocity and bounce off the walls. Initialise 3 blooms if empty. Send `blooms`.
4. **Pellets:** top up to `pellet_target`, at most 150 per tick. 40 % land near a bloom, the rest uniform. Top up thorns to `THORN_COUNT`, kept away from cells. Delete `ejecta` older than 60 s. Send one aggregated `pellets_spawned`.
5. **Leaderboard:** top 10 alive players by `sum(cells.mass)`. Send `leaderboard`.

Keep it set-based and fast (well under 50 ms). Log the duration with `raise debug` during development.

---

## 11. Edge Function `join` and local Realtime limits

**`supabase/functions/join/index.ts`** (`verify_jwt = true`):
1. Read the user from the `Authorization` header (`createClient(url, anonKey, { global: { headers: { Authorization } } }).auth.getUser()`).
2. Validate the body `{ name, skin? }`. Trim to 16 characters, strip control characters, run the `_shared/names.ts` blocklist, fall back to "Cell". `skin` must be a preset name or a path under `skins/<uid>/`.
3. Matchmaking with the service-role client: query `room_list`, pick the fullest room with `player_count < max_players`. If none exists, insert a new room.
4. Call `spawn_player(user.id, room.id, name, skin)` with service role and return its JSON.

**Local Realtime limits.** The local Realtime tenant has default rate limits that 15 Hz × N players with fanout may exceed.
- `scripts/dev-realtime-limits.sql` updates `_realtime.tenants` to raise `max_events_per_second`, `max_concurrent_users`, `max_joins_per_second` and `max_channels_per_client`. `npm run db:limits` runs it via `psql` and then restarts the realtime container.
- **The implementer must verify the column names against the running local stack.** Then confirm with 20 bots that no rate-limit errors appear in the channel `system` events or the realtime logs.

---

## 12. Storage (`config.toml` + `0006_storage.sql`)

```toml
[auth]
enable_anonymous_sign_ins = true

[storage.buckets.skins]
public = true
file_size_limit = "512KiB"
allowed_mime_types = ["image/png", "image/jpeg", "image/webp"]
objects_path = "./skins"        # seeds presets into skins/presets/...

[functions.join]
verify_jwt = true
```
Seeding: put about 8 original preset PNGs at `supabase/skins/presets/*.png`. Simple generated designs are fine: geometric or emoji-style, made in a script.

Policies: authenticated users may `insert/update/delete` objects in `skins` where `(storage.foldername(name))[1] = auth.uid()::text`. Reads are public.

Client: skins are drawn clipped to the circle once radius > 20, cached as `HTMLImageElement` per URL.

---

## 13. Client architecture details

- **Loops:**
  - `requestAnimationFrame` render.
  - Fixed-step 60 Hz sim accumulator for own cells.
  - `setInterval` at 66 ms for the `state` broadcast and 100 ms for `player_sync`.
  - Only one `player_sync` in flight at a time. If one is still pending, merge the eaten-pellet ids into the next call.
- **Reconciliation on `player_sync` response:**
  - The server cell set is the truth. Drop local cells not in it. Add cells that are in it but missing locally (thorn burst).
  - Take mass from the server.
  - For clamped ids, blend the position toward the server value over 150 ms.
  - `status !== 'alive'` → death flow.
- **Eat detection (`detect.ts`), every sim step, using a spatial grid:**
  - **Pellets:** an own cell overlapping a pellet hides it optimistically and queues the id. If it isn't confirmed by `pellets_eaten` or the sync within 1 s, unhide it.
  - **Remote cells:** check against the interpolated position. If the eat rule holds, call `eat_cell` once per victim (500 ms debounce per pair). Hide the victim optimistically on `{ok:true}`.
  - **Thorns:** queue them in `p_eaten`, for cells with mass > 130 only.
- **Remote interpolation:** keep a snapshot buffer per player and render at `now − 100 ms` with linear interpolation. Extrapolate up to 150 ms, then freeze. Cells that appear or disappear between snapshots fade or scale in and out.
- **Render order:**
  1. Background grid and dish edge.
  2. Bloom glows.
  3. Pellets.
  4. Ejecta.
  5. Cells sorted by mass ascending, with thorns drawn between them by size.
  6. Names and mass text on cells with radius > 18.
  7. HUD.
- **HUD:** top-10 leaderboard (from `leaderboard` events, own row highlighted), score, minimap (200 px, own cells plus blooms), debug overlay (FPS, sync RTT, player count) toggled with `` ` ``.
- **Death screen:** peak mass, kills, time survived, killer name. "Play again" calls `join` again with the same name and skin.
- **Menu:** name input (saved in localStorage), preset skin grid plus "upload", room list (`room_list` refreshed every 3 s), and a live all-time top-20 from `top_scores` with `postgres_changes` INSERT on `scores` triggering a refetch.
- **Visual identity (original):** dark "microscope slide" background with a faint hex grid. Cells are translucent with a membrane outline and a slightly wobbly edge (vertex jitter based on velocity). Pellets are small glowing dots. Thorns are spiky purple urchins.

**Stricter alternative (not v1):** the same protocol, but movement *inputs* (target and split/eject) go to a single authoritative Deno process that also uses Realtime. That breaks "Supabase only" unless it runs as a lease-renewed Edge Function, which is a fragile fit for the runtime limits.

---

## 14. Bots (`scripts/bots.ts`)

`npm run bots -- --count 15 --room auto`. Each bot:
- Calls `signInAnonymously` with its own client (separate storage, `persistSession: false`).
- Invokes `join`, subscribes, and tracks presence.
- Runs the same `sim.ts`, `detect.ts` and net modules, imported from `web/src` so they must stay DOM-free.
- Uses simple steering: flee the nearest threatening cell within 500 px, chase the nearest edible cell within 400 px, otherwise head for the nearest bloom or pellet. It splits when an edible target is within 250 px and less than 40 % of its own mass.
- Respawns 3 s after death and logs RPC errors and rate-limit errors.

This forces the net and sim modules in `web/src` to be DOM-free. Rendering and input are the only browser-only modules.

---

## 15. Testing and verification

1. **pgTAP** (`supabase test db`), simulating users with `set local role authenticated; set local request.jwt.claims …`:
   - Direct `insert into cells` as authenticated is denied.
   - `player_sync` clamps a teleport.
   - It refuses to eat a far pellet, and credits a near pellet exactly once.
   - `eat_cell` fails below 1.25×, fails when out of range, succeeds in range, marks death, and inserts a score.
   - A second `eat_cell` on the same victim returns `ok:false`.
   - `split` respects MIN_SPLIT_MASS and MAX_CELLS. `merge_cells` is refused before `merge_after`.
   - `game_tick` tops up pellets and removes stale players.
   - The user cannot call `spawn_player`.
2. **Vitest:** shared formulas, sim (split launch decay, soft collision), interpolation buffer, detect rules, and the TS/SQL constants match.
3. **Integration:** `supabase start && npm run db:limits && supabase functions serve & npm run dev`. Then `npm run bots -- --count 20` for 3 minutes, with no errors in the bot logs and `game_tick` average under 50 ms (`select * from cron.job_run_details order by start_time desc limit 20`).
4. **Manual:** two browser windows. Eat pellets, split-kill the other window, die, play again, upload a skin, watch the high score appear live on the menu.

---

## 16. Implementation order (for the subagent rollout)

| Step | Owner | Depends on | Output |
|---|---|---|---|
| 1. Scaffold | light-implementer | – | `supabase init`, config.toml, Vite TS app, root scripts, `_shared/game.ts`, `.env.local` from `supabase status` |
| 2. Database | heavy-implementer | 1 | migrations 0001–0006, seed, pgTAP suite passing, generated types |
| 3. Edge Function + realtime limits | light-implementer | 2 | `join` working via curl, `db:limits` script verified |
| 4. Client | heavy-implementer | 1 (contract §6–9); can run in parallel with 2–3 | full game client |
| 5. Bots + integration | light-implementer | 3, 4 | bots script, 20-bot soak passing |
| 6. Polish | light-implementer | 5 | skins upload UI, visual polish, README with run instructions |

---

## 17. Open decisions (defaults chosen)

1. **Name and theme:** "Petri", microscope aesthetic.
2. **Anti-cheat strictness:** hybrid referee (§3), not a single authoritative server.
3. **Player cap:** 40 per room. Rooms are created on demand.
4. **Timed rounds** (pg_cron ends a 10-minute round, archives a `round_results` table, resets the room): **stretch goal, not v1.**
5. **Account upgrade** (link email to an anonymous user to keep high scores): stretch goal.
