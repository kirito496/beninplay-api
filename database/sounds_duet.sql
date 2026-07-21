-- ── Sons + Duo/Stitch ───────────────────────────────────────────────────────
-- À exécuter une fois dans Supabase (SQL editor). Idempotent.

-- Table des "sons" (comme TikTok) : chaque vidéo publiée crée son son
-- original ; d'autres créateurs peuvent le réutiliser ("Utiliser ce son").
create table if not exists sounds (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  creator_id      uuid references users(id) on delete set null,
  source_video_id uuid references videos(id) on delete set null,
  audio_url       text,               -- optionnel (URL de la vidéo source)
  uses_count      integer not null default 1,
  created_at      timestamptz not null default now()
);
create index if not exists sounds_creator_idx on sounds (creator_id);

-- Colonnes ajoutées aux vidéos : son utilisé + références Duo/Stitch.
alter table videos add column if not exists sound_id         uuid references sounds(id) on delete set null;
alter table videos add column if not exists duet_source_id   uuid references videos(id) on delete set null;
alter table videos add column if not exists stitch_source_id uuid references videos(id) on delete set null;

create index if not exists videos_sound_idx on videos (sound_id);
