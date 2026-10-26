-- 2026-10-22: a line or two about each service on the booking page, in
-- Russian and Uzbek (owner's request of 2026-10-21, texts checked by him).
-- 2026-10-26: owner's answers — wash and styling come with any haircut,
-- styling alone is paid separately; the promo mask is for the face; wax
-- zones are nose, ears, moustache, beard and face; "Proffesional" fixed in
-- the Uzbek name of the massage. Keratin and biowave texts added.
with texts (id, description_ru, description_uz, name_uz) as (values
  ('mens_haircut', 'Стрижка с учётом формы лица и ваших пожеланий: мастер обсудит с вами длину и форму. Мытьё головы и укладка входят в стоимость.', 'Yuz shakli va istaklaringizni hisobga olgan soch turmagi: usta uzunlik va shaklni siz bilan kelishib oladi. Bosh yuvish va turmaklash narxga kiradi.', null),
  ('clipper_haircut', 'Быстрая стрижка машинкой с насадками — одной длины или с плавным переходом.', 'Mashinka bilan tezkor soch olish — bir xil uzunlikda yoki silliq o''tish bilan.', null),
  ('kids_haircut_under_14', 'Аккуратная стрижка для детей до 14 лет. Мастер работает спокойно и без спешки, чтобы ребёнку было комфортно.', '14 yoshgacha bolalar uchun ozoda soch turmagi. Usta shoshilmasdan, xotirjam ishlaydi — bola o''zini qulay his qiladi.', null),
  ('edging', 'Чёткий контур у висков, на шее и за ушами — когда стрижка ещё держит форму, а края уже отросли.', 'Chakka, bo''yin va quloq orqasida aniq chiziqlar — soch turmagi shaklini saqlagan, lekin chetlari o''sib qolganda.', null),
  ('styling', 'Укладка без стрижки — на каждый день или к важному событию. Если вы стрижётесь, укладка уже входит в стоимость стрижки.', 'Soch olmasdan turmaklash — har kun uchun yoki muhim tadbirga. Soch olsangiz, turmaklash soch turmagi narxiga kiradi.', null),
  ('haircut_beard_modeling', 'Стрижка и оформление бороды за один визит: форма бороды подбирается под стрижку и черты лица.', 'Bir tashrifda soch turmagi va soqolga shakl berish: soqol shakli soch turmagi va yuz tuzilishiga mos tanlanadi.', null),
  ('mens_haircut_hair_coloring', 'Стрижка и окрашивание за один визит — чтобы закрасить седину или освежить цвет.', 'Bir tashrifda soch turmagi va bo''yash — oqarishni yashirish yoki rangni yangilash uchun.', null),
  ('promo_haircut_mask_head_massage', 'Стрижка, маска для лица и массаж головы — по цене обычной мужской стрижки.', 'Soch turmagi, yuz uchun niqob va bosh massaji — oddiy erkaklar soch turmagi narxida.', null),
  ('beard_modeling', 'Форма и контур бороды под черты лица: ровная длина и чёткие линии на щеках и шее.', 'Yuz tuzilishiga mos soqol shakli: bir tekis uzunlik, yonoq va bo''yinda aniq chiziqlar.', null),
  ('beard_coloring', 'Окрашивание бороды в естественный оттенок: закрывает седину и выравнивает цвет.', 'Soqolni tabiiy tusga bo''yash: oqarishni yashiradi va rangni bir xil qiladi.', null),
  ('beard_modeling_coloring', 'Форма, контур и цвет бороды за один визит.', 'Bir tashrifda soqol shakli, chiziqlari va rangi.', null),
  ('hair_coloring', 'Окрашивание волос: закрасить седину, освежить цвет или немного его изменить.', 'Soch bo''yash: oqarishni yashirish, rangni yangilash yoki biroz o''zgartirish.', null),
  ('head_toning', 'Мягкое тонирование: седина становится менее заметной, а цвет выглядит естественно.', 'Yumshoq tonlash: oqarish kamroq ko''rinadi, rang esa tabiiy ko''rinadi.', null),
  ('complex_head_massage', '15 минут массажа головы: снимает напряжение и помогает расслабиться.', '15 daqiqalik bosh massaji: zo''riqishni ketkazadi va dam olishga yordam beradi.', 'Professional bosh massaji'),
  ('face_mask', 'Очищающая маска для лица — кожа выглядит свежее.', 'Yuz uchun tozalovchi niqob — teri yangilangan ko''rinadi.', null),
  ('steam_face_cleansing', 'Глубокое очищение: пар раскрывает поры, затем скраб и маска — кожа становится чище и свежее.', 'Chuqur tozalash: bug'' teri teshiklarini ochadi, so''ng skrab va niqob — teri tozaroq va yangiroq bo''ladi.', null),
  ('waxing_one_zone', 'Удаление волос воском в одной зоне на выбор: нос, уши, усы, борода или лицо.', 'Tanlagan bitta zonadagi tuklarni vosk bilan olib tashlash: burun, quloq, mo''ylov, soqol yoki yuz.', null),
  ('hair_keratin', 'Кератин для волос: волосы становятся гладкими, мягкими и блестящими, их легче укладывать.', 'Sochga keratin: soch silliq, yumshoq va yaltiroq bo''ladi, uni turmaklash osonlashadi.', null),
  ('hair_biowave', 'Биозавивка: превращает прямые волосы в естественные кудри или добавляет им объём.', 'Biozavivka: to''g''ri sochni tabiiy jingalakka aylantiradi yoki unga hajm qo''shadi.', null)
),
written as (
  update public.booking_services as service
     set description_ru = texts.description_ru,
         description_uz = texts.description_uz,
         name_uz = coalesce(texts.name_uz, service.name_uz)
    from texts
   where service.id = texts.id
  returning service.id
)
select count(*) as services_described from written;
