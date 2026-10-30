-- 0002 game constants: SQL mirror of supabase/functions/_shared/game.ts (PLAN.md §6).
-- Keep values and formulas identical; constants.test.ts asserts equality.

create or replace function public.gc()
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $$
  select jsonb_build_object(
    'WORLD_SIZE', 6000,
    'START_MASS', 20,
    'PELLET_MASS', 1,
    'PELLET_RADIUS', 6,
    'PELLET_TARGET', 1200,
    'PELLET_MAX_PER_TICK', 150,
    'EAT_RATIO', 1.25,
    'EAT_OVERLAP', 0.35,
    'MIN_SPLIT_MASS', 36,
    'MAX_CELLS', 16,
    'SPLIT_SPEED', 900,
    'SPLIT_DECAY', 6,
    'EJECT_MIN_MASS', 35,
    'EJECT_COST', 16,
    'EJECT_MASS', 12,
    'EJECT_DISTANCE', 420,
    'DECAY_THRESHOLD', 150,
    'DECAY_RATE', 0.002,
    'MAX_CELL_MASS', 20000,
    'THORN_COUNT', 25,
    'THORN_MASS', 100,
    'THORN_BURST_RATIO', 1.3,
    'BLOOM_COUNT', 3,
    'BLOOM_RADIUS', 300,
    'BLOOM_FRACTION', 0.4,
    'NET_STATE_HZ', 15,
    'NET_SYNC_HZ', 10,
    'INTERP_DELAY_MS', 100,
    'STALE_PLAYER_S', 5,
    'ZOOM_MIN', 0.15,
    'ZOOM_MAX', 1.2,
    'PALETTE', jsonb_build_array(
      '#e0457b', '#b5338a', '#7b4fd1', '#4a6cf7', '#2fa4e7', '#1fc2b0',
      '#3fcf6e', '#9be03a', '#f2d43d', '#f59a2b', '#ef5b3a', '#c9a0ff'
    )
  )
$$;

-- radius(m) = 10 * sqrt(m)
create or replace function public.cell_radius(m double precision)
returns double precision
language sql immutable parallel safe
set search_path = ''
as $$ select 10 * sqrt(greatest(m, 0)) $$;

-- speed(m) = max(50, 600 * m^-0.35)   (px/s)
create or replace function public.cell_speed(m double precision)
returns double precision
language sql immutable parallel safe
set search_path = ''
as $$ select greatest(50, 600 * power(greatest(m, 1e-6), -0.35)) $$;

-- mergeDelay(m) = 12 + 0.02 * m   (seconds)
create or replace function public.merge_delay(m double precision)
returns double precision
language sql immutable parallel safe
set search_path = ''
as $$ select 12 + 0.02 * m $$;

-- posTolerance(mass, dt, ageS) = 1.3 * speed * dt + 40 (+ SPLIT_SPEED * 0.6 if age < 1 s)
create or replace function public.pos_tolerance(mass double precision, dt double precision, cell_age_s double precision)
returns double precision
language sql immutable parallel safe
set search_path = ''
as $$
  select 1.3 * public.cell_speed(mass) * greatest(dt, 0) + 40
         + case when cell_age_s < 1 then 900 * 0.6 else 0 end
$$;

-- canEat(eater, victim) = eater >= 1.25 * victim
create or replace function public.can_eat(eater_mass double precision, victim_mass double precision)
returns boolean
language sql immutable parallel safe
set search_path = ''
as $$ select eater_mass >= 1.25 * victim_mass $$;

-- eatOverlapOk(dist, rEater, rVictim) = dist <= rEater - 0.35 * rVictim
create or replace function public.eat_overlap_ok(dist double precision, r_eater double precision, r_victim double precision)
returns boolean
language sql immutable parallel safe
set search_path = ''
as $$ select dist <= r_eater - 0.35 * r_victim $$;

-- Pure helpers are harmless; any role may call them (constants are public knowledge).
revoke all on function public.gc(), public.cell_radius(double precision), public.cell_speed(double precision),
  public.merge_delay(double precision), public.pos_tolerance(double precision, double precision, double precision),
  public.can_eat(double precision, double precision), public.eat_overlap_ok(double precision, double precision, double precision)
  from public;
grant execute on function public.gc(), public.cell_radius(double precision), public.cell_speed(double precision),
  public.merge_delay(double precision), public.pos_tolerance(double precision, double precision, double precision),
  public.can_eat(double precision, double precision), public.eat_overlap_ok(double precision, double precision, double precision)
  to anon, authenticated, service_role;
