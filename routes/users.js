'use strict';

const express = require('express');
const multer = require('multer');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { notify } = require('../services/notify');

const router = express.Router();

// Upload photo de profil : image en mémoire (max 5 Mo) puis Supabase Storage.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

/**
 * DELETE /api/users/me
 * Suppression du compte (exigence Google Play) : supprime les vidéos du
 * stockage, les données liées (best-effort) puis le compte lui-même.
 * Action DÉFINITIVE — confirmée côté app par une double validation.
 */
router.delete('/me', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'videos';
  try {
    // 1) Fichiers vidéo du créateur dans le stockage (best-effort)
    try {
      const { data: vids } = await supabaseAdmin
        .from('videos').select('storage_path').eq('creator_id', userId);
      const paths = (vids || []).map((v) => v.storage_path).filter(Boolean);
      if (paths.length > 0) {
        await supabaseAdmin.storage.from(bucket).remove(paths).catch(() => {});
      }
    } catch (_) {}

    // 2) Données liées (chaque table peut ne pas exister : best-effort)
    const cleanups = [
      () => supabaseAdmin.from('videos').delete().eq('creator_id', userId),
      () => supabaseAdmin.from('video_likes').delete().eq('user_id', userId),
      () => supabaseAdmin.from('video_purchases').delete().eq('user_id', userId),
      () => supabaseAdmin.from('follows').delete().eq('follower_id', userId),
      () => supabaseAdmin.from('follows').delete().eq('following_id', userId),
      () => supabaseAdmin.from('notifications').delete().eq('user_id', userId),
      () => supabaseAdmin.from('user_blocks').delete().eq('blocker_id', userId),
      () => supabaseAdmin.from('user_blocks').delete().eq('blocked_id', userId),
      () => supabaseAdmin.from('video_reports').delete().eq('reporter_id', userId),
    ];
    for (const fn of cleanups) {
      try { await fn(); } catch (_) {}
    }

    // 3) Le compte lui-même — si ça échoue, on le signale clairement
    const { error } = await supabaseAdmin.from('users').delete().eq('id', userId);
    if (error) {
      console.error('[Users] suppression compte échouée:', error.message);
      return res.status(500).json({
        success: false,
        message: 'Suppression impossible pour le moment. Contacte le support.',
      });
    }

    console.log(`[Users] compte ${userId} supprimé (demande utilisateur)`);
    return res.json({ success: true, message: 'Compte supprimé définitivement.' });
  } catch (err) {
    console.error('[Users] delete/me erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * POST /api/users/:id/block — bloquer un utilisateur (exigence Google Play UGC)
 * DELETE /api/users/:id/block — le débloquer
 * Les vidéos d'un créateur bloqué disparaissent du fil du bloqueur.
 */
router.post('/:id/block', requireAuth, async (req, res) => {
  const blockedId = req.params.id;
  if (blockedId === req.user.id) {
    return res.status(400).json({ success: false, message: 'Impossible de se bloquer soi-même' });
  }
  try {
    const { error } = await supabaseAdmin
      .from('user_blocks')
      .upsert({ blocker_id: req.user.id, blocked_id: blockedId }, { onConflict: 'blocker_id,blocked_id' });
    if (error) throw error;
    return res.json({ success: true, message: 'Utilisateur bloqué' });
  } catch (err) {
    console.error('[Users] block erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Blocage impossible (migration manquante ?)' });
  }
});

router.delete('/:id/block', requireAuth, async (req, res) => {
  try {
    await supabaseAdmin
      .from('user_blocks').delete()
      .eq('blocker_id', req.user.id).eq('blocked_id', req.params.id);
    return res.json({ success: true, message: 'Utilisateur débloqué' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * GET /api/users/leaderboard?limit=50
 * Classement des créateurs par score d'impact (vues complétées incluses).
 */
router.get('/leaderboard', optionalAuth, async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
  try {
    // Voie rapide : fonction SQL agrégée
    const { data, error } = await supabaseAdmin.rpc('creator_leaderboard', { limit_n: limit });
    if (!error && Array.isArray(data)) {
      const ranked = data.map((r, i) => ({ rank: i + 1, ...r }));
      return res.json({ success: true, creators: ranked });
    }
    throw error || new Error('rpc indisponible');
  } catch (_) {
    // Repli : agrégation simple côté serveur (sans vues complétées ni abonnés)
    try {
      const { data: vids } = await supabaseAdmin
        .from('videos')
        .select('creator_id, views, likes_count, comments_count, creator:users!creator_id(id, username, avatar_url, is_creator)')
        .eq('status', 'published')
        .limit(2000);
      const acc = {};
      for (const v of vids || []) {
        if (!v.creator || v.creator.is_creator !== true) continue;
        const id = v.creator_id;
        acc[id] = acc[id] || {
          creator_id: id, username: v.creator.username, avatar_url: v.creator.avatar_url,
          videos_count: 0, total_views: 0, completed_views: 0, likes: 0, comments: 0, followers: 0,
        };
        acc[id].videos_count += 1;
        acc[id].total_views += v.views || 0;
        acc[id].likes += v.likes_count || 0;
        acc[id].comments += v.comments_count || 0;
      }
      const ranked = Object.values(acc)
        .map((c) => ({ ...c, score: c.likes * 3 + c.comments * 4 + c.total_views }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((c, i) => ({ rank: i + 1, ...c }));
      return res.json({ success: true, creators: ranked });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }
});

/**
 * GET /api/users/search?q=... — recherche de créateurs/utilisateurs par pseudo
 */
router.get('/search', optionalAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim().toLowerCase().slice(0, 40);
    if (q.length < 2) return res.json({ success: true, users: [] });
    const safe = q.replace(/[%_]/g, '');

    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, username, avatar_url, is_creator, bio')
      .ilike('username', `%${safe}%`)
      .limit(30);

    // Ajoute le nombre d'abonnés pour chaque résultat (léger, best-effort)
    const out = [];
    for (const u of users || []) {
      let followers = 0;
      try {
        const { count } = await supabaseAdmin
          .from('follows').select('*', { count: 'exact', head: true }).eq('following_id', u.id);
        followers = count || 0;
      } catch (_) { /* ignore */ }
      out.push({ ...u, followers_count: followers });
    }
    // Créateurs d'abord, puis par nombre d'abonnés
    out.sort((a, b) => (b.is_creator === true ? 1 : 0) - (a.is_creator === true ? 1 : 0)
      || b.followers_count - a.followers_count);

    return res.json({ success: true, users: out });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * GET /api/users/me/stats — tableau de bord chiffré du créateur connecté
 */
router.get('/me/stats', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;

    // Mes vidéos (agrégats + top)
    const { data: myVideos } = await supabaseAdmin
      .from('videos')
      .select('id, title, thumbnail_url, views, likes_count, comments_count')
      .eq('creator_id', uid)
      .eq('status', 'published')
      .order('views', { ascending: false })
      .limit(500);

    const vids = myVideos || [];
    const totals = vids.reduce((a, v) => {
      a.views += v.views || 0;
      a.likes += v.likes_count || 0;
      a.comments += v.comments_count || 0;
      return a;
    }, { views: 0, likes: 0, comments: 0 });

    const topVideos = vids.slice(0, 5).map((v) => ({
      id: v.id, title: v.title, thumbnail_url: v.thumbnail_url,
      views: v.views || 0, likes_count: v.likes_count || 0,
    }));

    // Abonnés
    let followers = 0;
    try {
      const { count } = await supabaseAdmin
        .from('follows').select('*', { count: 'exact', head: true }).eq('following_id', uid);
      followers = count || 0;
    } catch (_) { /* ignore */ }

    // Gains cumulés (transactions "earning" confirmées) + solde
    let earningsTotal = 0;
    try {
      const { data: earn } = await supabaseAdmin
        .from('transactions').select('amount').eq('user_id', uid).eq('type', 'earning');
      earningsTotal = (earn || []).reduce((s, t) => s + (t.amount || 0), 0);
    } catch (_) { /* table/type absent */ }

    let walletBalance = 0;
    try {
      const { data: u } = await supabaseAdmin
        .from('users').select('wallet_balance').eq('id', uid).single();
      walletBalance = u?.wallet_balance || 0;
    } catch (_) { /* ignore */ }

    // Vues des 7 derniers jours (sur mes vidéos)
    let views7d = 0;
    try {
      if (vids.length > 0) {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { count } = await supabaseAdmin
          .from('video_views')
          .select('*', { count: 'exact', head: true })
          .in('video_id', vids.map((v) => v.id))
          .gte('created_at', since);
        views7d = count || 0;
      }
    } catch (_) { /* table absente */ }

    return res.json({
      success: true,
      stats: {
        videos: vids.length,
        views: totals.views,
        likes: totals.likes,
        comments: totals.comments,
        followers,
        earnings_total: earningsTotal,
        wallet_balance: walletBalance,
        views_7d: views7d,
        top_videos: topVideos,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * GET /api/users/:id
 * Profil public d'un créateur + compteurs + si je le suis
 */
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, username, avatar_url, bio, is_creator, created_at')
      .eq('id', id)
      .single();

    if (error || !user) {
      return res.status(404).json({ success: false, message: 'Utilisateur introuvable' });
    }

    // Compteurs
    const [{ count: followers }, { count: following }, { count: videos }] = await Promise.all([
      supabaseAdmin.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', id),
      supabaseAdmin.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', id),
      supabaseAdmin.from('videos').select('*', { count: 'exact', head: true }).eq('creator_id', id).eq('status', 'published'),
    ]);

    // Total de likes reçus sur ses vidéos
    const { data: vids } = await supabaseAdmin
      .from('videos').select('likes_count').eq('creator_id', id).eq('status', 'published');
    const totalLikes = (vids || []).reduce((s, v) => s + (v.likes_count || 0), 0);

    // Est-ce que le viewer le suit ?
    let isFollowing = false;
    if (req.user && req.user.id !== id) {
      const { data: f } = await supabaseAdmin
        .from('follows').select('id')
        .eq('follower_id', req.user.id).eq('following_id', id).limit(1);
      isFollowing = !!(f && f.length > 0);
    }

    return res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        avatar_url: user.avatar_url,
        bio: user.bio,
        is_creator: user.is_creator,
        followers_count: followers || 0,
        following_count: following || 0,
        videos_count: videos || 0,
        total_likes: totalLikes,
        is_following: isFollowing,
        is_me: req.user ? req.user.id === id : false,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/users/:id/follow
 * Suivre / ne plus suivre (toggle)
 */
router.post('/:id/follow', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (id === req.user.id) {
      return res.status(400).json({ success: false, message: 'Tu ne peux pas te suivre toi-même' });
    }

    // Cible existe ?
    const { data: target } = await supabaseAdmin.from('users').select('id').eq('id', id).single();
    if (!target) return res.status(404).json({ success: false, message: 'Utilisateur introuvable' });

    // Déjà suivi ?
    const { data: existing } = await supabaseAdmin
      .from('follows').select('id')
      .eq('follower_id', req.user.id).eq('following_id', id).limit(1);

    let following;
    if (existing && existing.length > 0) {
      await supabaseAdmin.from('follows').delete().eq('id', existing[0].id);
      following = false;
    } else {
      await supabaseAdmin.from('follows').insert({
        follower_id: req.user.id,
        following_id: id,
        created_at: new Date().toISOString(),
      });
      following = true;

      // Notifie la personne suivie
      const { data: me } = await supabaseAdmin
        .from('users').select('username').eq('id', req.user.id).single();
      const who = me?.username || 'Quelqu\'un';
      notify(id, {
        type: 'follow',
        title: 'Nouvel abonné',
        body: `@${who} a commencé à te suivre`,
        actorId: req.user.id,
        data: { follower_id: req.user.id },
      });
    }

    return res.json({ success: true, following });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/users/avatar — change la photo de profil.
 * Reçoit un fichier image (champ 'avatar'), le stocke et met à jour avatar_url.
 */
router.post('/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, message: 'Aucune image reçue' });
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'videos';
    const ext = (file.mimetype && file.mimetype.includes('png')) ? 'png' : 'jpg';
    const path = `avatars/${req.user.id}_${Date.now()}.${ext}`;

    const { error: upErr } = await supabaseAdmin.storage
      .from(bucket)
      .upload(path, file.buffer, { contentType: file.mimetype || 'image/jpeg', upsert: true });
    if (upErr) return res.status(500).json({ success: false, message: upErr.message });

    const { data: pub } = supabaseAdmin.storage.from(bucket).getPublicUrl(path);
    const avatarUrl = pub && pub.publicUrl;

    await supabaseAdmin.from('users').update({ avatar_url: avatarUrl }).eq('id', req.user.id);
    return res.json({ success: true, avatar_url: avatarUrl });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/users/sticker — téléverse une image à poser comme sticker sur une
 * vidéo (façon Snapchat). Renvoie l'URL publique (stockée dans l'overlay).
 */
router.post('/sticker', requireAuth, avatarUpload.single('sticker'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, message: 'Aucune image reçue' });
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'videos';
    const ext = (file.mimetype && file.mimetype.includes('png')) ? 'png' : 'jpg';
    const path = `stickers/${req.user.id}_${Date.now()}.${ext}`;

    const { error: upErr } = await supabaseAdmin.storage
      .from(bucket)
      .upload(path, file.buffer, { contentType: file.mimetype || 'image/png', upsert: true });
    if (upErr) return res.status(500).json({ success: false, message: upErr.message });

    const { data: pub } = supabaseAdmin.storage.from(bucket).getPublicUrl(path);
    return res.json({ success: true, url: pub && pub.publicUrl });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/users/interests — « Tes centres d'intérêt ».
 * Montre ce que l'algo a appris de toi : thèmes (tags des vidéos aimées) et
 * créateurs préférés, agrégés depuis tes likes. C'est exactement le signal que
 * la reco utilise pour te proposer plus de vidéos qui te ressemblent.
 */
router.get('/interests', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { data: likes } = await supabaseAdmin
      .from('video_likes').select('video_id').eq('user_id', userId).limit(500);
    const ids = (likes || []).map((l) => l.video_id);
    if (ids.length === 0) {
      return res.json({ success: true, totalLikes: 0, interests: [], creators: [] });
    }

    const { data: vids } = await supabaseAdmin
      .from('videos')
      .select('id, tags, creator_id, creator:users!creator_id(id, username, avatar_url)')
      .in('id', ids);

    const tagCount = {};
    const creatorCount = {};
    const creatorInfo = {};
    for (const v of vids || []) {
      for (const t of (v.tags || [])) {
        const k = String(t).toLowerCase().replace(/^#/, '').trim();
        if (k) tagCount[k] = (tagCount[k] || 0) + 1;
      }
      if (v.creator_id) {
        creatorCount[v.creator_id] = (creatorCount[v.creator_id] || 0) + 1;
        creatorInfo[v.creator_id] = v.creator;
      }
    }

    const interests = Object.entries(tagCount)
      .sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([tag, count]) => ({ tag, count }));
    const creators = Object.entries(creatorCount)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([id, count]) => ({
        id, count,
        username: creatorInfo[id]?.username || 'Créateur',
        avatar_url: creatorInfo[id]?.avatar_url || null,
      }));

    return res.json({ success: true, totalLikes: ids.length, interests, creators });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
