# Maestro Telegram AI Team

Отдельный Telegram-сервис для владельца Maestro. Он анализирует разрешённые
агрегированные отчёты, задаёт уточняющие вопросы, привлекает специалистов и
формирует измеримый план действий. Сервис не встроен в клиентское приложение и
не умеет изменять рабочие таблицы Maestro.

## Что реализовано

- Главный координатор с инструментами OpenAI Responses API.
- Специалисты: аналитик, финансист, маркетолог, CRM, операционный агент,
  технический агент и независимый контролёр.
- Безопасный Supabase Edge Function `agents-report` с фиксированным белым
  списком отчётов и только `select`-операциями.
- Отчёты бизнеса, мастеров, финансов, долгов и посещаемости.
- Быстрые Telegram-команды `/today`, `/week`, `/month`, `/problems`, `/help`.
- Instagram-продюсер с командами `/instagram` и `/reel <тема>`: контент-календарь,
  сценарии, покадровый план, тексты, обложки, CTA, KPI и готовые промпты для Higgsfield.
- Обязательное подтверждение владельца перед любой генерацией Higgsfield, расходующей кредиты.
- Сравнение с предыдущим периодом такой же длины.
- Сохранение исторического правила Maestro для legacy pending продаж.
- Поддержка постоянной истории через один OpenAI Conversation.
- Защита владельца, секрета webhook и отдельного секрета отчётной функции.
- Ограничение числа AI-инструментов, безопасные сообщения об ошибках и
  best-effort защита от повторных Telegram update.

## Архитектура безопасности

Telegram-сервис не получает `SUPABASE_SERVICE_ROLE_KEY` и не вызывает таблицы
напрямую. Он обращается к `agents-report` по отдельному случайному секрету.
Service role остаётся только внутри Supabase Edge Function. В коде функции нет
`insert`, `update`, `upsert`, `delete` или RPC.

`agents-report` возвращает агрегаты и разрешённые поля. Он не возвращает
`app_users`, Telegram ID, сессии или секреты.

## Локальная проверка

```powershell
cd services/telegram-agents
npm.cmd install
npm.cmd run verify
```

Для локального запуска serverless endpoints можно использовать актуальный
Vercel CLI через `npx vercel dev`; CLI намеренно не включён в runtime-зависимости.

## Переменные Vercel

Создайте отдельный Vercel project с Root Directory
`services/telegram-agents` (создан: `maestro-telegram-agents`) и добавьте:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `OWNER_TELEGRAM_ID`
- `OPENAI_API_KEY`
- `OPENAI_COORDINATOR_MODEL` — по умолчанию `gpt-5.4`
- `OPENAI_SPECIALIST_MODEL` — по умолчанию `gpt-5.4-mini`
- `OPENAI_CONVERSATION_ID`
- `MAESTRO_SUPABASE_URL`
- `MAESTRO_REPORT_SECRET`
- `MAESTRO_CONTENT_SECRET`

В Supabase secrets добавляется только:

- `AGENTS_REPORT_SECRET` — то же случайное значение, что
  `MAESTRO_REPORT_SECRET` в Vercel.
- `AGENTS_CONTENT_SECRET` — то же случайное значение, что
  `MAESTRO_CONTENT_SECRET` в Vercel и локальном исполнителе.

Не добавляйте service role или Telegram token во frontend `.env` Maestro.

## Создание постоянной истории

После установки переменной `OPENAI_API_KEY` выполните:

```powershell
node scripts/create-conversation.mjs
```

Сохраните выведенный `conv_...` как `OPENAI_CONVERSATION_ID` в Vercel. Если
переменная отсутствует, один запрос с вызовами инструментов работает, но
история между Telegram-сообщениями не гарантируется.

## Регистрация webhook

После готового Vercel deployment зарегистрируйте URL
`https://<agents-domain>/api/telegram` через Telegram `setWebhook`, передав
`TELEGRAM_WEBHOOK_SECRET` как `secret_token`.

Для безопасной повторной регистрации используется `POST /api/setup-webhook`.
Endpoint принимает только `x-maestro-content-secret`, проверяет, что токен
принадлежит `@maestro_ai_team_bot`, и может назначить только фиксированный URL
`https://maestro-telegram-agents.vercel.app/api/telegram`.

Постоянная память создаётся однократно через защищённый
`POST /api/setup-conversation` с тем же `x-maestro-content-secret`. Возвращённый
`conv_...` сохраняется как `OPENAI_CONVERSATION_ID` только на сервере Vercel.

## Доступные данные и ограничения

Уже доступны продажи, клиентские количества, новые/постоянные клиенты,
мастера, расходы, расчётная прибыль, долги, платежи, посещаемость и штрафы.

Пока отсутствуют индивидуальные карточки клиентов, история повторных визитов,
расписание, неявки, источники клиента, Instagram/TikTok статистика и рекламные
расходы. Агент обязан сообщать об этом и не выдумывать такие показатели.

## Higgsfield и Instagram

Команда уже умеет готовить полный производственный пакет для Reels, постов,
каруселей и Stories. Команда `/reel преображение до и после` создаёт сценарий и
точный промпт для Higgsfield, а `/instagram` — недельный план с тремя
приоритетными роликами.

Платная генерация защищена отдельным подтверждением. `/reel <тема>` создаёт
структурированный черновик в `agent_content_jobs`, `/approve <id>` разрешает
расход кредитов, `/cancel <id>` отменяет его, а `/content [id]` показывает
статус и ссылку на результат. До подтверждения Higgsfield не запускается.

Оплаченный пользовательский Higgsfield Pro и Higgsfield Cloud API имеют разные
балансы. Чтобы не покупать Cloud-кредиты второй раз, генерация запускается на
компьютере владельца через уже авторизованный официальный CLI:

```powershell
cd services/telegram-agents
$env:OWNER_TELEGRAM_ID="..."
$env:MAESTRO_SUPABASE_URL="https://ivowbhraaistxvoymxpf.supabase.co"
$env:MAESTRO_CONTENT_SECRET="..."
npm.cmd run content:run -- 12
```

Число `12` — номер подтверждённого задания. Исполнитель принимает только статус
`approved`, переводит его в `generating`, ждёт Seedance 2.0 и сохраняет итоговый
URL либо безопасное сообщение об ошибке. Команда `/content 12` покажет результат.

## Следующие этапы

1. Проверить неделю реальных диалогов и исправить слабые диагностические ответы.
2. Добавить отдельное хранилище задач, KPI и экспериментов, не затрагивая
   рабочие таблицы Maestro.
3. После первого ручного теста установить локальный исполнитель как фоновую
   задачу Windows, чтобы подтверждённые ролики запускались без команды в консоли.
4. Подключить клиентскую CRM и маркетинговые источники с отдельным согласием и
   политиками доступа.
5. Добавлять действия только через явное подтверждение владельца и журнал
   аудита.
