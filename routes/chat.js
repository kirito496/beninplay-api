'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
router.get('/conversations', requireAuth, async (req, res) => {
  const { data: c } = await supabaseAdmin.from('conversations').select('id,updated_at,participant_a:users!participant_a_id(id,username,avatar_url),participant_b:users!participant_b_id(id,username,avatar_url)').or(`participant_a_id.eq.${req.user.id},participant_b_id.eq.${req.user.id}`).order('updated_at', { ascending: false }).limit(50);
  const list = c || [];
  // Aperçu du dernier message + nombre de non-lus par conversation (2 requêtes)
  const lastByConv = {}; const unreadByConv = {};
  const ids = list.map(cv => cv.id);
  if (ids.length > 0) {
    const { data: msgs } = await supabaseAdmin.from('messages')
      .select('conversation_id,content,message_type,sender_id,created_at,read_at')
      .in('conversation_id', ids)
      .order('created_at', { ascending: false })
      .limit(300);
    for (const m of (msgs || [])) {
      if (!lastByConv[m.conversation_id]) lastByConv[m.conversation_id] = m;
      if (m.sender_id !== req.user.id && !m.read_at) {
        unreadByConv[m.conversation_id] = (unreadByConv[m.conversation_id] || 0) + 1;
      }
    }
  }
  const formatted = list.map(cv => {
    const lm = lastByConv[cv.id];
    return {
      id: cv.id,
      otherUser: cv.participant_a?.id === req.user.id ? cv.participant_b : cv.participant_a,
      updatedAt: cv.updated_at,
      lastMessage: lm ? { content: lm.content || '📎 Média', mine: lm.sender_id === req.user.id } : null,
      unread: unreadByConv[cv.id] || 0,
    };
  });
  return res.json({ success: true, conversations: formatted });
});
// Total de messages non lus (badge sur l'icône Messages du fil)
router.get('/unread', requireAuth, async (req, res) => {
  const { data: c } = await supabaseAdmin.from('conversations').select('id').or(`participant_a_id.eq.${req.user.id},participant_b_id.eq.${req.user.id}`);
  const ids = (c || []).map(x => x.id);
  if (ids.length === 0) return res.json({ success: true, unread: 0 });
  const { count } = await supabaseAdmin.from('messages')
    .select('id', { count: 'exact', head: true })
    .in('conversation_id', ids)
    .neq('sender_id', req.user.id)
    .is('read_at', null);
  return res.json({ success: true, unread: count || 0 });
});
router.get('/conversations/:userId', requireAuth, async (req, res) => {
  const { userId } = req.params;
  if (userId === req.user.id) return res.status(400).json({ success: false, message: 'Impossible de se contacter soi-même' });
  const { data: other } = await supabaseAdmin.from('users').select('id,username,avatar_url').eq('id', userId).eq('is_active', true).single();
  if (!other) return res.status(404).json({ success: false, message: 'Utilisateur introuvable' });
  const { data: ex } = await supabaseAdmin.from('conversations').select('id').or(`and(participant_a_id.eq.${req.user.id},participant_b_id.eq.${userId}),and(participant_a_id.eq.${userId},participant_b_id.eq.${req.user.id})`).single();
  let cid;
  if (ex) { cid = ex.id; } else {
    const { data: nc } = await supabaseAdmin.from('conversations').insert({ id: uuidv4(), participant_a_id: req.user.id, participant_b_id: userId, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }).select('id').single();
    cid = nc.id;
  }
  return res.json({ success: true, conversationId: cid, otherUser: other });
});
router.get('/messages/:cid', requireAuth, async (req, res) => {
  const { cid } = req.params;
  const { data: cv } = await supabaseAdmin.from('conversations').select('id,participant_a_id,participant_b_id').eq('id', cid).single();
  if (!cv) return res.status(404).json({ success: false, message: 'Conversation introuvable' });
  if (cv.participant_a_id !== req.user.id && cv.participant_b_id !== req.user.id) return res.status(403).json({ success: false, message: 'Accès refusé' });
  const page = Math.max(1, parseInt(req.query.page||'1',10));
  const limit = Math.min(100, parseInt(req.query.limit||'50',10));
  const { data: msgs } = await supabaseAdmin.from('messages').select('id,content,media_url,message_type,created_at,sender_id,sender:users!sender_id(id,username,avatar_url)').eq('conversation_id', cid).order('created_at', { ascending: false }).range((page-1)*limit, page*limit-1);
  await supabaseAdmin.from('messages').update({ read_at: new Date().toISOString() }).eq('conversation_id', cid).neq('sender_id', req.user.id).is('read_at', null);
  return res.json({ success: true, messages: (msgs||[]).reverse(), pagination: { page, limit, hasMore: (msgs||[]).length === limit } });
});
router.post('/messages/:cid', requireAuth, async (req, res) => {
  const { cid } = req.params;
  const { content, media_url, message_type = 'text' } = req.body;
  if (!content && !media_url) return res.status(400).json({ success: false, message: 'Contenu requis' });
  const { data: cv } = await supabaseAdmin.from('conversations').select('id,participant_a_id,participant_b_id').eq('id', cid).single();
  if (!cv || (cv.participant_a_id !== req.user.id && cv.participant_b_id !== req.user.id)) return res.status(403).json({ success: false, message: 'Accès refusé' });
  const { data: msg } = await supabaseAdmin.from('messages').insert({ id: uuidv4(), conversation_id: cid, sender_id: req.user.id, content: content?.trim()||null, media_url: media_url||null, message_type, created_at: new Date().toISOString() }).select('id,content,media_url,message_type,created_at,sender_id,sender:users!sender_id(id,username,avatar_url)').single();
  await supabaseAdmin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', cid);
  return res.status(201).json({ success: true, message: msg });
});
module.exports = router;
