-- 2026-10-19. The barbers' photos on the booking site: face close-ups (400 x 400)
-- cut from their portraits, all six on a wall modelled on Javohir's; his own is
-- his photo as sent. Files are in the public bucket master-photos
-- (migration 20261019120000). Raise ?v= when a photo is replaced.

update public.masters as m
   set photo_url = 'https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/' || p.file || '?v=1'
  from (values (1, 'javohir.jpg'), (2, 'ibrohim.jpg'), (3, 'javlon.jpg'), (4, 'jamoliddin.jpg'),
               (6, 'mironshoh.jpg'), (21, 'ziyodulla.jpg'), (24, 'salim.jpg')) as p(id, file)
 where m.id = p.id;

select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'photo', right(photo_url, 22)) order by id) as result
  from public.masters where active and show_online;
