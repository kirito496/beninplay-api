'use strict';
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { sendOTP, normalizeBeninPhone } = require('../services/sms');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
const OTP_EXPIRY = 5;
const TEST_OTP = '123456';
router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Numéro requis' });
    const p = normalizeBeninPhone(phone);
    if (!p) return res.status(400).json({ success: false, message: 'Numéro béninois invalide (+229XXXXXXXX)' });
    const ago = new Date(Date.now() - 3600000).toISOString();
    const { count } = await supabaseAdmin.from('otp_codes').select('*', { count: 'exact', head: true }).eq('phone', p).gte('created_at', ago);
    if (count >= 3) return res.status(429).json({ success: false, message: 'Trop de tentatives. Réessayez dans 1h.' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await supabaseAdmin.from('otp_codes').update({ used: true }).eq('phone', p).eq('used', false);
    await supabaseAdmin.from('otp_codes').insert({ id: uuidv4(), phone: p, code: otp, expires_at: new Date(Date.now() + OTP_EXPIRY * 60000).toISOString(), used: false });
    const sms = await sendOTP(p, otp);
    if (!sms.success) return res.status(503).json({ success: false, message: "Impossible d'envoyer le SMS." });
    const r = { success: true, message: `Code envoyé au ${p}`, expiresInMinutes: OTP_EXPIRY };
    if (process.env.NODE_ENV !== 'production') r.devOtp = otp;
    return res.json(r);
  } catch (err) { return res.status(500).json({ success: false, message: 'Erreur interne' }); }
});
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ success: false, message: 'Téléphone et code requis' });
    const p = normalizeBeninPhone(phone);
    if (!p) return res.status(400).json({ success: false, message: 'Numéro invalide' });
    const c = code.toString().trim();
    const isTest = process.env.NODE_ENV !== 'production' && c === TEST_OTP;
    if (!isTest) {
      const { data: otp } = await supabaseAdmin.from('otp_codes').select('*').eq('phone', p).eq('code', c).eq('used', false).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).single();
      if (!otp) return res.status(400).json({ success: false, message: 'Code OTP invalide ou expiré' });
      await supabaseAdmin.from('otp_codes').update({ used: true }).eq('id', otp.id);
    }
    let { data: user } = await supabaseAdmin.from('users').select('*').eq('phone', p).single();
    let isNew = false;
    if (!user) {
      isNew = true;
      const { data: created } = await supabaseAdmin.from('users').insert({ id: uuidv4(), phone: p, username: `user_${Date.now()}`, is_creator: false, is_active: true, wallet_balance: 0, created_at: new Date().toISOString() }).select().single();
      user = created;
    }
    if (!user.is_active) return res.status(403).json({ success: false, message: 'Compte suspendu.' });
    const token = jwt.sign({ userId: user.id, phone: user.phone }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
    await supabaseAdmin.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);
    return res.json({ success: true, message: isNew ? 'Compte créé' : 'Connexion réussie', isNewUser: isNew, token, user: { id: user.id, phone: user.phone, username: user.username, avatar_url: user.avatar_url, is_creator: user.is_creator, wallet_balance: user.wallet_balance } });
  } catch (err) { return res.status(500).json({ success: false, message: 'Erreur interne' }); }
});
router.get('/me', requireAuth, (req, res) => res.json({ success: true, user: req.user }));
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { username, bio, avatar_url } = req.body;
    const u = {};
    if (username) {
      if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) return res.status(400).json({ success: false, message: 'Pseudo invalide (3-30 caractères)' });
      const { data: ex } = await supabaseAdmin.from('users').select('id').eq('username', username).neq('id', req.user.id).single();
      if (ex) return res.status(409).json({ success: false, message: 'Pseudo déjà pris' });
      u.username = username;
    }
    if (bio !== undefined) u.bio = bio?.slice(0, 200);
    if (avatar_url !== undefined) u.avatar_url = avatar_url;
    if (!Object.keys(u).length) return res.status(400).json({ success: false, message: 'Rien à mettre à jour' });
    u.updated_at = new Date().toISOString();
    const { data: updated } = await supabaseAdmin.from('users').update(u).eq('id', req.user.id).select('id,phone,username,bio,avatar_url,is_creator,wallet_balance').single();
    return res.json({ success: true, user: updated });
  } catch { return res.status(500).json({ success: false, message: 'Erreur interne' }); }
});
router.post('/become-creator', requireAuth, async (req, res) => {
  if (req.user.is_creator) return res.status(400).json({ success: false, message: 'Déjà créateur' });
  await supabaseAdmin.from('users').update({ is_creator: true, became_creator_at: new Date().toISOString() }).eq('id', req.user.id);
  return res.json({ success: true, message: 'Félicitations ! Vous êtes maintenant créateur BeninPlay.' });
});
module.exports = router;
