'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');
const { getClientIp, geoFromIp, BENIN_REGIONS } = require('../services/geo');
const { sendVerificationCode } = require('../services/email');
const { notify } = require('../services/notify');

const router = express.Router();

// ── Auth par EMAIL (codes envoyés via Brevo) ─────────────────────────────
const emailOtpStore = new Map(); // email -> { code, expiresAt }
const normalizeEmail = (e) => (e || '').trim().toLowerCase();
const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function normalizeBeninPhone(phone) {
  let cleaned = (phone || '').replace(/[\s\-]/g, '');
  if (/^\+229\d{8}$/.test(cleaned)) return cleaned;
  if (/^229\d{8}$/.test(cleaned)) return `+${cleaned}`;
  if (/^0\d{8}$/.test(cleaned)) return `+229${cleaned.slice(1)}`;
  if (/^\d{8}$/.test(cleaned)) return `+229${cleaned}`;
  return null;
}

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
 * POST /api/auth/email/request — envoie un code de vérification par email
 */
router.post('/email/request', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Adresse email invalide' });
    }
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    // Persistant en base (otp_codes) : robuste aux redémarrages / multi-process
    // d'Azure. La mémoire vive n'est pas partagée entre process → codes perdus.
    await supabaseAdmin.from('otp_codes').delete().eq('phone', email);
    await supabaseAdmin
      .from('otp_codes')
      .insert({ phone: email, code, used: false, expires_at: expiresAt });

    const r = await sendVerificationCode(email, code);
    console.log(`[Auth] code email ${email} = ${code} (envoyé: ${r.sent})`);

    return res.json({
      success: true,
      message: r.sent ? 'Code envoyé par email' : 'Code généré',
      sent: r.sent,
      // Sans Brevo configuré, on renvoie le code pour permettre les tests
      ...(r.sent ? {} : { otp: code }),
    });
  } catch (err) {
    console.error('[Auth] email/request erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * POST /api/auth/email/verify — vérifie le code et retourne un JWT
 */
router.post('/email/verify', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = (req.body.code || '').toString().trim();
    if (!isValidEmail(email) || !code) {
      return res.status(400).json({ success: false, message: 'Email et code requis' });
    }

    // Relecture depuis la base (otp_codes) : fonctionne quel que soit le process
    // Azure qui répond, ou après un redémarrage du serveur.
    const { data: otpRow } = await supabaseAdmin
      .from('otp_codes')
      .select('id')
      .eq('phone', email)
      .eq('code', code)
      .eq('used', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!otpRow) {
      return res.status(400).json({ success: false, message: 'Code invalide ou expiré' });
    }
    await supabaseAdmin.from('otp_codes').update({ used: true }).eq('id', otpRow.id);

    // Un seul compte par email (unique) → un seul compte peut monétiser
    let { data: user } = await supabaseAdmin.from('users').select('*').eq('email', email).single();
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const { data: created, error } = await supabaseAdmin
        .from('users')
        .insert({
          id: uuidv4(),
          email,
          email_verified: true,
          username: `user_${Date.now()}`,
          is_creator: false,
          is_active: true,
          wallet_balance: 0,
          created_at: new Date().toISOString(),
        })
        .select()
        .single();
      if (error) {
        console.error('[Auth] création compte email:', error);
        return res.status(500).json({ success: false, message: 'Erreur création du compte' });
      }
      user = created;
    } else if (!user.email_verified) {
      await supabaseAdmin.from('users').update({ email_verified: true }).eq('id', user.id);
    }

    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'Compte suspendu.' });
    }

    await supabaseAdmin.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // Profil complet = toutes les infos essentielles au ciblage boost
    const profileComplete = Boolean(
      user.full_name && user.birth_year && user.region && user.gender
    );

    return res.json({
      success: true,
      message: isNewUser ? 'Compte créé avec succès' : 'Connexion réussie',
      isNewUser,
      profileComplete,
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar_url: user.avatar_url,
        is_creator: user.is_creator,
        wallet_balance: user.wallet_balance,
      },
    });
  } catch (err) {
    console.error('[Auth] email/verify erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * PUT /api/auth/profile
 */
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { username, bio, avatar_url, region, gender, birthYear, fullName, birthDate } = req.body;
    const updates = {};

    // Nom complet (affiché sur le profil, requis pour un compte sérieux)
    if (fullName !== undefined) {
      const n = (fullName || '').toString().trim();
      if (n && n.length < 2) {
        return res.status(400).json({ success: false, message: 'Nom complet trop court' });
      }
      updates.full_name = n ? n.slice(0, 80) : null;
    }

    // Date de naissance (AAAA-MM-JJ) → déduit aussi birth_year pour le ciblage
    if (birthDate !== undefined && birthDate) {
      const d = new Date(birthDate);
      const y = d.getFullYear();
      if (isNaN(d.getTime()) || y < 1920 || y > new Date().getFullYear()) {
        return res.status(400).json({ success: false, message: 'Date de naissance invalide' });
      }
      const age = Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000));
      if (age < 13) {
        return res.status(400).json({ success: false, message: 'Tu dois avoir au moins 13 ans pour utiliser BeninPlay' });
      }
      updates.birth_date = birthDate;
      updates.birth_year = y;
    }

    // Région déclarée ou détectée par GPS (doit être un des 12 départements)
    if (region !== undefined && region !== null) {
      if (region !== '' && !BENIN_REGIONS.includes(region)) {
        return res.status(400).json({ success: false, message: 'Région invalide' });
      }
      updates.region = region || null;
    }

    // Démographie (pour le ciblage du boost)
    if (gender !== undefined) {
      if (gender && !['homme', 'femme'].includes(gender)) {
        return res.status(400).json({ success: false, message: 'Genre invalide' });
      }
      updates.gender = gender || null;
    }
    if (birthYear !== undefined) {
      const y = parseInt(birthYear, 10);
      if (birthYear && (isNaN(y) || y < 1920 || y > new Date().getFullYear())) {
        return res.status(400).json({ success: false, message: 'Année de naissance invalide' });
      }
      updates.birth_year = birthYear ? y : null;
    }

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

    let { data: updatedUser, error } = await supabaseAdmin
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select('id, phone, username, bio, avatar_url, is_creator, wallet_balance, region, gender, birth_year')
      .single();

    // Compat pré-migration : si full_name / birth_date n'existent pas encore,
    // on réessaie sans ces colonnes (le reste du profil est quand même sauvé).
    if (error && (updates.full_name !== undefined || updates.birth_date !== undefined)) {
      delete updates.full_name;
      delete updates.birth_date;
      if (Object.keys(updates).filter((k) => k !== 'updated_at').length > 0) {
        ({ data: updatedUser, error } = await supabaseAdmin
          .from('users')
          .update(updates)
          .eq('id', req.user.id)
          .select('id, phone, username, bio, avatar_url, is_creator, wallet_balance, region, gender, birth_year')
          .single());
      }
    }

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
  try {
    // Si l'utilisateur n'a pas encore de région, on l'estime via son IP (approximatif)
    if (!req.user.region) {
      const ip = getClientIp(req);
      const geo = await geoFromIp(ip);
      if (geo) {
        // Sauvegarde la région estimée + signale si VPN (hors Bénin)
        if (geo.region) {
          await supabaseAdmin
            .from('users')
            .update({ region: geo.region })
            .eq('id', req.user.id);
          req.user.region = geo.region;
        }
        req.user.geo_country = geo.country;
        req.user.geo_is_vpn = geo.isVpn;
        req.user.region_source = 'ip'; // approximatif
      }
    }
    return res.json({ success: true, user: req.user });
  } catch (_) {
    return res.json({ success: true, user: req.user });
  }
});

