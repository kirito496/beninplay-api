'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');
const { initiatePayment, checkPaymentStatus, initiateTransfer, calculateRevenueSplit, MIN_WITHDRAWAL } = require('../services/payment');
const router = express.Router();
router.get('/balance', requireAuth, async (req, res) => {
  const { data: u } = await supabaseAdmin.from('users').select('wallet_balance').eq('id', req.user.id).single();
  const { data: tx } = await supabaseAdmin.from('transactions').select('id,type,amount,status,description,created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(20);
  return res.json({ success: true, balance: u?.wallet_balance || 0, currency: 'FCFA', transactions: tx || [], minWithdrawal: MIN_WITHDRAWAL });
});
router.post('/deposit', requireAuth, async (req, res) => {
  const { amount, phone, return_url } = req.body;
  const a = parseInt(amount, 10);
  if (!a || a < 100) return res.status(400).json({ success: false, message: 'Minimum 100 FCFA' });
  const tid = uuidv4();
  await supabaseAdmin.from('transactions').insert({ id: tid, user_id: req.user.id, type: 'deposit', amount: a, status: 'pending', description: `Dépôt ${a} FCFA`, created_at: new Date().toISOString() });
  const r = await initiatePayment({ amount: a, description: `Recharge BeninPlay ${a} FCFA`, customerId: req.user.id, customerPhone: phone || req.user.phone, returnUrl: return_url });
  if (!r.success) { await supabaseAdmin.from('transactions').update({ status: 'failed' }).eq('id', tid); return res.status(502).json({ success: false, message: 'Paiement impossible. Réessayez.' }); }
  await supabaseAdmin.from('transactions').update({ cinetpay_transaction_id: r.transactionId }).eq('id', tid);
  return res.json({ success: true, paymentUrl: r.paymentUrl, transactionId: tid, amount: a });
});
router.post('/notify', async (req, res) => {
  const { cpm_trans_id, cpm_site_id, cpm_amount } = req.body;
  if (cpm_site_id !== process.env.CINETPAY_SITE_ID) return res.status(400).send('KO');
  const s = await checkPaymentStatus(cpm_trans_id);
  if (!s.success || s.status !== 'ACCEPTED') return res.send('KO');
  const { data: tx } = await supabaseAdmin.from('transactions').select('*').eq('cinetpay_transaction_id', cpm_trans_id).single();
  if (!tx || tx.status === 'completed') return res.send('OK');
  await supabaseAdmin.from('transactions').update({ status: 'completed', confirmed_at: new Date().toISOString() }).eq('id', tx.id);
  await supabaseAdmin.rpc('increment_wallet_balance', { user_id: tx.user_id, amount: parseInt(cpm_amount, 10) });
  return res.send('OK');
});
router.post('/withdraw', requireAuth, async (req, res) => {
  if (!req.user.is_creator) return res.status(403).json({ success: false, message: 'Réservé aux créateurs' });
  const { amount, phone, operator } = req.body;
  const a = parseInt(amount, 10);
  if (!a || a < MIN_WITHDRAWAL) return res.status(400).json({ success: false, message: `Minimum ${MIN_WITHDRAWAL} FCFA` });
  if (!['MTN','MOOV'].includes((operator||'').toUpperCase())) return res.status(400).json({ success: false, message: 'Opérateur: MTN ou MOOV' });
  const split = calculateRevenueSplit(a);
  const { data: u } = await supabaseAdmin.from('users').select('wallet_balance').eq('id', req.user.id).single();
  if (!u || u.wallet_balance < a) return res.status(400).json({ success: false, message: `Solde insuffisant (${u?.wallet_balance||0} FCFA)` });
  const tid = uuidv4();
  await supabaseAdmin.from('transactions').insert({ id: tid, user_id: req.user.id, type: 'withdrawal', amount: a, net_amount: split.creatorNet, status: 'pending', description: `Retrait ${operator} ${phone}`, created_at: new Date().toISOString() });
  await supabaseAdmin.rpc('decrement_wallet_balance', { user_id: req.user.id, amount: a });
  const tr = await initiateTransfer({ amount: split.creatorNet, phoneNumber: phone, operator: operator.toUpperCase() });
  if (!tr.success) {
    await supabaseAdmin.rpc('increment_wallet_balance', { user_id: req.user.id, amount: a });
    await supabaseAdmin.from('transactions').update({ status: 'failed' }).eq('id', tid);
    return res.status(502).json({ success: false, message: 'Échec transfert. Solde restauré.' });
  }
  await supabaseAdmin.from('transactions').update({ status: 'processing', cinetpay_transaction_id: tr.transactionId }).eq('id', tid);
  return res.json({ success: true, message: `Vous recevrez ${split.creatorNet} FCFA sur votre ${operator.toUpperCase()}`, details: { requested: a, momoFee: split.momoFee, netAmount: split.creatorNet } });
});
module.exports = router;
