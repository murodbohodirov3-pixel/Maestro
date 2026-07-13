# Maestro AI knowledge base

Status: `APPROVED FOR STAGE 3 TEST-ONLY CUSTOMER BOT`

This is the single approval document for Stage 2. A customer agent must not launch until every required fact is filled, source-checked, and the status is changed to `APPROVED` by the owner.

## 1. Verified system facts

| Field | Current value | Source | State |
|---|---|---|---|
| Business name | Maestro Barberia | production application | verified |
| City | Tashkent | production settings/project context | verified |
| Timezone | Asia/Tashkent | production reporting contract | verified |
| Salon coordinates | 41.3512479308835, 69.2895722812834 | `public.settings` | verified for attendance only |
| Customer-facing address | Chinobod ko'chasi, 8, Tashkent | owner, 2026-07-13 | verified |
| Staff shift start | 10:10 | `public.settings.shift_start` | not confirmed as customer opening time |
| Customer languages | Russian, Uzbek | agreed Maestro AI plan | verified requirement |

## 2. Active masters

Names are verified from live Supabase. Customer-facing RU/UZ spelling and service assignments are owner-approved. The bot does not promise which language an individual master speaks.

| Internal ID | Display name | RU spelling approved | UZ spelling approved | Languages | Specialties | Service IDs |
|---:|---|---|---|---|---|---|
| 1 | Жавохир | yes | Javohir — yes | not published | all services | all 16 active services |
| 2 | Иброхим | yes | Ibrohim — yes | not published | all services | all 16 active services |
| 3 | Жавлон | yes | Javlon — yes | not published | all services | all 16 active services |
| 4 | Жамолиддин | yes | Jamoliddin — yes | not published | all services | all 16 active services |
| 6 | Мироншох | yes | Mironshoh — yes | not published | all services | all 16 active services |

Inactive masters remain in historical finance data but must not be offered to customers.

## 3. Customer contacts — required

| Field | Approved value | Source/date |
|---|---|---|
| Full customer-facing address | Chinobod ko'chasi, 8, Tashkent | owner, 2026-07-13 |
| Map link | https://maps.google.com/?q=41.3512479308835,69.2895722812834 | production coordinates |
| Public telephone | +998 20 014 30 00 | owner, 2026-07-13 |
| Customer Telegram | new separate test bot; username assigned during Stage 3 | approved strategy, 2026-07-13 |
| Instagram | https://www.instagram.com/maestro.barberia/ | owner, 2026-07-13 |
| Website | none supplied | owner, 2026-07-13 |
| Parking instructions | parking available; detailed directions not supplied | owner, 2026-07-13 |

## 4. Opening hours — required

The staff shift time cannot be treated as customer opening hours.

| Day | Opens | Closes | Last booking | Notes |
|---|---:|---:|---:|---|
| Monday | 09:00 | 23:00 | depends on service and confirmed slot | owner-confirmed daily schedule |
| Tuesday | 09:00 | 23:00 | depends on service and confirmed slot | owner-confirmed daily schedule |
| Wednesday | 09:00 | 23:00 | depends on service and confirmed slot | owner-confirmed daily schedule |
| Thursday | 09:00 | 23:00 | depends on service and confirmed slot | owner-confirmed daily schedule |
| Friday | 09:00 | 23:00 | depends on service and confirmed slot | owner-confirmed daily schedule |
| Saturday | 09:00 | 23:00 | depends on service and confirmed slot | owner-confirmed daily schedule |
| Sunday | 09:00 | 23:00 | depends on service and confirmed slot | owner-confirmed daily schedule |

## 5. Service catalog — required

One row per sellable service. Prices must be exact integers in UZS; “from” pricing requires explicit minimum/maximum and an explanation.

