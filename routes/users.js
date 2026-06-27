'use strict';

const express = require('express');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

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
    }

    return res.json({ success: true, following });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
