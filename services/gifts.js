'use strict';

// Économie des pièces (coins) et des cadeaux/stickers de live.
// Règle simple : 1 pièce = 1 FCFA de valeur. La valeur brute d'un cadeau
// (en FCFA) est égale à son coût en pièces ; le créateur en reçoit la part
// nette (après commission plateforme, via calculateRevenueSplit).

// Catalogue des stickers de soutien (coût en pièces).
// ⚠️ TOUS les stickers sont payants (aucun gratuit) : sans pièces, impossible d'envoyer.
const GIFTS = [
  { key: 'heart',    emoji: '❤️', name: 'Cœur',       coins: 10 },
  { key: 'rose',     emoji: '🌹', name: 'Rose',       coins: 20 },
  { key: 'thumbsup', emoji: '👍', name: 'Pouce',      coins: 25 },
  { key: 'clap',     emoji: '👏', name: 'Bravo',      coins: 30 },
  { key: 'laugh',    emoji: '😂', name: 'Rire',       coins: 40 },
  { key: 'fire',     emoji: '🔥', name: 'Feu',        coins: 50 },
  { key: 'heart_eyes', emoji: '😍', name: 'Admiration', coins: 60 },
  { key: 'party',    emoji: '🎉', name: 'Fête',       coins: 70 },
  { key: 'football', emoji: '⚽', name: 'Ballon',     coins: 80 },
  { key: 'star',     emoji: '⭐', name: 'Étoile',     coins: 100 },
  { key: 'trophy',   emoji: '🏆', name: 'Trophée',    coins: 150 },
  { key: 'gift',     emoji: '🎁', name: 'Cadeau',     coins: 200 },
  { key: 'crown',    emoji: '👑', name: 'Couronne',   coins: 300 },
  { key: 'ring',     emoji: '💍', name: 'Bague',      coins: 400 },
  { key: 'diamond',  emoji: '💎', name: 'Diamant',    coins: 500 },
  { key: 'car',      emoji: '🚗', name: 'Voiture',    coins: 750 },
  { key: 'rocket',   emoji: '🚀', name: 'Fusée',      coins: 1000 },
  { key: 'castle',   emoji: '🏰', name: 'Château',    coins: 2000 },
];

// Paquets de pièces achetables en Mobile Money (bonus sur les gros paquets).
const COIN_PACKS = [
  { fcfa: 500,  coins: 500 },
  { fcfa: 1000, coins: 1050 },
  { fcfa: 2000, coins: 2200 },
  { fcfa: 5000, coins: 5750 },
];

const giftByKey = (key) => GIFTS.find((g) => g.key === key) || null;

module.exports = { GIFTS, COIN_PACKS, giftByKey };
