# Petri

Petri is a multiplayer cell-eating game for the browser, in the style of agar.io. You steer a translucent cell around a dark petri dish, eat pellets to grow, split to catch smaller cells, and avoid bigger ones and the spiky thorns. Everything runs on Supabase: there is no custom game server. Each client simulates its own cells and streams them to the room over Realtime, while Postgres functions act as the referee that validates every pellet, kill and split.

## Supabase primitives used

| Primitive | Used for |
|---|---|
| Auth (anonymous sign-ins) | Every browser gets a real `auth.uid()` without signup |
| Postgres tables + RLS | Rooms, players, cells, pellets, scores; clients read, only RPCs write |
| Postgres functions (RPC) | The referee: `player_sync`, `eat_cell`, `split`, `eject`, `merge_cells`, `leave_game` |
| Realtime Broadcast | Client-to-client movement; database-to-client events (`realtime.send`) |
| Realtime Presence | Who is in the room, disconnect detection, lobby counts |
| Realtime Authorization | Private channels guarded by RLS on `realtime.messages` |
| Realtime Postgres Changes | Live all-time high-score list on the menu |
| pg_cron (sub-minute) | 1 s world tick: pellets, blooms, decay, stale-player cleanup, leaderboard |
| Edge Functions | `join`: name validation, matchmaking, safe spawn |
| Storage | `skins` bucket: seeded preset skins plus user uploads (per-user folders, 512 KiB, image MIME types) |
| pgTAP | Database tests for RPC rules and RLS |

## Prerequisites

- Node.js 20+ and npm
- [Supabase CLI](https://supabase.com/docs/guides/cli) and Docker (for the local stack)
- `psql` on your PATH (used by `npm run db:limits`)

## Run it

```bash
npm install
supabase start                  # applies migrations, seeds rooms and preset skins
npm run db:limits               # raise local Realtime limits (needed after every start/restart)
supabase functions serve        # in a second terminal: serves the `join` function
supabase status -o env          # copy API_URL and ANON_KEY into web/.env.local (see web/.env.example)
npm run dev                     # http://localhost:5173
npm run bots -- --count 15      # optional: fill the dish with bots
```

`web/.env.local` needs `VITE_SUPABASE_URL` (the `API_URL`) and `VITE_SUPABASE_ANON_KEY` (the `ANON_KEY`).

## Controls

| Input | Action |
|---|---|
| Mouse | Steer your cells toward the cursor |
| Space | Split |
| W | Eject mass |
| `` ` `` (backtick) | Toggle the debug overlay (FPS, sync RTT, player count) |

## Testing

```bash
npm test             # vitest: shared formulas, sim, interpolation, detection, TS/SQL constants
npm run test:db      # pgTAP via `supabase test db` (needs the stack running)
npm run typecheck    # tsc --noEmit
npm run build        # production build of the web client
```

Soak test: `npm run bots -- --count 20 --duration 180` should finish with no RPC or rate-limit errors.

## Gotchas

- **Anon key rotation.** `supabase db reset` and full restarts generate new keys. Re-copy `ANON_KEY` from `supabase status -o env` into `web/.env.local` and restart `npm run dev` and the bots. Avoid resets while developing.
- **Realtime limits.** The local Realtime container re-seeds its tenant limits (100 events/s) on boot. Run `npm run db:limits` after every `supabase start` or Realtime restart, or players will be rate limited.
- **`verify_jwt = false` for `join`.** The local Edge runtime rejects the ES256 tokens issued by local Auth, so `supabase/config.toml` disables gateway JWT verification for `join`. The function still authenticates the caller itself with `auth.getUser()`. If `join` returns `{"msg":"Invalid JWT"}`, restart `supabase functions serve`.
- **Skins directory.** `supabase/skins/` is seeded into the `skins` bucket on start, and the bucket only accepts PNG, JPEG and WebP. Put only image files there (presets live in `supabase/skins/presets/`, regenerate with `npm run gen-skins`). Any other file type fails the seed.
- **Types.** After a schema change, run `npm run gen-types` to refresh `web/src/db.types.ts`.

## Architecture

The full design lives in [PLAN.md](PLAN.md): the trust model (§3), data model (§7), RPC API (§8), the Realtime protocol (§9), the world tick (§10), the `join` function (§11), storage (§12) and the client (§13).

- `supabase/migrations/`: schema, game constants, RPCs, realtime policies, tick, storage.
- `supabase/functions/join` and `_shared/`: matchmaking plus constants shared with the client.
- `web/src/net`, `web/src/game`: Realtime room, `player_sync` loop, local sim, interpolation, eat detection. `net` and the sim modules stay DOM-free so the bots can reuse them.
- `web/src/ui`, `web/src/game/render.ts`: menu, HUD, death screen and canvas rendering (browser only).
- `scripts/bots.ts`: headless bots built on the same client modules.
