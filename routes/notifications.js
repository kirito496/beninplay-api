'use strict';

const express = require('express');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/notifications — mes notifications + nombre de non-lues
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('notifications')
      .select('id, type, title, body, data, read, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(100);

    const list = data || [];
    const unread = list.filter((n) => !n.read).length;
    return res.json({ success: true, unread, notifications: list });
  } catch (err) {
    // Table absente (avant migration) → liste vide plutôt qu'une erreur
    return res.json({ success: true, unread: 0, notifications: [] });
  }
});

/**
 * GET /api/notifications/unread — juste le compteur (pour le badge)
 */
router.get('/unread', requireAuth, async (req, res) => {
  try {
    const { count } = await supabaseAdmin
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('read', false);
    return res.json({ success: true, unread: count || 0 });
  } catch (err) {
    return res.json({ success: true, unread: 0 });
  }
});

/**
 * POST /api/notifications/read — marque tout (ou une liste d'ids) comme lu
 * body: { ids?: string[] }  (sans ids → tout marquer lu)
 */
router.post('/read', requireAuth, async (req, res) => {
  try {
    let q = supabaseAdmin.from('notifications').update({ read: true }).eq('user_id', req.user.id);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    if (ids && ids.length > 0) q = q.in('id', ids);
    else q = q.eq('read', false);
    await q;
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * POST /api/notifications/token — enregistre le jeton FCM de l'appareil
 * (pour recevoir les push quand l'appli est fermée). body: { token: string }
 */
router.post('/token', requireAuth, async (req, res) => {
  try {
    const token = (req.body?.token || '').toString().trim();
    if (!token) return res.status(400).json({ success: false, message: 'Jeton manquant' });
    await supabaseAdmin.from('users').update({ fcm_token: token }).eq('id', req.user.id);
    return res.json({ success: true });
  } catch (err) {
    // Colonne absente (avant migration) → on ignore pour ne pas casser l'appli
    return res.json({ success: true });
  }
});

module.exports = router;
