'use strict';

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// Média de story en mémoire puis upload vers Supabase Storage (bucket "videos").
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 }, // 60 Mo (photo ou courte vidéo)
  fileFilter(req, file, cb) {
    const ok = [
      'image/jpeg', 'image/png', 'image/webp',
      'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp',
    ];
    return ok.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Format non supporté (photo JPEG/PNG/WebP ou vidéo MP4/MOV).'));
  },
});

/**
 * POST /api/stories  (champ "media")
 * Publie une story (photo ou courte vidéo) qui expire après 24 h.
 */
router.post('/', requireAuth, upload.single('media'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, message: 'Média requis' });

    const isVideo = file.mimetype.startsWith('video/');
    const id = uuidv4();
    const ext = (file.originalname.split('.').pop() || (isVideo ? 'mp4' : 'jpg')).toLowerCase();
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'videos';
    const storagePath = `stories/${req.user.id}/${id}.${ext}`;

    const { error: upErr } = await supabaseAdmin.storage
      .from(bucket)
      .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
    if (upErr) {
      console.error('[Stories] upload storage:', upErr);
      return res.status(500).json({ success: false, message: 'Erreur upload' });
    }

    const { data: pub } = supabaseAdmin.storage.from(bucket).getPublicUrl(storagePath);

    const { data: story, error } = await supabaseAdmin
      .from('stories')
      .insert({
        creator_id: req.user.id,
        media_url: pub.publicUrl,
        media_type: isVideo ? 'video' : 'image',
        caption: (req.body.caption || '').toString().slice(0, 200) || null,
        storage_path: storagePath,
      })
      .select('id, media_url, media_type, caption, created_at, expires_at')
      .single();

    if (error) {
      console.error('[Stories] insert:', error);
      return res.status(500).json({ success: false, message: "Impossible d'enregistrer la story" });
    }
    return res.json({ success: true, story });
  } catch (err) {
    console.error('[Stories] create:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * GET /api/stories
 * Stories ACTIVES (< 24 h) des créateurs suivis + les miennes, groupées par
 * créateur (les plus récentes en premier, ma propre entrée d'abord).
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    const nowIso = new Date().toISOString();

    // Cercle de créateurs à afficher : ceux que je suis + moi-même.
    let creatorIds = null;
    if (req.user) {
      const { data: follows } = await supabaseAdmin
        .from('follows').select('following_id').eq('follower_id', req.user.id);
      creatorIds = [...new Set([...(follows || []).map((f) => f.following_id), req.user.id])];
    }

    let q = supabaseAdmin
      .from('stories')
      .select(`
        id, media_url, media_type, caption, created_at, expires_at, creator_id,
        creator:users!creator_id(id, username, avatar_url)
      `)
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: true })
      .limit(400);

    if (creatorIds && creatorIds.length > 0) q = q.in('creator_id', creatorIds);

    const { data: rows, error } = await q;
    if (error) {
      console.error('[Stories] list:', error);
      return res.json({ success: true, groups: [] });
    }

    // Groupe par créateur.
    const byCreator = new Map();
    for (const r of rows || []) {
      const cid = r.creator_id;
      if (!byCreator.has(cid)) {
        byCreator.set(cid, {
          creator_id: cid,
          creator_name: r.creator?.username || 'Créateur',
          creator_avatar: r.creator?.avatar_url || null,
          items: [],
        });
      }
      byCreator.get(cid).items.push({
        id: r.id,
        media_url: r.media_url,
        media_type: r.media_type,
        caption: r.caption,
        created_at: r.created_at,
      });
    }

    // Ma propre story en premier, puis les autres (plus récente activité d'abord).
    const groups = [...byCreator.values()];
    groups.sort((a, b) => {
      if (req.user) {
        if (a.creator_id === req.user.id) return -1;
        if (b.creator_id === req.user.id) return 1;
      }
      const la = a.items[a.items.length - 1].created_at;
      const lb = b.items[b.items.length - 1].created_at;
      return new Date(lb) - new Date(la);
    });

    return res.json({ success: true, groups });
  } catch (err) {
    console.error('[Stories] list erreur:', err.message);
    return res.json({ success: true, groups: [] });
  }
});

/**
 * DELETE /api/stories/:id — supprime ma story (média + ligne).
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { data: story } = await supabaseAdmin
      .from('stories').select('creator_id, storage_path').eq('id', req.params.id).single();
    if (!story || story.creator_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Non autorisé' });
    }
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'videos';
    if (story.storage_path) {
      await supabaseAdmin.storage.from(bucket).remove([story.storage_path]).catch(() => {});
    }
    await supabaseAdmin.from('stories').delete().eq('id', req.params.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

module.exports = router;
