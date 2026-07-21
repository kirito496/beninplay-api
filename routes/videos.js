'use strict';

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { getClientIp } = require('../services/geo');
const { enqueueLight, faststart } = require('../services/transcode');

const router = express.Router();

// ── Vente à l'unité : charge les prix + les achats du spectateur ──────────────
// Best-effort : si la colonne price / la table video_purchases n'existent pas
// encore (avant migration), tout est considéré comme gratuit.
async function loadPaywall(videos, userId) {
  const out = { priceMap: {}, purchasedIds: new Set() };
  if (!videos || videos.length === 0) return out;
  const ids = videos.map((v) => v.id);
  try {
    // hls_url : version multi-qualités (adaptative) générée par le serveur
    // filter/overlays : effets d'édition "façon Snapchat" (réappliqués à la lecture)
    let { data: pr } = await supabaseAdmin.from('videos').select('id, price, hls_url, filter, overlays').in('id', ids);
    if (!pr) ({ data: pr } = await supabaseAdmin.from('videos').select('id, price, hls_url').in('id', ids));
    if (!pr) ({ data: pr } = await supabaseAdmin.from('videos').select('id, price').in('id', ids));
    if (pr) {
      const hls = {}, flt = {}, ovl = {};
      for (const r of pr) {
        out.priceMap[r.id] = r.price || 0;
        if (r.hls_url) hls[r.id] = r.hls_url;
        if (r.filter) flt[r.id] = r.filter;
        if (r.overlays) ovl[r.id] = r.overlays;
      }
      for (const v of videos) {
        if (hls[v.id]) v.hls_url = hls[v.id];
        if (flt[v.id]) v.filter = flt[v.id];
        if (ovl[v.id]) v.overlays = ovl[v.id];
      }
    }
  } catch (_) { /* colonne price absente */ }
  if (userId) {
    try {
      const { data: pu } = await supabaseAdmin
        .from('video_purchases').select('video_id').eq('user_id', userId).in('video_id', ids);
      if (pu) out.purchasedIds = new Set(pu.map((p) => p.video_id));
    } catch (_) { /* table absente */ }
  }
  return out;
}

// IDs des créateurs bloqués par ce spectateur (best-effort : table optionnelle).
// Leurs vidéos disparaissent de son fil — exigence Google Play (contenu UGC).
async function loadBlockedIds(userId) {
  if (!userId) return new Set();
  try {
    const { data } = await supabaseAdmin
      .from('user_blocks').select('blocked_id').eq('blocker_id', userId);
    return new Set((data || []).map((b) => b.blocked_id));
  } catch (_) {
    return new Set();
  }
}

// ── Profil de goûts du spectateur (fil personnalisé "IA") ──────────────
// Pondère les hashtags et créateurs de ses 80 derniers likes (poids 3) et
// de ses 120 dernières vidéos regardées jusqu'au bout (poids 2). Le fil
// s'adapte donc en TEMPS RÉEL : chaque like / visionnage complet modifie
// le classement du prochain chargement.
async function loadViewerPrefs(userId) {
  const prefs = { tags: new Map(), creators: new Map() };
  if (!userId) return prefs;
  const addVideo = (v, w) => {
    if (!v) return;
    for (const t of (v.tags || [])) {
      const k = String(t).toLowerCase();
      prefs.tags.set(k, (prefs.tags.get(k) || 0) + w);
    }
    if (v.creator_id) prefs.creators.set(v.creator_id, (prefs.creators.get(v.creator_id) || 0) + w);
  };
  try {
    const [likesRes, viewsRes] = await Promise.all([
      supabaseAdmin.from('video_likes')
        .select('video:videos!video_id(tags, creator_id)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(80),
      supabaseAdmin.from('video_views')
        .select('video:videos!video_id(tags, creator_id)')
        .eq('viewer_key', `u:${userId}`)
        .eq('completed', true)
        .order('created_at', { ascending: false })
        .limit(120),
    ]);
    for (const l of (likesRes.data || [])) addVideo(l.video, 3);
    for (const vv of (viewsRes.data || [])) addVideo(vv.video, 2);
  } catch (_) { /* pré-migration : pas d'historique → fil non personnalisé */ }
  return prefs;
}

// Renvoie {price, is_locked, video_url} : masque l'URL si vidéo payante non achetée
function lockFields(v, priceMap, purchasedIds, userId) {
  const price = priceMap[v.id] || 0;
  const isOwner = userId && v.creator && v.creator.id === userId;
  const locked = price > 0 && !isOwner && !purchasedIds.has(v.id);
  return {
    price,
    is_locked: locked,
    video_url: locked ? null : v.video_url,
    hls_url: locked ? null : (v.hls_url || null),
  };
}

// Configuration multer - stockage en mémoire puis upload vers Supabase Storage
// Champs : "video" (obligatoire) + "thumbnail" (image d'aperçu, optionnelle —
// affichée instantanément dans le fil pendant que la vidéo charge, comme TikTok).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 200 * 1024 * 1024, // 200 MB max
  },
  fileFilter(req, file, cb) {
    if (file.fieldname === 'thumbnail') {
      const okImg = ['image/jpeg', 'image/png', 'image/webp'];
      return okImg.includes(file.mimetype)
        ? cb(null, true)
        : cb(new Error('Miniature : format image non supporté (JPEG, PNG ou WebP)'));
    }
    const allowed = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm', 'video/3gpp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format vidéo non supporté. Utilisez MP4, MOV, AVI, WebM ou 3GP'));
    }
  },
});
const uploadFields = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
]);

/**
 * POST /api/videos/upload
 * Upload d'une vidéo (réservé aux créateurs)
 */
