-- pgTAP suite for the Petri database (PLAN.md §15.1). Run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;

select plan(50);

-- ------------------------------------------------------------------ fixtures (as postgres)
-- Users U1/U2/U3, a private test room R, players P1 (U1) and P2 (U2).
insert into auth.users (id, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a3', 'authenticated', 'authenticated');

insert into public.rooms (id, name) values ('00000000-0000-0000-0000-00000000beef', 'Test Dish');

insert into public.players (id, user_id, room_id, name, color, peak_mass) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000beef', 'P1', '#e0457b', 20),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000beef', 'P2', '#4a6cf7', 20);

-- C1: P1's cell for sync tests. Last synced 100 ms ago, born 10 s ago (no split allowance).
insert into public.cells (id, player_id, room_id, x, y, mass, synced_at, created_at) overriding system value values
  (900001, '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000beef', 1000, 1000, 20,
   now() - interval '100 ms', now() - interval '10 s');

-- ------------------------------------------------------------------ RLS / grants
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

select throws_ok(
  $$ insert into public.cells (player_id, room_id, x, y, mass)
     values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000beef', 1, 1, 9999) $$,
  '42501', null, 'authenticated cannot insert into cells directly');
select throws_ok($$ update public.cells set mass = 9999 $$, '42501', null, 'authenticated cannot update cells');
select throws_ok($$ delete from public.pellets $$, '42501', null, 'authenticated cannot delete pellets');
select throws_ok($$ update public.players set status = 'alive' $$, '42501', null, 'authenticated cannot update players');
select isnt_empty($$ select * from public.cells $$, 'authenticated can read cells');
select isnt_empty($$ select * from public.room_list $$, 'authenticated can read room_list');
select throws_ok(
  $$ select public.spawn_player('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000beef', 'x', null) $$,
  '42501', null, 'authenticated cannot call spawn_player');
select throws_ok($$ select public.game_tick() $$, '42501', null, 'authenticated cannot call game_tick');
select throws_ok(
  $$ select public.player_sync('00000000-0000-0000-0000-0000000000b2', '[]', '{}') $$,
  '42501', null, 'player_sync on someone else''s player is rejected');

reset role;
set local role anon;
select throws_ok($$ select * from public.cells $$, '42501', null, 'anon cannot read cells');
select throws_ok(
  $$ select public.spawn_player('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000beef', 'x', null) $$,
  '42501', null, 'anon cannot call spawn_player');
reset role;

-- ------------------------------------------------------------------ spawn_player (service_role)
set local role service_role;
select is(
  (public.spawn_player('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000beef', '  Carol  ', null)
     -> 'cell' ->> 'mass')::numeric,
  20::numeric, 'service_role can spawn; first cell has START_MASS');
select ok(
  (public.spawn_player('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000beef', 'Carol', null)
     ? 'player_id'),
  'second spawn returns a player');
reset role;
select is(
  (select array_agg(status order by spawned_at, status) from public.players where user_id = '00000000-0000-0000-0000-0000000000a3'),
  array['alive', 'left'] , 'respawn marks the previous alive player as left');
select is(
  (select name from public.players where user_id = '00000000-0000-0000-0000-0000000000a3' and status = 'alive'),
  'Carol', 'name is trimmed');

-- ------------------------------------------------------------------ player_sync: clamp
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is(
  public.player_sync('00000000-0000-0000-0000-0000000000b1', '[{"id":900001,"x":2000,"y":1000}]', '{}') -> 'corrections',
  '[900001]'::jsonb, 'player_sync reports a teleport as a correction');
reset role;
select is(
  (select round(x::numeric, 1) from public.cells where id = 900001),
  round((1000 + public.pos_tolerance(20, 0.1, 10))::numeric, 1),
  'teleport is clamped to POS_TOLERANCE');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
-- synced_at is now now(), so tolerance is the 40 px floor: a 30 px move is accepted as-is.
select is(
  public.player_sync('00000000-0000-0000-0000-0000000000b1',
                     jsonb_build_array(jsonb_build_object('id', 900001,
                       'x', (select x from public.cells where id = 900001) + 30, 'y', 1000)), '{}') -> 'corrections',
  '[]'::jsonb, 'a plausible move is not corrected');
select ok(
  public.player_sync('00000000-0000-0000-0000-0000000000b1', '[{"id":900001,"x":-500,"y":1000},{"id":424242,"x":1,"y":1}]', '{}')
    -> 'cells' @> '[{"id":900001}]'::jsonb,
  'unknown cell ids are ignored; own cell set returned');
reset role;

-- Park C1 at a known spot for the pellet tests.
update public.cells set x = 1000, y = 1000 where id = 900001;
insert into public.pellets (id, room_id, kind, x, y, mass) overriding system value values
  (800001, '00000000-0000-0000-0000-00000000beef', 'food', 1500, 1000, 1),   -- far (500 px)
  (800002, '00000000-0000-0000-0000-00000000beef', 'food', 1020, 1000, 1);   -- inside the cell

-- ------------------------------------------------------------------ player_sync: pellets
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is(
  public.player_sync('00000000-0000-0000-0000-0000000000b1', '[]', '{800001}') -> 'cells' -> 0 -> 'mass',
  '20.00'::jsonb, 'far pellet is not credited');
select ok(exists(select 1 from public.pellets where id = 800001), 'far pellet still exists');
select is(
  (public.player_sync('00000000-0000-0000-0000-0000000000b1', '[]', '{800002}') -> 'cells' -> 0 ->> 'mass')::numeric,
  21::numeric, 'near pellet is credited');
select is(
  (public.player_sync('00000000-0000-0000-0000-0000000000b1', '[]', '{800002}') -> 'cells' -> 0 ->> 'mass')::numeric,
  21::numeric, 'near pellet is credited exactly once');
reset role;
select ok(not exists(select 1 from public.pellets where id = 800002), 'eaten pellet is deleted');
select ok(
  exists(select 1 from realtime.messages
          where event = 'pellets_eaten' and topic = 'room:00000000-0000-0000-0000-00000000beef'
            and payload -> 'ids' = '[800002]'::jsonb
            and payload ->> 'by' = '00000000-0000-0000-0000-0000000000b1'),
  'pellets_eaten is broadcast to the room');

-- ------------------------------------------------------------------ eat_cell
-- E (P1) at (3000,3000) mass 100; V (P2, its only cell) far away, mass 90.
insert into public.cells (id, player_id, room_id, x, y, mass, synced_at, created_at) overriding system value values
  (900010, '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000beef', 3000, 3000, 100, now(), now() - interval '10 s'),
  (900020, '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000beef', 3400, 3000, 90,  now(), now() - interval '10 s');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is(public.eat_cell(900010, 900020, 3000, 3000) ->> 'reason', 'too_small', 'eat_cell fails below EAT_RATIO');
reset role;
update public.cells set mass = 200 where id = 900010;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is(public.eat_cell(900010, 900020, 3000, 3000) ->> 'reason', 'out_of_range', 'eat_cell fails out of range');
select is(public.eat_cell(900010, 900020, 3300, 3000) ->> 'reason', 'out_of_range',
  'a reported eater position beyond tolerance is clamped (still out of range)');
reset role;
update public.cells set x = 3050 where id = 900020;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select throws_ok($$ select public.eat_cell(900010, 900020, 3000, 3000) $$, '42501', null,
  'eat_cell with someone else''s eater cell is rejected');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is(public.eat_cell(900010, 900020, 3000, 3000), '{"ok": true, "eater_mass": 290.00}'::jsonb,
  'eat_cell succeeds in range and adds the victim mass');
select is(public.eat_cell(900010, 900020, 3000, 3000), '{"ok": false, "reason": "gone"}'::jsonb,
  'a second eat_cell on the same victim fails');
reset role;

select is(
  (select row(status, killed_by, ended_at is not null)::text from public.players where id = '00000000-0000-0000-0000-0000000000b2'),
  row('dead', '00000000-0000-0000-0000-0000000000b1'::uuid, true)::text,
  'victim with no cells left is marked dead with killed_by');
select is((select kills from public.players where id = '00000000-0000-0000-0000-0000000000b1'), 1, 'killer kills incremented');
select is(
  (select count(*)::int from public.scores where player_id = '00000000-0000-0000-0000-0000000000b2'), 1, 'death inserts a score');
select ok(
  exists(select 1 from realtime.messages where event = 'player_died'
          and payload ->> 'player_id' = '00000000-0000-0000-0000-0000000000b2'
          and payload ->> 'killer_name' = 'P1'),
  'player_died is broadcast');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select is(public.player_sync('00000000-0000-0000-0000-0000000000b2', '[]', '{}'),
  '{"status": "dead", "cells": [], "corrections": []}'::jsonb, 'player_sync on a dead player returns its status');
reset role;

-- ------------------------------------------------------------------ split / merge
delete from public.cells where player_id = '00000000-0000-0000-0000-0000000000b1';
insert into public.cells (id, player_id, room_id, x, y, mass) overriding system value values
  (900030, '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000beef', 3000, 3000, 30);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is(public.split('00000000-0000-0000-0000-0000000000b1', 1, 0) -> 'cells', '[]'::jsonb,
  'split refuses cells below MIN_SPLIT_MASS');
reset role;
update public.cells set mass = 1000 where id = 900030;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is(jsonb_array_length(public.split('00000000-0000-0000-0000-0000000000b1', 3, 4) -> 'cells'), 1, 'split halves a cell');
select is(public.split('00000000-0000-0000-0000-0000000000b1', 0, 0) -> 'dir', '[1, 0]'::jsonb, 'zero direction defaults to +x');
do $$ begin
  perform public.split('00000000-0000-0000-0000-0000000000b1', 1, 0);
  perform public.split('00000000-0000-0000-0000-0000000000b1', 1, 0);
end $$;
select is((select count(*)::int from public.cells where player_id = '00000000-0000-0000-0000-0000000000b1'), 16,
  'repeated splits reach MAX_CELLS');
select is(public.split('00000000-0000-0000-0000-0000000000b1', 1, 0) -> 'cells', '[]'::jsonb, 'split respects MAX_CELLS');
select is(
  public.merge_cells(
    (select min(id) from public.cells where player_id = '00000000-0000-0000-0000-0000000000b1'),
    (select max(id) from public.cells where player_id = '00000000-0000-0000-0000-0000000000b1')) ->> 'reason',
  'too_early', 'merge_cells is refused before merge_after');
reset role;
update public.cells set merge_after = now() - interval '1 s', x = 3000, y = 3000
 where player_id = '00000000-0000-0000-0000-0000000000b1';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is(
  (public.merge_cells(
    (select min(id) from public.cells where player_id = '00000000-0000-0000-0000-0000000000b1'),
    (select max(id) from public.cells where player_id = '00000000-0000-0000-0000-0000000000b1')) -> 'cell' ->> 'mass')::numeric,
  125::numeric, 'merge_cells merges after merge_after');

-- ------------------------------------------------------------------ eject
select is(jsonb_array_length(public.eject('00000000-0000-0000-0000-0000000000b1', 1, 0) -> 'cells'), 15,
  'eject fires from every cell >= EJECT_MIN_MASS');
reset role;
select is(
  (select count(*)::int from public.pellets where room_id = '00000000-0000-0000-0000-00000000beef' and kind = 'ejecta'), 15,
  'eject inserts ejecta pellets');

-- ------------------------------------------------------------------ game_tick
-- Make U3's alive player stale.
update public.players set last_sync_at = now() - interval '10 s'
 where user_id = '00000000-0000-0000-0000-0000000000a3' and status = 'alive';

select lives_ok($$ select public.game_tick() $$, 'game_tick runs');
select is(
  (select count(*)::int from public.pellets where room_id = '00000000-0000-0000-0000-00000000beef' and kind = 'food'),
  151, 'game_tick tops up food by PELLET_MAX_PER_TICK');
select is(
  (select status from public.players where user_id = '00000000-0000-0000-0000-0000000000a3' order by spawned_at desc, status limit 1),
  'left', 'game_tick removes stale players');

-- ------------------------------------------------------------------ leave_game
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.leave_game('00000000-0000-0000-0000-0000000000b1') $$, 'leave_game runs');
reset role;
select is(
  (select row(p.status, (select count(*) from public.cells c where c.player_id = p.id),
              (select count(*) from public.scores s where s.player_id = p.id))::text
     from public.players p where p.id = '00000000-0000-0000-0000-0000000000b1'),
  row('left', 0, 1)::text, 'leave_game marks left, deletes cells, records score');

select * from finish();
rollback;
