-- 2026-10-22, two more works of Жавохир (the owner's photos of the same
-- morning) after his five: works/1/06 and 07 in the master-photos bucket.
-- Runs once: the second time the first url is already there.
update public.masters
   set work_photos = coalesce(work_photos, '[]'::jsonb) || '[{"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/1/06.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/1/06_t.jpg?v=1", "width": 1076, "height": 1270}, {"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/1/07.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/1/07_t.jpg?v=1", "width": 820, "height": 1440}]'::jsonb
 where id = 1
   and not coalesce(work_photos, '[]'::jsonb) @> '[{"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/1/06.jpg?v=1"}]'::jsonb;
select id, name, jsonb_array_length(work_photos) as works, work_photos -> -1 ->> 'url' as last
  from public.masters where id = 1;
