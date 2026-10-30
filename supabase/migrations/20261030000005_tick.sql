-- 0005 world tick (PLAN.md §10). Runs every second via pg_cron, only for rooms with alive players.
-- Never waits on row locks: everything it locks uses `skip locked`, so it cannot deadlock with RPCs.

create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.game_tick()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  g jsonb := public.gc();
  k_stale interval := make_interval(secs => (g->>'STALE_PLAYER_S')::double precision);
  k_decay_threshold double precision := (g->>'DECAY_THRESHOLD')::double precision;
  k_decay_rate double precision := (g->>'DECAY_RATE')::double precision;  -- per second; tick = 1 s
  k_bloom_count int := (g->>'BLOOM_COUNT')::int;
  k_bloom_radius double precision := (g->>'BLOOM_RADIUS')::double precision;
  k_bloom_fraction double precision := (g->>'BLOOM_FRACTION')::double precision;
  k_pellet_mass double precision := (g->>'PELLET_MASS')::double precision;
  k_pellet_max int := (g->>'PELLET_MAX_PER_TICK')::int;
  k_thorn_count int := (g->>'THORN_COUNT')::int;
  k_thorn_mass double precision := (g->>'THORN_MASS')::double precision;
  k_ejecta_ttl constant interval := interval '60 seconds';
  k_pad constant double precision := 10;   -- keep pellets this far from the walls
  v_t0 timestamptz := clock_timestamp();
  r public.rooms;
  v_pid uuid;
  v_retired public.players;
  v_ws double precision;
  v_blooms jsonb;
  v_nb int;
  v_n int;
  v_missing int;
  v_expired bigint[];
  v_food jsonb;
  v_thorns jsonb;
  v_top jsonb;
