-- ── Notifications push (FCM) : jeton de l'appareil par utilisateur ──────────
-- À exécuter une fois dans Supabase (SQL editor). Idempotent.

alter table users add column if not exists fcm_token text;
