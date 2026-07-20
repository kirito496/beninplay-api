-- ============================================================================
-- BeninPlay — SCRIPT SQL COMPLET (base + migration)
-- À coller UNE FOIS dans Supabase → SQL Editor → Run.
-- 100% idempotent : peut être relancé sans risque (n'efface rien).
-- ============================================================================

-- ── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 1) TABLES DE BASE
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone VARCHAR(20) UNIQUE NOT NULL,
  username VARCHAR(30) UNIQUE,
  bio TEXT,
  avatar_url TEXT,
  is_creator BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  wallet_balance INTEGER NOT NULL DEFAULT 0,
  became_creator_at TIMESTAMPTZ,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone VARCHAR(20) NOT NULL,
  code VARCHAR(6) NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS videos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(150) NOT NULL,
  description TEXT,
  video_url TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  thumbnail_url TEXT,
  tags TEXT[] DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'published' CHECK (status IN ('published','processing','deleted','banned')),
  views INTEGER NOT NULL DEFAULT 0,
  likes_count INTEGER NOT NULL DEFAULT 0,
  comments_count INTEGER NOT NULL DEFAULT 0,
  shares_count INTEGER NOT NULL DEFAULT 0,
  file_size BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS video_likes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(video_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (char_length(content) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  participant_a_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_b_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(participant_a_id, participant_b_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT CHECK (char_length(content) <= 2000),
  media_url TEXT,
  message_type VARCHAR(20) NOT NULL DEFAULT 'text' CHECK (message_type IN ('text','image','video','audio')),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('deposit','withdrawal','earning','refund','fee')),
  amount INTEGER NOT NULL,
  net_amount INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','cancelled')),
  description TEXT,
  cinetpay_transaction_id VARCHAR(50),
  metadata JSONB DEFAULT '{}',
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS follows (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(follower_id, following_id)
);

-- ── Fonctions de base ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION increment_views(video_id UUID) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN UPDATE videos SET views = views + 1 WHERE id = video_id AND status = 'published'; END; $$;

CREATE OR REPLACE FUNCTION increment_wallet_balance(user_id UUID, amount INTEGER) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN IF amount <= 0 THEN RAISE EXCEPTION 'Montant positif requis'; END IF;
  UPDATE users SET wallet_balance = wallet_balance + amount WHERE id = user_id; END; $$;

CREATE OR REPLACE FUNCTION decrement_wallet_balance(user_id UUID, amount INTEGER) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE b INTEGER;
BEGIN IF amount <= 0 THEN RAISE EXCEPTION 'Montant positif requis'; END IF;
  SELECT wallet_balance INTO b FROM users WHERE id = user_id FOR UPDATE;
  IF b < amount THEN RAISE EXCEPTION 'Solde insuffisant: % FCFA', b; END IF;
  UPDATE users SET wallet_balance = wallet_balance - amount WHERE id = user_id; END; $$;

-- ── Row Level Security ──────────────────────────────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE follows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "videos_public" ON videos;
CREATE POLICY "videos_public" ON videos FOR SELECT USING (status = 'published');
DROP POLICY IF EXISTS "comments_public" ON comments;
CREATE POLICY "comments_public" ON comments FOR SELECT USING (true);

-- ============================================================================
-- 2) MIGRATION (email, éditeur, boost, live, pièces, modération…)
-- ============================================================================

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
CREATE INDEX IF NOT EXISTS idx_videos_zone ON videos(zone);
CREATE INDEX IF NOT EXISTS idx_videos_boost ON videos(boosted, boost_end);

-- ── Utilisateurs : démographie (ciblage boost) ─────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS region VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(10);
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_year INTEGER;

-- ── Live en direct (Agora) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live_streams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  title TEXT,
  status VARCHAR(10) NOT NULL DEFAULT 'live',
  viewers INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_live_status ON live_streams(status, started_at);

-- ── Anti-multi-comptes ─────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS monetization_status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS monetization_blocked_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_users_device ON users(device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_payout ON users(payout_phone) WHERE payout_phone IS NOT NULL;

-- ── Profil complet ─────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE;

-- ── Auth par email (Brevo) : un seul compte par email ─────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(lower(email)) WHERE email IS NOT NULL;

-- ── Demande de statut créateur ─────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS creator_status VARCHAR(20) DEFAULT 'none';
ALTER TABLE users ADD COLUMN IF NOT EXISTS creator_request_note TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS creator_requested_at TIMESTAMPTZ;

-- ── Zone Dark : KYC + abonnement ───────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(20) DEFAULT 'none';
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_submitted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_front_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_back_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dark_sub_until TIMESTAMPTZ;

-- ── Paiements (MoMo) ───────────────────────────────────────────────────
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

-- ── Vues uniques (anti-fraude boost) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS video_views (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  viewer_key VARCHAR(90) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(video_id, viewer_key)
);
CREATE INDEX IF NOT EXISTS idx_video_views_video ON video_views(video_id);
CREATE INDEX IF NOT EXISTS idx_video_views_time ON video_views(video_id, created_at);

-- ── Vente de vidéos à l'unité (pay-per-view) ───────────────────────────
ALTER TABLE videos ADD COLUMN IF NOT EXISTS price INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS video_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(video_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_video_purchases_user ON video_purchases(user_id);

-- ── Classement des créateurs ───────────────────────────────────────────
ALTER TABLE video_views ADD COLUMN IF NOT EXISTS completed BOOLEAN NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION creator_leaderboard(limit_n INTEGER DEFAULT 50)
RETURNS TABLE(
  creator_id UUID, username TEXT, avatar_url TEXT,
  videos_count BIGINT, total_views BIGINT, completed_views BIGINT,
  likes BIGINT, comments BIGINT, followers BIGINT, score NUMERIC
) LANGUAGE sql STABLE AS $$
  WITH vids AS (
    SELECT creator_id,
           COUNT(*) AS videos_count,
           COALESCE(SUM(views),0) AS total_views,
           COALESCE(SUM(likes_count),0) AS likes,
           COALESCE(SUM(comments_count),0) AS comments
    FROM videos WHERE status = 'published' GROUP BY creator_id
  ),
  comp AS (
    SELECT v.creator_id, COUNT(*) AS completed_views
    FROM video_views vv JOIN videos v ON v.id = vv.video_id
    WHERE vv.completed = true
    GROUP BY v.creator_id
  ),
  fol AS (
    SELECT following_id AS creator_id, COUNT(*) AS followers
    FROM follows GROUP BY following_id
  )
  SELECT u.id, u.username, u.avatar_url,
    COALESCE(vids.videos_count, 0),
    COALESCE(vids.total_views, 0),
    COALESCE(comp.completed_views, 0),
    COALESCE(vids.likes, 0),
    COALESCE(vids.comments, 0),
    COALESCE(fol.followers, 0),
    (COALESCE(comp.completed_views,0) * 5
     + COALESCE(vids.likes,0) * 3
     + COALESCE(vids.comments,0) * 4
     + COALESCE(fol.followers,0) * 2
     + COALESCE(vids.total_views,0) * 1)::numeric AS score
  FROM users u
  JOIN vids ON vids.creator_id = u.id
  LEFT JOIN comp ON comp.creator_id = u.id
  LEFT JOIN fol ON fol.creator_id = u.id
  WHERE u.is_creator = true
  ORDER BY score DESC
  LIMIT limit_n;
$$;

-- ── Live payant / privé ────────────────────────────────────────────────
ALTER TABLE live_streams ADD COLUMN IF NOT EXISTS price INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS live_id UUID REFERENCES live_streams(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS live_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  live_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(live_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_live_purchases_user ON live_purchases(user_id);

-- ── Notifications ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(30) NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  data JSONB DEFAULT '{}',
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at DESC);

-- ── Pièces (monnaie interne) + cadeaux live ────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS coin_balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS live_gifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  live_id UUID REFERENCES live_streams(id) ON DELETE SET NULL,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gift_key VARCHAR(30) NOT NULL,
  coins INTEGER NOT NULL,
  amount_fcfa INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_live_gifts_creator ON live_gifts(creator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_gifts_live ON live_gifts(live_id);

CREATE OR REPLACE FUNCTION add_coins(p_user UUID, p_amount INTEGER)
RETURNS void LANGUAGE sql AS $$
  UPDATE users SET coin_balance = coin_balance + p_amount WHERE id = p_user;
$$;

CREATE OR REPLACE FUNCTION spend_coins(p_user UUID, p_amount INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE affected INTEGER;
BEGIN
  UPDATE users SET coin_balance = coin_balance - p_amount
   WHERE id = p_user AND coin_balance >= p_amount;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END; $$;

-- ── Vidéo adaptative (HLS) ─────────────────────────────────────────────
ALTER TABLE videos ADD COLUMN IF NOT EXISTS hls_url TEXT;

-- ── Édition "façon Snapchat" : filtre + overlays ───────────────────────
ALTER TABLE videos ADD COLUMN IF NOT EXISTS filter VARCHAR(30);
ALTER TABLE videos ADD COLUMN IF NOT EXISTS overlays JSONB;

-- ── Modération (Google Play : signaler / bloquer) ──────────────────────
CREATE TABLE IF NOT EXISTS video_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID NOT NULL,
  reporter_id UUID NOT NULL,
  reason VARCHAR(20) NOT NULL DEFAULT 'autre',
  details TEXT,
  status VARCHAR(15) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (video_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS idx_video_reports_status ON video_reports(status);

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id UUID NOT NULL,
  blocked_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);

-- ── OTP email : la colonne phone doit accueillir une adresse email ─────
-- (le code de vérification email est stocké dans otp_codes, clé = email)
ALTER TABLE otp_codes ALTER COLUMN phone TYPE TEXT;

-- ============================================================================
-- FIN — tout est prêt. Retourne sur l'app et connecte-toi.
-- ============================================================================
