'use strict';

const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../services/supabase');

/**
 * Middleware JWT - vérifie le token Bearer et attache l'utilisateur à req.user
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Token d\'authentification requis',
      });
    }

    const token = authHeader.slice(7);

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtErr) {
      if (jwtErr.name === 'TokenExpiredError') {
        return res.status(401).json({ success: false, message: 'Session expirée, veuillez vous reconnecter' });
      }
      return res.status(401).json({ success: false, message: 'Token invalide' });
    }

    // Vérifier que l'utilisateur existe toujours en base
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, phone, username, is_creator, is_active, wallet_balance, region, gender, birth_year')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      return res.status(401).json({ success: false, message: 'Utilisateur introuvable' });
    }

    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'Compte suspendu, contactez le support' });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('[Auth Middleware]', err.message);
    return res.status(500).json({ success: false, message: 'Erreur d\'authentification' });
  }
}

/**
 * Middleware optionnel - attache l'utilisateur si token présent, sans bloquer
 */
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  try {
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { data: user } = await supabaseAdmin
      .from('users')
      .select('id, phone, username, is_creator, is_active, wallet_balance, region, gender, birth_year')
      .eq('id', decoded.userId)
      .single();

    req.user = user || null;
  } catch {
    req.user = null;
  }

  next();
}

/**
 * Middleware - réservé aux créateurs
 */
function requireCreator(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentification requise' });
  }
  if (!req.user.is_creator) {
    return res.status(403).json({ success: false, message: 'Accès réservé aux créateurs' });
  }
  next();
}

module.exports = { requireAuth, optionalAuth, requireCreator };
