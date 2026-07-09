'use strict';

const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('./supabase');

/**
 * Crée une notification pour un utilisateur (best-effort : n'interrompt jamais
 * le flux appelant si la table n'existe pas encore ou en cas d'erreur).
 *
 * @param {string} userId  destinataire
 * @param {object} n       { type, title, body?, data?, actorId? }
 */
async function notify(userId, n) {
  if (!userId || !n || !n.type || !n.title) return;
  try {
    await supabaseAdmin.from('notifications').insert({
      id: uuidv4(),
      user_id: userId,
      type: String(n.type).slice(0, 30),
      title: String(n.title).slice(0, 200),
      body: n.body ? String(n.body).slice(0, 500) : null,
      data: n.data || {},
      actor_id: n.actorId || null,
      read: false,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Notify] échec (ignoré):', err.message);
  }
}

module.exports = { notify };
