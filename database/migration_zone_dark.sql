-- ============================================================
-- Migration : colonnes Zone / Dark / Boost + démographie
-- À exécuter UNE FOIS dans Supabase → SQL Editor.
-- Idempotent : peut être relancé sans risque.
-- ============================================================

-- ── Vidéos : zone (normal / dark) + compteurs + boost ──────────────────
ALTER TABLE videos ADD COLUMN IF NOT EXISTS zone VARCHAR(10) NOT NULL DEFAULT 'normal';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS shares_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE videos ADD COLUMN IF NOT EXISTS boosted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS boost_end TIMESTAMPTZ;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS boost_region VARCHAR(50);
ALTER TABLE videos ADD COLUMN IF NOT EXISTS boost_regions TEXT[] DEFAULT '{}';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS boost_gender VARCHAR(10);
ALTER TABLE videos ADD COLUMN IF NOT EXISTS boost_age_min INTEGER;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS boost_age_max INTEGER;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS boost_amount INTEGER DEFAULT 0;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS boost_tags TEXT[] DEFAULT '{}';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS boost_views_start INTEGER DEFAULT 0;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS boost_started_at TIMESTAMPTZ;

-- Index pour accélérer le filtrage par zone
CREATE INDEX IF NOT EXISTS idx_videos_zone ON videos(zone);
CREATE INDEX IF NOT EXISTS idx_videos_boost ON videos(boosted, boost_end);

-- ── Utilisateurs : démographie (ciblage boost) ─────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS region VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(10);
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_year INTEGER;

-- ── Demande de statut créateur (validation manuelle par l'admin) ───────
ALTER TABLE users ADD COLUMN IF NOT EXISTS creator_status VARCHAR(20) DEFAULT 'none';
ALTER TABLE users ADD COLUMN IF NOT EXISTS creator_request_note TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS creator_requested_at TIMESTAMPTZ;

-- ── Zone Dark : vérification d'identité (KYC) + abonnement ─────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(20) DEFAULT 'none'; -- none|pending|verified|rejected
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_submitted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_front_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_back_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dark_sub_until TIMESTAMPTZ;

-- ── Paiements (système MoMo + SMS gratuit) ─────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id UUID REFERENCES videos(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL,
  operator VARCHAR(10) NOT NULL,
  type VARCHAR(20) NOT NULL DEFAULT 'boost',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  reference VARCHAR(30),
  payment_number VARCHAR(20),
  transaction_id VARCHAR(50),
  sender_phone VARCHAR(20),
  target_region VARCHAR(50),
  target_regions TEXT[] DEFAULT '{}',
  target_gender VARCHAR(10),
  target_age_min INTEGER DEFAULT 0,
  target_age_max INTEGER DEFAULT 120,
  target_tags TEXT[] DEFAULT '{}',
  boost_days INTEGER DEFAULT 1,
  boost_applied BOOLEAN NOT NULL DEFAULT false,
  confirmed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_pending ON payments(status, operator, amount, expires_at);
CREATE INDEX IF NOT EXISTS idx_payments_txn ON payments(transaction_id);

-- ── Vues uniques (anti-fraude boost : 1 vue par personne/vidéo) ────────
CREATE TABLE IF NOT EXISTS video_views (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  viewer_key VARCHAR(90) NOT NULL,   -- u:<user_id> | d:<device_id> | ip:<ip>
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(video_id, viewer_key)
);
CREATE INDEX IF NOT EXISTS idx_video_views_video ON video_views(video_id);
CREATE INDEX IF NOT EXISTS idx_video_views_time ON video_views(video_id, created_at);
