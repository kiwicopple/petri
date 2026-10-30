-- 0003 RPCs: the referee (PLAN.md §8).
--
-- All public functions are security definer with search_path = '' and fully qualified names.
-- Locking rules (deadlock avoidance):
--   1. Cells are always locked first, with `order by id for update`.
--   2. Player rows are locked only after all cell locks, in id order, with `for no key update`
--      (no-key so FK checks from cells/killed_by, which take key-share locks, never conflict).
--   3. Nobody waits on a cell lock while holding a player lock. game_tick only uses skip locked.
-- Ownership failures raise SQLSTATE 42501. Game-rule failures return {ok:false, reason}.
-- Timestamps in JSON results are epoch milliseconds (bigint).

-- ------------------------------------------------------------------ private helpers

create or replace function private.epoch_ms(ts timestamptz)
returns bigint
language sql immutable parallel safe
set search_path = ''
as $$ select (extract(epoch from ts) * 1000)::bigint $$;

create or replace function private.clampf(v double precision, lo double precision, hi double precision)
returns double precision
language sql immutable parallel safe
set search_path = ''
as $$ select least(greatest(v, lo), hi) $$;

-- {id, x, y, mass, merge_after (epoch ms), born (created_at, epoch ms)}
create or replace function private.cell_json(c public.cells)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.id,
    'x', round(c.x::numeric, 2),
    'y', round(c.y::numeric, 2),
    'mass', round(c.mass::numeric, 2),
    'merge_after', private.epoch_ms(c.merge_after),
    'born', private.epoch_ms(c.created_at)
  )
$$;

-- Broadcast from the database to a room's private channel.
create or replace function private.send(p_room uuid, p_event text, p_payload jsonb)
returns void
language sql
set search_path = ''
as $$ select realtime.send(p_payload, p_event, 'room:' || p_room::text, true) $$;

-- Returns the player row if it belongs to auth.uid(); raises 42501 otherwise.
create or replace function private.owned_player(p_player uuid)
returns public.players
language plpgsql stable
set search_path = ''
as $$
declare
  r public.players;
begin
  select * into r from public.players where id = p_player;
  if not found or r.user_id is distinct from auth.uid() then
    raise exception 'player % does not belong to the current user', p_player using errcode = '42501';
  end if;
  return r;
end;
$$;

-- Ends a player's life: status/ended_at/killed_by, deletes their cells, records a score
-- (always for 'dead', for 'left' only if peak_mass > START_MASS).
-- Caller must already hold the cell locks (or pass p_skip_locked => true) and the player lock.
-- Returns the updated player row, or null if the player was not alive.
create or replace function private.retire_player(p_player uuid, p_status text, p_killer uuid default null, p_skip_locked boolean default false)
returns public.players
language plpgsql
set search_path = ''
as $$
declare
  r public.players;
  k_start double precision := (public.gc()->>'START_MASS')::double precision;
begin
  update public.players
     set status = p_status, ended_at = now(), killed_by = p_killer
   where id = p_player and status = 'alive'
  returning * into r;
  if not found then
    return null;
  end if;

  if p_skip_locked then
    delete from public.cells where id in (
      select id from public.cells where player_id = p_player order by id for update skip locked);
  else
    delete from public.cells where player_id = p_player;
  end if;

  if p_status = 'dead' or r.peak_mass > k_start then
    insert into public.scores (user_id, player_id, name, peak_mass, kills, survived_seconds)
    values (r.user_id, r.id, r.name, r.peak_mass, r.kills,
            greatest(0, extract(epoch from r.ended_at - r.spawned_at))::int);
  end if;
  return r;
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ------------------------------------------------------------------ spawn_player (service_role)

