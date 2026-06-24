'use strict';
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 }, fileFilter(req, file, cb) { const ok = ['video/mp4','video/quicktime','video/x-msvideo','video/webm','video/3gpp']; ok.includes(file.mimetype) ? cb(null,true) : cb(new Error('Format non supporté')); } });

router.post('/register', requireAuth, async (req, res) => {
  try {
    const { title, video_url, description, zone, tags } = req.body;
    if (!title || !video_url) return res.status(400).json({ success: false, message: 'Titre et URL requis' });
    const { data, error } = await supabaseAdmin
      .from('videos')
      .insert({
        creator_id: req.user.userId,
        title,
        video_url,
        description: description || '',
        zone: zone || 'normal',
        tags: Array.isArray(tags) ? tags : (tags ? tags.split(',') : []),
      })
      .select()
      .single();
    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, video: data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});
router.post('/upload', requireAuth, upload.single('video'), async (req, res) => {
  try {
    if (!req.user.is_creator) return res.status(403).json({ success: false, message: 'Créateurs uniquement' });
    if (!req.file) return res.status(400).json({ success: false, message: 'Fichier requis' });
    const { title, description, tags, thumbnail_url } = req.body;
    if (!title || title.trim().length < 3) return res.status(400).json({ success: false, message: 'Titre requis' });
    const vid = uuidv4();
    const ext = req.file.originalname.split('.').pop() || 'mp4';
    const path = `videos/${req.user.id}/${vid}.${ext}`;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'videos';
    const { error: ue } = await supabaseAdmin.storage.from(bucket).upload(path, req.file.buffer, { contentType: req.file.mimetype });
    if (ue) return res.status(500).json({ success: false, message: "Erreur upload" });
    const { data: ud } = supabaseAdmin.storage.from(bucket).getPublicUrl(path);
    let ptags = [];
    if (tags) ptags = (typeof tags==='string'?tags.split(','):tags).map(t=>t.trim().toLowerCase()).filter(t=>t).slice(0,10);
    const { data: video, error: de } = await supabaseAdmin.from('videos').insert({ id: vid, creator_id: req.user.id, title: title.trim().slice(0,150), description: description?.trim().slice(0,2000)||null, video_url: ud?.publicUrl, storage_path: path, thumbnail_url: thumbnail_url||null, tags: ptags, status: 'published', views: 0, likes_count: 0, comments_count: 0, shares_count: 0, file_size: req.file.size, created_at: new Date().toISOString() }).select().single();
    if (de) { supabaseAdmin.storage.from(bucket).remove([path]); return res.status(500).json({ success: false, message: "Erreur DB" }); }
    return res.status(201).json({ success: true, video });
  } catch(err) { return res.status(500).json({ success: false, message: 'Erreur interne' }); }
});
router.get('/', optionalAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page||'1',10));
    const limit = Math.min(50, parseInt(req.query.limit||'20',10));
    const offset = (page-1)*limit;
    let q = supabaseAdmin.from('videos').select('id,title,description,video_url,thumbnail_url,tags,views,likes_count,comments_count,shares_count,created_at,creator:users!creator_id(id,username,avatar_url)').eq('status','published').order('created_at',{ascending:false}).range(offset,offset+limit-1);
    if (req.query.tag) q = q.contains('tags',[req.query.tag.toLowerCase()]);
    if (req.query.creator_id) q = q.eq('creator_id',req.query.creator_id);
    const { data: videos, error } = await q;
    if (error) return res.status(500).json({ success: false, message: 'Erreur chargement' });
    let liked = new Set();
    if (req.user && videos.length) {
      const { data: lk } = await supabaseAdmin.from('video_likes').select('video_id').eq('user_id',req.user.id).in('video_id',videos.map(v=>v.id));
      if (lk) liked = new Set(lk.map(l=>l.video_id));
    }
    return res.json({ success: true, videos: videos.map(v=>({...v,is_liked:liked.has(v.id)})), pagination: { page, limit, hasMore: videos.length===limit } });
  } catch { return res.status(500).json({ success: false, message: 'Erreur interne' }); }
});
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { data: video, error } = await supabaseAdmin.from('videos').select('id,title,description,video_url,thumbnail_url,tags,views,likes_count,comments_count,shares_count,created_at,creator:users!creator_id(id,username,avatar_url,bio)').eq('id',req.params.id).eq('status','published').single();
    if (error||!video) return res.status(404).json({ success: false, message: 'Vidéo introuvable' });
    supabaseAdmin.rpc('increment_views',{video_id:req.params.id}).catch(()=>{});
    let isLiked = false;
    if (req.user) { const { data: lk } = await supabaseAdmin.from('video_likes').select('id').eq('video_id',req.params.id).eq('user_id',req.user.id).single(); isLiked = !!lk; }
    return res.json({ success: true, video: {...video,is_liked:isLiked} });
  } catch { return res.status(500).json({ success: false, message: 'Erreur interne' }); }
});
router.post('/:id/like', requireAuth, async (req, res) => {
  try {
    const { data: v } = await supabaseAdmin.from('videos').select('id,likes_count').eq('id',req.params.id).eq('status','published').single();
    if (!v) return res.status(404).json({ success: false, message: 'Vidéo introuvable' });
    const { data: ex } = await supabaseAdmin.from('video_likes').select('id').eq('video_id',req.params.id).eq('user_id',req.user.id).single();
    let liked;
    if (ex) { await supabaseAdmin.from('video_likes').delete().eq('id',ex.id); await supabaseAdmin.from('videos').update({likes_count:Math.max(0,v.likes_count-1)}).eq('id',req.params.id); liked=false; }
    else { await supabaseAdmin.from('video_likes').insert({id:uuidv4(),video_id:req.params.id,user_id:req.user.id,created_at:new Date().toISOString()}); await supabaseAdmin.from('videos').update({likes_count:v.likes_count+1}).eq('id',req.params.id); liked=true; }
    return res.json({ success: true, liked });
  } catch { return res.status(500).json({ success: false, message: 'Erreur interne' }); }
});
router.post('/:id/comment', requireAuth, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content||content.trim().length<1) return res.status(400).json({ success: false, message: 'Commentaire vide' });
    if (content.length>500) return res.status(400).json({ success: false, message: 'Max 500 caractères' });
    const { data: v } = await supabaseAdmin.from('videos').select('id,comments_count').eq('id',req.params.id).eq('status','published').single();
    if (!v) return res.status(404).json({ success: false, message: 'Vidéo introuvable' });
    const { data: c, error } = await supabaseAdmin.from('comments').insert({id:uuidv4(),video_id:req.params.id,user_id:req.user.id,content:content.trim(),created_at:new Date().toISOString()}).select('id,content,created_at,user:users!user_id(id,username,avatar_url)').single();
    if (error) return res.status(500).json({ success: false, message: 'Erreur ajout commentaire' });
    await supabaseAdmin.from('videos').update({comments_count:v.comments_count+1}).eq('id',req.params.id);
    return res.status(201).json({ success: true, comment: c });
  } catch { return res.status(500).json({ success: false, message: 'Erreur interne' }); }
});
router.get('/:id/comments', async (req, res) => {
  try {
    const page = Math.max(1,parseInt(req.query.page||'1',10)); const limit = Math.min(50,parseInt(req.query.limit||'20',10));
    const { data: comments, error } = await supabaseAdmin.from('comments').select('id,content,created_at,user:users!user_id(id,username,avatar_url)').eq('video_id',req.params.id).order('created_at',{ascending:false}).range((page-1)*limit,page*limit-1);
    if (error) return res.status(500).json({ success: false, message: 'Erreur chargement' });
    return res.json({ success: true, comments, pagination:{page,limit,hasMore:comments.length===limit} });
  } catch { return res.status(500).json({ success: false, message: 'Erreur interne' }); }
});
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { data: v } = await supabaseAdmin.from('videos').select('id,creator_id,storage_path').eq('id',req.params.id).single();
    if (!v) return res.status(404).json({ success: false, message: 'Vidéo introuvable' });
    if (v.creator_id!==req.user.id) return res.status(403).json({ success: false, message: 'Interdit' });
    await supabaseAdmin.from('videos').update({status:'deleted'}).eq('id',req.params.id);
    if (v.storage_path) supabaseAdmin.storage.from(process.env.SUPABASE_STORAGE_BUCKET||'videos').remove([v.storage_path]).catch(()=>{});
    return res.json({ success: true, message: 'Vidéo supprimée' });
  } catch { return res.status(500).json({ success: false, message: 'Erreur interne' }); }
});

router.post('/register', requireAuth, async (req, res) => {
  try {
    const { title, video_url, description, zone, tags } = req.body;
    if (!title || !video_url) return res.status(400).json({ success: false, message: 'Titre et URL requis' });
    let parsedTags = [];
    if (tags) {
      parsedTags = (Array.isArray(tags) ? tags : tags.split(','))
        .map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0).slice(0, 10);
    }
    const { data: video, error } = await supabaseAdmin.from('videos').insert({
      id: uuidv4(), creator_id: req.user.id,
      title: title.trim().slice(0, 150),
      description: description?.trim() || null,
      video_url, zone: zone || 'normal', tags: parsedTags,
      status: 'published', views: 0, likes_count: 0, comments_count: 0, shares_count: 0,
      created_at: new Date().toISOString(),
    }).select().single();
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(201).json({ success: true, video });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});
module.exports = router;
