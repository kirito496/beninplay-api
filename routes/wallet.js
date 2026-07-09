'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');
const { calculateRevenueSplit, MIN_WITHDRAWAL } = require('../services/payment');
const router = express.Router();

// Protection des routes admin par une clé secrète (variable d'env ADMIN_KEY).
function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: 'Non autorisé' });
  }
  next();
}

// ── Solde + dernières transactions ─────────────────────────────────────────
router.get('/balance', requireAuth, async (req, res) => {
  const { data: u } = await supabaseAdmin.from('users').select('wallet_balance').eq('id', req.user.id).single();
  const { data: tx } = await supabaseAdmin.from('transactions')
    .select('id,type,amount,status,description,created_at')
    .eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(20);
  return res.json({ success: true, balance: u?.wallet_balance || 0, currency: 'FCFA', transactions: tx || [], minWithdrawal: MIN_WITHDRAWAL });
});

// ── Demande de retrait (traitement manuel gratuit) ─────────────────────────
// Le solde est réservé immédiatement ; l'admin envoie le MoMo puis valide.
router.post('/withdraw', requireAuth, async (req, res) => {
  if (!req.user.is_creator) return res.status(403).json({ success: false, message: 'Réservé aux créateurs' });
  const { amount, phone, operator } = req.body;
  const a = parseInt(amount, 10);
  if (!a || a < MIN_WITHDRAWAL) return res.status(400).json({ success: false, message: `Minimum ${MIN_WITHDRAWAL} FCFA` });
  const op = (operator || '').toUpperCase();
  if (!['MTN', 'MOOV'].includes(op)) return res.status(400).json({ success: false, message: 'Opérateur : MTN ou MOOV' });
  const cleanPhone = String(phone || '').replace(/\s/g, '');
  if (cleanPhone.length < 8) return res.status(400).json({ success: false, message: 'Numéro Mobile Money invalide' });

  // ── Anti-multi-comptes : un seul compte monétisable par personne ──────────
  const deviceId = (req.headers['x-device-id'] || '').toString().slice(0, 64) || null;
  const { data: me } = await supabaseAdmin
    .from('users').select('monetization_status, kyc_status').eq('id', req.user.id).single();
  // KYC obligatoire pour monétiser (vrai verrou "1 personne = 1 compte")
  if (me?.kyc_status !== 'verified') {
    return res.status(403).json({
      success: false, code: 'kyc_required',
      message: "Vérification d'identité requise pour retirer tes gains. Fais vérifier ta pièce (CIP).",
    });
  }
  if (me && me.monetization_status && me.monetization_status !== 'active') {
    return res.status(403).json({
      success: false, code: 'monetization_blocked',
      message: me.monetization_status === 'review'
        ? 'Réexamination en cours. Tu seras notifié dès qu\'elle est traitée.'
        : 'Compte bloqué (plusieurs comptes détectés). Demande une réexamination.',
    });
  }
  // Cherche un autre compte lié (même numéro de retrait ou même appareil)
  const orParts = [`payout_phone.eq.${cleanPhone}`];
  if (deviceId) orParts.push(`device_id.eq.${deviceId}`);
  const { data: siblings } = await supabaseAdmin
    .from('users').select('id').or(orParts.join(',')).neq('id', req.user.id).limit(1);
  if (siblings && siblings.length > 0) {
    const reason = 'Plusieurs comptes détectés (même numéro de retrait ou même appareil)';
    await supabaseAdmin.from('users')
      .update({ monetization_status: 'blocked', monetization_blocked_reason: reason })
      .eq('id', req.user.id);
    await supabaseAdmin.from('users')
      .update({ monetization_status: 'blocked', monetization_blocked_reason: reason })
      .or(orParts.join(',')).neq('id', req.user.id);
    return res.status(403).json({
      success: false, code: 'monetization_blocked',
      message: 'Un autre compte utilise ce numéro ou cet appareil. La monétisation est bloquée. Demande une réexamination.',
    });
  }
  // Mémorise l'empreinte de ce compte (numéro de retrait + appareil)
  await supabaseAdmin.from('users')
    .update({ payout_phone: cleanPhone, ...(deviceId ? { device_id: deviceId } : {}) })
    .eq('id', req.user.id);

  const split = calculateRevenueSplit(a);
  const { data: u } = await supabaseAdmin.from('users').select('wallet_balance').eq('id', req.user.id).single();
  if (!u || u.wallet_balance < a) return res.status(400).json({ success: false, message: `Solde insuffisant (${u?.wallet_balance || 0} FCFA)` });

  // Réserver le solde (empêche de retirer deux fois le même argent)
  try {
    await supabaseAdmin.rpc('decrement_wallet_balance', { user_id: req.user.id, amount: a });
  } catch {
    return res.status(400).json({ success: false, message: 'Solde insuffisant' });
  }

  const tid = uuidv4();
  const { error: insErr } = await supabaseAdmin.from('transactions').insert({
    id: tid, user_id: req.user.id, type: 'withdrawal', amount: a, net_amount: split.creatorNet,
    status: 'pending', description: `Retrait ${op} ${cleanPhone}`,
    metadata: { phone: cleanPhone, operator: op, momoFee: split.momoFee, netAmount: split.creatorNet },
    created_at: new Date().toISOString(),
  });
  if (insErr) {
    // Échec d'enregistrement : on rend le solde
    await supabaseAdmin.rpc('increment_wallet_balance', { user_id: req.user.id, amount: a });
    return res.status(500).json({ success: false, message: 'Erreur. Réessayez.' });
  }

  return res.json({
    success: true,
    message: `Demande enregistrée ✅ Tu recevras ${split.creatorNet} FCFA sur ton ${op} (${cleanPhone}) sous 24 h.`,
    details: { requested: a, momoFee: split.momoFee, netAmount: split.creatorNet, status: 'pending' },
  });
});

