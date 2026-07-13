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

-- ── Live en direct (Agora) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live_streams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  title TEXT,
  status VARCHAR(10) NOT NULL DEFAULT 'live', -- live | ended
  viewers INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_live_status ON live_streams(status, started_at);

-- ── Anti-multi-comptes : un seul compte monétisable par personne ──────
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS monetization_status VARCHAR(20) NOT NULL DEFAULT 'active'; -- active|blocked|review
ALTER TABLE users ADD COLUMN IF NOT EXISTS monetization_blocked_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_users_device ON users(device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_payout ON users(payout_phone) WHERE payout_phone IS NOT NULL;

-- ── Profil complet à l'inscription (ciblage boost précis) ─────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE;

-- ── Auth par email (Brevo) : un seul compte par email ─────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL; -- l'email peut désormais suffire
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(lower(email)) WHERE email IS NOT NULL;

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

-- ── Vente de vidéos à l'unité (pay-per-view) ───────────────────────────
ALTER TABLE videos ADD COLUMN IF NOT EXISTS price INTEGER NOT NULL DEFAULT 0; -- 0 = gratuit

CREATE TABLE IF NOT EXISTS video_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(video_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_video_purchases_user ON video_purchases(user_id);

-- ── Classement des créateurs : vues "complétées" (regardées jusqu'au bout) ──
ALTER TABLE video_views ADD COLUMN IF NOT EXISTS completed BOOLEAN NOT NULL DEFAULT false;

-- Score d'impact agrégé par créateur (inclut les non-abonnés qui vont au bout)
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

-- ── Live payant / privé : prix + accès payant + achats ────────────────
-- (placé en fin de fichier : live_streams et payments existent déjà plus haut)
ALTER TABLE live_streams ADD COLUMN IF NOT EXISTS price INTEGER NOT NULL DEFAULT 0; -- 0 = gratuit
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

-- ── Notifications (centre de notifs in-app, sans push payant) ──────────
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- destinataire
  type VARCHAR(30) NOT NULL,          -- follow|purchase|live_purchase|withdrawal|kyc|creator|monetization
  title TEXT NOT NULL,
  body TEXT,
  data JSONB DEFAULT '{}',            -- infos libres (ids, montants…)
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL, -- qui a déclenché (optionnel)
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at DESC);

-- ── Pièces (monnaie interne) + cadeaux/stickers en live ───────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS coin_balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 0; -- pièces à créditer (achat de pièces)

CREATE TABLE IF NOT EXISTS live_gifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  live_id UUID REFERENCES live_streams(id) ON DELETE SET NULL,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gift_key VARCHAR(30) NOT NULL,
  coins INTEGER NOT NULL,        -- coût en pièces
  amount_fcfa INTEGER NOT NULL,  -- valeur brute FCFA
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_live_gifts_creator ON live_gifts(creator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_gifts_live ON live_gifts(live_id);

-- Ajoute des pièces (achat confirmé)
CREATE OR REPLACE FUNCTION add_coins(p_user UUID, p_amount INTEGER)
RETURNS void LANGUAGE sql AS $$
  UPDATE users SET coin_balance = coin_balance + p_amount WHERE id = p_user;
$$;

-- Débite des pièces de façon atomique : ne réussit que si le solde suffit
CREATE OR REPLACE FUNCTION spend_coins(p_user UUID, p_amount INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE affected INTEGER;
BEGIN
  UPDATE users SET coin_balance = coin_balance - p_amount
   WHERE id = p_user AND coin_balance >= p_amount;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END; $$;

-- ── Vidéo adaptative (HLS multi-qualités générée par le serveur) ──────
ALTER TABLE videos ADD COLUMN IF NOT EXISTS hls_url TEXT;

-- ── Édition "façon Snapchat" : filtre couleur + overlays (texte/emojis) ──
-- Métadonnées légères réappliquées à la lecture (aucun ré-encodage vidéo).
ALTER TABLE videos ADD COLUMN IF NOT EXISTS filter VARCHAR(30);
ALTER TABLE videos ADD COLUMN IF NOT EXISTS overlays JSONB;

-- ── Modération (exigences Google Play pour le contenu UGC) ────────────
-- Signalements de vidéos : un utilisateur ne peut signaler une vidéo qu'une fois.
CREATE TABLE IF NOT EXISTS video_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID NOT NULL,
  reporter_id UUID NOT NULL,
  reason VARCHAR(20) NOT NULL DEFAULT 'autre',
  details TEXT,
  status VARCHAR(15) NOT NULL DEFAULT 'pending', -- pending | dismissed | actioned
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (video_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS idx_video_reports_status ON video_reports(status);

-- Blocages entre utilisateurs : les vidéos d'un créateur bloqué
-- disparaissent du fil du bloqueur.
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id UUID NOT NULL,
  blocked_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);
