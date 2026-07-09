'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');
const { calculateRevenueSplit } = require('../services/payment');
const { notify } = require('../services/notify');

const router = express.Router();

const MTN_NUMBER = process.env.MTN_NUMBER || '97952522';
const MOOV_NUMBER = process.env.MOOV_NUMBER || '65543131';

// ── Parsers SMS ───────────────────────────────────────────────────────────────

function parseMtnSms(body) {
  // "Transfert 2000F de NOM PRENOM (2290XXXXXXXXX) 2026-06-24 15:00:00 Ref:XXXX Solde:XXXXF ID:XXXXXXXXXXX"
  const amountMatch = body.match(/Transfert\s+([\d\s]+)F\s+de/i);
  const phoneMatch = body.match(/\(?(229\d{9,10})\)?/);
  const idMatch = body.match(/ID:(\d+)/i);
  const refMatch = body.match(/Ref:(\S+)/i);

  if (!amountMatch || !idMatch) return null;

  const amount = parseInt(amountMatch[1].replace(/\s/g, ''), 10);
  return {
    operator: 'mtn',
    amount,
    senderPhone: phoneMatch ? phoneMatch[1] : null,
    transactionId: idMatch[1],
    ref: refMatch ? refMatch[1] : null,
  };
}

function parseMoovSms(body) {
  // "Vous avez reçu X FCFA de 229XXXXXXXXX ... Ref : XXXXXXXXXX"
  const amountMatch = body.match(/reçu\s+(?:un\s+d[eé]p[oô]t\s+de\s+)?([\d\s]+)\s*FCFA/i);
  const phoneMatch = body.match(/de\s+(?:l['']agent\s+\S+\s+)?(229\d{8,10})/i);
  const refMatch = body.match(/R[eé]f\s*:?\s*(\d+)/i);

  if (!amountMatch || !refMatch) return null;

  const amount = parseInt(amountMatch[1].replace(/\s/g, ''), 10);
  return {
    operator: 'moov',
    amount,
    senderPhone: phoneMatch ? phoneMatch[1] : null,
    transactionId: refMatch[1],
    ref: refMatch[1],
  };
}

function parseSms(sender, body) {
  const s = (sender || '').toLowerCase();
  const b = body || '';

  if (s.includes('mtn') || s.includes('momo')) return parseMtnSms(b);
  if (s.includes('moov')) return parseMoovSms(b);

  // Auto-detect par contenu
  if (/Transfert\s+\d+F\s+de/i.test(b)) return parseMtnSms(b);
  if (/reçu.*FCFA/i.test(b)) return parseMoovSms(b);

  return null;
}

// ── Activation du boost (partagée webhook + filet de sécurité) ─────────────────
async function activateBoost(payment) {
  if (!payment || payment.type !== 'boost' || !payment.video_id) return;

  // Idempotence : si ce paiement a déjà été appliqué, on ne refait rien
  if (payment.boost_applied === true) return;

  // Récupère la vidéo pour figer les vues de départ (mesure de la portée gagnée)
  const { data: video } = await supabaseAdmin
    .from('videos')
    .select('id, views, boosted, boost_end')
    .eq('id', payment.video_id)
    .single();

  if (!video) return;

  // Autorise un nouveau boost si l'ancien a expiré ; bloque seulement
  // si un boost est ENCORE actif (évite la double activation simultanée).
  const stillActive = video.boosted && video.boost_end && new Date(video.boost_end).getTime() > Date.now();
  if (stillActive) return;

  const days = payment.boost_days || Math.max(1, Math.floor(payment.amount / 500));
  const now = Date.now();
  const boostEnd = new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
  const regions = (payment.target_regions && payment.target_regions.length > 0)
    ? payment.target_regions
    : [payment.target_region || 'all'];

  await supabaseAdmin
    .from('videos')
    .update({
      boosted: true,
      boost_end: boostEnd,
      boost_region: regions[0] || 'all',
      boost_regions: regions,
      boost_gender: payment.target_gender || 'all',
      boost_age_min: payment.target_age_min || 0,
      boost_age_max: payment.target_age_max || 120,
      boost_amount: payment.amount || 0,
      boost_tags: payment.target_tags || [],
      boost_views_start: video.views || 0,
      boost_started_at: new Date(now).toISOString(),
    })
    .eq('id', payment.video_id);

  // Marque le paiement comme appliqué (idempotence : pas de double activation)
  await supabaseAdmin
    .from('payments')
    .update({ boost_applied: true })
    .eq('id', payment.id);

  console.log('[Boost] Activé vidéo', payment.video_id,
    '-', days, 'j - régions:', regions.join(','),
    '- genre:', payment.target_gender, '- enchère:', payment.amount);
}

