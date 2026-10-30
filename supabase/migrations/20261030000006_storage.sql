-- 0006 storage policies for the `skins` bucket (PLAN.md §12).
-- The bucket itself (public, 512 KiB, png/jpeg/webp) is created from config.toml.
-- Reads are public; authenticated users may write only under their own `<uid>/` folder.

create policy "skins public read" on storage.objects
  for select to public
  using ( bucket_id = 'skins' );

create policy "skins owner insert" on storage.objects
  for insert to authenticated
  with check ( bucket_id = 'skins' and (storage.foldername(name))[1] = (select auth.uid())::text );

create policy "skins owner update" on storage.objects
  for update to authenticated
  using ( bucket_id = 'skins' and (storage.foldername(name))[1] = (select auth.uid())::text )
  with check ( bucket_id = 'skins' and (storage.foldername(name))[1] = (select auth.uid())::text );

create policy "skins owner delete" on storage.objects
  for delete to authenticated
  using ( bucket_id = 'skins' and (storage.foldername(name))[1] = (select auth.uid())::text );
