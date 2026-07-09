'use strict';

const express = require('express');
const { supabaseAdmin } = require('../services/supabase');

const router = express.Router();

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page({ title, body, image }) {
  return `<!doctype html><html lang="fr"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)} · BeninPlay</title>
<meta property="og:title" content="${esc(title)}"/>
<meta property="og:site_name" content="BeninPlay"/>
<meta property="og:type" content="video.other"/>
${image ? `<meta property="og:image" content="${esc(image)}"/>` : ''}
<meta name="twitter:card" content="summary_large_image"/>
<style>
  body{margin:0;background:#0b0b0f;color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
       min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .card{max-width:440px;width:100%;background:#16161d;border:1px solid #26262f;border-radius:18px;overflow:hidden}
  .media{position:relative;background:#000;aspect-ratio:9/16;max-height:70vh;display:flex;align-items:center;justify-content:center}
  .media img,.media video{width:100%;height:100%;object-fit:cover}
  .lock{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
        background:rgba(0,0,0,.55);gap:10px;text-align:center;padding:20px}
  .p{padding:18px}
  h1{font-size:17px;margin:0 0 6px}
  .mut{color:#9a9aa5;font-size:13px;margin:0}
  .cta{display:block;margin-top:16px;background:#00C853;color:#04210f;text-align:center;
       padding:14px;border-radius:12px;font-weight:800;text-decoration:none}
  .brand{display:flex;align-items:center;gap:8px;padding:14px 18px;border-bottom:1px solid #26262f;font-weight:800}
  .dot{width:9px;height:9px;border-radius:50%;background:#00C853}
</style></head>
<body><div class="card"><div class="brand"><span class="dot"></span>BeninPlay 🇧🇯</div>${body}</div></body></html>`;
}

/**
 * GET /v/:id — page d'aperçu partageable d'une vidéo.
 * ⚠️ Les vidéos de la Zone Dark ne sont JAMAIS partageables (page indisponible).
 */
router.get('/:id', async (req, res) => {
  try {
    const { data: v } = await supabaseAdmin
      .from('videos')
      .select('id, title, thumbnail_url, video_url, zone, price, status, creator:users!creator_id(username)')
      .eq('id', req.params.id)
      .single();

    // Introuvable, non publiée, ou DARK → indisponible (jamais de fuite Dark)
    if (!v || v.status !== 'published' || v.zone === 'dark') {
      return res.status(404).send(page({
        title: 'Vidéo indisponible',
        body: `<div class="p"><h1>Vidéo indisponible</h1>
          <p class="mut">Ce contenu n'existe pas ou n'est pas partageable.</p></div>`,
      }));
    }

    const creator = v.creator?.username ? `@${v.creator.username}` : 'un créateur';
    const thumb = v.thumbnail_url || '';
    const isPaid = (v.price || 0) > 0;

    // Média : lecture directe si gratuit ; sinon aperçu verrouillé
    let media;
    if (!isPaid && v.video_url) {
      media = `<div class="media"><video controls playsinline preload="metadata"
        ${thumb ? `poster="${esc(thumb)}"` : ''} src="${esc(v.video_url)}"></video></div>`;
    } else {
      media = `<div class="media">
        ${thumb ? `<img src="${esc(thumb)}" alt=""/>` : ''}
        <div class="lock">
          <div style="font-size:34px">🔒</div>
          <div style="font-weight:700">Vidéo payante</div>
          <div class="mut">Disponible dans l'application BeninPlay (${esc(v.price)} FCFA)</div>
        </div></div>`;
    }

    return res.send(page({
      title: v.title || 'Vidéo BeninPlay',
      image: thumb,
      body: `${media}<div class="p">
        <h1>${esc(v.title || 'Vidéo BeninPlay')}</h1>
        <p class="mut">par ${esc(creator)}</p>
        <a class="cta" href="#">Ouvrir dans BeninPlay</a>
      </div>`,
    }));
  } catch (err) {
    return res.status(500).send(page({
      title: 'Erreur',
      body: `<div class="p"><h1>Oups</h1><p class="mut">Réessaie plus tard.</p></div>`,
    }));
  }
});

module.exports = router;