// ── Activation d'un abonnement Zone Dark (paiement confirmé) ───────────────────
async function activateDarkSub(payment) {
  if (!payment || payment.type !== 'dark_sub') return;
  if (payment.boost_applied === true) return; // idempotence (on réutilise le drapeau)

  const days = payment.boost_days || 30; // durée de l'abonnement (30/90/365)
  const { data: u } = await supabaseAdmin
    .from('users').select('dark_sub_until').eq('id', payment.user_id).single();

  // Prolonge à partir de la fin actuelle si l'abonnement est encore actif
  const now = Date.now();
  const current = u?.dark_sub_until && new Date(u.dark_sub_until).getTime() > now
    ? new Date(u.dark_sub_until).getTime() : now;
  const until = new Date(current + days * 24 * 60 * 60 * 1000).toISOString();

  await supabaseAdmin.from('users').update({ dark_sub_until: until }).eq('id', payment.user_id);
  await supabaseAdmin.from('payments').update({ boost_applied: true }).eq('id', payment.id);
  console.log('[DarkSub] activé', payment.user_id, '+', days, 'j →', until);
}

// ── Enregistre l'achat d'une vidéo à l'unité (paiement confirmé) ───────────────
async function activatePurchase(payment) {
  if (!payment || payment.type !== 'video' || !payment.video_id) return;
  if (payment.boost_applied === true) return; // idempotence
  await supabaseAdmin.from('video_purchases').upsert(
    {
      video_id: payment.video_id,
      user_id: payment.user_id,
      amount: payment.amount || 0,
      created_at: new Date().toISOString(),
    },
    { onConflict: 'video_id,user_id' }
  );
  await supabaseAdmin.from('payments').update({ boost_applied: true }).eq('id', payment.id);
  console.log('[Purchase] vidéo', payment.video_id, 'achetée par', payment.user_id);

  // Notifie le créateur de la vidéo
  try {
    const { data: v } = await supabaseAdmin
      .from('videos').select('creator_id, title').eq('id', payment.video_id).single();
    if (v && v.creator_id) {
      notify(v.creator_id, {
        type: 'purchase',
        title: 'Vidéo achetée 🎉',
        body: `Ta vidéo « ${v.title || 'sans titre'} » a été achetée (${payment.amount} FCFA)`,
        data: { video_id: payment.video_id, amount: payment.amount },
      });
    }
  } catch (_) { /* best-effort */ }
}

