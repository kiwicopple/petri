-- 0001 schema: tables, indexes, views, RLS, grants (PLAN.md §7).
-- Clients are read-only; every write goes through security definer RPCs (0003).

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  max_players int not null default 40,
  world_size int not null default 6000,
  pellet_target int not null default 1200,
  blooms jsonb not null default '[]',        -- [{x,y,vx,vy}]
  created_at timestamptz default now()
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  room_id uuid not null references public.rooms on delete cascade,
  name text not null,
  color text not null,                       -- hex from palette
  skin text,                                 -- storage path or null
  status text not null default 'alive' check (status in ('alive','dead','left')),
  kills int not null default 0,
  peak_mass real not null default 0,
  spawned_at timestamptz not null default now(),
  ended_at timestamptz,
  last_sync_at timestamptz not null default now(),
  killed_by uuid references public.players on delete set null
);
create unique index one_alive_player_per_user on public.players(user_id) where status = 'alive';
create index players_room_alive_idx on public.players(room_id) where status = 'alive';
create index players_killed_by_idx on public.players(killed_by);

create table public.cells (
  id bigint generated always as identity primary key,
  player_id uuid not null references public.players on delete cascade,
  room_id uuid not null references public.rooms on delete cascade,
  x real not null, y real not null,
  mass real not null,
  merge_after timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index cells_room_idx on public.cells(room_id);
create index cells_player_idx on public.cells(player_id);

create table public.pellets (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms on delete cascade,
  kind text not null default 'food' check (kind in ('food','ejecta','thorn')),
  x real not null, y real not null,
  mass real not null default 1,
  created_at timestamptz not null default now()
);
create index pellets_room_kind_idx on public.pellets(room_id, kind);

create table public.scores (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users on delete set null,
  player_id uuid,
  name text not null,
  peak_mass real not null,
  kills int not null,
  survived_seconds int not null,
  created_at timestamptz not null default now()
);
create index scores_peak_idx on public.scores(peak_mass desc);
create index scores_user_idx on public.scores(user_id);

create view public.top_scores with (security_invoker = true) as
  select name, peak_mass, kills, survived_seconds, created_at
  from public.scores order by peak_mass desc limit 20;

create view public.room_list with (security_invoker = true) as
  select r.id, r.name, r.max_players,
         (select count(*) from public.players p where p.room_id = r.id and p.status = 'alive') as player_count
  from public.rooms r;

-- ---------------------------------------------------------------- RLS
alter table public.rooms   enable row level security;
alter table public.players enable row level security;
alter table public.cells   enable row level security;
alter table public.pellets enable row level security;
alter table public.scores  enable row level security;

create policy "authenticated read rooms"   on public.rooms   for select to authenticated using (true);
create policy "authenticated read players" on public.players for select to authenticated using (true);
create policy "authenticated read cells"   on public.cells   for select to authenticated using (true);
create policy "authenticated read pellets" on public.pellets for select to authenticated using (true);
create policy "authenticated read scores"  on public.scores  for select to authenticated using (true);

-- ---------------------------------------------------------------- grants
-- Supabase default privileges grant everything to anon/authenticated; strip them.
revoke all on public.rooms, public.players, public.cells, public.pellets, public.scores,
              public.top_scores, public.room_list
  from anon, authenticated, public;
grant select on public.rooms, public.players, public.cells, public.pellets, public.scores,
                public.top_scores, public.room_list
  to authenticated;
-- service_role (edge function) keeps its default full access (it bypasses RLS).
