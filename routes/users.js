'use strict';

const express = require('express');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { notify } = require('../services/notify');

const router = express.Router();

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

module.exports = router;
