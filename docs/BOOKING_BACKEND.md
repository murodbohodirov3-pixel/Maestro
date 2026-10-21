# Онлайн-запись: серверная часть

Страница записи живёт в отдельном проекте `Maestro-Booking`, её контракт — `Maestro-Booking/docs/API_CONTRACT.md`. Здесь описано, что этому контракту отвечает в проде `ivowbhraaistxvoymxpf`.

## Для страницы

- `VITE_BOOKING_API_URL=https://ivowbhraaistxvoymxpf.supabase.co/functions/v1`
- Функции и формы ответов совпадают с контрактом, отступлений нет:
  - `GET /booking-catalog`
  - `POST /customer-availability`, режимы `day`, `nearest`, `month`
  - `POST /booking-hold`
  - `GET /booking-status?token=…`
  - `POST /booking-release`
- Моменты времени приходят с `+05:00`, даты в виде `YYYY-MM-DD`.
- Ошибки: `{ "ok": false, "error": "<код>" }` с кодами из контракта. HTTP-статусы: 400 `invalid_request` и `date_out_of_range`, 404 `unknown_service`, `unknown_master` и `not_found`, 409 `slot_taken`, 429 `rate_limited`, 500 `temporary_error`.
- CORS открыт только для адресов из `BOOKING_SITE_ORIGINS`: прод страницы и `http://localhost:5181` для разработки. Запросы с других адресов браузер не прочитает.
- Ограничения частоты по IP. Хранится только солёный хеш адреса.
  - Чтение (каталог, слоты, статус, отказ): 600 запросов за 10 минут.
  - Удержание: не больше 3 активных и 10 попыток в час.
- Бот подтверждения: `@Maestro_uzbot`. Ссылка из `booking-hold` выглядит так: `https://t.me/Maestro_uzbot?start=b_<token>`.

### Пример ответа `booking-hold`

```json
{
  "ok": true,
  "booking": {
    "token": "q8Xf2kP0aZq8Xf2kP0aZq8Xf2kP0aZq8",
    "status": "held",
    "hold_expires_at": "2026-10-15T16:55:41+05:00",
    "master_id": 21,
    "starts_at": "2026-10-16T11:00:00+05:00",
    "ends_at": "2026-10-16T12:00:00+05:00",
    "service_ids": ["mens_haircut"],
    "total_price_uzs": 150000,
    "total_duration_minutes": 60
  },
  "telegram_url": "https://t.me/Maestro_uzbot?start=b_q8Xf2kP0aZq8Xf2kP0aZq8Xf2kP0aZq8"
}
```

### Как тестировать без мусора в проде

- Удержание без подтверждения через 10 минут само становится `expired`. Отказ через `booking-release` даёт `cancelled`. В выручку, продажи и отчёты записи не попадают: это таблица `appointments`, а не `sales`.
- Полный путь с ботом проходит Telegram, которого нет среди сотрудников: с 19.10.2026 бот не даёт сотруднику (активному `app_users`) подтвердить запись на сайте, `staff_account`. Подтверждённую запись отменяют в боте кнопкой «Отменить запись».
- Если мастера нужно временно убрать со страницы, ему ставят `masters.show_online = false`.
- Фото мастеров (с 19.10.2026): квадрат 400 × 400 с лицом, в публичном бакете `master-photos`, ссылка в `masters.photo_url` с `?v=<n>`. Новое фото — загрузить под тем же именем (`supabase storage cp <файл> ss:///master-photos/<имя>.jpg --experimental --linked`, путь к файлу относительный) и поднять `?v=`. Сайт показывает фото кружком.
- Карточка мастера (с 21.10.2026, миграция `20261021100000_master_profiles`): `masters.experience_years`, `specialties_ru/uz` (метки), `bio_ru/uz` (2–3 предложения), `work_photos` — `[{url, thumb_url, width, height}]` по порядку. Фото работ — в том же бакете, `works/<id мастера>/NN.jpg` (1440 px по длинной стороне) и `NN_t.jpg` (480 px шириной), с `?v=<n>`. Всё необязательно: без этого на сайте у мастера только имя и фото. Тексты 21.10 — `docs/release-2026-10/master_profiles_2026-10-21.sql`.
- Имя и фамилия клиента (с 21.10.2026, миграция `20261021120000_client_name_parts`) — отдельно, обе обязательны: по 2–40 символов, без цифр. `booking-hold` берёт `client_first_name` и `client_last_name`; `client_name` без частей ещё принимается от страницы, открытой до перемены. Части лежат в `appointments.client_first_name/last_name` до подтверждения. Новая карточка получает обе. Карточке, найденной по номеру, дописывается только недостающая фамилия, и только если имя совпало. В `clients` поля `first_name` и `last_name`; `full_name` («Имя Фамилия») собирает из них триггер.

