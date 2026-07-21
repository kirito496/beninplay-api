'use strict';

// ── Défis à Cagnotte : concours hashtag hebdo avec prix réels (FCFA) ────────
// Les participants publient une vidéo avec le hashtag du défi pendant la
// fenêtre. Classement par engagement (likes×3 + vues). À la clôture, la
// cagnotte est partagée 50/30/20 entre les 3 MEILLEURS CRÉATEURS (distincts),
// créditée directement dans leur portefeuille. Clôture automatique.

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: 'Non autorisé' });
  }
  next();
}

// Répartition de la cagnotte entre les 3 premiers.
const SPLIT = [0.5, 0.3, 0.2];

// Classement d'un défi : vidéos portant le hashtag, publiées dans la fenêtre.
async function leaderboard(ch, limit = 20) {
  const { data: vids } = await supabaseAdmin
    .from('videos')
    .select('id, title, thumbnail_url, views, likes_count, created_at, creator_id, creator:users!creator_id(id, username, avatar_url)')
    .eq('status', 'published')
    .contains('tags', [ch.hashtag])
    .gte('created_at', ch.starts_at)
    .lte('created_at', ch.ends_at)
    .limit(300);
  const scored = (vids || [])
    .map((v) => ({
      video_id: v.id,
      title: v.title,
      thumbnail_url: v.thumbnail_url,
      views: v.views || 0,
      likes: v.likes_count || 0,
      score: (v.likes_count || 0) * 3 + (v.views || 0),
      creator_id: v.creator_id,
      creator_name: v.creator?.username || 'Créateur',
      creator_avatar: v.creator?.avatar_url || null,
    }))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

async function credit(userId, amount, description) {
  if (!userId || amount <= 0) return;
  const { error } = await supabaseAdmin.rpc('increment_wallet_balance', {
    user_id: userId, amount,
  });
  if (error) {
    const { data: u } = await supabaseAdmin.from('users').select('wallet_balance').eq('id', userId).single();
    if (u) await supabaseAdmin.from('users').update({ wallet_balance: (u.wallet_balance || 0) + amount }).eq('id', userId);
  }
  await supabaseAdmin.from('transactions').insert({
    id: uuidv4(), user_id: userId, type: 'earning', amount, net_amount: amount,
    status: 'completed', description, created_at: new Date().toISOString(),
  }).then(() => {}, () => {});
}

// Clôture un défi : calcule les 3 meilleurs CRÉATEURS distincts, paie, archive.
async function settle(ch) {
  // Verrou optimiste : ne clôture que si encore 'active' (évite double paiement
  // si l'admin clique en même temps que la clôture automatique).
  const { data: locked } = await supabaseAdmin
    .from('challenges').update({ status: 'finishing' })
    .eq('id', ch.id).eq('status', 'active').select('id');
  if (!locked || locked.length === 0) return null;

  const board = await leaderboard(ch, 50);
  // 3 meilleurs créateurs DISTINCTS (une même personne ne rafle pas tout).
  const winners = [];
  const seen = new Set();
  for (const row of board) {
    if (seen.has(row.creator_id)) continue;
    seen.add(row.creator_id);
    winners.push(row);
    if (winners.length === 3) break;
  }
  const paid = [];
  for (let i = 0; i < winners.length; i++) {
    const amount = Math.floor(ch.prize_pool * SPLIT[i]);
    if (amount > 0) {
      await credit(winners[i].creator_id, amount,
        `🏆 Défi #${ch.hashtag} — ${i + 1}${i === 0 ? 'ère' : 'e'} place`);
    }
    paid.push({ ...winners[i], rank: i + 1, prize: amount });
  }
  await supabaseAdmin.from('challenges')
    .update({ status: 'finished', winners: paid })
    .eq('id', ch.id);
  console.log(`[Défis] #${ch.hashtag} clôturé — ${paid.length} gagnant(s) payés sur ${ch.prize_pool} FCFA`);
  return paid;
}

// ── Clôture AUTOMATIQUE : toutes les 10 min, règle les défis expirés ────────
let settling = false;
async function autoSettle() {
  if (settling) return;
  settling = true;
  try {
    const { data: ended } = await supabaseAdmin
      .from('challenges').select('*')
      .eq('status', 'active').lt('ends_at', new Date().toISOString()).limit(5);
    for (const ch of ended || []) await settle(ch);
  } catch (e) {
    console.error('[Défis] auto-clôture:', e.message);
  } finally {
    settling = false;
  }
}
const t = setInterval(autoSettle, 10 * 60 * 1000);
if (t.unref) t.unref();
setTimeout(autoSettle, 90 * 1000); // rattrapage peu après le boot

/**
 * GET /api/challenges — défi actif (avec classement) + derniers défis terminés.
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    const nowIso = new Date().toISOString();
    const { data: actives } = await supabaseAdmin
      .from('challenges').select('*')
      .eq('status', 'active').gt('ends_at', nowIso)
      .order('ends_at', { ascending: true }).limit(3);
    const withBoards = [];
    for (const ch of actives || []) {
      withBoards.push({ ...ch, leaderboard: await leaderboard(ch, 10) });
    }
    const { data: finished } = await supabaseAdmin
      .from('challenges').select('id, hashtag, title, prize_pool, ends_at, winners')
      .eq('status', 'finished')
      .order('ends_at', { ascending: false }).limit(5);
    return res.json({ success: true, active: withBoards, finished: finished || [] });
  } catch (err) {
    return res.json({ success: true, active: [], finished: [] });
  }
});

/**
 * GET /api/challenges/:id — détail + classement complet.
 */
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { data: ch } = await supabaseAdmin
      .from('challenges').select('*').eq('id', req.params.id).single();
    if (!ch) return res.status(404).json({ success: false, message: 'Défi introuvable' });
    return res.json({ success: true, challenge: ch, leaderboard: await leaderboard(ch, 30) });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * POST /api/challenges (admin) — crée un défi.
 * body: { hashtag, title, description?, prize_pool, days }
 */
router.post('/', requireAdmin, async (req, res) => {
  try {
    const hashtag = (req.body?.hashtag || '').toString().trim().toLowerCase().replace(/^#/, '').replace(/[^a-z0-9_àâéèêëîïôùûç]/g, '');
    const title = (req.body?.title || '').toString().trim().slice(0, 120);
    const prize = Math.max(0, parseInt(req.body?.prize_pool, 10) || 0);
    const days = Math.min(30, Math.max(1, parseInt(req.body?.days, 10) || 7));
    if (!hashtag || !title) {
      return res.status(400).json({ success: false, message: 'hashtag et titre requis' });
    }
    const { data: ch, error } = await supabaseAdmin.from('challenges').insert({
      hashtag, title,
      description: (req.body?.description || '').toString().slice(0, 500) || null,
      prize_pool: prize,
      ends_at: new Date(Date.now() + days * 24 * 3600 * 1000).toISOString(),
    }).select().single();
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, challenge: ch, message: `Défi #${hashtag} lancé pour ${days} j (${prize} FCFA) 🏆` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * POST /api/challenges/:id/finish (admin) — clôture manuelle (paie les gagnants).
 */
router.post('/:id/finish', requireAdmin, async (req, res) => {
  try {
    const { data: ch } = await supabaseAdmin
      .from('challenges').select('*').eq('id', req.params.id).single();
    if (!ch) return res.status(404).json({ success: false, message: 'Défi introuvable' });
    if (ch.status !== 'active') return res.status(400).json({ success: false, message: 'Déjà clôturé' });
    const paid = await settle(ch);
    return res.json({ success: true, winners: paid || [], message: 'Défi clôturé, gagnants payés ✅' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

module.exports = router;
