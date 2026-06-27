'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

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

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/payments/initiate
 * Crée un paiement en attente pour un boost ou abonnement
 */
router.post('/initiate', requireAuth, async (req, res) => {
  try {
    const { amount, type, videoId, operator, targetRegion } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ success: false, message: 'Montant invalide (min 100 FCFA)' });
    }
    if (!['mtn', 'moov'].includes(operator)) {
      return res.status(400).json({ success: false, message: 'Opérateur invalide (mtn ou moov)' });
    }

    const paymentNumber = operator === 'mtn' ? MTN_NUMBER : MOOV_NUMBER;
    const reference = `BP${Date.now().toString().slice(-8)}`;

    const { data: payment, error } = await supabaseAdmin
      .from('payments')
      .insert({
        id: uuidv4(),
        user_id: req.user.id,
        video_id: videoId || null,
        amount,
        operator,
        type: type || 'boost',
        status: 'pending',
        reference,
        payment_number: paymentNumber,
        target_region: targetRegion || 'all', // région ciblée du boost

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
      .select('id, status, amount, operator, reference, created_at, confirmed_at, transaction_id')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !payment) {
      return res.status(404).json({ success: false, message: 'Paiement introuvable' });
    }

    return res.json({ success: true, payment });
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

    // Cherche un paiement en attente correspondant au montant
    const { data: payments } = await supabaseAdmin
      .from('payments')
      .select('*')
      .eq('status', 'pending')
      .eq('operator', parsed.operator)
      .eq('amount', parsed.amount)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
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

    // Active le boost si c'est un boost
    if (payment.type === 'boost' && payment.video_id) {
      const days = Math.floor(payment.amount / 500); // 500F = 1 jour de boost
      const boostEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      await supabaseAdmin
        .from('videos')
        .update({
          boosted: true,
          boost_end: boostEnd,
          boost_region: payment.target_region || 'all', // ciblage régional
        })
        .eq('id', payment.video_id);
      console.log('[SMS] Boost activé pour vidéo', payment.video_id,
        '- durée:', days, 'jours - région:', payment.target_region || 'all');
    }

    console.log('[SMS] Paiement', payment.id, 'confirmé !');
    return res.json({ success: true, message: 'Paiement confirmé', paymentId: payment.id });
  } catch (err) {
    console.error('[SMS] Erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

module.exports = router;
