'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');
const { GIFTS, COIN_PACKS } = require('../services/gifts');
const { calculateRevenueSplit } = require('../services/payment');
const { notify } = require('../services/notify');

const router = express.Router();

// Montants de tip autorisés (en pièces)
const TIP_AMOUNTS = [50, 100, 250, 500, 1000, 2000];

/**
 * GET /api/gifts/catalog — stickers, paquets de pièces et solde de l'utilisateur
 */
router.get('/catalog', requireAuth, async (req, res) => {
  let coinBalance = 0;
  try {
    const { data: u } = await supabaseAdmin
      .from('users').select('coin_balance').eq('id', req.user.id).single();
    coinBalance = u?.coin_balance || 0;
  } catch (_) { /* colonne absente avant migration */ }
  return res.json({ success: true, gifts: GIFTS, packs: COIN_PACKS, coin_balance: coinBalance });
});

/**
 * GET /api/gifts/balance — solde de pièces
 */
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const { data: u } = await supabaseAdmin
      .from('users').select('coin_balance').eq('id', req.user.id).single();
    return res.json({ success: true, coin_balance: u?.coin_balance || 0 });
  } catch (_) {
    return res.json({ success: true, coin_balance: 0 });
  }
});

/**
 * POST /api/gifts/tip — envoyer un tip (soutien direct) à un créateur, payé en pièces.
 * body: { creatorId, coins, videoId? }
 * ⚠️ Instantané : débit atomique des pièces (sans pièces, impossible d'envoyer).
 */
router.post('/tip', requireAuth, async (req, res) => {
  try {
    const creatorId = (req.body.creatorId || '').toString();
    const coins = parseInt(req.body.coins, 10) || 0;
    const videoId = req.body.videoId ? req.body.videoId.toString() : null;

    if (!creatorId) return res.status(400).json({ success: false, message: 'Créateur manquant' });
    if (creatorId === req.user.id) return res.status(400).json({ success: false, message: 'Tu ne peux pas te soutenir toi-même' });
    if (!TIP_AMOUNTS.includes(coins)) return res.status(400).json({ success: false, message: 'Montant de tip invalide' });

    // Le créateur existe ?
    const { data: creator } = await supabaseAdmin
      .from('users').select('id, username').eq('id', creatorId).single();
    if (!creator) return res.status(404).json({ success: false, message: 'Créateur introuvable' });

    // Débit atomique des pièces (bloque si solde insuffisant)
    const { data: ok } = await supabaseAdmin.rpc('spend_coins', { p_user: req.user.id, p_amount: coins });
    if (ok !== true) {
      return res.status(402).json({ success: false, code: 'no_coins', message: 'Pièces insuffisantes. Recharge pour soutenir.' });
    }

    // Crédite le créateur (part nette) + trace + notif
    const split = calculateRevenueSplit(coins);
    await supabaseAdmin.rpc('increment_wallet_balance', { user_id: creatorId, amount: split.creatorGross });
    await supabaseAdmin.from('live_gifts').insert({
      id: uuidv4(), live_id: null, sender_id: req.user.id, creator_id: creatorId,
      gift_key: 'tip', coins, amount_fcfa: coins, created_at: new Date().toISOString(),
    });
    await supabaseAdmin.from('transactions').insert({
      id: uuidv4(), user_id: creatorId, type: 'earning',
      amount: split.creatorGross, net_amount: split.creatorGross, status: 'completed',
      description: `Tip de soutien (${coins} pièces)`,
      metadata: { from: req.user.id, coins, video_id: videoId },
      created_at: new Date().toISOString(), confirmed_at: new Date().toISOString(),
    });

    // Nom de l'expéditeur pour la notif
    const { data: me } = await supabaseAdmin.from('users').select('username').eq('id', req.user.id).single();
    notify(creatorId, {
      type: 'live_purchase',
      title: 'Tip de soutien 💝',
      body: `@${me?.username || 'Quelqu\'un'} t'a envoyé un tip (+${split.creatorGross} FCFA)`,
      data: { coins, from: req.user.id, video_id: videoId },
    });

    const { data: u } = await supabaseAdmin.from('users').select('coin_balance').eq('id', req.user.id).single();
    return res.json({ success: true, message: 'Tip envoyé ❤️', coin_balance: u?.coin_balance || 0 });
  } catch (err) {
    console.error('[Tip] erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

module.exports = router;