| Stable ID | Name RU | Name UZ | Price UZS | Duration min | Active | Description/conditions |
|---|---|---|---:|---:|---|---|
| mens_haircut | Мужская стрижка | Erkaklar soch turmagi | 150000 | 60 | yes | |
| clipper_haircut | Мужская стрижка под машинку | Mashinkada erkaklarni sochini olish | 100000 | 40 | yes | |
| kids_haircut_under_14 | Детская стрижка до 14 лет | 14 yoshgacha bolalar soch turmagi | 100000 | 60 | yes | age limit confirmed |
| mens_haircut_hair_coloring | Мужская стрижка + окраска волос | Erkaklar soch turmagi + soch bo'yash | 200000 | 100 | yes | |
| head_toning | Тонировка головы | Sochni tonlash | 100000 | 30 | yes | |
| styling | Укладка | Soch turmaklash | 60000 | 30 | yes | |
| edging | Окантовка | Soch chetlarini tekislash | 70000 | 40 | yes | |
| beard_modeling | Моделирование бороды | Soqolni modellashtirish | 70000 | 30 | yes | |
| beard_modeling_coloring | Моделирование бороды + окраска бороды | Soqolni modellashtirish + bo'yash | 100000 | 60 | yes | |
| haircut_beard_modeling | Стрижка + моделирование бороды | Soch turmagi + soqolni modellashtirish | 180000 | 90 | yes | |
| hair_coloring | Окраска волос | Soch bo'yash | 80000 | 30 | yes | |
| beard_coloring | Окраска бороды | Soqol bo'yash | 80000 | 30 | yes | |
| steam_face_cleansing | Чистка лица паровым аппаратом (скраб + маска) | Yuzni bug' apparati bilan tozalash (skrab + niqob) | 100000 | 40 | yes | |
| face_mask | Чистка лица (маска) | Yuzni tozalash (niqob) | 35000 | 20 | yes | |
| waxing_one_zone | Удаление воском — 1 зона | Vosk bilan tozalash — 1 zona | 20000 | 15 | yes | |
| complex_head_massage | Комплексный массаж головы | Proffesional bosh massaji | 60000 | 15 | yes | |

Required checks:

- combo services are separate rows;
- children/long hair/VIP prices are explicit;
- duration includes cleanup/buffer if it blocks the chair;
- every service is mapped to eligible masters;
- temporary offers are not stored as permanent prices.

## 6. Policies — required

| Policy | Approved RU text | Approved UZ text | Agent action |
|---|---|---|---|
| Late arrival | Штрафов и наказаний нет; попросить сообщить администратору | approved Uzbek translation | inform / hand off if rescheduling is needed |
| Cancellation | Штрафов и наказаний нет; помочь подобрать другое время | approved Uzbek translation | hand off until booking workflow exists |
| Rescheduling | no automated changes during Stage 3 | no automated changes during Stage 3 | always hand off |
| No-show | no separate rule supplied | no separate rule supplied | do not invent; hand off |
| Refund/complaint | no public promise | no public promise | always hand off |
| Discount request | no public promise | no public promise | never promise; hand off |
| Children/minimum age | child haircut through age 14 inclusive; no other restrictions | approved Uzbek service wording | answer; hand off ambiguity |
| Non-standard service | only listed services may be promised | only listed services may be promised | hand off |

## 7. Payments and promotions — required

| Field | Approved value | Expiry/source |
|---|---|---|
| Cash | yes | owner, 2026-07-13 |
| Card transfer | yes | owner, 2026-07-13 |
| QR/Paynet | yes | owner, 2026-07-13 |
| Prepayment required | no | owner, 2026-07-13 |
| Active promotions | Стрижка + маска + массаж головы — 150 000 сум, 60 minutes | active, owner confirmed 2026-07-13; no expiry, valid until withdrawn |
| Gift certificates | not confirmed | do not claim availability; hand off |

For the child haircut, the only condition is age up to and including 14; there are no additional restrictions. The customer channel will be a new separate test Telegram bot with production writes disabled.

The agent may mention a promotion only when an expiry date and approval source are present.

## 8. FAQ and tone

Twenty-four machine-checked RU/UZ FAQ scenarios are stored in `services/customer-ai/knowledge/faq-cases.json`. They cover:

- how to choose a master;
- haircut duration;
- beard and combo services;
- walk-ins versus booking;
- parking and landmarks;
- accepted payment methods;
- late arrival/cancellation;
- children and special requests;
- how booking confirmation works.

Tone requirements already approved:

- polite, concise, sales-oriented without pressure;
- mirror Russian or Uzbek used by the customer;
- never invent price, availability, master capability, promotion, or policy;
- normally answer in 1–4 short sentences;
- lead to the next concrete step;
- hand off complaints, refunds, discounts, conflicts, ambiguity, and non-standard requests.

## 9. Approval gate

Stage 2 can be marked complete only when:

1. Sections 3–7 contain no `pending` values.
2. Every active service has exact price, duration, and eligible masters.
3. RU and UZ customer-facing names and policy texts are approved.
4. At least 20 FAQ test questions have expected answers.
5. The owner explicitly approves the document and its effective date.
6. A machine-readable version is generated from this document and validated before deployment.

Stage 2 is complete. Approval permits only the separate Stage 3 test bot; it does not permit production booking writes or reuse of existing Telegram bots.