## Как это устроено

1. **Удержание.** `booking-hold` вызывает `maestro_hold_booking`. Та создаёт запись `appointments` со статусом `pending`, источником `web` и `hold_expires_at` через 10 минут. Время сразу защищено ограничением исключения по мастеру. При «любом мастере» берётся тот, у кого в этот день меньше записей.
2. **Токен.** В базе только его SHA-256 (`booking_token_hash`).
3. **Бот** — функция `booking-bot`, вебхук с секретом `X-Telegram-Bot-Api-Secret-Token`.
   - `/start b_<token>` привязывает удержание к этому Telegram-пользователю: `booking_tg_user_id`, функция `maestro_booking_for_bot`.
   - Если номер этого пользователя уже известен, хватает одной кнопки «Подтвердить». Иначе — кнопка «Поделиться номером».
   - Контакт принимается, только если `contact.user_id` совпадает с `from.id`.
   - Подтверждение — `maestro_confirm_booking`: клиент в CRM с источником `web`, проверка блокировки, статус `confirmed`.
   - После подтверждения и при отмене клиентом уведомления получают лично владелец, админ и Жамшид (`app_users` с ролями owner, admin, partner; номер полностью) и мастер (номер скрыт). Группы нет (решение владельца 16.10).
   - Отмена клиентом — `maestro_cancel_booking_by_client`.
4. **Истечение.** pg_cron `maestro-booking-holds` раз в минуту запускает `maestro_expire_booking_holds`: отмена с `cancelled_by = 'system'` и `status_reason_code = 'hold_expired'`.
5. **Напоминания** за 24 и 2 часа. pg_cron `maestro-booking-reminders` раз в 5 минут вызывает `booking-bot` с `{"action":"reminders"}`. Функция `maestro_claim_web_reminders` берёт их из журнала `appointment_notification_deliveries`.
6. **Свободное время** — `maestro_booking_slots`, `maestro_booking_nearest`, `maestro_booking_days`. Правила те же, что у `maestro_get_available_slots_for_duration`: версия графика на этот день, выходные, занятые записи. Только мастера с `show_online = true`, шаг 15 минут, не раньше чем через 15 минут от «сейчас».

## Секреты функций

| Имя | Что это |
|---|---|
| `BOT_TOKEN` | Токен `@Maestro_uzbot`, уже есть: на нём вход в приложение |
| `BOOKING_BOT_USERNAME` | `Maestro_uzbot` |
| `BOOKING_BOT_WEBHOOK_SECRET` | Секрет вебхука, случайная строка |
| `BOOKING_CRON_SECRET` | Секрет для pg_cron и служебных действий; то же значение в Vault под именем `booking_cron_secret` |
| `BOOKING_IP_SALT` | Соль для хеша IP |
| `BOOKING_SITE_ORIGINS` | `https://maestro-booking.vercel.app,http://localhost:5181` |
| `BOOKING_SITE_URL` | `https://maestro-booking.vercel.app`, ссылка в сообщениях бота |

## Служебные действия бота

Это `POST /booking-bot` с заголовком `x-booking-cron-secret`:
- `{"action":"webhook_info"}` — какой вебхук сейчас стоит у бота;
- `{"action":"set_webhook"}` — поставить вебхук. Чужой вебхук без `"force": true` бот не перезапишет;
- `{"action":"reminders"}` — отправить напоминания, которым пришло время.
