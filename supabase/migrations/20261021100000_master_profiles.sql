-- The barber's card on the booking site (owner's request of 2026-10-21): years
-- of experience, a few specialty tags and a short text in both languages, and
-- photos of their work. All optional: a master without them shows only the
-- name and photo, as before.
-- work_photos: [{ "url", "thumb_url", "width", "height" }] in display order;
-- the files are in the public bucket master-photos under works/<master id>/
-- (migration 20261019120000), with ?v=<n> raised when a photo is replaced.

alter table public.masters
  add column if not exists experience_years smallint,
  add column if not exists bio_ru text,
  add column if not exists bio_uz text,
  add column if not exists specialties_ru text[],
  add column if not exists specialties_uz text[],
  add column if not exists work_photos jsonb not null default '[]'::jsonb;

alter table public.masters drop constraint if exists masters_profile_check;
alter table public.masters add constraint masters_profile_check check (
  (experience_years is null or experience_years between 0 and 60)
  and char_length(coalesce(bio_ru, '')) <= 800
  and char_length(coalesce(bio_uz, '')) <= 800
  and jsonb_typeof(work_photos) = 'array'
);
