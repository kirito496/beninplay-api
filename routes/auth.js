'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { normalizeBeninPhone } = require('../services/sms');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Stockage temporaire des OTP en mémoire (évite la dépendance à la table otp_codes)
const otpStore = new Map(); // phone -> { code, expiresAt }

/**
 * POST /api/auth/send-otp
 * Génère un code OTP et le retourne dans la réponse (l'app l'affiche)
 */
router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, message: 'Numéro de téléphone requis' });
    }

    const normalizedPhone = normalizeBeninPhone(phone);
    if (!normalizedPhone) {
      return res.status(400).json({
        success: false,
        message: 'Numéro invalide. Format béninois requis (ex: 97XXXXXX)',
      });
    }

    // Générer OTP à 6 chiffres
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Stocker en mémoire
    otpStore.set(normalizedPhone, { code: otp, expiresAt });

    console.log(`[Auth] OTP généré pour ${normalizedPhone}: ${otp}`);

    return res.json({
      success: true,
      message: 'Code de vérification généré',
      expiresInMinutes: 10,
      otp, // Retourné directement pour que l'app l'affiche
    });
  } catch (err) {
    console.error('[Auth] send-otp erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * POST /api/auth/verify-otp
 * Vérifie le code OTP et retourne un JWT
 */
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({ success: false, message: 'Numéro et code requis' });
    }

    const normalizedPhone = normalizeBeninPhone(phone);
    if (!normalizedPhone) {
      return res.status(400).json({ success: false, message: 'Numéro invalide' });
    }

    const submittedCode = code.toString().trim();

    // Vérifier l'OTP en mémoire
    const stored = otpStore.get(normalizedPhone);
    const isValid = stored && stored.code === submittedCode && Date.now() < stored.expiresAt;

    if (!isValid) {
      return res.status(400).json({ success: false, message: 'Code invalide ou expiré' });
    }

    // Supprimer l'OTP utilisé
    otpStore.delete(normalizedPhone);

    // Récupérer ou créer l'utilisateur
    let { data: user } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('phone', normalizedPhone)
      .single();

    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const { data: createdUser, error: createError } = await supabaseAdmin
        .from('users')
        .insert({
          id: uuidv4(),
          phone: normalizedPhone,
          username: `user_${Date.now()}`,
          is_creator: false,
          is_active: true,
          wallet_balance: 0,
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (createError) {
        console.error('[Auth] Erreur création utilisateur:', createError);
        return res.status(500).json({ success: false, message: 'Erreur création du compte' });
      }
      user = createdUser;
    }

    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'Compte suspendu.' });
    }

    // Mettre à jour last_login
    await supabaseAdmin
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', user.id);

    // Générer le JWT
    const token = jwt.sign(
      { userId: user.id, phone: user.phone },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    return res.json({
      success: true,
      message: isNewUser ? 'Compte créé avec succès' : 'Connexion réussie',
      isNewUser,
      token,
      user: {
        id: user.id,
        phone: user.phone,
        username: user.username,
        avatar_url: user.avatar_url,
        is_creator: user.is_creator,
        wallet_balance: user.wallet_balance,
      },
    });
  } catch (err) {
    console.error('[Auth] verify-otp erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * PUT /api/auth/profile
 */
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { username, bio, avatar_url } = req.body;
    const updates = {};

    if (username) {
      if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
        return res.status(400).json({
          success: false,
          message: 'Pseudo invalide. 3-30 caractères alphanumériques et underscores',
        });
      }
      const { data: existing } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('username', username)
        .neq('id', req.user.id)
        .single();

      if (existing) {
        return res.status(409).json({ success: false, message: 'Ce pseudo est déjà pris' });
      }
      updates.username = username;
    }

    if (bio !== undefined) updates.bio = bio?.slice(0, 200);
    if (avatar_url !== undefined) updates.avatar_url = avatar_url;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'Aucune donnée à mettre à jour' });
    }

    updates.updated_at = new Date().toISOString();

    const { data: updatedUser, error } = await supabaseAdmin
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select('id, phone, username, bio, avatar_url, is_creator, wallet_balance')
      .single();

    if (error) {
      return res.status(500).json({ success: false, message: 'Erreur mise à jour' });
    }

    return res.json({ success: true, message: 'Profil mis à jour', user: updatedUser });
  } catch (err) {
    console.error('[Auth] profile erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * GET /api/auth/me
 */
router.get('/me', requireAuth, async (req, res) => {
  return res.json({ success: true, user: req.user });
});

/**
 * POST /api/auth/become-creator
 */
router.post('/become-creator', requireAuth, async (req, res) => {
  try {
    if (req.user.is_creator) {
      return res.status(400).json({ success: false, message: 'Vous êtes déjà créateur' });
    }

    const { error } = await supabaseAdmin
      .from('users')
      .update({ is_creator: true, became_creator_at: new Date().toISOString() })
      .eq('id', req.user.id);

    if (error) {
      return res.status(500).json({ success: false, message: 'Erreur activation' });
    }

    return res.json({ success: true, message: 'Félicitations ! Vous êtes maintenant créateur.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

module.exports = router;
