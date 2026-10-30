-- Seed rooms. Fixed ids so bots/tests/dev tooling can refer to them.
insert into public.rooms (id, name) values
  ('00000000-0000-4000-8000-00000000000a', 'Dish A'),
  ('00000000-0000-4000-8000-00000000000b', 'Dish B')
on conflict (id) do nothing;
