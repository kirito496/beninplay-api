'use strict';

// Génération des jetons Agora (RTC) pour le Live.
// AGORA_APP_ID = public ; AGORA_APP_CERTIFICATE = secret (variables Railway).
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

const APP_ID = process.env.AGORA_APP_ID || '';
const APP_CERT = process.env.AGORA_APP_CERTIFICATE || '';
const TOKEN_TTL = 3600; // 1 heure

function isConfigured() {
  return Boolean(APP_ID && APP_CERT);
}

/**
 * Construit un jeton RTC pour un canal.
 * @param {string} channel - nom du canal
 * @param {boolean} isHost - true = diffuseur (publisher), false = spectateur
 * @param {number} uid - 0 = valable pour n'importe quel uid attribué par Agora
 */
function buildRtcToken(channel, isHost, uid = 0) {
  if (!isConfigured()) return null;
  const role = isHost ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
  const expireTs = Math.floor(Date.now() / 1000) + TOKEN_TTL;
  return RtcTokenBuilder.buildTokenWithUid(APP_ID, APP_CERT, channel, uid, role, expireTs);
}

module.exports = { buildRtcToken, isConfigured, APP_ID };
