'use strict';

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// Configuration multer - stockage en mémoire puis upload vers Supabase Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 200 * 1024 * 1024, // 200 MB max
  },
  fileFilter(req, file, cb) {
    const allowed = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm', 'video/3gpp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format vidéo non supporté. Utilisez MP4, MOV, AVI, WebM ou 3GP'));
    }
  },
});

/**
 * POST /api/videos/upload
 * Upload d'une vidéo (réservé aux créateurs)
 */
router.post('/upload', requireAuth, upload.single('video'), async (req, res) => {
  try {
    if (!req.user.is_creator) {
      return res.status(403).json({ success: false, message: 'Seuls les créateurs peuvent publier des vidéos' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Fichier vidéo requis' });
    }

    const { title, description, tags, thumbnail_url } = req.body;

    if (!title || title.trim().length < 3) {
      return res.status(400).json({ success: false, message: 'Titre requis (minimum 3 caractères)' });
    }

    const videoId = uuidv4();
    const fileExt = req.file.originalname.split('.').pop() || 'mp4';
    const storagePath = `videos/${req.user.id}/${videoId}.${fileExt}`;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'videos';

    // Upload vers Supabase Storage
    const { error: uploadError } = await supabaseAdmin.storage
      .from(bucket)
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
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

    // Enregistrer la vidéo en base
    const videoData = {
      id: videoId,
      creator_id: req.user.id,
      title: title.trim().slice(0, 150),
      description: description?.trim().slice(0, 2000) || null,
      video_url: videoUrl,
      storage_path: storagePath,
      thumbnail_url: thumbnail_url || null,
      tags: parsedTags,
      status: 'published',
      views: 0,
      likes_count: 0,
      comments_count: 0,
      shares_count: 0,
      file_size: req.file.size,
      created_at: new Date().toISOString(),
    };

    const { data: video, error: dbError } = await supabaseAdmin
      .from('videos')
      .insert(videoData)
      .select()
      .single();

    if (dbError) {
      console.error('[Videos] Erreur insertion DB:', dbError);
      // Nettoyer le fichier uploadé
      await supabaseAdmin.storage.from(bucket).remove([storagePath]);
      return res.status(500).json({ success: false, message: 'Erreur lors de l\'enregistrement de la vidéo' });
    }

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

    let query = supabaseAdmin
      .from('videos')
      .select(`
        id, title, description, video_url, thumbnail_url, tags,
        views, likes_count, comments_count, shares_count, created_at,
        creator:users!creator_id(id, username, avatar_url, is_creator)
      `)
      .eq('status', 'published')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (tag) {
      query = query.contains('tags', [tag.toLowerCase()]);
    }
    if (creatorId) {
      query = query.eq('creator_id', creatorId);
    }

    const { data: videos, error, count } = await query;

    if (error) {
      console.error('[Videos] Erreur liste:', error);
      return res.status(500).json({ success: false, message: 'Erreur lors du chargement des vidéos' });
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

    const enrichedVideos = videos.map((v) => ({
      ...v,
      creator_name: v.creator?.username || 'Créateur',
      creator_avatar: v.creator?.avatar_url || null,
      is_liked: likedVideoIds.has(v.id),
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

    return res.json({ success: true, video: { ...video, is_liked: isLiked } });
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
      parsedTags = (Array.isArray(tags) ? tags : tags.split(','))
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0)
        .slice(0, 10);
    }

    const insertData = {
      id: uuidv4(),
      creator_id: req.user.id,
      title: title.trim().slice(0, 150),
      description: description?.trim().slice(0, 2000) || null,
      video_url,
      zone: zone || 'normal',
      tags: parsedTags,
      status: 'published',
      views: 0,
      likes_count: 0,
      comments_count: 0,
      created_at: new Date().toISOString(),
    };

    // Colonnes optionnelles — ajoutées seulement si elles existent dans le schéma
    try { insertData.shares_count = 0; } catch (_) {}
    try { insertData.file_size = 0; } catch (_) {}

    console.log('[Videos] register insert data:', JSON.stringify(insertData));

    const { data: video, error } = await supabaseAdmin
      .from('videos')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      console.error('[Videos] Erreur register:', error);
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.status(201).json({ success: true, message: 'Vidéo publiée !', video });
  } catch (err) {
    console.error('[Videos] register erreur:', err.message);
    return res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

module.exports = router;