// Protection admin par clé secrète
function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: 'Non autorisé' });
  }
  next();
}

/**
 * POST /api/auth/creator/apply
 * Demande à devenir créateur de contenu (monétisation). Validée par l'admin.
 */
router.post('/creator/apply', requireAuth, async (req, res) => {
  try {
    if (req.user.is_creator) {
      return res.status(400).json({ success: false, message: 'Tu es déjà créateur' });
    }
    const note = (req.body?.message || '').toString().slice(0, 500);
    const { error } = await supabaseAdmin
      .from('users')
      .update({
        creator_status: 'pending',
        creator_request_note: note || null,
        creator_requested_at: new Date().toISOString(),
      })
      .eq('id', req.user.id);

    if (error) {
      return res.status(500).json({ success: false, message: `Impossible d'enregistrer la demande : ${error.message}` });
    }
    return res.json({ success: true, message: 'Demande envoyée ✅ Nous l\'examinons sous 24-48 h.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * GET /api/auth/creator/status
 * Statut de la demande créateur de l'utilisateur.
 */
router.get('/creator/status', requireAuth, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('users').select('is_creator, creator_status').eq('id', req.user.id).single();
    const isCreator = data?.is_creator === true;
    return res.json({
      success: true,
      is_creator: isCreator,
      status: data?.creator_status || (isCreator ? 'approved' : 'none'),
    });
  } catch {
    const isCreator = req.user.is_creator === true;
    return res.json({ success: true, is_creator: isCreator, status: isCreator ? 'approved' : 'none' });
  }
});

/**
 * ADMIN : lister / traiter les demandes de créateur
 */
router.get('/creator/requests', requireAdmin, async (req, res) => {
  const { data } = await supabaseAdmin
    .from('users')
    .select('id, username, phone, creator_status, creator_request_note, creator_requested_at')
    .eq('creator_status', 'pending')
    .order('creator_requested_at', { ascending: true })
    .limit(100);
  return res.json({ success: true, count: (data || []).length, requests: data || [] });
});

router.post('/creator/requests/:id/approve', requireAdmin, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ is_creator: true, creator_status: 'approved', became_creator_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ success: false, message: error.message });
  notify(req.params.id, {
    type: 'creator',
    title: 'Tu es créateur ⭐',
    body: 'Ta demande est acceptée. Tu peux maintenant publier et monétiser tes contenus.',
  });
  return res.json({ success: true, message: 'Créateur approuvé ✅' });
});

router.post('/creator/requests/:id/reject', requireAdmin, async (req, res) => {
  await supabaseAdmin.from('users').update({ creator_status: 'rejected' }).eq('id', req.params.id);
  notify(req.params.id, {
    type: 'creator',
    title: 'Demande créateur refusée',
    body: 'Ta demande pour devenir créateur n\'a pas été retenue pour le moment.',
  });
  return res.json({ success: true, message: 'Demande rejetée' });
});

module.exports = router;
