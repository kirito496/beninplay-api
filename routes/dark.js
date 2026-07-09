'use strict';

const express = require('express');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: 'Non autorisé' });
  }
  next();
}

// Calcule l'accès Dark d'un utilisateur (par défaut : refusé).
async function computeAccess(userId) {
  try {
    const { data } = await supabaseAdmin
      .from('users').select('kyc_status, dark_sub_until').eq('id', userId).single();
    const kyc = data?.kyc_status || 'none';
    const until = data?.dark_sub_until || null;
    const subscribed = until ? new Date(until).getTime() > Date.now() : false;
    return { kyc_status: kyc, subscribed, until, can_access: kyc === 'verified' && subscribed };
  } catch {
    return { kyc_status: 'none', subscribed: false, until: null, can_access: false };
  }
}

/**
 * GET /api/dark/access — état d'accès de l'utilisateur à la Zone Dark
 */
router.get('/access', requireAuth, async (req, res) => {
  const a = await computeAccess(req.user.id);
  return res.json({ success: true, ...a });
});

/**
 * POST /api/dark/kyc/submit — soumet la vérification d'identité (+18)
 * body: { front_url?, back_url? }  → passe le compte en "pending"
 */
router.post('/kyc/submit', requireAuth, async (req, res) => {
  try {
    const { front_url, back_url } = req.body || {};
    const update = { kyc_status: 'pending', kyc_submitted_at: new Date().toISOString() };
    if (front_url) update.kyc_front_url = String(front_url).slice(0, 500);
    if (back_url) update.kyc_back_url = String(back_url).slice(0, 500);
    const { error } = await supabaseAdmin.from('users').update(update).eq('id', req.user.id);
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, message: 'Vérification envoyée ✅ Validation sous 24-48 h.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

// ── ADMIN : vérification KYC ────────────────────────────────────────────
router.get('/kyc/pending', requireAdmin, async (req, res) => {
  const { data } = await supabaseAdmin
    .from('users')
    .select('id, username, phone, kyc_status, kyc_front_url, kyc_back_url, kyc_submitted_at')
    .eq('kyc_status', 'pending')
    .order('kyc_submitted_at', { ascending: true })
    .limit(100);
  return res.json({ success: true, count: (data || []).length, pending: data || [] });
});

router.post('/kyc/:id/verify', requireAdmin, async (req, res) => {
  const { error } = await supabaseAdmin.from('users').update({ kyc_status: 'verified' }).eq('id', req.params.id);
  if (error) return res.status(500).json({ success: false, message: error.message });
  return res.json({ success: true, message: 'Identité vérifiée ✅' });
});

router.post('/kyc/:id/reject', requireAdmin, async (req, res) => {
  await supabaseAdmin.from('users').update({ kyc_status: 'rejected' }).eq('id', req.params.id);
  return res.json({ success: true, message: 'Vérification rejetée' });
});

module.exports = router;
module.exports.computeAccess = computeAccess;
