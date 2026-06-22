'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.post('/:userId', requireAuth, async (req, res) => {
  try {
    const followingId = req.params.userId;
    if (followingId === req.user.id) return res.status(400).json({ success: false, message: 'Vous ne pouvez pas vous suivre vous-même' });
    const { error } = await supabaseAdmin.from('follows').insert({ id: uuidv4(), follower_id: req.user.id, following_id: followingId, created_at: new Date().toISOString() });
    if (error && error.code !== '23505') return res.status(500).json({ success: false, message: 'Erreur serveur' });
    return res.json({ success: true, following: true });
  } catch { return res.status(500).json({ success: false, message: 'Erreur interne' }); }
});

router.delete('/:userId', requireAuth, async (req, res) => {
  try {
    await supabaseAdmin.from('follows').delete().eq('follower_id', req.user.id).eq('following_id', req.params.userId);
    return res.json({ success: true, following: false });
  } catch { return res.status(500).json({ success: false, message: 'Erreur interne' }); }
});

router.get('/:userId/status', requireAuth, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('follows').select('id').eq('follower_id', req.user.id).eq('following_id', req.params.userId).single();
    return res.json({ success: true, following: !!data });
  } catch { return res.json({ success: true, following: false }); }
});

module.exports = router;
