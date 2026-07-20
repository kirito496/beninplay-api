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

// ── Rattrapage : vidéos publiées AVANT l'activation du HLS (hls_url vide) ──
// Convertit 2 vidéos par passe (préserve le CPU du plan B1), re-vérifie
// toutes les 10 minutes jusqu'à ce que tout le catalogue soit adaptatif.
let backfillRunning = false;
async function backfillHls() {
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
    console.log(`[HLS] rattrapage : ${vids.length} vidéo(s) sans version adaptative`);
    for (const v of vids) {
      if (!v.storage_path) continue;
      const { data: file, error: dlErr } = await supabaseAdmin.storage
        .from(BUCKET)
        .download(v.storage_path);
      if (dlErr || !file) continue;
      enqueueHls(v.id, v.creator_id, Buffer.from(await file.arrayBuffer()));
    }
    await chain; // attend la fin de la passe avant d'autoriser la suivante
  } catch (e) {
    console.error('[HLS] rattrapage erreur:', e.message);
  } finally {
    backfillRunning = false;
  }
}

// Rattrapage HLS DÉSACTIVÉ par défaut : l'app lit désormais le MP4 (mis en
// cache disque sur le téléphone), le HLS n'est plus utilisé. En plus, le
// bucket Supabase refuse le type MIME des playlists .m3u8, donc la génération
// échouait en boucle. Réactivable via ENABLE_HLS=true (si un jour le bucket
// autorise application/vnd.apple.mpegurl et video/mp2t).
if (ffmpegPath && process.env.ENABLE_HLS === 'true') {
  setTimeout(backfillHls, 60 * 1000); // 1 min après le boot
  const t = setInterval(backfillHls, 10 * 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = { enqueueHls, faststart, backfillHls, isConfigured: () => !!ffmpegPath };
