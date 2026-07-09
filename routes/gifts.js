'use strict';

const express = require('express');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');
const { GIFTS, COIN_PACKS } = require('../services/gifts');

const router = express.Router();

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

module.exports = router;
