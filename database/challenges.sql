-- ── Défis à Cagnotte (concours hashtag avec prix réels en FCFA) ─────────────
-- À exécuter une fois dans Supabase (SQL editor). Idempotent.

create table if not exists challenges (
  id          uuid primary key default gen_random_uuid(),
  hashtag     text not null,                       -- sans le #, minuscule
  title       text not null,
  description text,
  prize_pool  integer not null default 0,          -- cagnotte totale (FCFA)
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz not null,
  status      text not null default 'active',      -- active | finished
  winners     jsonb,                               -- rempli à la clôture
  created_at  timestamptz not null default now()
);

create index if not exists challenges_status_idx on challenges (status, ends_at);
