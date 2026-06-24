'use strict';

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm', 'video/3gpp'];
    ok.includes(file.mimetype) ? cb(null, true) : cb(new Error('Format non supporté'));
  },
});

/**
 * POST /api/videos/register
 * Enregistre une vidéo déjà uploadée depuis le client Flutter
 */
router.post('/register', requireAuth, async (req, res) => {
  try {
    const { title, video_url, description, zone, tags } = req.body;

    if (!title || !video_url) {
      return res.status(400).json({ success: false, message: 'Titre et URL requis' });
    }

    let parsedTags = [];
    if (tags) {
      parsedTags = (Array.isArray(tags) ? tags : tags.split(','))
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0)
        .slice(0, 10);
    }

    console.log('[register] user:', req.user?.id, 'title:', title, 'url:', video_url?.substring(0, 60));

    const { data: video, error } = await supabaseAdmin
      .from('videos')
      .insert({
        id: uuidv4(),
        creator_id: req.user.id,
        title: title.trim().slice(0, 150),
        description: description?.trim() || null,
        video_url,
        zone: zone || 'normal',
        tags: parsedTags,
        status: 'published',
        views: 0,
        likes_count: 0,
        comments_count: 0,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      console.error('[register] DB error:', JSON.stringify(error));
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.status(201).json({ success: true, video });
  } catch (err) {
    console.error('[register] catch:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/videos/upload
 * Upload d'une vidéo via le serveur (multipart)
 */
router.post('/upload', requireAuth, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Fichier requis' });

    const { title, description, tags, thumbnail_url } = req.body;
    if (!title || title.trim().length < 3) {
      return res.status(400).json({ success: false, message: 'Titre requis (min 3 caractères)' });
    }

    const vid = uuidv4();
    const ext = req.file.originalname.split('.').pop() || 'mp4';
    const storagePath = `videos/${req.user.id}/${vid}.${ext}`;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'videos';

    const { error: ue } = await supabaseAdmin.storage
      .from(bucket)
      .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype });

    if (ue) return res.status(500).json({ success: false, message: 'Erreur upload storage' });

    const { data: ud } = supabaseAdmin.storage.from(bucket).getPublicUrl(storagePath);

    let ptags = [];
    if (tags) {
      ptags = (typeof tags === 'string' ? tags.split(',') : tags)
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0)
        .slice(0, 10);
    }

    const { data: video, error: de } = await supabaseAdmin
      .from('videos')
      .insert({
        id: vid,
        creator_id: req.user.id,
        title: title.trim().slice(0, 150),
        description: description?.trim().slice(0, 2000) || null,
        video_url: ud?.publicUrl,
        storage_path: storagePath,
        thumbnail_url: thumbnail_url || null,
        tags: ptags,
        status: 'published',
        views: 0,
        likes_count: 0,
        comments_count: 0,
        file_size: req.file.size,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (de) {
      supabaseAdmin.storage.from(bucket).remove([storagePath]).catch(() => {});
      return res.status(500).json({ success: false, message: 'Erreur enregistrement DB' });
    }

    return res.status(201).json({ success: true, video });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * GET /api/videos
 * Feed principal
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, parseInt(req.query.limit || '20', 10));
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
      .from('videos')
      .select('id,title,description,video_url,thumbnail_url,tags,views,likes_count,comments_count,created_at,creator:users!creator_id(id,username,avatar_url)')
      .eq('status', 'published')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (req.query.tag) q = q.contains('tags', [req.query.tag.toLowerCase()]);
    if (req.query.creator_id) q = q.eq('creator_id', req.query.creator_id);

    const { data: videos, error } = await q;
    if (error) return res.status(500).json({ success: false, message: 'Erreur chargement vidéos' });

    let liked = new Set();
    if (req.user && videos.length) {
      const { data: lk } = await supabaseAdmin
        .from('video_likes')
        .select('video_id')
        .eq('user_id', req.user.id)
        .in('video_id', videos.map((v) => v.id));
      if (lk) liked = new Set(lk.map((l) => l.video_id));
    }

    return res.json({
      success: true,
      videos: videos.map((v) => ({
        ...v,
        creator_name: v.creator?.username || 'Créateur',
        creator_avatar: v.creator?.avatar_url || null,
        likes: v.likes_count,
        comments: v.comments_count,
        is_liked: liked.has(v.id),
      })),
      pagination: { page, limit, hasMore: videos.length === limit },
    });
  } catch (err) {
    console.error('[videos] list error:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * GET /api/videos/mine
 * Vidéos du créateur connecté
 */
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const { data: videos, error } = await supabaseAdmin
      .from('videos')
      .select('id,title,description,video_url,thumbnail_url,tags,views,likes_count,comments_count,created_at,zone')
      .eq('creator_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, videos: videos || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/videos/:id
 */
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { data: video, error } = await supabaseAdmin
      .from('videos')
      .select('id,title,description,video_url,thumbnail_url,tags,views,likes_count,comments_count,created_at,creator:users!creator_id(id,username,avatar_url,bio)')
      .eq('id', req.params.id)
      .eq('status', 'published')
      .single();

    if (error || !video) return res.status(404).json({ success: false, message: 'Vidéo introuvable' });

    supabaseAdmin.rpc('increment_views', { video_id: req.params.id }).catch(() => {});

    let isLiked = false;
    if (req.user) {
      const { data: lk } = await supabaseAdmin
        .from('video_likes')
        .select('id')
        .eq('video_id', req.params.id)
        .eq('user_id', req.user.id)
        .single();
      isLiked = !!lk;
    }

    return res.json({ success: true, video: { ...video, is_liked: isLiked } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * POST /api/videos/:id/like
 */
router.post('/:id/like', requireAuth, async (req, res) => {
  try {
    const { data: v } = await supabaseAdmin
      .from('videos')
      .select('id,likes_count')
      .eq('id', req.params.id)
      .eq('status', 'published')
      .single();

    if (!v) return res.status(404).json({ success: false, message: 'Vidéo introuvable' });

    const { data: ex } = await supabaseAdmin
      .from('video_likes')
      .select('id')
      .eq('video_id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    let liked;
    if (ex) {
      await supabaseAdmin.from('video_likes').delete().eq('id', ex.id);
      await supabaseAdmin.from('videos').update({ likes_count: Math.max(0, v.likes_count - 1) }).eq('id', req.params.id);
      liked = false;
    } else {
      await supabaseAdmin.from('video_likes').insert({ id: uuidv4(), video_id: req.params.id, user_id: req.user.id, created_at: new Date().toISOString() });
      await supabaseAdmin.from('videos').update({ likes_count: v.likes_count + 1 }).eq('id', req.params.id);
      liked = true;
    }

    return res.json({ success: true, liked });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * POST /api/videos/:id/comment
 */
router.post('/:id/comment', requireAuth, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || content.trim().length < 1) return res.status(400).json({ success: false, message: 'Commentaire vide' });
    if (content.length > 500) return res.status(400).json({ success: false, message: 'Max 500 caractères' });

    const { data: v } = await supabaseAdmin
      .from('videos')
      .select('id,comments_count')
      .eq('id', req.params.id)
      .eq('status', 'published')
      .single();

    if (!v) return res.status(404).json({ success: false, message: 'Vidéo introuvable' });

    const { data: c, error } = await supabaseAdmin
      .from('comments')
      .insert({ id: uuidv4(), video_id: req.params.id, user_id: req.user.id, content: content.trim(), created_at: new Date().toISOString() })
      .select('id,content,created_at,user:users!user_id(id,username,avatar_url)')
      .single();

    if (error) return res.status(500).json({ success: false, message: 'Erreur ajout commentaire' });

    await supabaseAdmin.from('videos').update({ comments_count: v.comments_count + 1 }).eq('id', req.params.id);

    return res.status(201).json({ success: true, comment: c });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * GET /api/videos/:id/comments
 */
router.get('/:id/comments', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, parseInt(req.query.limit || '20', 10));

    const { data: comments, error } = await supabaseAdmin
      .from('comments')
      .select('id,content,created_at,user:users!user_id(id,username,avatar_url)')
      .eq('video_id', req.params.id)
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (error) return res.status(500).json({ success: false, message: 'Erreur chargement commentaires' });

    return res.json({ success: true, comments, pagination: { page, limit, hasMore: comments.length === limit } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

/**
 * DELETE /api/videos/:id
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { data: v } = await supabaseAdmin
      .from('videos')
      .select('id,creator_id,storage_path')
      .eq('id', req.params.id)
      .single();

    if (!v) return res.status(404).json({ success: false, message: 'Vidéo introuvable' });
    if (v.creator_id !== req.user.id) return res.status(403).json({ success: false, message: 'Interdit' });

    await supabaseAdmin.from('videos').update({ status: 'deleted' }).eq('id', req.params.id);

    if (v.storage_path) {
      supabaseAdmin.storage
        .from(process.env.SUPABASE_STORAGE_BUCKET || 'videos')
        .remove([v.storage_path])
        .catch(() => {});
    }

    return res.json({ success: true, message: 'Vidéo supprimée' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

module.exports = router;