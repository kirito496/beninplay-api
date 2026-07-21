'use strict';

// ── Fonds créateur : paie les créateurs pour les VUES et les LIKES ──────────
//
// Utilise le portefeuille existant (users.wallet_balance + RPC
// increment_wallet_balance + table transactions). AUCUNE migration SQL requise.
//
// Réglages (variables d'environnement Azure, facultatives) :
//   CREATOR_FUND_ENABLED  = "true" (défaut) | "false"
//   CREATOR_RPM           = FCFA pour 1000 vues   (défaut 100)
//   CREATOR_PER_LIKE      = FCFA par like          (défaut 1)
//
// ⚠️ C'est un « fonds créateur » : cet argent sort de ta trésorerie. Finance-le
// avec les revenus pub/boost. Baisse les taux si besoin (ou mets ENABLED=false).

const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('./supabase');

const ENABLED = process.env.CREATOR_FUND_ENABLED !== 'false';
const RPM = Math.max(0, parseInt(process.env.CREATOR_RPM || '100', 10)); // FCFA / 1000 vues
const PER_LIKE = Math.max(0, parseInt(process.env.CREATOR_PER_LIKE || '1', 10)); // FCFA / like
// Nombre de vues pour gagner 1 FCFA (ex: RPM 100 → 1 FCFA toutes les 10 vues).
const VIEWS_PER_FCFA = RPM > 0 ? Math.max(1, Math.round(1000 / RPM)) : 0;

async function _credit(userId, amount, description) {
  if (!userId || amount <= 0) return;
  // Crédit du solde (RPC, avec repli lecture/écriture).
  const { error } = await supabaseAdmin.rpc('increment_wallet_balance', {
    user_id: userId,
    amount,
  });
  if (error) {
    const { data: u } = await supabaseAdmin
      .from('users').select('wallet_balance').eq('id', userId).single();
    if (u) {
      await supabaseAdmin.from('users')
        .update({ wallet_balance: (u.wallet_balance || 0) + amount }).eq('id', userId);
    }
  }
  // Trace comptable (best-effort, non bloquant).
  supabaseAdmin.from('transactions').insert({
    id: uuidv4(),
    user_id: userId,
    type: 'earning',
    amount,
    net_amount: amount,
    status: 'completed',
    description,
    created_at: new Date().toISOString(),
  }).then(() => {}, () => {});
}

/** Appelé à chaque NOUVELLE vue unique. `newViews` = compteur de vues après incrément. */
async function onView({ creatorId, viewerId, newViews }) {
  try {
    if (!ENABLED || VIEWS_PER_FCFA === 0) return;
    if (!creatorId || creatorId === viewerId) return; // pas payé pour ses propres vues
    if (newViews > 0 && newViews % VIEWS_PER_FCFA === 0) {
      await _credit(creatorId, 1, `Gains vues (${RPM} FCFA / 1000 vues)`);
    }
  } catch (_) { /* jamais bloquant */ }
}

/** Appelé quand un spectateur AIME (nouveau like). */
async function onLike({ creatorId, likerId }) {
  try {
    if (!ENABLED || PER_LIKE <= 0) return;
    if (!creatorId || creatorId === likerId) return;
    await _credit(creatorId, PER_LIKE, 'Gains like');
  } catch (_) { /* jamais bloquant */ }
}

const rate = { ENABLED, RPM, PER_LIKE, VIEWS_PER_FCFA };

module.exports = { onView, onLike, rate };
