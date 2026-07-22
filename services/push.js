'use strict';

/**
 * Notifications push (Firebase Cloud Messaging — API HTTP v1).
 *
 * Best-effort : si FCM n'est pas configuré (variable d'env absente) ou en cas
 * d'erreur, on ne bloque JAMAIS le flux appelant — on ignore silencieusement.
 *
 * Configuration (une seule variable, sur Azure App Service → Configuration) :
 *   FCM_SERVICE_ACCOUNT = le contenu JSON du compte de service Firebase
 *     (Console Firebase → Paramètres du projet → Comptes de service →
 *      « Générer une nouvelle clé privée »). Colle tout le JSON comme valeur.
 *
 * Aucune dépendance externe : le jeton OAuth2 Google est signé localement
 * (RS256) avec le module `crypto` natif, puis mis en cache jusqu'à expiration.
 */

const crypto = require('crypto');
const { supabaseAdmin } = require('./supabase');

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

let _sa = null; // compte de service parsé (client_email, private_key, project_id)
let _saParsed = false;
let _token = null; // { value, exp } — jeton d'accès en cache

function serviceAccount() {
  if (_saParsed) return _sa;
  _saParsed = true;
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    _sa = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!_sa.client_email || !_sa.private_key || !_sa.project_id) _sa = null;
  } catch (e) {
    console.error('[Push] FCM_SERVICE_ACCOUNT invalide (JSON) — push désactivé.');
    _sa = null;
  }
  return _sa;
}

function isConfigured() {
  return serviceAccount() != null;
}

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Récupère (et met en cache) un jeton d'accès OAuth2 pour FCM. */
async function accessToken() {
  const sa = serviceAccount();
  if (!sa) return null;
  const now = Math.floor(Date.now() / 1000);
  if (_token && _token.exp - 60 > now) return _token.value; // encore valide

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URI,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key);
  const jwt = `${unsigned}.${base64url(signature)}`;

  const res = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    console.error('[Push] échec OAuth Google:', res.status);
    return null;
  }
  const json = await res.json();
  _token = { value: json.access_token, exp: now + (json.expires_in || 3600) };
  return _token.value;
}

/**
 * Envoie une notification push à un utilisateur et RENVOIE le résultat détaillé
 * (utile pour l'auto-test). Codes `reason` : not_configured | no_token |
 * no_access | fcm_error | ok.
 * @param {string} userId  destinataire
 * @param {object} msg     { title, body?, data? }
 * @returns {Promise<{ok: boolean, reason: string, status?: number, detail?: string}>}
 */
async function sendPushResult(userId, msg) {
  try {
    if (!userId || !msg || !msg.title) return { ok: false, reason: 'bad_request' };
    if (!isConfigured()) return { ok: false, reason: 'not_configured' };

    const { data: user } = await supabaseAdmin
      .from('users').select('fcm_token').eq('id', userId).single();
    const token = user && user.fcm_token;
    if (!token) return { ok: false, reason: 'no_token' };

    const access = await accessToken();
    if (!access) return { ok: false, reason: 'no_access' };

    const sa = serviceAccount();
    const data = {};
    for (const [k, v] of Object.entries(msg.data || {})) data[k] = String(v);

    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: msg.title, body: msg.body || '' },
            data,
            android: { priority: 'high', notification: { sound: 'default' } },
          },
        }),
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Jeton périmé/invalide → on le nettoie pour ne plus réessayer.
      if (res.status === 404 || res.status === 400) {
        try { await supabaseAdmin.from('users').update({ fcm_token: null }).eq('id', userId); } catch (_) {}
      }
      console.error('[Push] envoi échoué:', res.status, detail.slice(0, 120));
      return { ok: false, reason: 'fcm_error', status: res.status, detail: detail.slice(0, 200) };
    }
    return { ok: true, reason: 'ok' };
  } catch (err) {
    console.error('[Push] erreur (ignorée):', err.message);
    return { ok: false, reason: 'exception', detail: err.message };
  }
}

/**
 * Envoie une notification push (best-effort, sans valeur de retour).
 * @param {string} userId  destinataire
 * @param {object} msg     { title, body?, data? }
 */
async function sendPush(userId, msg) {
  await sendPushResult(userId, msg).catch(() => {});
}

module.exports = { sendPush, sendPushResult, isConfigured };
