# Maestro AI knowledge base

Status: `DRAFT — NOT ALLOWED FOR CUSTOMER ANSWERS`

This is the single approval document for Stage 2. A customer agent must not launch until every required fact is filled, source-checked, and the status is changed to `APPROVED` by the owner.

## 1. Verified system facts

| Field | Current value | Source | State |
|---|---|---|---|
| Business name | Maestro Barberia | production application | verified |
| City | Tashkent | production settings/project context | verified |
| Timezone | Asia/Tashkent | production reporting contract | verified |
| Salon coordinates | 41.3512479308835, 69.2895722812834 | `public.settings` | verified for attendance only |
| Approximate address | 8 Chinobod ko'chasi, Yunusobod | reverse lookup of coordinates | must be owner-confirmed |
| Staff shift start | 10:10 | `public.settings.shift_start` | not confirmed as customer opening time |
| Customer languages | Russian, Uzbek | agreed Maestro AI plan | verified requirement |

## 2. Active masters

Names are verified from live Supabase. Customer-facing spelling, languages, specialties, and service assignments still require confirmation.

| Internal ID | Display name | RU spelling approved | UZ spelling approved | Languages | Specialties | Service IDs |
|---:|---|---|---|---|---|---|
| 1 | Жавохир | pending | pending | pending | pending | pending |
| 2 | Иброхим | pending | pending | pending | pending | pending |
| 3 | Жавлон | pending | pending | pending | pending | pending |
| 4 | Жамолиддин | pending | pending | pending | pending | pending |
| 6 | Мироншох | pending | pending | pending | pending | pending |

Inactive masters remain in historical finance data but must not be offered to customers.

## 3. Customer contacts — required

| Field | Approved value | Source/date |
|---|---|---|
| Full customer-facing address | pending | pending |
| Google/2GIS/Yandex map link | pending | pending |
| Public telephone | pending | pending |
| Customer Telegram | pending | pending |
| Instagram | pending | pending |
| Website | pending / none | pending |
| Parking instructions | pending | pending |

## 4. Opening hours — required

The staff shift time cannot be treated as customer opening hours.

| Day | Opens | Closes | Last booking | Notes |
|---|---:|---:|---:|---|
| Monday | pending | pending | pending | |
| Tuesday | pending | pending | pending | |
| Wednesday | pending | pending | pending | |
| Thursday | pending | pending | pending | |
| Friday | pending | pending | pending | |
| Saturday | pending | pending | pending | |
| Sunday | pending | pending | pending | |

## 5. Service catalog — required

One row per sellable service. Prices must be exact integers in UZS; “from” pricing requires explicit minimum/maximum and an explanation.

| Stable ID | Name RU | Name UZ | Price UZS | Duration min | Active | Description/conditions |
|---|---|---|---:|---:|---|---|
| pending | pending | pending | pending | pending | pending | pending |

Required checks:

- combo services are separate rows;
- children/long hair/VIP prices are explicit;
- duration includes cleanup/buffer if it blocks the chair;
- every service is mapped to eligible masters;
- temporary offers are not stored as permanent prices.

## 6. Policies — required

| Policy | Approved RU text | Approved UZ text | Agent action |
|---|---|---|---|
| Late arrival | pending | pending | pending |
| Cancellation | pending | pending | pending |
| Rescheduling | pending | pending | pending |
| No-show | pending | pending | pending |
| Refund/complaint | pending | pending | always hand off |
| Discount request | pending | pending | never promise; hand off |
| Children/minimum age | pending | pending | pending |
| Non-standard service | pending | pending | hand off |

## 7. Payments and promotions — required

| Field | Approved value | Expiry/source |
|---|---|---|
| Cash | pending | pending |
| Card | pending | pending |
| QR/Paynet | pending | pending |
| Prepayment required | pending | pending |
| Active promotions | pending / none | pending |
| Gift certificates | pending / none | pending |

The agent may mention a promotion only when an expiry date and approval source are present.

## 8. FAQ and tone

Required FAQ topics:

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

Until then, no customer bot is allowed to answer real clients.
