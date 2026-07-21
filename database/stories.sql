-- ── Stories (façon Snapchat / Instagram) — expirent après 24 h ──────────────
-- À exécuter une fois dans Supabase (SQL editor). Idempotent.

create table if not exists stories (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null references users(id) on delete cascade,
  media_url    text not null,
  media_type   text not null default 'image',   -- 'image' | 'video'
  caption      text,
  storage_path text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '24 hours')
);

create index if not exists stories_active_idx  on stories (expires_at);
create index if not exists stories_creator_idx on stories (creator_id, created_at desc);
