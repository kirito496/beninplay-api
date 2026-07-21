'use strict';

const express = require('express');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Clé de l'API Claude (À TOI) — à définir dans les variables d'env Azure :
//   AI_API_KEY   = ta clé Anthropic (sk-ant-...)
//   AI_MODEL     = (facultatif) modèle, défaut "claude-3-5-haiku-latest"
const AI_KEY = process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'claude-3-5-haiku-latest';

// Récupère quelques stats du créateur pour que l'assistant puisse en parler.
async function loadStats(userId) {
  try {
    const [{ data: vids }, { count: followers }] = await Promise.all([
      supabaseAdmin.from('videos').select('views, likes_count, comments_count').eq('creator_id', userId),
      supabaseAdmin.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', userId),
    ]);
    const list = vids || [];
    const views = list.reduce((s, v) => s + (v.views || 0), 0);
    const likes = list.reduce((s, v) => s + (v.likes_count || 0), 0);
    const comments = list.reduce((s, v) => s + (v.comments_count || 0), 0);
    return { videos: list.length, views, likes, comments, followers: followers || 0 };
  } catch (_) {
    return null;
  }
}

/**
 * POST /api/ai/chat
 * body: { message: string, history?: [{role:'user'|'assistant', content}] }
 * Assistant IA de BeninPlay. Peut parler des performances du créateur.
 */
router.post('/chat', requireAuth, async (req, res) => {
  try {
    const message = (req.body?.message || '').toString().trim().slice(0, 2000);
    if (!message) return res.status(400).json({ success: false, message: 'Message vide' });

    // Sans clé configurée : réponse de repli honnête (pas de vrai LLM).
    if (!AI_KEY) {
      return res.json({
        success: true,
        configured: false,
        reply:
          "🤖 L'assistant IA n'est pas encore activé. Le propriétaire de l'app doit " +
          "ajouter une clé API Claude (variable AI_API_KEY) côté serveur. " +
          "En attendant : publie régulièrement, utilise des hashtags locaux (#Cotonou, " +
          "#Bénin), réponds aux commentaires et poste aux heures de forte affluence (18h–22h) 📈.",
      });
    }

    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-10) : [];
    const stats = await loadStats(req.user.id);

    const statLine = stats
      ? `Statistiques actuelles du créateur : ${stats.videos} vidéos, ${stats.views} vues, ` +
        `${stats.likes} j'aime, ${stats.comments} commentaires, ${stats.followers} abonnés.`
      : `Statistiques du créateur : indisponibles pour le moment.`;

    const system =
      "Tu es l'assistant IA de BeninPlay, une appli béninoise de vidéos courtes. " +
      "Tu aides les créateurs à grandir : conseils de contenu, analyse de leurs " +
      "performances, idées de vidéos, stratégie hashtags/horaires, monétisation. " +
      "Réponds en français, de façon chaleureuse, concrète et concise (adaptée au " +
      "Bénin et à l'Afrique de l'Ouest). " + statLine;

    const messages = [
      ...history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
        .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) })),
      { role: 'user', content: message },
    ];

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': AI_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 700, system, messages }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.error('[AI] erreur API:', resp.status, txt.slice(0, 300));
      return res.json({
        success: true,
        configured: true,
        reply: "😕 L'assistant est momentanément indisponible. Réessaie dans un instant.",
      });
    }

    const data = await resp.json();
    const reply = (data?.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim();

    return res.json({
      success: true,
      configured: true,
      reply: reply || "Je n'ai pas de réponse pour le moment.",
    });
  } catch (err) {
    console.error('[AI] chat erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

module.exports = router;
