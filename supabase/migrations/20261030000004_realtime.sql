-- 0004 realtime: private-channel authorization + publication for the menu high-score feed (PLAN.md §9).
-- Simple variant: any authenticated user may join/broadcast/track presence on room:* topics.
-- (Stricter alive-player variant intentionally not used: it would break spectating after death
--  and any lobby/presence use of room channels before a player row exists.)

create policy "room members read" on realtime.messages
  for select to authenticated
  using ( (select realtime.topic()) like 'room:%' and realtime.messages.extension in ('broadcast', 'presence') );

create policy "room members write" on realtime.messages
  for insert to authenticated
  with check ( (select realtime.topic()) like 'room:%' and realtime.messages.extension in ('broadcast', 'presence') );

alter publication supabase_realtime add table public.scores;
