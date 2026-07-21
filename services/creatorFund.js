'use strict';

// ── Fonds créateur : paie les créateurs pour les VUES et les LIKES ──────────
//
// Montants FRACTIONNAIRES (ex: 0,75 FCFA / like). On accumule les centimes
// dans users.pending_earnings et on ne déplace QUE des FCFA entiers vers
// wallet_balance (fonction SQL atomique add_creator_earning). Le reste est
// gardé pour la prochaine fois → aucun centime perdu, aucun sur-paiement.
//
// Réglages (variables d'environnement Azure, facultatives) :
//   CREATOR_FUND_ENABLED = "true" (défaut) | "false"
//   CREATOR_PER_LIKE     = FCFA par like   (défaut 0.75  ← ton prix max)
//   CREATOR_PER_VIEW     = FCFA par vue    (défaut 0.05)
//
// ⚠️ Cet argent sort de ta trésorerie : finance-le avec les revenus pub/boost.
// Nécessite la migration database/creator_fund.sql (colonne + fonction).

const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('./supabase');

const ENABLED = process.env.CREATOR_FUND_ENABLED !== 'false';
const PER_LIKE = Math.max(0, parseFloat(process.env.CREATOR_PER_LIKE || '0.75'));
const PER_VIEW = Math.max(0, parseFloat(process.env.CREATOR_PER_VIEW || '0.05'));

async function _credit(userId, amount, description) {
  if (!userId || amount <= 0) return;
  try {
    // Accumule le montant fractionnaire ; renvoie les FCFA ENTIERS versés au
    // portefeuille (0 si on n'a pas encore atteint 1 FCFA).
    const { data: flushed, error } = await supabaseAdmin.rpc('add_creator_earning', {
      p_user: userId,
      p_amount: amount,
    });
    if (error) {
      // Repli (migration pas encore exécutée) : on ne verse que les montants
      // ≥ 1 FCFA pour ne rien sur-payer ; les fractions attendront la migration.
      if (amount >= 1) {
        await supabaseAdmin.rpc('increment_wallet_balance', {
          user_id: userId,
          amount: Math.floor(amount),
        }).then(() => {}, () => {});
      }
      return;
    }
    const whole = typeof flushed === 'number' ? flushed : parseInt(flushed || '0', 10);
    if (whole > 0) {
      // Une trace comptable par FCFA entier versé (pas par centime) → peu de lignes.
      supabaseAdmin.from('transactions').insert({
        id: uuidv4(),
        user_id: userId,
        type: 'earning',
        amount: whole,
        net_amount: whole,
        status: 'completed',
        description,
        created_at: new Date().toISOString(),
      }).then(() => {}, () => {});
    }
  } catch (_) { /* jamais bloquant */ }
}

/** Appelé à chaque NOUVELLE vue unique. */
async function onView({ creatorId, viewerId }) {
  if (!ENABLED || PER_VIEW <= 0) return;
  if (!creatorId || creatorId === viewerId) return; // pas payé pour ses propres vues
  await _credit(creatorId, PER_VIEW, 'Gains vues');
}

/** Appelé quand un spectateur AIME (nouveau like). */
async function onLike({ creatorId, likerId }) {
  if (!ENABLED || PER_LIKE <= 0) return;
  if (!creatorId || creatorId === likerId) return;
  await _credit(creatorId, PER_LIKE, 'Gains likes');
}

const rate = { ENABLED, PER_LIKE, PER_VIEW };

module.exports = { onView, onLike, rate };