create or replace function public.spawn_player(p_user uuid, p_room uuid, p_name text, p_skin text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g jsonb := public.gc();
  k_start double precision := (g->>'START_MASS')::double precision;
  k_threat double precision := k_start * (g->>'EAT_RATIO')::double precision;
  v_room public.rooms;
  v_old record;
  v_color text;
  v_x double precision;
  v_y double precision;
  v_margin double precision;
  v_player public.players;
  v_cell public.cells;
begin
  if p_user is null then
    raise exception 'p_user is required' using errcode = '22004';
  end if;
  select * into v_room from public.rooms where id = p_room;
  if not found then
    raise exception 'room % not found', p_room using errcode = 'P0002';
  end if;

  -- Retire any previous alive player of this user (cells first, then player rows).
  perform 1 from public.cells c
   where c.player_id in (select p.id from public.players p where p.user_id = p_user and p.status = 'alive')
   order by c.id for update;
  for v_old in
    select p.id, p.room_id from public.players p
     where p.user_id = p_user and p.status = 'alive'
     order by p.id for no key update
  loop
    perform private.retire_player(v_old.id, 'left');
    perform private.send(v_old.room_id, 'player_left', jsonb_build_object('player_id', v_old.id));
  end loop;

  v_color := (g->'PALETTE')->>(floor(random() * jsonb_array_length(g->'PALETTE')))::int;

  -- Safe spawn: 12 random points, keep the one farthest from any threatening cell.
  v_margin := least(200, v_room.world_size / 4.0);
  select s.x, s.y into v_x, v_y
    from (select v_margin + random() * (v_room.world_size - 2 * v_margin) as x,
                 v_margin + random() * (v_room.world_size - 2 * v_margin) as y
            from generate_series(1, 12)) s
    left join lateral (
      select min(sqrt((c.x - s.x) ^ 2 + (c.y - s.y) ^ 2) - public.cell_radius(c.mass)) as d
        from public.cells c
       where c.room_id = p_room and c.mass >= k_threat
    ) t on true
   order by coalesce(t.d, 1e12) desc
   limit 1;

  insert into public.players (user_id, room_id, name, color, skin, peak_mass)
  values (p_user, p_room, coalesce(nullif(btrim(p_name), ''), 'Cell'), v_color, nullif(p_skin, ''), k_start)
  returning * into v_player;

  insert into public.cells (player_id, room_id, x, y, mass)
  values (v_player.id, p_room, v_x, v_y, k_start)
  returning * into v_cell;

  return jsonb_build_object(
    'player_id', v_player.id,
    'room_id', p_room,
    'world_size', v_room.world_size,
    'color', v_color,
    'name', v_player.name,
    'skin', v_player.skin,
    'cell', private.cell_json(v_cell)
  );
end;
$$;

-- ------------------------------------------------------------------ player_sync

create or replace function public.player_sync(p_player uuid, p_cells jsonb, p_eaten bigint[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g jsonb := public.gc();
  k_max_cells int := (g->>'MAX_CELLS')::int;
  k_max_mass double precision := (g->>'MAX_CELL_MASS')::double precision;
  k_pellet_r double precision := (g->>'PELLET_RADIUS')::double precision;
  k_thorn_mass double precision := (g->>'THORN_MASS')::double precision;
  k_thorn_ratio double precision := (g->>'THORN_BURST_RATIO')::double precision;
  k_slack constant double precision := 40;  -- px of staleness slack for pellet/thorn overlap
  v_player public.players;
  v_status text;
  v_ws double precision;
  v_corr bigint[] := '{}'::bigint[];
  v_eaten bigint[] := '{}'::bigint[];
  v_thorn record;
  v_cell public.cells;
  v_count int;
  v_pieces int;
  v_piece_mass double precision;
  v_ring double precision;
  v_total double precision;
  v_cells jsonb;
begin
  v_player := private.owned_player(p_player);

  -- Lock own cells first (locking rule), then re-read the status: a concurrent eat_cell may have
  -- killed this player while we waited.
  perform 1 from public.cells where player_id = p_player order by id for update;
  select status into v_status from public.players where id = p_player;
  if v_status <> 'alive' then
    return jsonb_build_object('status', v_status, 'cells', '[]'::jsonb, 'corrections', '[]'::jsonb);
  end if;
  select world_size into v_ws from public.rooms where id = v_player.room_id;

  -- (1) Positions: clamp each move to POS_TOLERANCE since synced_at, then to world bounds.
  if jsonb_typeof(p_cells) = 'array' then
    with rep as (
      select distinct on (s.id) s.id, s.x, s.y
        from (select (e->>'id')::numeric::bigint as id,
                     (e->>'x')::double precision as x,
                     (e->>'y')::double precision as y
                from jsonb_array_elements(p_cells) e
               where jsonb_typeof(e) = 'object'
                 and jsonb_typeof(e->'id') = 'number'
                 and jsonb_typeof(e->'x') = 'number'
                 and jsonb_typeof(e->'y') = 'number') s
       order by s.id
    ), calc as (
      select c.id, c.x as ox, c.y as oy, r.x - c.x as dx, r.y - c.y as dy,
             sqrt((r.x - c.x) ^ 2 + (r.y - c.y) ^ 2) as d,
             public.pos_tolerance(c.mass,
                                  least(1.0, extract(epoch from now() - c.synced_at)::double precision),
                                  extract(epoch from now() - c.created_at)::double precision) as tol
        from public.cells c
        join rep r on r.id = c.id
       where c.player_id = p_player
    ), tgt as (
      select id, d > tol as clamped,
             case when d > tol then ox + dx * tol / d else ox + dx end as tx,
             case when d > tol then oy + dy * tol / d else oy + dy end as ty
        from calc
    ), upd as (
      update public.cells c
         set x = private.clampf(t.tx, 0, v_ws),
             y = private.clampf(t.ty, 0, v_ws),
             synced_at = now()
        from tgt t
       where c.id = t.id
      returning c.id, (t.clamped or t.tx < 0 or t.tx > v_ws or t.ty < 0 or t.ty > v_ws) as corrected
    )
    select coalesce(array_agg(u.id order by u.id) filter (where u.corrected), '{}') into v_corr from upd u;
  end if;

  if p_eaten is not null and cardinality(p_eaten) > 0 then
    -- (2) Food/ejecta: delete only pellets some own cell actually overlaps (with slack),
    -- credit each to the nearest own cell. A pellet can be deleted (and credited) only once.
    with eaten as (
      delete from public.pellets p
       where p.id = any(p_eaten)
         and p.room_id = v_player.room_id
         and p.kind in ('food', 'ejecta')
         and exists (select 1 from public.cells c
                      where c.player_id = p_player
                        and (c.x - p.x) ^ 2 + (c.y - p.y) ^ 2 <= (public.cell_radius(c.mass) + k_pellet_r + k_slack) ^ 2)
      returning p.id, p.x, p.y, p.mass
    ), credit as (
      select e.id, e.mass,
             (select c.id from public.cells c
               where c.player_id = p_player
               order by (c.x - e.x) ^ 2 + (c.y - e.y) ^ 2, c.id
               limit 1) as cid
        from eaten e
    ), upd as (
      update public.cells c
         set mass = least(c.mass + s.m, k_max_mass)
        from (select cid, sum(mass) as m from credit group by cid) s
       where c.id = s.cid
      returning c.id
    )
    select coalesce(array_agg(id order by id), '{}') into v_eaten from credit;

    -- (3) Thorns: an overlapping own cell with mass > THORN_BURST_RATIO * THORN_MASS bursts into
    -- equal pieces (total cells capped at MAX_CELLS, pieces >= 10 mass), placed on a ring.
    for v_thorn in
      select p.id, p.x, p.y from public.pellets p
       where p.id = any(p_eaten) and p.room_id = v_player.room_id and p.kind = 'thorn'
       order by p.id
       for update skip locked
    loop
      select count(*) into v_count from public.cells where player_id = p_player;
      exit when v_count >= k_max_cells;

      select * into v_cell from public.cells c
       where c.player_id = p_player
         and c.mass > k_thorn_ratio * k_thorn_mass
         and (c.x - v_thorn.x) ^ 2 + (c.y - v_thorn.y) ^ 2 <= (public.cell_radius(c.mass) + k_slack) ^ 2
       order by c.mass desc, c.id
       limit 1;
      continue when not found;

      v_pieces := least(k_max_cells - v_count + 1, floor(v_cell.mass / 10)::int);
      continue when v_pieces < 2;

      delete from public.pellets where id = v_thorn.id;
      v_eaten := v_eaten || v_thorn.id;

      v_piece_mass := v_cell.mass / v_pieces;
      v_ring := public.cell_radius(v_cell.mass) * 0.5;
      update public.cells
         set mass = v_piece_mass,
             merge_after = now() + make_interval(secs => public.merge_delay(v_piece_mass))
       where id = v_cell.id;
      insert into public.cells (player_id, room_id, x, y, mass, merge_after)
      select p_player, v_player.room_id,
             private.clampf(v_cell.x + cos(2 * pi() * k / (v_pieces - 1)) * v_ring, 0, v_ws),
             private.clampf(v_cell.y + sin(2 * pi() * k / (v_pieces - 1)) * v_ring, 0, v_ws),
             v_piece_mass,
             now() + make_interval(secs => public.merge_delay(v_piece_mass))
        from generate_series(0, v_pieces - 2) k;
    end loop;
  end if;

  -- (4) peak_mass + heartbeat (player row locked after cells).
  select coalesce(sum(mass), 0) into v_total from public.cells where player_id = p_player;
  update public.players
     set peak_mass = greatest(peak_mass, v_total), last_sync_at = now()
   where id = p_player;

  -- (5) Tell the room which pellets/thorns are gone.
  if cardinality(v_eaten) > 0 then
    perform private.send(v_player.room_id, 'pellets_eaten',
                         jsonb_build_object('ids', to_jsonb(v_eaten), 'by', p_player));
  end if;

  select coalesce(jsonb_agg(private.cell_json(c) order by c.id), '[]'::jsonb) into v_cells
    from public.cells c where c.player_id = p_player;

  return jsonb_build_object('status', 'alive', 'cells', v_cells, 'corrections', to_jsonb(v_corr));
end;
$$;

-- ------------------------------------------------------------------ eat_cell

create or replace function public.eat_cell(p_eater bigint, p_victim bigint, p_ex real, p_ey real)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g jsonb := public.gc();
  k_ratio double precision := (g->>'EAT_RATIO')::double precision;
  k_overlap double precision := (g->>'EAT_OVERLAP')::double precision;
  k_max_mass double precision := (g->>'MAX_CELL_MASS')::double precision;
  c public.cells;
  e public.cells;
  v public.cells;
  v_owner uuid;
  v_eater_status text;
  v_ws double precision;
  v_tol double precision;
  v_dx double precision;
  v_dy double precision;
  v_d double precision;
  v_ex double precision;
  v_ey double precision;
  v_reach double precision;
  v_new_mass double precision;
  v_left int;
  ep public.players;
  vp public.players;
begin
  if p_eater = p_victim then
    return jsonb_build_object('ok', false, 'reason', 'same_cell');
  end if;

  for c in select * from public.cells where id in (p_eater, p_victim) order by id for update loop
    if c.id = p_eater then e := c; else v := c; end if;
  end loop;

  if e.id is null then
    return jsonb_build_object('ok', false, 'reason', 'eater_gone');
  end if;
  select user_id, status into v_owner, v_eater_status from public.players where id = e.player_id;
  if v_owner is distinct from auth.uid() then
    raise exception 'cell % does not belong to the current user', p_eater using errcode = '42501';
  end if;
  if v.id is null then
    return jsonb_build_object('ok', false, 'reason', 'gone');
  end if;
  if v_eater_status <> 'alive' then
    return jsonb_build_object('ok', false, 'reason', 'dead');
  end if;
  if v.room_id <> e.room_id then
    return jsonb_build_object('ok', false, 'reason', 'wrong_room');
  end if;
  if v.player_id = e.player_id then
    return jsonb_build_object('ok', false, 'reason', 'same_player');
  end if;
  if e.mass < k_ratio * v.mass then
    return jsonb_build_object('ok', false, 'reason', 'too_small');
  end if;

  -- Plausibility clamp on the reported eater position.
  select world_size into v_ws from public.rooms where id = e.room_id;
  v_ex := coalesce(p_ex, e.x);
  v_ey := coalesce(p_ey, e.y);
  v_dx := v_ex - e.x;
  v_dy := v_ey - e.y;
  v_d := sqrt(v_dx * v_dx + v_dy * v_dy);
  v_tol := public.pos_tolerance(e.mass,
                                least(1.0, extract(epoch from now() - e.synced_at)::double precision),
                                extract(epoch from now() - e.created_at)::double precision);
  if v_d > v_tol then
    v_ex := e.x + v_dx * v_tol / v_d;
    v_ey := e.y + v_dy * v_tol / v_d;
  end if;
  v_ex := private.clampf(v_ex, 0, v_ws);
  v_ey := private.clampf(v_ey, 0, v_ws);

  -- Overlap: dist <= r_e - 0.35 r_v + speed(victim) * min(0.3, staleness) + 30
  v_reach := public.cell_radius(e.mass) - k_overlap * public.cell_radius(v.mass)
             + public.cell_speed(v.mass) * least(0.3, greatest(0, extract(epoch from now() - v.synced_at)::double precision))
             + 30;
  if sqrt((v_ex - v.x) ^ 2 + (v_ey - v.y) ^ 2) > v_reach then
    return jsonb_build_object('ok', false, 'reason', 'out_of_range');
  end if;

  -- Success.
  v_new_mass := least(e.mass + v.mass, k_max_mass);
  update public.cells set mass = v_new_mass, x = v_ex, y = v_ey, synced_at = now() where id = e.id;
  delete from public.cells where id = v.id;

  -- Player rows after cells, in id order. Holding the victim player's lock makes the
  -- "no cells left" check race-free against concurrent eats of the victim's other cells.
  perform 1 from public.players where id in (e.player_id, v.player_id) order by id for no key update;

  update public.players
     set peak_mass = greatest(peak_mass, (select coalesce(sum(mass), 0) from public.cells where player_id = e.player_id))
   where id = e.player_id
  returning * into ep;

  select count(*) into v_left from public.cells where player_id = v.player_id;
  if v_left = 0 then
    select * into vp from public.players where id = v.player_id;
    if vp.status = 'alive' then
      update public.players set kills = kills + 1 where id = e.player_id returning * into ep;
      vp := private.retire_player(v.player_id, 'dead', e.player_id);
      perform private.send(e.room_id, 'player_died', jsonb_build_object(
        'player_id', vp.id,
        'killer_id', ep.id,
        'killer_name', ep.name,
        'peak_mass', round(vp.peak_mass::numeric, 2),
        'kills', vp.kills,
        'survived_seconds', greatest(0, extract(epoch from vp.ended_at - vp.spawned_at))::int
      ));
    end if;
  end if;

  perform private.send(e.room_id, 'cell_eaten', jsonb_build_object(
    'eater_cell', e.id,
    'eater_player', e.player_id,
    'eater_mass', round(v_new_mass::numeric, 2),
    'victim_cell', v.id,
    'victim_player', v.player_id
  ));

  return jsonb_build_object('ok', true, 'eater_mass', round(v_new_mass::numeric, 2));
end;
$$;

-- ------------------------------------------------------------------ split

create or replace function public.split(p_player uuid, p_dx real, p_dy real)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g jsonb := public.gc();
  k_max_cells int := (g->>'MAX_CELLS')::int;
  k_min_split double precision := (g->>'MIN_SPLIT_MASS')::double precision;
  v_player public.players;
  v_status text;
  v_ws double precision;
  v_dx double precision := coalesce(p_dx, 0);
  v_dy double precision := coalesce(p_dy, 0);
  v_len double precision;
  v_count int;
  v_half double precision;
  v_merge timestamptz;
  c public.cells;
  v_new public.cells;
  v_out jsonb := '[]'::jsonb;
begin
  v_player := private.owned_player(p_player);
  perform 1 from public.cells where player_id = p_player order by id for update;

  v_len := sqrt(v_dx * v_dx + v_dy * v_dy);
  if v_len < 1e-9 then
    v_dx := 1; v_dy := 0;
  else
    v_dx := v_dx / v_len; v_dy := v_dy / v_len;
  end if;

  select status into v_status from public.players where id = p_player;
  if v_status <> 'alive' then
    return jsonb_build_object('cells', v_out, 'dir', jsonb_build_array(v_dx, v_dy));
  end if;
  select world_size into v_ws from public.rooms where id = v_player.room_id;
  select count(*) into v_count from public.cells where player_id = p_player;

  -- Largest first; the cursor snapshot excludes cells created during this loop.
  for c in select * from public.cells where player_id = p_player order by mass desc, id loop
    exit when v_count >= k_max_cells;
    continue when c.mass < k_min_split;

    v_half := c.mass / 2;
    v_merge := now() + make_interval(secs => public.merge_delay(v_half));
    update public.cells set mass = v_half, merge_after = v_merge where id = c.id;
    insert into public.cells (player_id, room_id, x, y, mass, merge_after)
    values (p_player, c.room_id,
            private.clampf(c.x + v_dx * public.cell_radius(v_half), 0, v_ws),
            private.clampf(c.y + v_dy * public.cell_radius(v_half), 0, v_ws),
            v_half, v_merge)
    returning * into v_new;
    v_out := v_out || jsonb_build_array(private.cell_json(v_new) || jsonb_build_object('parent', c.id));
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('cells', v_out, 'dir', jsonb_build_array(v_dx, v_dy));
end;
$$;

-- ------------------------------------------------------------------ eject

create or replace function public.eject(p_player uuid, p_dx real, p_dy real)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g jsonb := public.gc();
  k_min double precision := (g->>'EJECT_MIN_MASS')::double precision;
  k_cost double precision := (g->>'EJECT_COST')::double precision;
  k_mass double precision := (g->>'EJECT_MASS')::double precision;
  k_dist double precision := (g->>'EJECT_DISTANCE')::double precision;
  v_player public.players;
  v_status text;
  v_ws double precision;
  v_dx double precision := coalesce(p_dx, 0);
  v_dy double precision := coalesce(p_dy, 0);
  v_len double precision;
  v_m double precision;
  v_r double precision;
  v_fx double precision;
  v_fy double precision;
  v_tx double precision;
  v_ty double precision;
  v_pid bigint;
  c public.cells;
  v_out jsonb := '[]'::jsonb;
begin
  v_player := private.owned_player(p_player);
  perform 1 from public.cells where player_id = p_player order by id for update;
  select status into v_status from public.players where id = p_player;
  if v_status <> 'alive' then
    return jsonb_build_object('cells', v_out);
  end if;
  select world_size into v_ws from public.rooms where id = v_player.room_id;

  v_len := sqrt(v_dx * v_dx + v_dy * v_dy);
  if v_len < 1e-9 then
    v_dx := 1; v_dy := 0;
  else
    v_dx := v_dx / v_len; v_dy := v_dy / v_len;
  end if;

  for c in select * from public.cells where player_id = p_player and mass >= k_min order by id loop
    v_m := c.mass - k_cost;
    v_r := public.cell_radius(v_m);
    update public.cells set mass = v_m where id = c.id;
    v_fx := private.clampf(c.x + v_dx * v_r, 0, v_ws);
    v_fy := private.clampf(c.y + v_dy * v_r, 0, v_ws);
    v_tx := private.clampf(c.x + v_dx * (v_r + k_dist), 0, v_ws);
    v_ty := private.clampf(c.y + v_dy * (v_r + k_dist), 0, v_ws);
    insert into public.pellets (room_id, kind, x, y, mass)
    values (v_player.room_id, 'ejecta', v_tx, v_ty, k_mass)
    returning id into v_pid;
    perform private.send(v_player.room_id, 'ejected', jsonb_build_object(
      'id', v_pid,
      'from', jsonb_build_array(round(v_fx::numeric, 1), round(v_fy::numeric, 1)),
      'to', jsonb_build_array(round(v_tx::numeric, 1), round(v_ty::numeric, 1)),
      'mass', k_mass,
      'by', p_player
    ));
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', c.id, 'mass', round(v_m::numeric, 2)));
  end loop;

  return jsonb_build_object('cells', v_out);
end;
$$;

-- ------------------------------------------------------------------ merge_cells

create or replace function public.merge_cells(p_a bigint, p_b bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k_max_mass double precision := (public.gc()->>'MAX_CELL_MASS')::double precision;
  c public.cells;
  a public.cells;
  b public.cells;
  v_owner uuid;
  v_status text;
  v_ra double precision;
  v_rb double precision;
  v_limit double precision;
begin
  if p_a = p_b then
    return jsonb_build_object('ok', false, 'reason', 'same_cell');
  end if;

  for c in select * from public.cells where id in (p_a, p_b) order by id for update loop
    if c.id = p_a then a := c; else b := c; end if;
  end loop;
  if a.id is null or b.id is null then
    return jsonb_build_object('ok', false, 'reason', 'gone');
  end if;

  select user_id, status into v_owner, v_status from public.players where id = a.player_id;
  if v_owner is distinct from auth.uid() or b.player_id <> a.player_id then
    raise exception 'cells % and % do not both belong to the current user', p_a, p_b using errcode = '42501';
  end if;
  if v_status <> 'alive' then
    return jsonb_build_object('ok', false, 'reason', 'dead');
  end if;
  if now() < a.merge_after or now() < b.merge_after then
    return jsonb_build_object('ok', false, 'reason', 'too_early');
  end if;

  -- Client merges when overlap > 50% of the smaller radius; allow staleness tolerance.
  v_ra := public.cell_radius(a.mass);
  v_rb := public.cell_radius(b.mass);
  v_limit := v_ra + v_rb - 0.5 * least(v_ra, v_rb) + public.pos_tolerance(least(a.mass, b.mass), 0.3, 10);
  if sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2) > v_limit then
    return jsonb_build_object('ok', false, 'reason', 'too_far');
  end if;

  update public.cells set mass = least(a.mass + b.mass, k_max_mass) where id = a.id returning * into a;
  delete from public.cells where id = b.id;

  return jsonb_build_object('ok', true, 'cell', private.cell_json(a));
end;
$$;

-- ------------------------------------------------------------------ leave_game

create or replace function public.leave_game(p_player uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.players;
begin
  perform private.owned_player(p_player);
  perform 1 from public.cells where player_id = p_player order by id for update;
  perform 1 from public.players where id = p_player for no key update;
  r := private.retire_player(p_player, 'left');
  if r.id is not null then
    perform private.send(r.room_id, 'player_left', jsonb_build_object('player_id', r.id));
  end if;
end;
$$;

-- ------------------------------------------------------------------ grants

revoke all on function
  public.spawn_player(uuid, uuid, text, text),
  public.player_sync(uuid, jsonb, bigint[]),
  public.eat_cell(bigint, bigint, real, real),
  public.split(uuid, real, real),
  public.eject(uuid, real, real),
  public.merge_cells(bigint, bigint),
  public.leave_game(uuid)
from public, anon, authenticated;

grant execute on function public.spawn_player(uuid, uuid, text, text) to service_role;

grant execute on function
  public.player_sync(uuid, jsonb, bigint[]),
  public.eat_cell(bigint, bigint, real, real),
  public.split(uuid, real, real),
  public.eject(uuid, real, real),
  public.merge_cells(bigint, bigint),
  public.leave_game(uuid)
to authenticated, service_role;
