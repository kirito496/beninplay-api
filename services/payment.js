'use strict';

// Paiement 100% gratuit — sans prestataire externe.
// - Les BOOSTS sont encaissés via le système MoMo manuel + SMS (routes/payments.js).
// - Les RETRAITS créateurs sont traités manuellement par l'admin
//   (voir routes/wallet.js : la demande est enregistrée, l'admin envoie le MoMo
//    depuis son téléphone puis marque le retrait comme payé).
//
// Ce module ne garde que le calcul de la répartition des revenus.

const MIN_WITHDRAWAL = parseInt(process.env.MIN_WITHDRAWAL || '500', 10);
const COMMISSION = parseFloat(process.env.PLATFORM_COMMISSION || '0.20');
const MOMO_FEE = parseFloat(process.env.MOMO_FEE_RATE || '0.015');
const TVA = parseFloat(process.env.TVA_RATE || '0.18');

/**
 * Répartit un montant brut entre la plateforme et le créateur.
 * @param {number} gross - montant demandé au retrait (FCFA)
 */
function calculateRevenueSplit(gross) {
  const platformShare = Math.floor(gross * COMMISSION);
  const creatorGross = gross - platformShare;
  const momoFee = Math.ceil(creatorGross * MOMO_FEE);
  return {
    grossAmount: gross,
    platformShare,
    creatorGross,
    creatorNet: creatorGross - momoFee,
    momoFee,
    tva: Math.floor(platformShare * TVA),
  };
}

module.exports = { calculateRevenueSplit, MIN_WITHDRAWAL };
