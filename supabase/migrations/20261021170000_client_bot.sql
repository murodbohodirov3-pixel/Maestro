-- The clients' own bot (owner's decision of 2026-10-21): site bookings are
-- confirmed with @MaestroBarberia_bot, and @Maestro_uzbot stays with the app
-- and the staff. Telegram lets a bot write only to whoever started it, so a
-- booking keeps the bot it was confirmed with, and its reminders and its
-- «Отменить» come from that bot. Bookings confirmed before have none and stay
-- with @Maestro_uzbot.
alter table public.appointments
  add column if not exists booking_bot text;

alter table public.appointments
  drop constraint if exists appointments_booking_bot_check,
  add constraint appointments_booking_bot_check check (booking_bot is null or booking_bot in ('client', 'staff'));
