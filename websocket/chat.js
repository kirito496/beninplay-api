'use strict';
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../services/supabase');
const { calculateRevenueSplit } = require('../services/payment');
const { giftByKey } = require('../services/gifts');
const { notify } = require('../services/notify');

const conns = new Map();      // userId -> Set<ws>  (messages privés)
const liveRooms = new Map();  // liveId -> Set<ws>  (commentaires + cadeaux live)

function joinLive(liveId, ws) {
  if (!liveId) return;
  if (!liveRooms.has(liveId)) liveRooms.set(liveId, new Set());
  liveRooms.get(liveId).add(ws);
  ws._lives = ws._lives || new Set();
  ws._lives.add(liveId);
}
function leaveLive(liveId, ws) {
  const r = liveRooms.get(liveId);
  if (r) { r.delete(ws); if (!r.size) liveRooms.delete(liveId); }
  if (ws._lives) ws._lives.delete(liveId);
}
function broadcastLive(liveId, data) {
  const r = liveRooms.get(liveId);
  if (!r) return;
  const j = JSON.stringify(data);
  for (const ws of r) if (ws.readyState === ws.OPEN) ws.send(j);
}

// Envoi d'un cadeau : débite les pièces, crédite le créateur, diffuse l'animation.
async function handleGift(ws, me, d) {
  const { liveId, giftKey } = d;
  const gift = giftByKey(giftKey);
  if (!liveId || !gift) return;

  const { data: live } = await supabaseAdmin
    .from('live_streams').select('id, creator_id, status').eq('id', liveId).single();
  if (!live || live.status !== 'live') { send(ws, { type: 'gift_error', message: 'Live terminé' }); return; }
  if (live.creator_id === me.id) { send(ws, { type: 'gift_error', message: 'Tu ne peux pas t\'offrir un cadeau' }); return; }

  // Débit atomique des pièces de l'expéditeur
  const { data: ok } = await supabaseAdmin.rpc('spend_coins', { p_user: me.id, p_amount: gift.coins });
  if (ok !== true) { send(ws, { type: 'gift_error', code: 'no_coins', message: 'Pièces insuffisantes' }); return; }

  // Valeur FCFA = coût en pièces ; le créateur reçoit la part nette
  const split = calculateRevenueSplit(gift.coins);
  await supabaseAdmin.rpc('increment_wallet_balance', { user_id: live.creator_id, amount: split.creatorGross });
  await supabaseAdmin.from('live_gifts').insert({
    id: uuidv4(), live_id: liveId, sender_id: me.id, creator_id: live.creator_id,
    gift_key: gift.key, coins: gift.coins, amount_fcfa: gift.coins, created_at: new Date().toISOString(),
  });
  await supabaseAdmin.from('transactions').insert({
    id: uuidv4(), user_id: live.creator_id, type: 'earning',
    amount: split.creatorGross, net_amount: split.creatorGross, status: 'completed',
    description: `Cadeau live : ${gift.name}`,
    metadata: { live_id: liveId, gift: gift.key, from: me.id, coins: gift.coins },
    created_at: new Date().toISOString(), confirmed_at: new Date().toISOString(),
  });

  // Confirme à l'expéditeur (nouveau solde) + diffuse à tout le live
  const { data: u } = await supabaseAdmin.from('users').select('coin_balance').eq('id', me.id).single();
  send(ws, { type: 'gift_ok', coin_balance: u?.coin_balance || 0 });
  broadcastLive(liveId, {
    type: 'gift', liveId,
    gift: { key: gift.key, emoji: gift.emoji, name: gift.name, coins: gift.coins },
    from: { id: me.id, username: me.username },
  });
  notify(live.creator_id, {
    type: 'live_purchase',
    title: `Cadeau reçu ${gift.emoji}`,
    body: `@${me.username} t'a offert « ${gift.name} » (+${split.creatorGross} FCFA)`,
    data: { live_id: liveId, gift: gift.key },
  });
}

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

          // ── Messages privés ──────────────────────────────────────────────
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
            return;
          }

          // ── Live : rejoindre / quitter la salle ──────────────────────────
          if (d.type === 'join_live')  { joinLive(d.liveId, ws);  return; }
          if (d.type === 'leave_live') { leaveLive(d.liveId, ws); return; }

          // ── Live : commentaire temps réel ────────────────────────────────
          if (d.type === 'live_comment') {
            const content = (d.content || '').toString().trim().slice(0, 300);
            if (!d.liveId || !content) return;
            broadcastLive(d.liveId, {
              type: 'live_comment', liveId: d.liveId, content,
              from: { id: me.id, username: me.username },
            });
            return;
          }

          // ── Live : cadeau/sticker payé en pièces ─────────────────────────
          if (d.type === 'live_gift') { await handleGift(ws, me, d); return; }
        } catch {}
      });

      ws.on('close', () => {
        if (me) { const s = conns.get(me.id); if (s) { s.delete(ws); if (!s.size) conns.delete(me.id); } }
        if (ws._lives) for (const lid of ws._lives) leaveLive(lid, ws);
      });
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