begin
  for r in
    select * from public.rooms rm
     where exists (select 1 from public.players p where p.room_id = rm.id and p.status = 'alive')
     order by rm.id
  loop
    v_ws := r.world_size;

    -- 1. Stale players -> left.
    for v_pid in
      select p.id from public.players p
       where p.room_id = r.id and p.status = 'alive' and p.last_sync_at < now() - k_stale
       order by p.id
       for no key update skip locked
    loop
      v_retired := private.retire_player(v_pid, 'left', null, true);
      if v_retired.id is not null then
        perform private.send(r.id, 'player_left', jsonb_build_object('player_id', v_pid));
      end if;
    end loop;

    -- Orphaned cells (owner no longer alive, e.g. rows skipped above while locked).
    delete from public.cells where id in (
      select c.id from public.cells c join public.players p on p.id = c.player_id
       where c.room_id = r.id and p.status <> 'alive'
       for update of c skip locked);

    -- 2. Decay.
    update public.cells set mass = mass * (1 - k_decay_rate)
     where id in (select id from public.cells
                   where room_id = r.id and mass > k_decay_threshold
                   order by id for update skip locked);

    -- 3. Blooms: init if needed, drift with a gentle random turn, bounce off the walls.
    v_blooms := coalesce(r.blooms, '[]'::jsonb);
    if jsonb_typeof(v_blooms) <> 'array' or jsonb_array_length(v_blooms) < k_bloom_count then
      select jsonb_agg(jsonb_build_object(
               'x', k_bloom_radius + random() * (v_ws - 2 * k_bloom_radius),
               'y', k_bloom_radius + random() * (v_ws - 2 * k_bloom_radius),
               'vx', cos(t.a) * t.s, 'vy', sin(t.a) * t.s))
        into v_blooms
        from (select random() * 2 * pi() as a, 20 + random() * 20 as s
                from generate_series(1, k_bloom_count)) t;
    else
      select jsonb_agg(jsonb_build_object(
               'x', case when m.nx < m.lo then 2 * m.lo - m.nx when m.nx > m.hi then 2 * m.hi - m.nx else m.nx end,
               'y', case when m.ny < m.lo then 2 * m.lo - m.ny when m.ny > m.hi then 2 * m.hi - m.ny else m.ny end,
               'vx', case when m.nx < m.lo or m.nx > m.hi then -m.vx else m.vx end,
               'vy', case when m.ny < m.lo or m.ny > m.hi then -m.vy else m.vy end) order by m.ord)
        into v_blooms
        from (select b.ord, k_bloom_radius as lo, v_ws - k_bloom_radius as hi,
                     (b.e->>'x')::double precision + t.vx as nx,
                     (b.e->>'y')::double precision + t.vy as ny,
                     t.vx, t.vy
                from jsonb_array_elements(v_blooms) with ordinality as b(e, ord)
                cross join lateral (
                  select (b.e->>'vx')::double precision * cos(w.da) - (b.e->>'vy')::double precision * sin(w.da) as vx,
                         (b.e->>'vx')::double precision * sin(w.da) + (b.e->>'vy')::double precision * cos(w.da) as vy
                    from (select (random() - 0.5) * 0.3 as da) w
                ) t) m;
    end if;
    update public.rooms set blooms = v_blooms where id = r.id;
    v_nb := jsonb_array_length(v_blooms);
    perform private.send(r.id, 'blooms', jsonb_build_object('b',
      (select jsonb_agg(jsonb_build_array(round((e->>'x')::numeric), round((e->>'y')::numeric)))
         from jsonb_array_elements(v_blooms) e)));

    -- 4a. Expire old ejecta (announced as pellets_eaten with by = null).
    with del as (
      delete from public.pellets where id in (
        select id from public.pellets
         where room_id = r.id and kind = 'ejecta' and created_at < now() - k_ejecta_ttl
         for update skip locked)
      returning id
    )
    select array_agg(id) into v_expired from del;
    if v_expired is not null then
      perform private.send(r.id, 'pellets_eaten', jsonb_build_object('ids', to_jsonb(v_expired), 'by', null));
    end if;

    -- 4b. Food top-up: at most PELLET_MAX_PER_TICK, BLOOM_FRACTION of them near a bloom.
    select count(*) into v_n from public.pellets where room_id = r.id and kind = 'food';
    v_missing := least(k_pellet_max, r.pellet_target - v_n);
    v_food := null;
    if v_missing > 0 then
      with ins as (
        insert into public.pellets (room_id, kind, x, y, mass)
        select r.id, 'food',
               private.clampf(case when s.near then (v_blooms->s.bi->>'x')::double precision + cos(s.a) * s.d else s.ux end, k_pad, v_ws - k_pad),
               private.clampf(case when s.near then (v_blooms->s.bi->>'y')::double precision + sin(s.a) * s.d else s.uy end, k_pad, v_ws - k_pad),
               k_pellet_mass
          from (select v_nb > 0 and random() < k_bloom_fraction as near,
                       floor(random() * greatest(v_nb, 1))::int as bi,
                       random() * 2 * pi() as a,
                       k_bloom_radius * sqrt(random()) as d,
                       k_pad + random() * (v_ws - 2 * k_pad) as ux,
                       k_pad + random() * (v_ws - 2 * k_pad) as uy
                  from generate_series(1, v_missing)) s
        returning id, x, y, mass, kind
      )
      select jsonb_agg(jsonb_build_array(id, round(x::numeric, 1), round(y::numeric, 1), mass, kind) order by id)
        into v_food from ins;
    end if;

    -- 4c. Thorn top-up, kept away from cells.
    select count(*) into v_n from public.pellets where room_id = r.id and kind = 'thorn';
    v_missing := k_thorn_count - v_n;
    v_thorns := null;
    if v_missing > 0 then
      with cand as (
        select 150 + random() * (v_ws - 300) as x, 150 + random() * (v_ws - 300) as y
          from generate_series(1, v_missing * 4)
      ), ok as (
        select cand.x, cand.y from cand
         where not exists (
           select 1 from public.cells c
            where c.room_id = r.id
              and (c.x - cand.x) ^ 2 + (c.y - cand.y) ^ 2
                  < (public.cell_radius(c.mass) + public.cell_radius(k_thorn_mass) + 20) ^ 2)
         limit v_missing
      ), ins as (
        insert into public.pellets (room_id, kind, x, y, mass)
        select r.id, 'thorn', ok.x, ok.y, k_thorn_mass from ok
        returning id, x, y, mass, kind
      )
      select jsonb_agg(jsonb_build_array(id, round(x::numeric, 1), round(y::numeric, 1), mass, kind) order by id)
        into v_thorns from ins;
    end if;

    if v_food is not null or v_thorns is not null then
      perform private.send(r.id, 'pellets_spawned', jsonb_build_object('p',
        coalesce(v_food, '[]'::jsonb) || coalesce(v_thorns, '[]'::jsonb)));
    end if;

    -- 5. Leaderboard: top 10 alive players by total mass.
    select coalesce(jsonb_agg(jsonb_build_array(t.id, t.name, t.total) order by t.total desc, t.id), '[]'::jsonb)
      into v_top
      from (select p.id, p.name, round(sum(c.mass)::numeric)::int as total
              from public.players p
              join public.cells c on c.player_id = p.id
             where p.room_id = r.id and p.status = 'alive'
             group by p.id, p.name
             order by total desc, p.id
             limit 10) t;
    perform private.send(r.id, 'leaderboard', jsonb_build_object('top', v_top));
  end loop;

  raise debug 'game_tick: % ms', round((extract(epoch from clock_timestamp() - v_t0) * 1000)::numeric, 2);
end;
$$;

revoke all on function public.game_tick() from public, anon, authenticated;
grant execute on function public.game_tick() to service_role;

-- Every second. cron.schedule upserts by job name.
select cron.schedule('petri-tick', '1 seconds', $$ select public.game_tick() $$);
-- Keep cron.job_run_details small (the tick writes 86k rows/day).
select cron.schedule('petri-cron-cleanup', '*/10 * * * *',
  $$ delete from cron.job_run_details where end_time < now() - interval '1 hour' $$);
