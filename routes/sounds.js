'use strict';

const express = require('express');
const { supabaseAdmin } = require('../services/supabase');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();

function pack(sound) {
  return {
    id: sound.id,
    title: sound.title,
    creator_id: sound.creator_id,
    creator_name: sound.creator?.username || 'Créateur',
    creator_avatar: sound.creator?.avatar_url || null,
    uses_count: sound.uses_count || 0,
    source_video_id: sound.source_video_id || null,
  };
}

async function videosOfSound(soundId) {
  const { data: vids } = await supabaseAdmin
    .from('videos')
    .select('id, title, thumbnail_url, video_url, views, likes_count, creator_id, creator:users!creator_id(username)')
    .eq('sound_id', soundId).eq('status', 'published')
    .order('views', { ascending: false }).limit(60);
  return (vids || []).map((v) => ({ ...v, creator_name: v.creator?.username || 'Créateur' }));
}

// GET /api/sounds → sons populaires (pour « Ajouter une musique » dans l'éditeur)
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { data: sounds } = await supabaseAdmin
      .from('sounds')
      .select('id, title, creator_id, source_video_id, uses_count, creator:users!creator_id(username, avatar_url)')
      .not('audio_url', 'is', null)
      .order('uses_count', { ascending: false })
      .limit(30);
    return res.json({ success: true, sounds: (sounds || []).map(pack) });
  } catch (_) {
    return res.json({ success: true, sounds: [] });
  }
});

// GET /api/sounds/by-video/:videoId → le son utilisé par cette vidéo
router.get('/by-video/:videoId', optionalAuth, async (req, res) => {
  try {
    const { data: v } = await supabaseAdmin
      .from('videos').select('sound_id').eq('id', req.params.videoId).single();
    if (!v || !v.sound_id) return res.json({ success: true, sound: null });
    const { data: sound } = await supabaseAdmin
      .from('sounds')
      .select('id, title, creator_id, source_video_id, uses_count, creator:users!creator_id(username, avatar_url)')
      .eq('id', v.sound_id).single();
    if (!sound) return res.json({ success: true, sound: null });
    return res.json({ success: true, sound: pack(sound) });
  } catch (_) {
    return res.json({ success: true, sound: null });
  }
});

// GET /api/sounds/:id → infos du son + vidéos qui l'utilisent
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { data: sound } = await supabaseAdmin
      .from('sounds')
      .select('id, title, creator_id, source_video_id, uses_count, creator:users!creator_id(username, avatar_url)')
      .eq('id', req.params.id).single();
    if (!sound) return res.status(404).json({ success: false, message: 'Son introuvable' });
    return res.json({ success: true, sound: pack(sound), videos: await videosOfSound(req.params.id) });
  } catch (_) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

module.exports = router;
