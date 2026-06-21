'use strict';
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const conns = new Map();
function initWebSocketServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', async (ws, req) => {
    let me = null;
    try {
      const token = url.parse(req.url, true).query.token;
      if (!token) { ws.close(4001, 'Token requis'); return; }
      let dec;
      try { dec = jwt.verify(token, process.env.JWT_SECRET); } catch { ws.close(4001, 'Token invalide'); return; }
      const { data: user } = await supabaseAdmin.from('users').select('id,username,avatar_url,is_active').eq('id', dec.userId).single();
      if (!user || !user.is_active) { ws.close(4003, 'Utilisateur invalide'); return; }
      me = user;
      if (!conns.has(me.id)) conns.set(me.id, new Set());
      conns.get(me.id).add(ws);
      send(ws, { type: 'connected', userId: me.id });
      ws.on('message', async raw => {
        try {
          const d = JSON.parse(raw.toString());
          if (d.type === 'ping') { send(ws, { type: 'pong' }); return; }
          if (d.type === 'send_message') {
            const { conversationId: cid, content, media_url, message_type = 'text' } = d;
            if (!cid || (!content && !media_url)) return;
            const { data: cv } = await supabaseAdmin.from('conversations').select('id,participant_a_id,participant_b_id').eq('id', cid).single();
            if (!cv || (cv.participant_a_id !== me.id && cv.participant_b_id !== me.id)) return;
            const { data: msg } = await supabaseAdmin.from('messages').insert({ id: uuidv4(), conversation_id: cid, sender_id: me.id, content: content?.trim()||null, media_url: media_url||null, message_type, created_at: new Date().toISOString() }).select('id,content,message_type,created_at').single();
            await supabaseAdmin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', cid);
            send(ws, { type: 'message_sent', message: { ...msg, sender: { id: me.id, username: me.username } }, conversationId: cid });
            const rid = cv.participant_a_id === me.id ? cv.participant_b_id : cv.participant_a_id;
            sendToUser(rid, { type: 'new_message', message: { ...msg, sender: { id: me.id, username: me.username } }, conversationId: cid });
          }
        } catch {}
      });
      ws.on('close', () => { if (me) { const s = conns.get(me.id); if (s) { s.delete(ws); if (!s.size) conns.delete(me.id); } } });
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
    } catch (err) { ws.close(1011, 'Erreur serveur'); }
  });
  const hb = setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 30000);
  wss.on('close', () => clearInterval(hb));
  return wss;
}
function send(ws, d) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(d)); }
function sendToUser(uid, d) { const s = conns.get(uid); if (!s) return; const j = JSON.stringify(d); for (const ws of s) if (ws.readyState === ws.OPEN) ws.send(j); }
module.exports = { initWebSocketServer, sendToUser };
