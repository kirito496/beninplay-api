'use strict';

// Transcodage HLS adaptatif : chaque vidéo publiée est convertie en
// 2 qualités (240p ≈ 300 kb/s pour connexion lente, 480p ≈ 800 kb/s).
// Le lecteur (ExoPlayer) choisit et BASCULE automatiquement selon la
// connexion du spectateur — comme TikTok/YouTube.
//
// Tourne en arrière-plan après la publication (la vidéo est disponible
// immédiatement en MP4, puis passe en adaptatif dès que le HLS est prêt).

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { supabaseAdmin } = require('./supabase');

let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch (_) { /* non installé */ }

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'videos';

// File d'attente séquentielle : 1 transcodage à la fois (préserve le CPU)
let chain = Promise.resolve();
function enqueueHls(videoId, creatorId, buffer) {
  if (!ffmpegPath || !buffer || !videoId) return;
  chain = chain
    .then(() => transcode(videoId, creatorId, buffer))
    .catch((e) => console.error('[HLS]', videoId, 'échec (vidéo reste en MP4):', e.message));
}

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-8000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg (${code}): ${err.slice(-300)}`))));
  });
}

async function transcode(videoId, creatorId, buffer) {
  const started = Date.now();
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hls-'));
  try {
    const input = path.join(work, 'in.mp4');
    await fs.promises.writeFile(input, buffer);

    const common = [
      '-y', '-i', input,
      '-preset', 'veryfast', '-g', '48', '-sc_threshold', '0',
      '-filter_complex', '[0:v]split=2[v1][v2];[v1]scale=-2:240[v1o];[v2]scale=-2:480[v2o]',
    ];
    const hlsOut = [
      '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', 'seg_%v_%03d.ts',
      '-master_pl_name', 'master.m3u8', 'out_%v.m3u8',
    ];
    // Avec audio
    const withAudio = [...common,
      '-map', '[v1o]', '-c:v:0', 'libx264', '-b:v:0', '300k', '-maxrate:v:0', '350k', '-bufsize:v:0', '700k',
      '-map', '[v2o]', '-c:v:1', 'libx264', '-b:v:1', '800k', '-maxrate:v:1', '900k', '-bufsize:v:1', '1600k',
      '-map', 'a:0', '-map', 'a:0', '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
      '-var_stream_map', 'v:0,a:0 v:1,a:1', ...hlsOut];
    // Sans audio (repli si la vidéo est muette)
    const noAudio = [...common,
      '-map', '[v1o]', '-c:v:0', 'libx264', '-b:v:0', '300k',
      '-map', '[v2o]', '-c:v:1', 'libx264', '-b:v:1', '800k',
      '-var_stream_map', 'v:0 v:1', ...hlsOut];

    try { await run(withAudio, work); }
    catch (_) { await run(noAudio, work); }

    // Envoie playlists + segments dans le même dossier (références relatives)
    const files = (await fs.promises.readdir(work)).filter((f) => f !== 'in.mp4');
    if (!files.includes('master.m3u8')) throw new Error('master.m3u8 manquant');
    const base = `videos/${creatorId}/${videoId}/hls`;
    for (const f of files) {
      const data = await fs.promises.readFile(path.join(work, f));
      const ct = f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
      const { error } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(`${base}/${f}`, data, { contentType: ct, upsert: true });
      if (error) throw new Error(`upload ${f}: ${error.message}`);
    }

    const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(`${base}/master.m3u8`);
    const { error: upErr } = await supabaseAdmin
      .from('videos').update({ hls_url: pub.publicUrl }).eq('id', videoId);
    if (upErr) console.error('[HLS] hls_url non enregistrée (migration manquante ?):', upErr.message);
    else console.log(`[HLS] ${videoId} prêt en ${Math.round((Date.now() - started) / 1000)}s (240p+480p adaptatif)`);
  } finally {
    fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Faststart : déplace l'index du MP4 (moov) AU DÉBUT du fichier ──────
// Les MP4 compressés sur Android ont leur index à la FIN : le lecteur doit
// faire plusieurs allers-retours réseau avant de démarrer (1-3 s perdues à
// chaque première lecture). Ce remux (copie de flux, PAS de ré-encodage,
// quelques secondes) permet au lecteur de démarrer dès les premiers octets.
// Renvoie le nouveau buffer, ou null si ffmpeg absent / échec (on garde
// alors le fichier d'origine — jamais bloquant).
async function faststart(buffer) {
  if (!ffmpegPath || !buffer) return null;
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fast-'));
  try {
    const input = path.join(work, 'in.mp4');
    const output = path.join(work, 'out.mp4');
    await fs.promises.writeFile(input, buffer);
    await run(['-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', output], work);
    const out = await fs.promises.readFile(output);
    return out.length > 0 ? out : null;
  } catch (e) {
    console.warn('[Faststart] remux impossible (fichier d\'origine conservé):', e.message);
    return null;
  } finally {
    fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Version LÉGÈRE 480p (MP4 unique, cachable, acceptée par le bucket) ──────
// L'app télécharge cette version quand la connexion est lente (peu de data,
// chargement rapide), et le MP4 d'origine (HD) quand la connexion est bonne.
// Contrairement au HLS (.m3u8 refusé par le bucket), un MP4 en video/mp4 passe.
async function transcodeLight(videoId, creatorId, buffer) {
  const started = Date.now();
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'light-'));
  try {
    const input = path.join(work, 'in.mp4');
    const output = path.join(work, 'light.mp4');
    await fs.promises.writeFile(input, buffer);
    // 480p, CRF 28 (bonne compression), faststart pour démarrage rapide.
    await run([
      '-y', '-i', input,
      '-vf', 'scale=-2:480',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart',
      output,
    ], work);
    const data = await fs.promises.readFile(output);
    if (!data.length) throw new Error('sortie vide');
    const dest = `videos/${creatorId}/${videoId}/light.mp4`;
    const { error: upErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(dest, data, { contentType: 'video/mp4', upsert: true });
    if (upErr) throw new Error(`upload light.mp4: ${upErr.message}`);
    const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(dest);
    // On réutilise la colonne hls_url pour stocker l'URL de la version légère.
    const { error: dbErr } = await supabaseAdmin
      .from('videos').update({ hls_url: pub.publicUrl }).eq('id', videoId);
    if (dbErr) console.error('[Light] URL non enregistrée (migration ?):', dbErr.message);
    else console.log(`[Light] ${videoId} 480p prêt en ${Math.round((Date.now() - started) / 1000)}s (${Math.round(data.length / 1024)} Ko)`);
  } finally {
    fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

function enqueueLight(videoId, creatorId, buffer) {
  if (!ffmpegPath || !buffer || !videoId) return;
  chain = chain
    .then(() => transcodeLight(videoId, creatorId, buffer))
    .catch((e) => console.error('[Light]', videoId, 'échec (l\'app lit le MP4 HD):', e.message));
}

// ── Rattrapage : génère la version 480p des vidéos qui n'en ont pas encore ──
// 2 vidéos par passe (préserve le CPU B1), re-vérifie toutes les 10 minutes.
let backfillRunning = false;
async function backfillLight() {
  if (!ffmpegPath || backfillRunning) return;
  backfillRunning = true;
  try {
    const { data: vids, error } = await supabaseAdmin
      .from('videos')
      .select('id, creator_id, storage_path')
      .eq('status', 'published')
      .is('hls_url', null)
      .order('created_at', { ascending: false })
      .limit(2);
    if (error || !vids || vids.length === 0) return;
    console.log(`[Light] rattrapage : ${vids.length} vidéo(s) sans version 480p`);
    for (const v of vids) {
      if (!v.storage_path) continue;
      const { data: file, error: dlErr } = await supabaseAdmin.storage
        .from(BUCKET)
        .download(v.storage_path);
      if (dlErr || !file) continue;
      enqueueLight(v.id, v.creator_id, Buffer.from(await file.arrayBuffer()));
    }
    await chain; // attend la fin de la passe avant d'autoriser la suivante
  } catch (e) {
    console.error('[Light] rattrapage erreur:', e.message);
  } finally {
    backfillRunning = false;
  }
}

// ── Pré-traitement à l'upload : TRIM (couper début/fin) + MUSIQUE ───────────
// Rapide sur un petit serveur : la vidéo est COPIÉE sans ré-encodage
// (-c:v copy) ; seule la piste audio est ré-encodée quand on mixe une musique.
// Renvoie le nouveau buffer, ou null si rien à faire / échec (on garde alors
// le fichier d'origine — jamais bloquant).
async function preprocess(buffer, { trimStart = 0, trimEnd = 0, musicUrl = null } = {}) {
  if (!ffmpegPath || !buffer) return null;
  const hasTrim = trimStart > 0 || trimEnd > 0;
  if (!hasTrim && !musicUrl) return null;
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'prep-'));
  try {
    const input = path.join(work, 'in.mp4');
    const output = path.join(work, 'out.mp4');
    await fs.promises.writeFile(input, buffer);

    let musicPath = null;
    if (musicUrl) {
      const resp = await fetch(musicUrl);
      if (resp.ok) {
        musicPath = path.join(work, 'music.mp4');
        await fs.promises.writeFile(musicPath, Buffer.from(await resp.arrayBuffer()));
      }
    }

    const seek = [];
    if (hasTrim) {
      if (trimStart > 0) seek.push('-ss', String(trimStart));
      if (trimEnd > trimStart) seek.push('-t', String(trimEnd - trimStart));
    }

    if (musicPath) {
      const mixArgs = [
        '-y', ...seek, '-i', input, '-i', musicPath,
        '-filter_complex', '[1:a]volume=0.6[m];[0:a][m]amix=inputs=2:duration=first[a]',
        '-map', '0:v', '-map', '[a]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart', output,
      ];
      try {
        await run(mixArgs, work);
      } catch (_) {
        // Vidéo sans piste audio → on REMPLACE l'audio par la musique.
        await run([
          '-y', ...seek, '-i', input, '-i', musicPath,
          '-map', '0:v', '-map', '1:a',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
          '-shortest', '-movflags', '+faststart', output,
        ], work);
      }
    } else {
      // Trim seul : copie de flux (très rapide, coupe au plus proche keyframe).
      await run(['-y', ...seek, '-i', input, '-c', 'copy', '-movflags', '+faststart', output], work);
    }

    const out = await fs.promises.readFile(output);
    return out.length > 0 ? out : null;
  } catch (e) {
    console.warn('[Prep] trim/musique impossible (fichier d\'origine conservé):', e.message);
    return null;
  } finally {
    fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Duo / Stitch : compose la vidéo de l'utilisateur avec la vidéo source ────
// Best-effort : si ffmpeg échoue (codecs, pas d'audio…), on garde le clip de
// l'utilisateur tel quel (publié et crédité). Jamais bloquant.
async function _download(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`download source ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function _compose(mode, sourceBuf, clipBuf) {
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'compose-'));
  try {
    const src = path.join(work, 'src.mp4');
    const clip = path.join(work, 'clip.mp4');
    const out = path.join(work, 'out.mp4');
    await fs.promises.writeFile(src, sourceBuf);
    await fs.promises.writeFile(clip, clipBuf);
    let filter;
    if (mode === 'duet') {
      // Côte à côte (même hauteur 640), audio mixé.
      filter =
        '[0:v]scale=-2:640,setsar=1[l];[1:v]scale=-2:640,setsar=1[r];' +
        '[l][r]hstack=inputs=2[v];' +
        '[0:a][1:a]amix=inputs=2:duration=shortest[a]';
    } else {
      // Stitch : source PUIS clip, dans un même cadre 720x1280.
      const norm =
        'scale=720:1280:force_original_aspect_ratio=decrease,' +
        'pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1';
      filter =
        `[0:v]${norm}[v0];[1:v]${norm}[v1];[v0][v1]concat=n=2:v=1:a=0[v];` +
        '[0:a][1:a]concat=n=2:v=0:a=1[a]';
    }
    await run([
      '-y', '-i', src, '-i', clip,
      '-filter_complex', filter,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      out,
    ], work);
    const data = await fs.promises.readFile(out);
    if (!data.length) throw new Error('sortie vide');
    return data;
  } finally {
    fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function composeAndSwap(videoId, creatorId, clipBuffer, sourceUrl, mode) {
  const sourceBuf = await _download(sourceUrl);
  const composed = await _compose(mode, sourceBuf, clipBuffer);
  const dest = `videos/${creatorId}/${videoId}/${mode}.mp4`;
  const { error: upErr } = await supabaseAdmin.storage
    .from(BUCKET).upload(dest, composed, { contentType: 'video/mp4', upsert: true });
  if (upErr) throw new Error(`upload ${mode}: ${upErr.message}`);
  const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(dest);
  // La vidéo devient la version composée ; hls_url remis à null → le
  // rattrapage régénère la version légère plus tard.
  await supabaseAdmin.from('videos')
    .update({ video_url: pub.publicUrl, storage_path: dest, hls_url: null })
    .eq('id', videoId);
  console.log(`[${mode}] ${videoId} composé (${Math.round(composed.length / 1024)} Ko)`);
}

function enqueueCompose(videoId, creatorId, clipBuffer, sourceUrl, mode) {
  if (!ffmpegPath || !clipBuffer || !videoId || !sourceUrl) return;
  chain = chain
    .then(() => composeAndSwap(videoId, creatorId, clipBuffer, sourceUrl, mode))
    .catch((e) => console.error(`[${mode}]`, videoId, 'échec (clip conservé):', e.message));
}

if (ffmpegPath) {
  setTimeout(backfillLight, 60 * 1000); // 1 min après le boot
  const t = setInterval(backfillLight, 10 * 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = { enqueueHls, enqueueLight, faststart, backfillLight, enqueueCompose, preprocess, isConfigured: () => !!ffmpegPath };
