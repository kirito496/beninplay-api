'use strict';

const express = require('express');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');
const { notify } = require('../services/notify');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: 'Non autorisé' });
  }
  next();
}

// Statut de monétisation de l'utilisateur (active | blocked | review)
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('users').select('monetization_status, monetization_blocked_reason').eq('id', req.user.id).single();
    return res.json({
      success: true,
      status: data?.monetization_status || 'active',
      reason: data?.monetization_blocked_reason || null,
    });
  } catch {
    return res.json({ success: true, status: 'active', reason: null });
  }
});

// Demande de réexamination (compte bloqué → passe en "review")
router.post('/review-request', requireAuth, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('users').select('monetization_status').eq('id', req.user.id).single();
    if (data?.monetization_status !== 'blocked') {
      return res.status(400).json({ success: false, message: 'Aucun blocage à réexaminer' });
    }
    await supabaseAdmin.from('users').update({ monetization_status: 'review' }).eq('id', req.user.id);
    return res.json({ success: true, message: 'Demande de réexamination envoyée ✅ Nous revenons vers toi.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

// ── ADMIN ────────────────────────────────────────────────────────────────
router.get('/flagged', requireAdmin, async (req, res) => {
  const { data } = await supabaseAdmin
    .from('users')
    .select('id, username, email, payout_phone, device_id, monetization_status, monetization_blocked_reason')
    .in('monetization_status', ['blocked', 'review'])
    .limit(200);
  return res.json({ success: true, count: (data || []).length, users: data || [] });
});

router.post('/:id/restore', requireAdmin, async (req, res) => {
  await supabaseAdmin.from('users')
    .update({ monetization_status: 'active', monetization_blocked_reason: null })
    .eq('id', req.params.id);
  notify(req.params.id, {
    type: 'monetization',
    title: 'Monétisation réactivée ✅',
    body: 'Ton compte peut de nouveau générer et retirer des gains.',
  });
  return res.json({ success: true, message: 'Monétisation réactivée' });
});

router.post('/:id/block', requireAdmin, async (req, res) => {
  const reason = req.body.reason || 'Bloqué par admin';
  await supabaseAdmin.from('users')
    .update({ monetization_status: 'blocked', monetization_blocked_reason: reason })
    .eq('id', req.params.id);
  notify(req.params.id, {
    type: 'monetization',
    title: 'Monétisation bloquée',
    body: `Ta monétisation a été suspendue. Motif : ${reason}. Demande une réexamination si besoin.`,
  });
  return res.json({ success: true, message: 'Compte bloqué' });
});

module.exports = router;
