-- 2026-10-21. The barbers' cards on the booking site: experience, tags, text
-- (ru/uz) and photos of their work. The barbers wrote the texts; edited and
-- approved by the owner on 21.10. Jamoliddin (4) and Ibrohim (2) sent none, so
-- their cards stay without a description. Work photos are in the public bucket
-- master-photos under works/<id>/ (NN.jpg and NN_t.jpg); raise ?v= when one is
-- replaced. Columns: migration 20261021100000_master_profiles.

update public.masters as m
   set experience_years = p.experience_years,
       specialties_ru = p.specialties_ru,
       specialties_uz = p.specialties_uz,
       bio_ru = p.bio_ru,
       bio_uz = p.bio_uz,
       work_photos = p.work_photos
  from (values
  (1, 7,
   array['Классические стрижки', 'Creative Fade', 'Борода', 'Чистка лица']::text[],
   array['Klassik soch turmaklari', 'Creative Fade', 'Soqol', 'Yuzni tozalash']::text[],
   'Жавохир специализируется на классических и современных стрижках и креативных fade. Подбирает стрижку под форму лица и индивидуальный стиль клиента, а также оформляет бороду и делает чистку лица. Его главные принципы — точность, творческий подход и внимание к каждой детали.',
   'Javohir klassik va zamonaviy soch turmaklari hamda kreativ Fade uslublariga ixtisoslashgan. Soch turmagini mijozning yuz tuzilishi va individual uslubiga qarab tanlaydi, shuningdek soqolga shakl beradi va yuzni tozalaydi. Uning asosiy tamoyillari — aniqlik, kreativ yondashuv va har bir detalga eʼtibor.',
   '[{"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/1/01.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/1/01_t.jpg?v=1", "width": 1010, "height": 1440}, {"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/1/02.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/1/02_t.jpg?v=1", "width": 1068, "height": 1440}, {"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/1/03.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/1/03_t.jpg?v=1", "width": 976, "height": 1288}, {"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/1/04.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/1/04_t.jpg?v=1", "width": 686, "height": 1132}, {"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/1/05.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/1/05_t.jpg?v=1", "width": 772, "height": 1262}]'::jsonb),
  (3, 3,
   array['Классические стрижки', 'Имиджевые стрижки', 'Подбор под форму лица', 'Борода']::text[],
   array['Klassik soch turmaklari', 'Imij soch turmaklari', 'Yuz shakliga mos tanlash', 'Soqol']::text[],
   'Жавлон специализируется на классических и имиджевых стрижках, а также оформляет бороду. Подбирает стрижку под форму лица и стиль клиента. Для него барберинг — не просто профессия, а творчество и создание собственного стиля.',
   'Javlon klassik va imij soch turmaklariga ixtisoslashgan, soqolga ham shakl beradi. Soch turmagini mijozning yuz tuzilishi va uslubiga qarab tanlaydi. Uning uchun barberlik shunchaki kasb emas, balki ijod va oʻziga xos uslub yaratishdir.',
   '[{"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/3/01.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/3/01_t.jpg?v=1", "width": 714, "height": 1440}, {"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/3/02.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/3/02_t.jpg?v=1", "width": 744, "height": 1440}, {"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/3/03.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/3/03_t.jpg?v=1", "width": 809, "height": 1440}, {"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/3/04.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/3/04_t.jpg?v=1", "width": 809, "height": 1440}, {"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/3/05.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/3/05_t.jpg?v=1", "width": 716, "height": 1440}]'::jsonb),
  (6, 3,
   array['Fade', 'Креативные стрижки', 'Чёткие линии']::text[],
   array['Fade', 'Kreativ soch turmaklari', 'Aniq chiziqlar']::text[],
   'Мироншох специализируется на fade и креативных стрижках. Следит за трендами, особое внимание уделяет чистым переходам и чётким линиям. Его цель — создать каждому клиенту современный образ, который подходит именно ему.',
   'Mironshoh Fade va kreativ soch turmaklariga ixtisoslashgan. Zamonaviy trendlarni kuzatib boradi, toza oʻtishlar va aniq chiziqlarga alohida eʼtibor beradi. Maqsadi — har bir mijozga unga mos va oʻziga xos imij yaratish.',
   '[{"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/6/01.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/6/01_t.jpg?v=1", "width": 1079, "height": 1440}, {"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/6/02.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/6/02_t.jpg?v=1", "width": 1065, "height": 1440}, {"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/6/03.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/6/03_t.jpg?v=1", "width": 1175, "height": 1206}, {"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/6/04.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/6/04_t.jpg?v=1", "width": 1136, "height": 1440}, {"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/6/05.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/6/05_t.jpg?v=1", "width": 1175, "height": 1335}, {"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/6/06.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/6/06_t.jpg?v=1", "width": 809, "height": 1440}, {"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/6/07.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/6/07_t.jpg?v=1", "width": 1175, "height": 1088}]'::jsonb),
  (21, 7,
   array['Классические стрижки', 'Taper Fade', 'Современный мужской стиль']::text[],
   array['Klassik soch turmaklari', 'Taper Fade', 'Zamonaviy erkak uslubi']::text[],
   'Зиёдулла работает с настоящей классикой и современным taper fade: плавные чистые переходы и мужской образ, который не выходит из моды. К каждому клиенту — профессиональный подход.',
   'Ziyodulla asosan haqiqiy klassik soch turmaklari va zamonaviy Taper Fade bilan ishlaydi: silliq, toza oʻtishlar va hech qachon urfdan qolmaydigan erkakcha koʻrinish. Har bir mijozga professional yondashadi.',
   '[{"url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/21/01.jpg?v=1", "thumb_url": "https://ivowbhraaistxvoymxpf.supabase.co/storage/v1/object/public/master-photos/works/21/01_t.jpg?v=1", "width": 1080, "height": 1440}]'::jsonb),
  (24, 8,
   array['Fade', 'Трендовые стрижки', 'Борода', 'Чистка лица']::text[],
   array['Fade', 'Trenddagi soch turmaklari', 'Soqol', 'Yuzni tozalash']::text[],
   'Салим работает с low, high и burst fade, классическими стрижками и трендовыми формами: mohawk, wolf cut, mullet, man bun и man bob. Кроме стрижек — оформление бороды и чистка лица.',
   'Salim Low, High va Burst Fade, klassik soch turmaklari hamda trenddagi Mohawk, Wolf Cut, Mullet, Man Bun va Man Bob uslublarini mohirona bajaradi. Bundan tashqari, soqolga shakl beradi va yuzni tozalaydi.',
   '[]'::jsonb)
  ) as p(id, experience_years, specialties_ru, specialties_uz, bio_ru, bio_uz, work_photos)
 where m.id = p.id;

select jsonb_agg(jsonb_build_object(
         'id', id, 'name', name, 'years', experience_years,
         'tags', coalesce(array_length(specialties_ru, 1), 0),
         'bio', char_length(coalesce(bio_ru, '')) > 0,
         'works', jsonb_array_length(work_photos)) order by id) as result
  from public.masters where active and show_online;
