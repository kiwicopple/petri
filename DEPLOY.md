# Deploying Petri

Backend: hosted Supabase project `gaoqzbrpakuewjprknwq`. Frontend: Vercel (static Vite build).

## Backend (Supabase)

```bash
supabase login
supabase link --project-ref gaoqzbrpakuewjprknwq

supabase db push                       # migrations: schema, RPCs, realtime policies, pg_cron tick, storage policies
supabase config push                   # anonymous sign-ins + skins bucket settings (review the diff)
supabase functions deploy join --no-verify-jwt
supabase seed buckets --linked         # upload preset skins (or upload supabase/skins/presets/ via the dashboard)
```

If the Supabase GitHub integration is connected, migrations may also be applied on push to `main`.
The edge function also has to be deployed, and the dashboard settings checked, as described above and below.

Dashboard checks:
- **Auth → Providers:** anonymous sign-ins are enabled.
- **Storage:** the `skins` bucket is public, with a 512 KB limit and the png/jpeg/webp MIME types. The presets are uploaded.
- **Integrations → Cron:** `petri-tick` runs every second without failures.
- **Seed rooms:** `seed.sql` is not needed. `join` creates rooms on demand.

`join` reads `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`, which are provided automatically.
It authenticates callers itself via `auth.getUser()`, so it is deployed with `--no-verify-jwt`.

## Frontend (Vercel)

`vercel.json` sets the build: `npm run build` from the repo root, output `web/dist`.
The repo root must be the build root, because Vite imports `supabase/functions/_shared`.

Environment variables (Project Settings → Environment Variables):

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://gaoqzbrpakuewjprknwq.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | anon (or publishable) key from Supabase → Project Settings → API |

Vite inlines these at build time, so redeploy after changing them.

## Before going public

- **Realtime quotas.** Each player broadcasts movement at `NET_STATE_HZ` (15 Hz) to the whole room.
  - A full 40-player room fans out to tens of thousands of messages per second, which is well beyond hosted plan limits.
  - Lower `NET_STATE_HZ`, lower `rooms.max_players`, or both.
  - `npm run db:limits` only affects the local stack.
- **Abuse.** Enable CAPTCHA (Cloudflare Turnstile) and the anonymous sign-in rate limits under Auth → Attack Protection.
- **CORS.** Restrict `Access-Control-Allow-Origin` in `supabase/functions/join/index.ts` to your Vercel domain.
- **Database load.** The cron tick runs every second. Watch database CPU on small instances.
