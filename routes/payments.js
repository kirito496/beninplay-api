'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const MTN_NUMBER = process.env.MTN_NUMBER || '97952522';
const MOOV_NUMBER = process.env.MOOV_NUMBER || '65543131';

function parseMtnSms(body) {
  const amountMatch = body.match(/Transfert\s+([\d\s]+)F\s+de/i);
  const phoneMatch = body.match(/\(?(229\d{9,10})\)?/);
  const idMatch = body.match(/ID:(\d+)/i);
  const refMatch = body.match(/Ref:(\S+)/i);
  if (!amountMatch || !idMatch) return null;
  return {
    operator: 'mtn',
    amount: parseInt(amountMatch[1].replace(/\s/g, ''), 10),
    senderPhone: phoneMatch ? phoneMatch[1] : null,
    transactionId: idMatch[1],
    ref: refMatch ? refMatch[1] : null,
  };
}

function parseMoovSms(body) {
  const amountMatch = body.match(/reçu\s+(?:un\s+d[eé]p[oô]t\s+de\s+)?([\d\s]+)\s*FCFA/i);
  const phoneMatch = body.match(/de\s+(?:l['']agent\s+\S+\s+)?(229\d{8,10})/i);
  const refMatch = body.match(/R[eé]f\s*:?\s*(\d+)/i);
  if (!amountMatch || !refMatch) return null;
  return {
    operator: 'moov',
    amount: parseInt(amountMatch[1].replace(/\s/g, ''), 10),
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
  if (/Transfert\s+\d+F\s+de/i.test(b)) return parseMtnSms(b);
  if (/reçu.*FCFA/i.test(b)) return parseMoovSms(b);
  return null;
}

router.post('/initiate', requireAuth, async (req, res) => {
  try {
    const { amount, type, videoId, operator } = req.body;
    if (!amount || amount < 100) return res.status(400).json({ success: false, message: 'Montant invalide (min 100 FCFA)' });
    if (!['mtn', 'moov'].includes(operator)) return res.status(400).json({ success: false, message: 'Opérateur invalide' });

    const paymentNumber = operator === 'mtn' ? MTN_NUMBER : MOOV_NUMBER;
    const reference = `BP${Date.now().toString().slice(-8)}`;

    const { data: payment, error } = await supabaseAdmin
      .from('payments')
      .insert({
        id: uuidv4(),
        user_id: req.user.id,
        video_id: videoId || null,
        amount, operator,
        type: type || 'boost',
        status: 'pending',
        reference, payment_number: paymentNumber,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      })
      .select().single();

    if (error) return res.status(500).json({ success: false, message: error.message });

    return res.json({
      success: true,
      payment: {
        id: payment.id, reference, amount, operator, paymentNumber,
        instructions: operator === 'mtn'
          ? `Envoyez ${amount} FCFA au ${MTN_NUMBER} via MTN MoMo`
          : `Envoyez ${amount} FCFA au ${MOOV_NUMBER} via Moov Money`,
        expiresAt: payment.expires_at,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

router.get('/status/:id', requireAuth, async (req, res) => {
  try {
    const { data: payment, error } = await supabaseAdmin
      .from('payments')
      .select('id, status, amount, operator, reference, created_at, confirmed_at, transaction_id')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();
    if (error || !payment) return res.status(404).json({ success: false, message: 'Paiement introuvable' });
    return res.json({ success: true, payment });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

router.post('/sms', async (req, res) => {
  try {
    const secret = req.headers['x-webhook-secret'];
    if (secret !== process.env.SMS_WEBHOOK_SECRET) return res.status(401).json({ success: false, message: 'Non autorisé' });

    const { sender, body } = req.body;
    console.log('[SMS] Reçu de:', sender, '| Corps:', body);

    const parsed = parseSms(sender, body);
    if (!parsed) return res.json({ success: true, message: 'SMS ignoré' });

    const { data: payments } = await supabaseAdmin
      .from('payments')
      .select('*')
      .eq('status', 'pending')
      .eq('operator', parsed.operator)
      .eq('amount', parsed.amount)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(5);

    if (!payments || payments.length === 0) return res.json({ success: true, message: 'Aucun paiement correspondant' });

    const payment = payments[0];
    await supabaseAdmin.from('payments').update({
      status: 'confirmed',
      transaction_id: parsed.transactionId,
      sender_phone: parsed.senderPhone,
      confirmed_at: new Date().toISOString(),
    }).eq('id', payment.id);

    if (payment.type === 'boost' && payment.video_id) {
      const days = Math.floor(payment.amount / 500);
      const boostEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      await supabaseAdmin.from('videos').update({ boosted: true, boost_end: boostEnd }).eq('id', payment.video_id);
    }

    console.log('[SMS] Paiement', payment.id, 'confirmé !');
    return res.json({ success: true, message: 'Paiement confirmé', paymentId: payment.id });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

module.exports = router;