// ── Accès à un live payant (paiement confirmé) + revenu créateur ───────────────
async function activateLivePurchase(payment) {
  if (!payment || payment.type !== 'live' || !payment.live_id) return;
  if (payment.boost_applied === true) return; // idempotence

  // 1) Débloque l'accès du spectateur à ce live
  await supabaseAdmin.from('live_purchases').upsert(
    {
      live_id: payment.live_id,
      user_id: payment.user_id,
      amount: payment.amount || 0,
      created_at: new Date().toISOString(),
    },
    { onConflict: 'live_id,user_id' }
  );

  // 2) Crédite le créateur du live (part nette après commission plateforme)
  try {
    const { data: live } = await supabaseAdmin
      .from('live_streams').select('creator_id').eq('id', payment.live_id).single();
    if (live && live.creator_id) {
      const split = calculateRevenueSplit(payment.amount || 0);
      await supabaseAdmin.rpc('increment_wallet_balance', {
        user_id: live.creator_id, amount: split.creatorGross,
      });
      await supabaseAdmin.from('transactions').insert({
        id: uuidv4(), user_id: live.creator_id, type: 'earning',
        amount: split.creatorGross, net_amount: split.creatorGross, status: 'completed',
        description: `Gain live payant (${payment.amount} FCFA)`,
        metadata: { live_id: payment.live_id, buyer: payment.user_id, gross: payment.amount },
        created_at: new Date().toISOString(), confirmed_at: new Date().toISOString(),
      });
      notify(live.creator_id, {
        type: 'live_purchase',
        title: 'Entrée à ton live payée 💰',
        body: `Un spectateur a payé ${payment.amount} FCFA pour rejoindre ton live (+${split.creatorGross} FCFA)`,
        data: { live_id: payment.live_id, amount: payment.amount, net: split.creatorGross },
      });
    }
  } catch (e) {
    console.error('[LivePurchase] crédit créateur échoué:', e.message);
  }

  await supabaseAdmin.from('payments').update({ boost_applied: true }).eq('id', payment.id);
  console.log('[LivePurchase] live', payment.live_id, 'acheté par', payment.user_id);
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/payments/initiate
 * Crée un paiement en attente pour un boost ou abonnement
 */
router.post('/initiate', requireAuth, async (req, res) => {
  try {
    const {
      amount, type, videoId, liveId, operator,
      targetRegion, targetRegions, targetGender, targetAgeMin, targetAgeMax, boostDays, targetTags,
    } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ success: false, message: 'Montant invalide (min 100 FCFA)' });
    }
    if (!['mtn', 'moov'].includes(operator)) {
      return res.status(400).json({ success: false, message: 'Opérateur invalide (mtn ou moov)' });
    }

    // Pour un boost : vérifie que la vidéo appartient bien à l'utilisateur
    if ((type === 'boost' || !type) && videoId) {
      const { data: vid } = await supabaseAdmin
        .from('videos')
        .select('id, creator_id, status, zone')
        .eq('id', videoId)
        .single();
      if (!vid) {
        return res.status(404).json({ success: false, message: 'Vidéo introuvable' });
      }
      if (vid.creator_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Tu ne peux booster que tes propres vidéos' });
      }
      if (vid.zone === 'dark') {
        return res.status(400).json({ success: false, message: 'Les vidéos de la Zone Dark ne peuvent pas être boostées dans le feed normal' });
      }
    }

    // Normalise le ciblage régions (accepte un seul ou une liste)
    let regions = ['all'];
    if (Array.isArray(targetRegions) && targetRegions.length > 0) {
      regions = targetRegions;
    } else if (targetRegion) {
      regions = [targetRegion];
    }

    const paymentNumber = operator === 'mtn' ? MTN_NUMBER : MOOV_NUMBER;
    const reference = `BP${Date.now().toString().slice(-8)}`;

    // ── Montant unique : on ajoute un petit code (1-99) pour que chaque
    // paiement en attente ait un montant exact distinct → matching SMS sans collision.
    const nowIso = new Date().toISOString();
    const { data: pendings } = await supabaseAdmin
      .from('payments')
      .select('amount')
      .eq('operator', operator)
      .eq('status', 'pending')
      .gte('expires_at', nowIso)
      .gte('amount', amount)
      .lt('amount', amount + 100);
    const used = new Set((pendings || []).map((p) => p.amount));
    let payAmount = amount;
    for (let off = 0; off <= 99; off++) {
      if (!used.has(amount + off)) { payAmount = amount + off; break; }
    }

    const { data: payment, error } = await supabaseAdmin
      .from('payments')
      .insert({
        id: uuidv4(),
        user_id: req.user.id,
        video_id: videoId || null,
        live_id: (type === 'live') ? (liveId || null) : null,
        amount: payAmount,         // montant exact à payer (unique)
        operator,
        type: type || 'boost',
        status: 'pending',
        reference,
        payment_number: paymentNumber,
        // Ciblage complet du boost
        target_region: regions[0] || 'all',
        target_regions: regions,
        target_gender: targetGender || 'all',
        target_age_min: parseInt(targetAgeMin, 10) || 0,
        target_age_max: parseInt(targetAgeMax, 10) || 120,
        target_tags: Array.isArray(targetTags)
          ? targetTags.map((t) => t.toString().toLowerCase()).slice(0, 10)
          : [],
        boost_days: parseInt(boostDays, 10) || Math.max(1, Math.floor(amount / 500)),
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min
      })
      .select()
      .single();

    if (error) {
      console.error('[Payments] initiate error:', error);
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.json({
      success: true,
      payment: {
        id: payment.id,
        reference,
        amount,
        operator,
        paymentNumber,
        instructions: operator === 'mtn'
          ? `Envoyez ${amount} FCFA au ${MTN_NUMBER} via MTN MoMo`
          : `Envoyez ${amount} FCFA au ${MOOV_NUMBER} via Moov Money`,
        expiresAt: payment.expires_at,
      },
    });
  } catch (err) {
    console.error('[Payments] initiate erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * GET /api/payments/status/:id
 * Vérifie le statut d'un paiement
 */
router.get('/status/:id', requireAuth, async (req, res) => {
  try {
    const { data: payment, error } = await supabaseAdmin
      .from('payments')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !payment) {
      return res.status(404).json({ success: false, message: 'Paiement introuvable' });
    }

    // Filet de sécurité : si le paiement est confirmé mais que la prestation
    // n'a pas été appliquée (ex: webhook raté), on l'applique ici.
    if (payment.status === 'confirmed' && payment.type === 'boost' && payment.video_id) {
      try { await activateBoost(payment); } catch (_) {}
    } else if (payment.status === 'confirmed' && payment.type === 'dark_sub') {
      try { await activateDarkSub(payment); } catch (_) {}
    } else if (payment.status === 'confirmed' && payment.type === 'video') {
      try { await activatePurchase(payment); } catch (_) {}
    } else if (payment.status === 'confirmed' && payment.type === 'live') {
      try { await activateLivePurchase(payment); } catch (_) {}
    }

    return res.json({
      success: true,
      payment: {
        id: payment.id, status: payment.status, amount: payment.amount,
        operator: payment.operator, reference: payment.reference,
        created_at: payment.created_at, confirmed_at: payment.confirmed_at,
        transaction_id: payment.transaction_id,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * POST /api/payments/sms
 * Reçoit les SMS forwardés depuis le téléphone marchand
 * Sécurisé par secret webhook
 */
router.post('/sms', async (req, res) => {
  try {
    // Accepte le secret dans le header OU dans l'URL (?secret=...)
    const secret = req.headers['x-webhook-secret'] || req.query.secret;
    if (secret !== process.env.SMS_WEBHOOK_SECRET) {
      console.log('[SMS] Secret invalide:', secret);
      return res.status(401).json({ success: false, message: 'Non autorisé' });
    }

    // Compatible SMS Forwarder (from/text), SMSSync (from/message), format custom (sender/body)
    const sender = req.body.from || req.body.sender || req.body.originator || '';
    const body   = req.body.text || req.body.message || req.body.body || req.body.smsBody || '';
    console.log('[SMS] Reçu de:', sender, '| Corps:', body);

    const parsed = parseSms(sender, body);
    if (!parsed) {
      console.log('[SMS] Format non reconnu, ignoré');
      return res.json({ success: true, message: 'SMS ignoré (format non reconnu)' });
    }

    console.log('[SMS] Parsé:', parsed);

    // Anti-rejeu : si cette transaction MoMo a déjà été enregistrée, on ignore
    if (parsed.transactionId) {
      const { data: existing } = await supabaseAdmin
        .from('payments')
        .select('id')
        .eq('transaction_id', parsed.transactionId)
        .limit(1);
      if (existing && existing.length > 0) {
        console.log('[SMS] Transaction déjà traitée:', parsed.transactionId);
        return res.json({ success: true, message: 'Déjà traité' });
      }
    }

    // Cherche un paiement en attente correspondant au montant
    const { data: payments } = await supabaseAdmin
      .from('payments')
      .select('*')
      .eq('status', 'pending')
      .eq('operator', parsed.operator)
      .eq('amount', parsed.amount)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: true }) // le plus ancien d'abord (FIFO, plus juste)
      .limit(5);

    if (!payments || payments.length === 0) {
      console.log('[SMS] Aucun paiement en attente trouvé pour', parsed.amount, 'F');
      return res.json({ success: true, message: 'Aucun paiement correspondant' });
    }

    // Prend le paiement le plus récent correspondant
    const payment = payments[0];

    // Confirme le paiement
    await supabaseAdmin
      .from('payments')
      .update({
        status: 'confirmed',
        transaction_id: parsed.transactionId,
        sender_phone: parsed.senderPhone,
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', payment.id);

    // Active la prestation selon le type
    if (payment.type === 'boost' && payment.video_id) {
      await activateBoost(payment);
    } else if (payment.type === 'dark_sub') {
      await activateDarkSub(payment);
    } else if (payment.type === 'video') {
      await activatePurchase(payment);
    } else if (payment.type === 'live') {
      await activateLivePurchase(payment);
    }

    console.log('[SMS] Paiement', payment.id, 'confirmé !');
    return res.json({ success: true, message: 'Paiement confirmé', paymentId: payment.id });
  } catch (err) {
    console.error('[SMS] Erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

module.exports = router;
