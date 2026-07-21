'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');

// Valider les variables d'environnement critiques au démarrage
const requiredEnvVars = ['JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missingEnvVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingEnvVars.length > 0) {
  console.error(`[Server] Variables d'environnement manquantes: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

// Routes
const authRoutes = require('./routes/auth');
const videosRoutes = require('./routes/videos');
const usersRoutes = require('./routes/users');
const walletRoutes = require('./routes/wallet');
const chatRoutes = require('./routes/chat');
const paymentsRoutes = require('./routes/payments');
const darkRoutes = require('./routes/dark');
const monetizationRoutes = require('./routes/monetization');
const liveRoutes = require('./routes/live');
const notificationsRoutes = require('./routes/notifications');
const shareRoutes = require('./routes/share');
const giftsRoutes = require('./routes/gifts');
const storiesRoutes = require('./routes/stories');
const aiRoutes = require('./routes/ai');
const soundsRoutes = require('./routes/sounds');

// WebSocket
const { initWebSocketServer } = require('./websocket/chat');

const app = express();
const PORT = process.env.PORT || 3000;

// Derrière le proxy Railway : lire la vraie IP du client (x-forwarded-for)
app.set('trust proxy', true);

// ============================================================
// Middlewares globaux
// ============================================================

// CORS - autoriser toutes les origines (application mobile)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Parser JSON (max 10MB pour les payloads)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logger des requêtes en développement
if (process.env.NODE_ENV === 'development') {
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// ============================================================
// Routes de santé
// ============================================================

app.get('/', (_req, res) => {
  res.json({
    name: 'BeninPlay API',
    version: '1.0.0',
    status: 'en ligne',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'production',
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Console admin (page web protégée par la clé ADMIN_KEY saisie côté navigateur)
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Pages légales publiques (exigées par Google Play)
app.get('/confidentialite', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'confidentialite.html'));
});
app.get('/cgu', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cgu.html'));
});
app.get('/supprimer-compte', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'suppression-compte.html'));
});

// ============================================================
// Routes API
// ============================================================

app.use('/api/auth', authRoutes);
app.use('/api/videos', videosRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/dark', darkRoutes);
app.use('/api/monetization', monetizationRoutes);
app.use('/api/live', liveRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/gifts', giftsRoutes);
app.use('/api/stories', storiesRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/sounds', soundsRoutes);
app.use('/v', shareRoutes);

// ============================================================
// Gestion des erreurs globale
// ============================================================

// 404 - Route non trouvée
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route introuvable' });
});

// Gestionnaire d'erreurs global
app.use((err, _req, res, _next) => {
  console.error('[Server] Erreur non gérée:', err.message, err.stack);

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Requête trop volumineuse' });
  }

  if (err.name === 'SyntaxError' && err.status === 400) {
    return res.status(400).json({ success: false, message: 'JSON invalide dans le corps de la requête' });
  }

  return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
});

// ============================================================
// Démarrage du serveur
// ============================================================

const server = http.createServer(app);

// Initialiser le serveur WebSocket sur le même port HTTP
initWebSocketServer(server);

server.listen(PORT, () => {
  const ffmpegOk = require('./services/transcode').isConfigured();
  console.log(`
  ┌─────────────────────────────────────────┐
  │   BeninPlay API démarrée                │
  │   Port     : ${PORT}                        │
  │   Env      : ${(process.env.NODE_ENV || 'production').padEnd(11)}            │
  │   WebSocket: ws://localhost:${PORT}/ws       │
  └─────────────────────────────────────────┘
  Vidéo : ffmpeg ${ffmpegOk ? 'ACTIF (faststart + HLS adaptatif ✓)' : 'ABSENT ✗ — pas de faststart ni de HLS (vérifier ffmpeg-static)'}
  `);
});

// Gestion propre de l'arrêt (Railway SIGTERM)
process.on('SIGTERM', () => {
  console.log('[Server] Signal SIGTERM reçu, arrêt propre...');
  server.close(() => {
    console.log('[Server] Serveur arrêté.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Server] Signal SIGINT reçu, arrêt...');
  server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  console.error('[Server] Exception non capturée:', err.message, err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Server] Promesse rejetée non gérée:', reason);
});

module.exports = { app, server };
