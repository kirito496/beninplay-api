'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.post('/', requireAuth, async (req, res) => {
  try {
    const { video_id, budget, objective, target_nationwide, target_regions, target_hashtags, target_hours, target_age_min, target_age_max, target_gender } = req.body;
    if (!video_id || !budget) return res.status(400).json({ success: false, message: 'video_id et budget requis' });
    const { data: video } = await supabaseAdmin.from('videos').select('creator_id').eq('id', video_id).single();
    if (!video) return res.status(404).json({ success: false, message: 'Vidéo introuvable' });
    if (video.creator_id !== req.user.id) return res.status(403).json({ success: false, message: 'Accès refusé' });
    const { data: boost, error } = await supabaseAdmin.from('boosts').insert({
      id: uuidv4(), video_id, user_id: req.user.id, budget, objective: objective || 'views',
      target_nationwide: target_nationwide ?? true, target_regions: target_regions || [],
      target_hashtags: target_hashtags || [], target_hours: target_hours || [],
      target_age_min: target_age_min || 13, target_age_max: target_age_max || 65,
      target_gender: target_gender || 'all', status: 'active',
      starts_at: new Date().toISOString(), created_at: new Date().toISOString()
    }).select().single();
    if (error) return res.status(500).json({ success: false, message: 'Erreur création boost' });
    return res.status(201).json({ success: true, boost });
  } catch { return res.status(500).json({ success: false, message: 'Erreur interne' }); }
});

router.get('/my', requireAuth, async (req, res) => {
  try {
    const { data: boosts } = await supabaseAdmin.from('boosts').select('*, video:videos!video_id(title,thumbnail_url)').eq('user_id', req.user.id).order('created_at', { ascending: false });
    return res.json({ success: true, boosts: boosts || [] });
  } catch { return res.status(500).json({ success: false, message: 'Erreur interne' }); }
});

module.exports = router;
