'use strict';
const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../services/supabase');
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ success: false, message: "Token requis" });
    const token = authHeader.slice(7);
    let decoded;
    try { decoded = jwt.verify(token, process.env.JWT_SECRET); }
    catch (e) { return res.status(401).json({ success: false, message: e.name === 'TokenExpiredError' ? 'Session expirée' : 'Token invalide' }); }
    const { data: user, error } = await supabaseAdmin.from('users').select('id, phone, username, is_creator, is_active, wallet_balance').eq('id', decoded.userId).single();
    if (error || !user) return res.status(401).json({ success: false, message: 'Utilisateur introuvable' });
    if (!user.is_active) return res.status(403).json({ success: false, message: 'Compte suspendu' });
    req.user = user; next();
  } catch (err) { return res.status(500).json({ success: false, message: "Erreur authentification" }); }
}
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) { req.user = null; return next(); }
  try {
    const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    const { data: user } = await supabaseAdmin.from('users').select('id, phone, username, is_creator, is_active, wallet_balance').eq('id', decoded.userId).single();
    req.user = user || null;
  } catch { req.user = null; }
  next();
}
function requireCreator(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Authentification requise' });
  if (!req.user.is_creator) return res.status(403).json({ success: false, message: 'Réservé aux créateurs' });
  next();
}
module.exports = { requireAuth, optionalAuth, requireCreator };
