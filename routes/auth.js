'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { sendOTP, normalizeBeninPhone } = require('../services/sms');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const OTP_EXPIRY_MINUTES = 5;
const TEST_OTP = '123456';

/**
 * POST /api/auth/send-otp
 * Envoie un code OTP par SMS
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
        message: 'Numéro de téléphone invalide. Format béninois requis: +229XXXXXXXX',
      });
    }

    // Vérifier le rate limiting: max 3 OTP par heure
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabaseAdmin
      .from('otp_codes')
      .select('*', { count: 'exact', head: true })
      .eq('phone', normalizedPhone)
      .gte('created_at', oneHourAgo);

    if (count >= 3) {
      return res.status(429).json({
        success: false,
        message: 'Trop de tentatives. Réessayez dans une heure.',
      });
    }

    // Générer OTP à 6 chiffres
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

    // Invalider les anciens OTP pour ce numéro
    await supabaseAdmin
      .from('otp_codes')
      .update({ used: true })
      .eq('phone', normalizedPhone)
      .eq('used', false);

    // Stocker le nouvel OTP
    const { error: insertError } = await supabaseAdmin.from('otp_codes').insert({
      id: uuidv4(),
      phone: normalizedPhone,
      code: otp,
      expires_at: expiresAt,
      used: false,
    });

    if (insertError) {
      console.error('[Auth] Erreur insertion OTP:', insertError);
      return res.status(500).json({ success: false, message: 'Erreur interne, réessayez' });
    }

    // Tentative d'envoi SMS (non bloquant si l'envoi échoue)
    const smsResult = await sendOTP(normalizedPhone, otp);
    if (!smsResult.success) {
      console.log('[Auth] SMS non envoyé (service non configuré), code retourné dans la réponse');
    }

    return res.json({
      success: true,
      message: `Code de vérification généré`,
      expiresInMinutes: OTP_EXPIRY_MINUTES,
      otp, // L'app affiche ce code directement à l'utilisateur
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
      return res.status(400).json({ success: false, message: 'Numéro de téléphone et code requis' });
    }

    const normalizedPhone = normalizeBeninPhone(phone);
    if (!normalizedPhone) {
      return res.status(400).json({ success: false, message: 'Numéro de téléphone invalide' });
    }

    const submittedCode = code.toString().trim();

    // Code test universel en développement
    const isTestCode = process.env.NODE_ENV === 'development' && submittedCode === TEST_OTP;

    if (!isTestCode) {
      // Chercher l'OTP valide en base
      const { data: otpRecord, error: otpError } = await supabaseAdmin
        .from('otp_codes')
        .select('*')
        .eq('phone', normalizedPhone)
        .eq('code', submittedCode)
        .eq('used', false)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (otpError || !otpRecord) {
        return res.status(400).json({
          success: false,
          message: 'Code OTP invalide ou expiré',
        });
      }

      // Marquer l'OTP comme utilisé
      await supabaseAdmin
        .from('otp_codes')
        .update({ used: true })
        .eq('id', otpRecord.id);
    }

    // Récupérer ou créer l'utilisateur
    let { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('phone', normalizedPhone)
      .single();

    let isNewUser = false;

    if (!user) {
      // Nouvel utilisateur
      isNewUser = true;
      const newUser = {
        id: uuidv4(),
        phone: normalizedPhone,
        username: `user_${Date.now()}`,
        is_creator: false,
        is_active: true,
        wallet_balance: 0,
        created_at: new Date().toISOString(),
      };

      const { data: createdUser, error: createError } = await supabaseAdmin
        .from('users')
        .insert(newUser)
        .select()
        .single();

      if (createError) {
        console.error('[Auth] Erreur création utilisateur:', createError);
        return res.status(500).json({ success: false, message: 'Erreur lors de la création du compte' });
      }

      user = createdUser;
    } else if (userError) {
      console.error('[Auth] Erreur récupération utilisateur:', userError);
      return res.status(500).json({ success: false, message: 'Erreur interne' });
    }

    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'Compte suspendu. Contactez le support.' });
    }

    // Générer le JWT
    const token = jwt.sign(
      { userId: user.id, phone: user.phone },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // Mettre à jour la date de dernière connexion
    await supabaseAdmin
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', user.id);

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
 * Met à jour le profil utilisateur
 */
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { username, bio, avatar_url } = req.body;
    const updates = {};

    if (username) {
      if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
        return res.status(400).json({
          success: false,
          message: 'Pseudo invalide. 3-30 caractères alphanumériques et underscores uniquement',
        });
      }

      // Vérifier unicité
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
      console.error('[Auth] Erreur mise à jour profil:', error);
      return res.status(500).json({ success: false, message: 'Erreur lors de la mise à jour' });
    }

    return res.json({ success: true, message: 'Profil mis à jour', user: updatedUser });
  } catch (err) {
    console.error('[Auth] profile update erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * GET /api/auth/me
 * Retourne le profil de l'utilisateur connecté
 */
router.get('/me', requireAuth, async (req, res) => {
  return res.json({ success: true, user: req.user });
});

/**
 * POST /api/auth/become-creator
 * Demande de statut créateur
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
      return res.status(500).json({ success: false, message: 'Erreur lors de l\'activation' });
    }

    return res.json({
      success: true,
      message: 'Félicitations ! Vous êtes maintenant créateur sur BeninPlay.',
    });
  } catch (err) {
    console.error('[Auth] become-creator erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

module.exports = router;
