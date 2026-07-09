'use strict';

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Bucket PRIVÉ dédié aux pièces d'identité (jamais public).
const KYC_BUCKET = process.env.SUPABASE_KYC_BUCKET || 'kyc';

// Upload en mémoire puis vers Supabase Storage (2 photos max, 10 Mo chacune).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    if (ok.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Photo invalide. Utilise JPEG, PNG ou WebP.'));
  },
});

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: 'Non autorisé' });
  }
  next();
}

// Crée le bucket privé au premier usage (idempotent).
let kycBucketReady = false;
async function ensureKycBucket() {
  if (kycBucketReady) return;
  try {
    await supabaseAdmin.storage.createBucket(KYC_BUCKET, { public: false });
  } catch (_) { /* existe déjà : on ignore */ }
  kycBucketReady = true;
}

// Envoie une photo de pièce dans le bucket privé, renvoie son chemin de stockage.
async function uploadKycImage(userId, file, side) {
  await ensureKycBucket();
  const ext = (file.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `${userId}/${side}_${uuidv4()}.${ext}`;
  const { error } = await supabaseAdmin.storage
    .from(KYC_BUCKET)
    .upload(path, file.buffer, { contentType: file.mimetype, upsert: true });
  if (error) throw error;
  return path;
}

// Transforme un chemin de stockage privé en URL signée temporaire (pour l'admin).
async function signKyc(pathOrUrl) {
  if (!pathOrUrl) return null;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl; // ancienne donnée déjà en URL
  try {
    const { data } = await supabaseAdmin.storage
      .from(KYC_BUCKET)
      .createSignedUrl(pathOrUrl, 60 * 30); // valable 30 minutes
    return data?.signedUrl || null;
  } catch (_) {
    return null;
  }
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
 * multipart: front (fichier), back (fichier optionnel)
 * Compat : accepte aussi { front_url, back_url } en JSON.
 */
router.post(
  '/kyc/submit',
  requireAuth,
  upload.fields([{ name: 'front', maxCount: 1 }, { name: 'back', maxCount: 1 }]),
  async (req, res) => {
    try {
      const update = { kyc_status: 'pending', kyc_submitted_at: new Date().toISOString() };
      const files = req.files || {};

      // 1) Voie principale : fichiers uploadés → bucket privé
      if (files.front && files.front[0]) {
        update.kyc_front_url = await uploadKycImage(req.user.id, files.front[0], 'front');
      }
      if (files.back && files.back[0]) {
        update.kyc_back_url = await uploadKycImage(req.user.id, files.back[0], 'back');
      }

      // 2) Compat : URLs déjà fournies (anciens clients)
      if (!update.kyc_front_url && req.body && req.body.front_url) {
        update.kyc_front_url = String(req.body.front_url).slice(0, 500);
      }
      if (!update.kyc_back_url && req.body && req.body.back_url) {
        update.kyc_back_url = String(req.body.back_url).slice(0, 500);
      }

      if (!update.kyc_front_url) {
        return res.status(400).json({ success: false, message: 'Photo recto de la pièce requise.' });
      }

      const { error } = await supabaseAdmin.from('users').update(update).eq('id', req.user.id);
      if (error) return res.status(500).json({ success: false, message: error.message });
      return res.json({ success: true, message: 'Vérification envoyée ✅ Validation sous 24-48 h.' });
    } catch (err) {
      console.error('[KYC] submit erreur:', err.message);
      return res.status(500).json({ success: false, message: "Erreur lors de l'envoi des photos." });
    }
  }
);

// ── ADMIN : vérification KYC ────────────────────────────────────────────
router.get('/kyc/pending', requireAdmin, async (req, res) => {
  const { data } = await supabaseAdmin
    .from('users')
    .select('id, username, phone, email, kyc_status, kyc_front_url, kyc_back_url, kyc_submitted_at')
    .eq('kyc_status', 'pending')
    .order('kyc_submitted_at', { ascending: true })
    .limit(100);

  // Génère des URLs signées temporaires pour voir les photos (bucket privé)
  const pending = [];
  for (const u of data || []) {
    pending.push({
      ...u,
      kyc_front_url: await signKyc(u.kyc_front_url),
      kyc_back_url: await signKyc(u.kyc_back_url),
    });
  }
  return res.json({ success: true, count: pending.length, pending });
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