// ── ADMIN : lister les retraits à traiter ──────────────────────────────────
// GET /api/wallet/admin/withdrawals?status=pending   (en-tête x-admin-key)
router.get('/admin/withdrawals', requireAdmin, async (req, res) => {
  const status = req.query.status || 'pending';
  const { data } = await supabaseAdmin.from('transactions')
    .select('id, user_id, amount, net_amount, status, description, metadata, created_at')
    .eq('type', 'withdrawal').eq('status', status)
    .order('created_at', { ascending: true }).limit(100);
  return res.json({ success: true, count: (data || []).length, withdrawals: data || [] });
});

// ── ADMIN : marquer un retrait comme payé (après envoi manuel du MoMo) ──────
router.post('/admin/withdrawals/:id/complete', requireAdmin, async (req, res) => {
  const { data: tx } = await supabaseAdmin.from('transactions').select('*').eq('id', req.params.id).eq('type', 'withdrawal').single();
  if (!tx) return res.status(404).json({ success: false, message: 'Retrait introuvable' });
  if (tx.status === 'completed') return res.json({ success: true, message: 'Déjà payé' });
  if (!['pending', 'processing'].includes(tx.status)) return res.status(400).json({ success: false, message: `Statut « ${tx.status} » non payable` });
  await supabaseAdmin.from('transactions').update({ status: 'completed', confirmed_at: new Date().toISOString() }).eq('id', tx.id);
  return res.json({ success: true, message: 'Retrait marqué comme payé ✅' });
});

// ── ADMIN : rejeter un retrait et rembourser le solde ──────────────────────
router.post('/admin/withdrawals/:id/reject', requireAdmin, async (req, res) => {
  const { data: tx } = await supabaseAdmin.from('transactions').select('*').eq('id', req.params.id).eq('type', 'withdrawal').single();
  if (!tx) return res.status(404).json({ success: false, message: 'Retrait introuvable' });
  if (tx.status === 'cancelled') return res.json({ success: true, message: 'Déjà annulé' });
  if (tx.status === 'completed') return res.status(400).json({ success: false, message: 'Déjà payé, non remboursable' });
  await supabaseAdmin.rpc('increment_wallet_balance', { user_id: tx.user_id, amount: tx.amount });
  await supabaseAdmin.from('transactions').update({ status: 'cancelled' }).eq('id', tx.id);
  return res.json({ success: true, message: 'Retrait rejeté, solde remboursé' });
});

module.exports = router;
