-- The barbers' photos for the booking site (owner's decision of 2026-10-19).
-- A public bucket: a file is read by its address, as the site shows it anyway.
-- There is no policy on storage.objects, so nobody lists the bucket or writes
-- to it except with the service key. masters.photo_url points into it, with
-- ?v=<n> to be raised when a photo is replaced.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('master-photos', 'master-photos', true, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
