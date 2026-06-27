'use strict';

// Liste officielle des 12 départements du Bénin
const BENIN_REGIONS = [
  'Alibori', 'Atacora', 'Atlantique', 'Borgou', 'Collines', 'Couffo',
  'Donga', 'Littoral', 'Mono', 'Ouémé', 'Plateau', 'Zou',
];

// Normalise un nom de région renvoyé par une API externe vers nos 12 départements
function normalizeRegion(name) {
  if (!name) return null;
  const clean = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // enlève les accents
  for (const region of BENIN_REGIONS) {
    const r = region.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (clean.includes(r) || r.includes(clean)) return region;
  }
  // Quelques villes connues -> département
  if (clean.includes('cotonou')) return 'Littoral';
  if (clean.includes('porto') || clean.includes('novo')) return 'Ouémé';
  if (clean.includes('parakou')) return 'Borgou';
  if (clean.includes('abomey') && clean.includes('calavi')) return 'Atlantique';
  if (clean.includes('abomey')) return 'Zou';
  if (clean.includes('natitingou')) return 'Atacora';
  if (clean.includes('bohicon')) return 'Zou';
  if (clean.includes('djougou')) return 'Donga';
  if (clean.includes('lokossa')) return 'Mono';
  return null;
}

// Extrait l'IP réelle du client (derrière proxy Railway)
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || '';
}

/**
 * Géolocalise une IP de façon approximative (gratuit, sans clé).
 * Retourne { country, countryCode, region, isVpn } ou null.
 */
async function geoFromIp(ip) {
  if (!ip || ip.startsWith('127.') || ip.startsWith('192.168.') || ip === '::1') {
    return null;
  }
  try {
    // ip-api.com : gratuit, 45 requêtes/min, sans clé
    const res = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city,proxy,hosting`,
      { signal: AbortSignal.timeout(4000) },
    );
    const data = await res.json();
    if (data.status !== 'success') return null;

    return {
      country: data.country || null,
      countryCode: data.countryCode || null,
      region: normalizeRegion(data.regionName) || normalizeRegion(data.city),
      city: data.city || null,
      // proxy/hosting = probablement un VPN ou serveur
      isVpn: data.proxy === true || data.hosting === true,
    };
  } catch (err) {
    console.log('[Geo] Erreur géoloc IP:', err.message);
    return null;
  }
}

module.exports = { BENIN_REGIONS, normalizeRegion, getClientIp, geoFromIp };
