'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');
const { buildRtcToken, isConfigured, APP_ID } = require('../services/agora');

const router = express.Router();

/**
 * POST /api/live/start — démarre un live, renvoie le canal + jeton diffuseur
 */
router.post('/start', requireAuth, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ success: false, message: 'Live non configuré (clés Agora manquantes côté serveur)' });
    }
    const title = (req.body.title || '').toString().trim().slice(0, 120) || 'Live';
    const id = uuidv4();
    const channel = `live_${id.replace(/-/g, '').slice(0, 20)}`;

    const { error } = await supabaseAdmin.from('live_streams').insert({
      id, creator_id: req.user.id, channel, title, status: 'live',
      viewers: 0, started_at: new Date().toISOString(),
    });
    if (error) return res.status(500).json({ success: false, message: error.message });

    const token = buildRtcToken(channel, true, 0);
    return res.json({ success: true, liveId: id, channel, appId: APP_ID, token });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * POST /api/live/:id/stop — termine un live (diffuseur uniquement)
 */
router.post('/:id/stop', requireAuth, async (req, res) => {
  try {
    const { data: live } = await supabaseAdmin
      .from('live_streams').select('id, creator_id, status').eq('id', req.params.id).single();
    if (!live) return res.status(404).json({ success: false, message: 'Live introuvable' });
    if (live.creator_id !== req.user.id) return res.status(403).json({ success: false, message: 'Non autorisé' });
    await supabaseAdmin.from('live_streams')
      .update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', req.params.id);
    return res.json({ success: true, message: 'Live terminé' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * GET /api/live/active — liste des lives en cours
 */
router.get('/active', async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('live_streams')
      .select('id, channel, title, viewers, started_at, creator:users!creator_id(id, username, avatar_url)')
      .eq('status', 'live')
      .order('started_at', { ascending: false })
      .limit(50);
    const lives = (data || []).map((l) => ({
      id: l.id, channel: l.channel, title: l.title, viewers: l.viewers || 0,
      started_at: l.started_at,
      host_id: l.creator?.id, host_name: l.creator?.username || 'Créateur',
      host_avatar: l.creator?.avatar_url || null,
    }));
    return res.json({ success: true, lives });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * GET /api/live/:id/token — jeton spectateur pour rejoindre un live
 */
router.get('/:id/token', requireAuth, async (req, res) => {
  try {
    const { data: live } = await supabaseAdmin
      .from('live_streams').select('channel, status').eq('id', req.params.id).single();
    if (!live || live.status !== 'live') return res.status(404).json({ success: false, message: 'Live terminé ou introuvable' });
    const token = buildRtcToken(live.channel, false, 0);
    return res.json({ success: true, channel: live.channel, appId: APP_ID, token });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

module.exports = router;
