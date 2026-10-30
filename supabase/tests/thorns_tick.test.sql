-- pgTAP: thorn bursts and tick broadcasts.
begin;
create extension if not exists pgtap with schema extensions;

select plan(9);

insert into auth.users (id, aud, role) values ('00000000-0000-0000-0000-0000000000c1', 'authenticated', 'authenticated');
insert into public.rooms (id, name) values ('00000000-0000-0000-0000-00000000cafe', 'Thorn Dish');
insert into public.players (id, user_id, room_id, name, color, peak_mass) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000cafe', 'T', '#e0457b', 20);
insert into public.cells (id, player_id, room_id, x, y, mass) overriding system value values
  (910001, '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000cafe', 2000, 2000, 120),
  (910002, '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000cafe', 4000, 4000, 200);
insert into public.pellets (id, room_id, kind, x, y, mass) overriding system value values
  (810001, '00000000-0000-0000-0000-00000000cafe', 'thorn', 2010, 2000, 100),  -- under the 120-mass cell
  (810002, '00000000-0000-0000-0000-00000000cafe', 'thorn', 4010, 4000, 100);  -- under the 200-mass cell

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is(
  jsonb_array_length(public.player_sync('00000000-0000-0000-0000-0000000000d1', '[]', '{810001}') -> 'cells'), 2,
  'a cell with mass <= 1.3 * THORN_MASS does not burst');
select is(
  jsonb_array_length(public.player_sync('00000000-0000-0000-0000-0000000000d1', '[]', '{810002}') -> 'cells'), 16,
  'a big cell bursts into pieces up to MAX_CELLS, returned in the sync cell set');
reset role;

select ok(exists(select 1 from public.pellets where id = 810001), 'unburst thorn remains');
select ok(not exists(select 1 from public.pellets where id = 810002), 'burst thorn is consumed');
select is(
  (select round(sum(mass)::numeric) from public.cells where player_id = '00000000-0000-0000-0000-0000000000d1'),
  320::numeric, 'burst conserves mass');
select ok(
  (select bool_and(merge_after > now()) from public.cells where player_id = '00000000-0000-0000-0000-0000000000d1' and id <> 910001),
  'burst pieces get merge_after');

select lives_ok($$ select public.game_tick() $$, 'game_tick runs');
select ok(
  exists(select 1 from realtime.messages where topic = 'room:00000000-0000-0000-0000-00000000cafe' and event = 'pellets_spawned'
          and jsonb_array_length(payload -> 'p') = 150 + 24),
  'pellets_spawned carries 150 food + missing thorns');
select ok(
  exists(select 1 from realtime.messages where topic = 'room:00000000-0000-0000-0000-00000000cafe' and event = 'leaderboard'
          and payload -> 'top' -> 0 ->> 0 = '00000000-0000-0000-0000-0000000000d1'),
  'leaderboard is broadcast');

select * from finish();
rollback;