router.post('/upload', requireAuth, uploadFields, async (req, res) => {
  try {
    const videoFile = req.files?.video?.[0];
    const thumbFile = req.files?.thumbnail?.[0];
    if (!videoFile) {
      return res.status(400).json({ success: false, message: 'Fichier vidéo requis' });
    }

    const { title, description, tags, thumbnail_url, zone } = req.body;

    if (!title || title.trim().length < 3) {
      return res.status(400).json({ success: false, message: 'Titre requis (minimum 3 caractères)' });
    }

    const videoId = uuidv4();
    const fileExt = videoFile.originalname.split('.').pop() || 'mp4';
    const storagePath = `videos/${req.user.id}/${videoId}.${fileExt}`;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'videos';

    // ── Faststart : place l'index du MP4 au DÉBUT du fichier ──
    // Les MP4 Android ont l'index à la fin → le lecteur perd 1-3 s en
    // allers-retours réseau avant de démarrer. Remux en copie de flux
    // (rapide, sans ré-encodage). En cas d'échec : fichier d'origine.
    let videoBuffer = videoFile.buffer;
    if (['video/mp4', 'video/quicktime'].includes(videoFile.mimetype)) {
      const fast = await faststart(videoBuffer);
      if (fast) videoBuffer = fast;
    }

    // Upload vers Supabase Storage
    const { error: uploadError } = await supabaseAdmin.storage
      .from(bucket)
      .upload(storagePath, videoBuffer, {
        contentType: videoFile.mimetype,
        upsert: false,
      });

    if (uploadError) {
      console.error('[Videos] Erreur upload storage:', uploadError);
      return res.status(500).json({ success: false, message: 'Erreur lors de l\'upload de la vidéo' });
    }

    // Récupérer l'URL publique
    const { data: urlData } = supabaseAdmin.storage.from(bucket).getPublicUrl(storagePath);
    const videoUrl = urlData?.publicUrl;

    // Analyser les tags
    let parsedTags = [];
    if (tags) {
      parsedTags = (typeof tags === 'string' ? tags.split(',') : tags)
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0)
        .slice(0, 10);
    }

    // ── Miniature (affichée instantanément dans le fil pendant le chargement) ──
    let finalThumbUrl = thumbnail_url || null;
    if (thumbFile) {
      const thumbExt = thumbFile.mimetype === 'image/png' ? 'png'
        : thumbFile.mimetype === 'image/webp' ? 'webp' : 'jpg';
      const thumbPath = `thumbnails/${req.user.id}/${videoId}.${thumbExt}`;
      const { error: thumbErr } = await supabaseAdmin.storage
        .from(bucket)
        .upload(thumbPath, thumbFile.buffer, { contentType: thumbFile.mimetype, upsert: true });
      if (!thumbErr) {
        const { data: tPub } = supabaseAdmin.storage.from(bucket).getPublicUrl(thumbPath);
        if (tPub?.publicUrl) finalThumbUrl = tPub.publicUrl;
      } else {
        console.warn('[Videos] miniature non enregistrée:', thumbErr.message);
      }
    }

    // Enregistrer la vidéo en base (colonnes de base garanties)
    const videoData = {
      id: videoId,
      creator_id: req.user.id,
      title: title.trim().slice(0, 150),
      description: description?.trim().slice(0, 2000) || null,
      video_url: videoUrl,
      storage_path: storagePath,
      thumbnail_url: finalThumbUrl,
      tags: parsedTags,
      status: 'published',
      views: 0,
      likes_count: 0,
      comments_count: 0,
      shares_count: 0,
      file_size: videoBuffer.length,
      created_at: new Date().toISOString(),
    };
    // Publier en Zone Dark exige une identité vérifiée (+18)
    if (zone === 'dark') {
      const { data: u } = await supabaseAdmin.from('users').select('kyc_status').eq('id', req.user.id).single();
      if (u?.kyc_status !== 'verified') {
        await supabaseAdmin.storage.from(bucket).remove([storagePath]).catch(() => {});
        return res.status(403).json({ success: false, message: "Publication Dark : vérification d'identité requise" });
      }
    }

    // Effets d'édition "façon Snapchat" : filtre couleur + overlays
    // (textes / emojis). Stockés en métadonnées, réappliqués à la lecture.
    const { filter, overlays } = req.body;
    let overlaysJson = null;
    if (overlays) {
      try {
        const parsed = typeof overlays === 'string' ? JSON.parse(overlays) : overlays;
        if (Array.isArray(parsed)) overlaysJson = parsed.slice(0, 30);
      } catch (_) { /* overlays invalides → ignorés */ }
    }
    const filterVal = (typeof filter === 'string' && filter.trim().length > 0 && filter.length < 30)
      ? filter.trim()
      : null;

    // + zone et prix (colonnes optionnelles : présentes après la migration)
    const priceVal = Math.max(0, parseInt(req.body.price, 10) || 0);
    const withZone = {
      ...videoData,
      zone: zone === 'dark' ? 'dark' : 'normal',
      price: priceVal,
      filter: filterVal,
      overlays: overlaysJson,
    };

    let { data: video, error: dbError } = await supabaseAdmin
      .from('videos').insert(withZone).select().single();

    // Repli si la colonne "zone" n'existe pas encore
    if (dbError && /zone|column|does not exist|schema cache/i.test(dbError.message || '')) {
      console.warn('[Videos] upload : repli sans colonne zone —', dbError.message);
      ({ data: video, error: dbError } = await supabaseAdmin
        .from('videos').insert(videoData).select().single());
    }

    if (dbError) {
      console.error('[Videos] Erreur insertion DB:', dbError);
      await supabaseAdmin.storage.from(bucket).remove([storagePath]);
      return res.status(500).json({ success: false, message: `Enregistrement impossible : ${dbError.message}` });
    }

    // Publier est ouvert à tous. Le statut "créateur" (monétisation) reste
    // une demande spéciale à valider — il n'est PAS attribué automatiquement.

    // Version 480p légère (MP4) en arrière-plan : l'app la téléchargera si la
    // connexion est lente, sinon elle prendra le MP4 HD. La vidéo est
    // disponible tout de suite ; la version légère arrive quelques secondes après.
    enqueueLight(videoId, req.user.id, videoBuffer);

    return res.status(201).json({
      success: true,
      message: 'Vidéo publiée avec succès !',
      video,
    });
  } catch (err) {
    if (err.message && err.message.includes('Format vidéo')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, message: 'Vidéo trop volumineuse. Maximum 200 MB.' });
    }
    console.error('[Videos] upload erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * GET /api/videos
 * Liste les vidéos (feed principal)
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;
    const tag = req.query.tag;
    const creatorId = req.query.creator_id;

    // Vidéos déjà vues par ce spectateur (envoyées par l'app) : on ne les
    // reproposera JAMAIS tant qu'il en reste des nouvelles → à chaque
    // rafraîchissement, le fil montre d'autres vidéos.
    const excludeIds = new Set(
      String(req.query.exclude || '')
        .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 300)
    );
    // Quand on exclut les vidéos vues, on élargit la fenêtre de départ pour
    // quand même remplir une page complète de vidéos "fraîches".
    const fetchCount = excludeIds.size > 0 ? Math.min(80, limit * 4) : limit;

    const selectWithZone = `
        id, title, description, video_url, thumbnail_url, tags, zone,
        views, likes_count, comments_count, shares_count, created_at,
        creator:users!creator_id(id, username, avatar_url, is_creator)`;
    const selectNoZone = `
        id, title, description, video_url, thumbnail_url, tags,
        views, likes_count, comments_count, shares_count, created_at,
        creator:users!creator_id(id, username, avatar_url, is_creator)`;

    const buildList = (sel) => {
      let q = supabaseAdmin
        .from('videos')
        .select(sel)
        .eq('status', 'published')
        .order('created_at', { ascending: false })
        .range(offset, offset + fetchCount - 1);
      if (tag) q = q.contains('tags', [tag.toLowerCase()]);
      if (creatorId) q = q.eq('creator_id', creatorId);
      return q;
    };

    // Tente avec la colonne "zone" ; repli sans elle si elle n'existe pas (pré-migration)
    let hasZone = true;
    let { data: videos, error } = await buildList(selectWithZone);
    if (error) {
      hasZone = false;
      ({ data: videos, error } = await buildList(selectNoZone));
    }

    if (error) {
      console.error('[Videos] Erreur liste:', error);
      return res.status(500).json({ success: false, message: 'Erreur lors du chargement des vidéos' });
    }

    // Le feed normal ne montre JAMAIS les vidéos de la Zone Dark
    if (hasZone) videos = (videos || []).filter((v) => v.zone !== 'dark');

    // Retire les vidéos des créateurs bloqués par ce spectateur
    const blockedIds = await loadBlockedIds(req.user?.id);
    if (blockedIds.size > 0) {
      videos = (videos || []).filter((v) => !blockedIds.has(v.creator?.id || v.creator_id));
    }

    // Ne jamais reproposer une vidéo déjà vue (IDs envoyés par l'app).
    if (excludeIds.size > 0) {
      videos = (videos || []).filter((v) => !excludeIds.has(v.id));
    }

    // ── Fil personnalisé "IA" : apprend des goûts du spectateur ────────────
    // (hashtags + créateurs de ses likes et des vidéos qu'il regarde jusqu'au
    // bout) et classe le fil par affinité + fraîcheur + un peu de hasard.
    // Sans historique ou déconnecté : mélange aléatoire "frais" classique.
    // Les vidéos boostées ciblées sont ensuite replacées en tête ci-dessous.
    if (page === 1 && !tag && !creatorId && Array.isArray(videos)) {
      const prefs = req.user ? await loadViewerPrefs(req.user.id) : null;
      if (prefs && (prefs.tags.size > 0 || prefs.creators.size > 0)) {
        const nowMs = Date.now();
        videos = videos
          .map((v) => {
            let s = 0;
            for (const t of (v.tags || [])) s += prefs.tags.get(String(t).toLowerCase()) || 0;
            s += (prefs.creators.get(v.creator?.id) || 0) * 0.8;
            // Fraîcheur : bonus dégressif sur ~7 jours
            const ageH = (nowMs - new Date(v.created_at).getTime()) / 3.6e6;
            s += Math.max(0, 3 - ageH / 56);
            // Popularité douce + hasard pour que le fil varie à chaque visite
            s += Math.log10(1 + (v.views || 0)) * 0.5 + Math.random() * 2;
            return { v, s };
          })
          .sort((a, b) => b.s - a.s)
          .map((x) => x.v);
      } else {
        for (let i = videos.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [videos[i], videos[j]] = [videos[j], videos[i]];
        }
      }
    }

    // ── Placement sponsorisé par hashtag : si on filtre par tag, les vidéos
    // boostées sur ce hashtag remontent en tête (triées par enchère).
    if (page === 1 && tag && !creatorId) {
      const nowIso = new Date().toISOString();
      const { data: promo } = await supabaseAdmin
        .from('videos')
        .select(`
          id, title, description, video_url, thumbnail_url, tags, zone,
          views, likes_count, comments_count, shares_count, created_at, boost_end, boost_amount,
          creator:users!creator_id(id, username, avatar_url, is_creator)
        `)
        .eq('status', 'published')
        .eq('boosted', true)
        .gt('boost_end', nowIso)
        .contains('boost_tags', [tag.toLowerCase()])
        .order('boost_amount', { ascending: false })
        .limit(5);

      const promoted = (promo || []).filter((b) => b.zone !== 'dark');
      if (promoted.length > 0) {
        const ids = new Set(promoted.map((b) => b.id));
        const rest = (videos || []).filter((v) => !ids.has(v.id));
        videos = [...promoted, ...rest];
      }
    }

    // ── Boost ciblé : sur la 1re page, on remonte les vidéos boostées qui
    // correspondent au viewer (région + genre + âge), triées par enchère.
    if (page === 1 && !tag && !creatorId) {
      const viewerRegion = req.user?.region || null;
      const viewerGender = req.user?.gender || null;
      const viewerAge = req.user?.birth_year
        ? new Date().getFullYear() - req.user.birth_year
        : null;
      const nowIso = new Date().toISOString();

      // Régions ciblées qui matchent : "all" + la région du viewer
      const regionMatch = viewerRegion ? ['all', viewerRegion] : ['all'];

      let boostQuery = supabaseAdmin
        .from('videos')
        .select(`
          id, title, description, video_url, thumbnail_url, tags, zone,
          views, likes_count, comments_count, shares_count, created_at,
          boost_region, boost_regions, boost_end, boost_amount,
          boost_gender, boost_age_min, boost_age_max,
          creator:users!creator_id(id, username, avatar_url, is_creator)
        `)
        .eq('status', 'published')
        .eq('boosted', true)
        .gt('boost_end', nowIso)
        .overlaps('boost_regions', regionMatch)  // multi-région
        .order('boost_amount', { ascending: false })  // enchère : qui paie plus passe devant
        .order('boost_end', { ascending: false })
        .limit(20);

      let { data: boosted } = await boostQuery;
      boosted = (boosted || []).filter((b) => {
        // Cohérence de zone : pas de vidéo Dark dans le feed normal
        if (b.zone === 'dark') return false;
        // Ciblage genre
        if (b.boost_gender && b.boost_gender !== 'all') {
          if (!viewerGender || viewerGender !== b.boost_gender) return false;
        }
        // Ciblage âge
        if (viewerAge != null) {
          if (viewerAge < (b.boost_age_min || 0) || viewerAge > (b.boost_age_max || 120)) return false;
        }
        return true;
      });

      // Rotation simple : on garde le top enchères mais on mélange légèrement
      // pour ne pas toujours afficher exactement le même ordre.
      const topBoosted = boosted.slice(0, 8);
      for (let i = topBoosted.length - 1; i > 0; i--) {
        // mélange seulement parmi les enchères égales (groupes), léger
        if (topBoosted[i].boost_amount === topBoosted[i - 1].boost_amount) {
          const seed = (Date.now() + i) % 2;
          if (seed === 0) { const t = topBoosted[i]; topBoosted[i] = topBoosted[i - 1]; topBoosted[i - 1] = t; }
        }
      }

      if (topBoosted.length > 0) {
        const boostedIds = new Set(topBoosted.map((b) => b.id));
        const rest = (videos || []).filter((v) => !boostedIds.has(v.id));
        videos = [...topBoosted, ...rest];
      }
    }

    // Si l'utilisateur est connecté, récupérer ses likes
    let likedVideoIds = new Set();
    if (req.user && videos.length > 0) {
      const videoIds = videos.map((v) => v.id);
      const { data: likes } = await supabaseAdmin
        .from('video_likes')
        .select('video_id')
        .eq('user_id', req.user.id)
        .in('video_id', videoIds);
      if (likes) likedVideoIds = new Set(likes.map((l) => l.video_id));
    }

    // On a pu élargir la fenêtre (exclusion des vues) : on ne renvoie au plus
    // qu'une page complète, en gardant les vidéos boostées placées en tête.
    videos = videos.slice(0, limit);

    const nowMs = Date.now();
    const { priceMap, purchasedIds } = await loadPaywall(videos, req.user?.id);
    const enrichedVideos = videos.map((v) => ({
      ...v,
      ...lockFields(v, priceMap, purchasedIds, req.user?.id),
      creator_name: v.creator?.username || 'Créateur',
      creator_avatar: v.creator?.avatar_url || null,
      is_liked: likedVideoIds.has(v.id),
      is_boosted: v.boost_end ? new Date(v.boost_end).getTime() > nowMs : false,
    }));

    return res.json({
      success: true,
      videos: enrichedVideos,
      pagination: { page, limit, hasMore: videos.length === limit },
    });
  } catch (err) {
    console.error('[Videos] list erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * GET /api/videos/mine
 * Vidéos de l'utilisateur connecté
 */
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const { data: videos, error } = await supabaseAdmin
      .from('videos')
      .select('id, title, description, video_url, thumbnail_url, tags, views, likes_count, comments_count, created_at, zone')
      .eq('creator_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, videos: videos || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/videos/liked
 * Vidéos aimées par l'utilisateur connecté
 */
router.get('/liked', requireAuth, async (req, res) => {
  try {
    // Récupère les IDs des vidéos likées
    const { data: likes, error: likesErr } = await supabaseAdmin
      .from('video_likes')
      .select('video_id')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (likesErr) return res.status(500).json({ success: false, message: likesErr.message });

    const ids = (likes || []).map((l) => l.video_id);
    if (ids.length === 0) return res.json({ success: true, videos: [] });

    const { data: videos, error } = await supabaseAdmin
      .from('videos')
      .select('id, title, description, video_url, thumbnail_url, tags, views, likes_count, comments_count, created_at, zone, creator_id')
      .in('id', ids);

    if (error) return res.status(500).json({ success: false, message: error.message });

    // Marque toutes comme aimées
    const result = (videos || []).map((v) => ({ ...v, is_liked: true }));
    return res.json({ success: true, videos: result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/videos/my-boosts
 * Tableau de bord : les vidéos boostées de l'utilisateur + performances
 */
router.get('/my-boosts', requireAuth, async (req, res) => {
  try {
    const { data: videos, error } = await supabaseAdmin
      .from('videos')
      .select('id, title, thumbnail_url, video_url, views, likes_count, boosted, boost_end, boost_regions, boost_region, boost_gender, boost_amount, boost_views_start, boost_started_at')
      .eq('creator_id', req.user.id)
      .eq('boosted', true)
      .order('boost_started_at', { ascending: false });

    if (error) return res.status(500).json({ success: false, message: error.message });

    const now = Date.now();
    const boosts = await Promise.all((videos || []).map(async (v) => {
      const end = v.boost_end ? new Date(v.boost_end).getTime() : 0;
      const active = end > now;
      const msLeft = Math.max(0, end - now);
      const viewsGained = Math.max(0, (v.views || 0) - (v.boost_views_start || 0));
      const amount = v.boost_amount || 0;

      // Portée réelle = spectateurs UNIQUES depuis le début du boost
      let reach = null;
      try {
        let q = supabaseAdmin
          .from('video_views')
          .select('id', { count: 'exact', head: true })
          .eq('video_id', v.id);
        if (v.boost_started_at) q = q.gte('created_at', v.boost_started_at);
        const { count, error } = await q;
        if (!error) reach = count || 0;
      } catch (_) { /* table absente avant migration */ }

      return {
        id: v.id,
        title: v.title,
        thumbnail_url: v.thumbnail_url,
        video_url: v.video_url,
        active,
        days_left: Math.ceil(msLeft / (24 * 60 * 60 * 1000)),
        hours_left: Math.ceil(msLeft / (60 * 60 * 1000)),
        boost_end: v.boost_end,
        regions: v.boost_regions || [v.boost_region || 'all'],
        gender: v.boost_gender || 'all',
        amount,
        views_total: v.views || 0,
        views_gained: viewsGained,
        reach, // spectateurs uniques
        cost_per_view: viewsGained > 0 ? Math.round(amount / viewsGained) : null,
        likes: v.likes_count || 0,
      };
    }));

    return res.json({ success: true, boosts });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/videos/boost-reach
 * Estime le nombre d'utilisateurs touchés par un ciblage donné
 * Query: regions=Littoral,Ouémé (ou 'all'), gender=all|homme|femme, ageMin, ageMax
 */
router.get('/boost-reach', requireAuth, async (req, res) => {
  try {
    const regionsRaw = (req.query.regions || 'all').toString();
    const regions = regionsRaw.split(',').map((r) => r.trim()).filter(Boolean);
    const gender = (req.query.gender || 'all').toString();
    const ageMin = parseInt(req.query.ageMin, 10) || 0;
    const ageMax = parseInt(req.query.ageMax, 10) || 120;

    let q = supabaseAdmin
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', true);

    // Région (sauf si "all")
    if (!regions.includes('all') && regions.length > 0) {
      q = q.in('region', regions);
    }
    if (gender && gender !== 'all') {
      q = q.eq('gender', gender);
    }
    if (ageMin > 0) {
      q = q.lte('birth_year', new Date().getFullYear() - ageMin);
    }
    if (ageMax < 120) {
      q = q.gte('birth_year', new Date().getFullYear() - ageMax);
    }

    const { count, error } = await q;
    if (error) return res.status(500).json({ success: false, message: error.message });

    return res.json({ success: true, reach: count || 0 });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/videos/following
 * Feed "Abonnements" : vidéos des créateurs que je suis (anti-chronologique)
 */
router.get('/following', requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    // IDs des créateurs suivis
    const { data: follows } = await supabaseAdmin
      .from('follows').select('following_id').eq('follower_id', req.user.id);
    const ids = (follows || []).map((f) => f.following_id);
    if (ids.length === 0) return res.json({ success: true, videos: [] });

    const { data: videos, error } = await supabaseAdmin
      .from('videos')
      .select(`
        id, title, description, video_url, thumbnail_url, tags, zone,
        views, likes_count, comments_count, created_at,
        creator:users!creator_id(id, username, avatar_url, is_creator)
      `)
      .eq('status', 'published')
      .in('creator_id', ids)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ success: false, message: error.message });

    // Likes du viewer
    let likedIds = new Set();
    if (videos && videos.length > 0) {
      const vIds = videos.map((v) => v.id);
      const { data: likes } = await supabaseAdmin
        .from('video_likes').select('video_id').eq('user_id', req.user.id).in('video_id', vIds);
      if (likes) likedIds = new Set(likes.map((l) => l.video_id));
    }

    const blocked = await loadBlockedIds(req.user.id);
    const visible = (videos || []).filter(
      (v) => v.zone !== 'dark' && !blocked.has(v.creator?.id),
    );
    const { priceMap, purchasedIds } = await loadPaywall(visible, req.user.id);
    const enriched = visible.map((v) => ({
      ...v,
      ...lockFields(v, priceMap, purchasedIds, req.user.id),
      creator_name: v.creator?.username || 'Créateur',
      creator_avatar: v.creator?.avatar_url || null,
      is_liked: likedIds.has(v.id),
    }));

    return res.json({ success: true, videos: enriched });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/videos/dark
 * Feed INDÉPENDANT de la Zone Dark (+18, réservé). Ne renvoie QUE les vidéos
 * zone='dark'. Totalement séparé du feed normal.
 */
router.get('/dark', requireAuth, async (req, res) => {
  try {
    // ── Contrôle d'accès : KYC vérifié + abonnement Dark actif (refus par défaut) ──
    try {
      const { data: u } = await supabaseAdmin
        .from('users').select('kyc_status, dark_sub_until').eq('id', req.user.id).single();
      const kycOk = u?.kyc_status === 'verified';
      const subOk = u?.dark_sub_until ? new Date(u.dark_sub_until).getTime() > Date.now() : false;
      if (!kycOk || !subOk) {
        return res.status(403).json({
          success: false,
          code: 'dark_locked',
          message: !kycOk ? "Vérification d'identité requise" : 'Abonnement Zone Dark requis',
          kyc_status: u?.kyc_status || 'none',
          subscribed: subOk,
        });
      }
    } catch {
      return res.status(403).json({ success: false, code: 'dark_locked', message: 'Accès Zone Dark non autorisé' });
    }

    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    let videos = [];
    try {
      const { data, error } = await supabaseAdmin
        .from('videos')
        .select(`
          id, title, description, video_url, thumbnail_url, tags, zone,
          views, likes_count, comments_count, created_at,
          creator:users!creator_id(id, username, avatar_url, is_creator)
        `)
        .eq('status', 'published')
        .eq('zone', 'dark')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      videos = data || [];
    } catch (e) {
      // Colonne "zone" absente (migration pas encore appliquée) → aucune vidéo dark
      console.warn('[Videos] feed dark indisponible:', e.message);
      return res.json({ success: true, videos: [] });
    }

    let likedIds = new Set();
    if (videos.length > 0) {
      const vIds = videos.map((v) => v.id);
      const { data: likes } = await supabaseAdmin
        .from('video_likes').select('video_id').eq('user_id', req.user.id).in('video_id', vIds);
      if (likes) likedIds = new Set(likes.map((l) => l.video_id));
    }

    const { priceMap, purchasedIds } = await loadPaywall(videos, req.user.id);
    const enriched = videos.map((v) => ({
      ...v,
      ...lockFields(v, priceMap, purchasedIds, req.user.id),
      creator_name: v.creator?.username || 'Créateur',
      creator_avatar: v.creator?.avatar_url || null,
      is_liked: likedIds.has(v.id),
    }));

    return res.json({ success: true, videos: enriched });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/videos/popular-tags
 * Renvoie les hashtags les plus utilisés (pour le ciblage du boost)
 */
router.get('/popular-tags', async (req, res) => {
  try {
    const { data: rows } = await supabaseAdmin
      .from('videos')
      .select('tags')
      .eq('status', 'published')
      .limit(500);

    const counts = {};
    for (const r of rows || []) {
      for (const t of (r.tags || [])) {
        const k = t.toString().toLowerCase();
        counts[k] = (counts[k] || 0) + 1;
      }
    }
    const tags = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([tag, count]) => ({ tag, count }));

    return res.json({ success: true, tags });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Colonnes standard d'une vidéo (avec / sans zone selon l'état de la migration)
const VIDEO_SELECT = `
  id, title, description, video_url, thumbnail_url, tags, zone,
  views, likes_count, comments_count, shares_count, created_at,
  creator:users!creator_id(id, username, avatar_url, is_creator)`;
const VIDEO_SELECT_NOZONE = VIDEO_SELECT.replace(', zone', '');

// Enrichit une liste de vidéos (paywall + noms créateur) comme le feed principal
async function enrichVideos(videos, userId) {
  const { priceMap, purchasedIds } = await loadPaywall(videos, userId);
  return videos.map((v) => ({
    ...v,
    ...lockFields(v, priceMap, purchasedIds, userId),
    creator_name: v.creator?.username || 'Créateur',
    creator_avatar: v.creator?.avatar_url || null,
  }));
}

/**
 * GET /api/videos/search?q=... — recherche par titre ou hashtag (hors Dark)
 */
router.get('/search', optionalAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim().toLowerCase().slice(0, 60);
    if (q.length < 2) return res.json({ success: true, videos: [] });
    const safe = q.replace(/[%_]/g, ''); // neutralise les jokers ilike

    let hasZone = true;
    let { data: videos, error } = await supabaseAdmin.from('videos').select(VIDEO_SELECT)
      .eq('status', 'published').ilike('title', `%${safe}%`)
      .order('views', { ascending: false }).limit(30);
    if (error) {
      hasZone = false;
      ({ data: videos } = await supabaseAdmin.from('videos').select(VIDEO_SELECT_NOZONE)
        .eq('status', 'published').ilike('title', `%${safe}%`)
        .order('views', { ascending: false }).limit(30));
    }
    videos = videos || [];

    // Ajoute les vidéos qui portent ce hashtag
    try {
      const { data: byTag } = await supabaseAdmin.from('videos')
        .select(hasZone ? VIDEO_SELECT : VIDEO_SELECT_NOZONE)
        .eq('status', 'published').contains('tags', [q]).limit(30);
      if (byTag) {
        const seen = new Set(videos.map((v) => v.id));
        for (const v of byTag) if (!seen.has(v.id)) { videos.push(v); seen.add(v.id); }
      }
    } catch (_) { /* colonne tags absente : ignoré */ }

    if (hasZone) videos = videos.filter((v) => v.zone !== 'dark');
    return res.json({ success: true, videos: await enrichVideos(videos, req.user?.id) });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * GET /api/videos/trending — vidéos les plus vues (hors Dark)
 */
router.get('/trending', optionalAuth, async (req, res) => {
  try {
    let hasZone = true;
    let { data: videos, error } = await supabaseAdmin.from('videos').select(VIDEO_SELECT)
      .eq('status', 'published').order('views', { ascending: false }).limit(30);
    if (error) {
      hasZone = false;
      ({ data: videos } = await supabaseAdmin.from('videos').select(VIDEO_SELECT_NOZONE)
        .eq('status', 'published').order('views', { ascending: false }).limit(30));
    }
    videos = videos || [];
    if (hasZone) videos = videos.filter((v) => v.zone !== 'dark');
    return res.json({ success: true, videos: await enrichVideos(videos, req.user?.id) });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * POST /api/videos/:id/view
 * Enregistre une vue (appelé par le feed quand une vidéo est regardée).
 * Léger et non bloquant.
 */
router.post('/:id/view', optionalAuth, async (req, res) => {
  const { id } = req.params;
  try {
    // Clé unique du spectateur : compte connecté > appareil > IP.
    // → une même personne ne compte qu'UNE vue par vidéo (anti-fraude boost).
    const deviceId = (req.headers['x-device-id'] || req.body?.device_id || '').toString().slice(0, 64);
    const viewerKey = req.user?.id
      ? `u:${req.user.id}`
      : (deviceId ? `d:${deviceId}` : `ip:${getClientIp(req)}`);

    // Enregistre la vue unique. Si elle existe déjà (doublon), on ne recompte pas.
    let counts = true;
    try {
      const { error } = await supabaseAdmin
        .from('video_views')
        .insert({ video_id: id, viewer_key: viewerKey });
      if (error) {
        if (error.code === '23505' || /duplicate|unique/i.test(error.message || '')) {
          counts = false; // déjà vue par cette personne
        }
        // autre erreur (ex: table absente avant migration) → on compte quand même
      }
    } catch (_) {
      // table video_views indisponible → repli : on compte simplement
    }

    if (counts) {
      const { error: rpcErr } = await supabaseAdmin.rpc('increment_views', { video_id: id });
      if (rpcErr) {
        const { data: v } = await supabaseAdmin.from('videos').select('views').eq('id', id).single();
        if (v) {
          await supabaseAdmin.from('videos').update({ views: (v.views || 0) + 1 }).eq('id', id);
        }
      }
    }
    return res.json({ success: true, counted: counts });
  } catch (err) {
    return res.json({ success: true }); // jamais bloquant
  }
});

/**
 * POST /api/videos/:id/complete
 * Marque que ce spectateur a regardé la vidéo jusqu'au bout (signal d'impact,
 * même pour les non-abonnés). Sert au classement des créateurs.
 */
router.post('/:id/complete', optionalAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const deviceId = (req.headers['x-device-id'] || req.body?.device_id || '').toString().slice(0, 64);
    const viewerKey = req.user?.id
      ? `u:${req.user.id}`
      : (deviceId ? `d:${deviceId}` : `ip:${getClientIp(req)}`);

    // Upsert : crée la vue si besoin, et la marque "completed"
    await supabaseAdmin
      .from('video_views')
      .upsert({ video_id: id, viewer_key: viewerKey, completed: true }, { onConflict: 'video_id,viewer_key' });

    return res.json({ success: true });
  } catch (err) {
    return res.json({ success: true }); // jamais bloquant
  }
});

/**
 * GET /api/videos/:id
 * Récupère une vidéo par son ID et incrémente les vues
 */
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: video, error } = await supabaseAdmin
      .from('videos')
      .select(`
        id, title, description, video_url, thumbnail_url, tags,
        views, likes_count, comments_count, shares_count, created_at,
        creator:users!creator_id(id, username, avatar_url, is_creator, bio)
      `)
      .eq('id', id)
      .eq('status', 'published')
      .single();

    if (error || !video) {
      return res.status(404).json({ success: false, message: 'Vidéo introuvable' });
    }

    // Incrémenter les vues de façon asynchrone (pas bloquant)
    supabaseAdmin.rpc('increment_views', { video_id: id }).catch(console.error);

    let isLiked = false;
    if (req.user) {
      const { data: like } = await supabaseAdmin
        .from('video_likes')
        .select('id')
        .eq('video_id', id)
        .eq('user_id', req.user.id)
        .single();
      isLiked = !!like;
    }

    // Verrou vente à l'unité
    const { priceMap, purchasedIds } = await loadPaywall([video], req.user?.id);
    return res.json({
      success: true,
      video: { ...video, ...lockFields(video, priceMap, purchasedIds, req.user?.id), is_liked: isLiked },
    });
  } catch (err) {
    console.error('[Videos] get erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * POST /api/videos/:id/like
 * Like / Unlike une vidéo
 */
router.post('/:id/like', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Vérifier que la vidéo existe
    const { data: video } = await supabaseAdmin
      .from('videos')
      .select('id, likes_count, creator_id')
      .eq('id', id)
      .eq('status', 'published')
      .single();

    if (!video) {
      return res.status(404).json({ success: false, message: 'Vidéo introuvable' });
    }

    // Vérifier si déjà liké
    const { data: existingLike } = await supabaseAdmin
      .from('video_likes')
      .select('id')
      .eq('video_id', id)
      .eq('user_id', req.user.id)
      .single();

    let liked;
    if (existingLike) {
      // Unlike
      await supabaseAdmin.from('video_likes').delete().eq('id', existingLike.id);
      await supabaseAdmin
        .from('videos')
        .update({ likes_count: Math.max(0, video.likes_count - 1) })
        .eq('id', id);
      liked = false;
    } else {
      // Like
      await supabaseAdmin.from('video_likes').insert({
        id: uuidv4(),
        video_id: id,
        user_id: req.user.id,
        created_at: new Date().toISOString(),
      });
      await supabaseAdmin
        .from('videos')
        .update({ likes_count: video.likes_count + 1 })
        .eq('id', id);
      liked = true;
    }

    return res.json({
      success: true,
      liked,
      message: liked ? 'Vidéo aimée' : 'Like retiré',
    });
  } catch (err) {
    console.error('[Videos] like erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * POST /api/videos/:id/comment
 * Ajouter un commentaire
 */
router.post('/:id/comment', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;

    if (!content || content.trim().length < 1) {
      return res.status(400).json({ success: false, message: 'Commentaire vide non autorisé' });
    }

    if (content.trim().length > 500) {
      return res.status(400).json({ success: false, message: 'Commentaire trop long (max 500 caractères)' });
    }

    // Vérifier que la vidéo existe
    const { data: video } = await supabaseAdmin
      .from('videos')
      .select('id, comments_count')
      .eq('id', id)
      .eq('status', 'published')
      .single();

    if (!video) {
      return res.status(404).json({ success: false, message: 'Vidéo introuvable' });
    }

    const commentId = uuidv4();
    const { data: comment, error } = await supabaseAdmin
      .from('comments')
      .insert({
        id: commentId,
        video_id: id,
        user_id: req.user.id,
        content: content.trim(),
        created_at: new Date().toISOString(),
      })
      .select(`
        id, content, created_at,
        user:users!user_id(id, username, avatar_url)
      `)
      .single();

    if (error) {
      console.error('[Videos] Erreur ajout commentaire:', error);
      return res.status(500).json({ success: false, message: 'Erreur lors de l\'ajout du commentaire' });
    }

    // Incrémenter le compteur
    await supabaseAdmin
      .from('videos')
      .update({ comments_count: video.comments_count + 1 })
      .eq('id', id);

    return res.status(201).json({ success: true, message: 'Commentaire ajouté', comment });
  } catch (err) {
    console.error('[Videos] comment erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * GET /api/videos/:id/comments
 * Liste les commentaires d'une vidéo
 */
router.get('/:id/comments', async (req, res) => {
  try {
    const { id } = req.params;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, parseInt(req.query.limit || '20', 10));
    const offset = (page - 1) * limit;

    const { data: comments, error } = await supabaseAdmin
      .from('comments')
      .select(`
        id, content, created_at,
        user:users!user_id(id, username, avatar_url)
      `)
      .eq('video_id', id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return res.status(500).json({ success: false, message: 'Erreur lors du chargement des commentaires' });
    }

    return res.json({
      success: true,
      comments,
      pagination: { page, limit, hasMore: comments.length === limit },
    });
  } catch (err) {
    console.error('[Videos] comments list erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * DELETE /api/videos/:id
 * Supprime une vidéo (créateur uniquement)
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: video } = await supabaseAdmin
      .from('videos')
      .select('id, creator_id, storage_path')
      .eq('id', id)
      .single();

    if (!video) {
      return res.status(404).json({ success: false, message: 'Vidéo introuvable' });
    }

    if (video.creator_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Vous ne pouvez supprimer que vos propres vidéos' });
    }

    // Marquer comme supprimé en DB
    await supabaseAdmin.from('videos').update({ status: 'deleted' }).eq('id', id);

    // Supprimer du storage (asynchrone)
    if (video.storage_path) {
      const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'videos';
      supabaseAdmin.storage.from(bucket).remove([video.storage_path]).catch(console.error);
    }

    return res.json({ success: true, message: 'Vidéo supprimée' });
  } catch (err) {
    console.error('[Videos] delete erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});


/**
 * POST /api/videos/register
 * Enregistre une vidéo déjà uploadée directement sur Supabase Storage depuis le client
 */
router.post('/register', requireAuth, async (req, res) => {
  try {
    const { title, video_url, description, zone, tags } = req.body;

    if (!title || title.trim().length < 1) {
      return res.status(400).json({ success: false, message: 'Titre requis' });
    }
    if (!video_url) {
      return res.status(400).json({ success: false, message: 'URL vidéo requise' });
    }

    let parsedTags = [];
    if (tags) {
      parsedTags = (Array.isArray(tags) ? tags : String(tags).split(','))
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0)
        .slice(0, 10);
    }

    const id = uuidv4();
    // Colonnes de base (garanties présentes dans le schéma)
    const base = {
      id,
      creator_id: req.user.id,
      title: title.trim().slice(0, 150),
      description: description?.trim().slice(0, 2000) || null,
      video_url,
      tags: parsedTags,
      status: 'published',
      views: 0,
      likes_count: 0,
      comments_count: 0,
      created_at: new Date().toISOString(),
    };
    // Colonnes optionnelles (présentes seulement après la migration zone/dark)
    const full = { ...base, zone: zone || 'normal', shares_count: 0 };

    // 1re tentative avec toutes les colonnes ; repli automatique si l'une
    // d'elles n'existe pas encore dans la base (ex: colonne "zone" manquante).
    let { data: video, error } = await supabaseAdmin
      .from('videos').insert(full).select().single();

    if (error && /column|zone|shares_count|schema cache|does not exist/i.test(error.message || '')) {
      console.warn('[Videos] register : repli sans colonnes optionnelles —', error.message);
      ({ data: video, error } = await supabaseAdmin
        .from('videos').insert(base).select().single());
    }

    if (error) {
      console.error('[Videos] Erreur register:', error);
      // On renvoie la vraie cause au client (au lieu d'un message générique)
      return res.status(500).json({ success: false, message: `Publication impossible : ${error.message}` });
    }

    return res.status(201).json({ success: true, message: 'Vidéo publiée !', video });
  } catch (err) {
    console.error('[Videos] register erreur:', err.message);
    return res.status(500).json({ success: false, message: err.message || 'Erreur interne' });
  }
});

/**
 * PATCH /api/videos/:id/price
 * Le créateur fixe/modifie le prix de vente à l'unité (0 = gratuit).
 */
router.patch('/:id/price', requireAuth, async (req, res) => {
  try {
    const price = Math.max(0, parseInt(req.body.price, 10) || 0);
    const { data: video } = await supabaseAdmin
      .from('videos').select('id, creator_id').eq('id', req.params.id).single();
    if (!video) return res.status(404).json({ success: false, message: 'Vidéo introuvable' });
    if (video.creator_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Seul le créateur peut changer le prix' });
    }
    const { error } = await supabaseAdmin.from('videos').update({ price }).eq('id', req.params.id);
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, message: price > 0 ? `Prix fixé à ${price} FCFA` : 'Vidéo gratuite', price });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

// ── Signalement de contenu (exigence Google Play pour le contenu UGC) ────────

const REPORT_REASONS = ['nudite', 'violence', 'haine', 'arnaque', 'spam', 'mineur', 'autre'];

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ success: false, message: 'Accès refusé' });
  }
  next();
}

/**
 * POST /api/videos/:id/report
 * Signaler une vidéo. Motifs : nudite, violence, haine, arnaque, spam, mineur, autre.
 */
router.post('/:id/report', requireAuth, async (req, res) => {
  const videoId = req.params.id;
  const reason = REPORT_REASONS.includes(req.body?.reason) ? req.body.reason : 'autre';
  const details = (req.body?.details || '').toString().slice(0, 500) || null;
  try {
    const { error } = await supabaseAdmin.from('video_reports').insert({
      video_id: videoId,
      reporter_id: req.user.id,
      reason,
      details,
      status: 'pending',
    });
    if (error) {
      // Doublon (même personne, même vidéo) → on confirme quand même
      if (/duplicate|unique/i.test(error.message || '')) {
        return res.json({ success: true, message: 'Signalement déjà enregistré. Merci !' });
      }
      throw error;
    }
    return res.json({ success: true, message: 'Signalement envoyé. Notre équipe va vérifier.' });
  } catch (err) {
    console.error('[Videos] report erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Signalement impossible (migration manquante ?)' });
  }
});

/**
 * GET /api/videos/admin/reports — liste des signalements en attente (console admin)
 */
router.get('/admin/reports', requireAdmin, async (_req, res) => {
  try {
    const { data: reports, error } = await supabaseAdmin
      .from('video_reports')
      .select('id, video_id, reporter_id, reason, details, status, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(100);
    if (error) throw error;

    // Joint les infos vidéo (titre + créateur) pour affichage
    const vIds = [...new Set((reports || []).map((r) => r.video_id))];
    let vMap = {};
    if (vIds.length > 0) {
      const { data: vids } = await supabaseAdmin
        .from('videos')
        .select('id, title, creator_id, creator:users!creator_id(username)')
        .in('id', vIds);
      for (const v of vids || []) vMap[v.id] = v;
    }
    const enriched = (reports || []).map((r) => ({
      ...r,
      video_title: vMap[r.video_id]?.title || '(vidéo supprimée)',
      creator_name: vMap[r.video_id]?.creator?.username || '?',
    }));
    return res.json({ success: true, reports: enriched });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/videos/admin/reports/:id/action
 * { action: 'dismiss' } → signalement classé sans suite
 * { action: 'remove_video' } → vidéo retirée du fil (status='removed') + signalement clos
 */
router.post('/admin/reports/:id/action', requireAdmin, async (req, res) => {
  const action = req.body?.action;
  if (!['dismiss', 'remove_video'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Action invalide' });
  }
  try {
    const { data: report, error } = await supabaseAdmin
      .from('video_reports').select('id, video_id').eq('id', req.params.id).single();
    if (error || !report) {
      return res.status(404).json({ success: false, message: 'Signalement introuvable' });
    }
    if (action === 'remove_video') {
      await supabaseAdmin.from('videos')
        .update({ status: 'removed' }).eq('id', report.video_id);
      // Clôt aussi tous les autres signalements de la même vidéo
      await supabaseAdmin.from('video_reports')
        .update({ status: 'actioned' }).eq('video_id', report.video_id);
      return res.json({ success: true, message: 'Vidéo retirée + signalements clos' });
    }
    await supabaseAdmin.from('video_reports')
      .update({ status: 'dismissed' }).eq('id', report.id);
    return res.json({ success: true, message: 'Signalement classé sans suite' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
