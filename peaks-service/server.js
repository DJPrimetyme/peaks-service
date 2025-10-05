// server.js — peaks microservice for Railway + Bunny
// Node 20+, ESM

import express from 'express';
import cors from 'cors';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;

// Bunny Storage / CDN
const BUNNY_STORAGE_NAME = reqEnv('BUNNY_STORAGE_NAME'); // e.g. "markcutz"
const BUNNY_ACCESS_KEY   = reqEnv('BUNNY_ACCESS_KEY');   // Storage Password
const BUNNY_FOLDER       = process.env.BUNNY_FOLDER || 'waveforms';
const CDN_HOST           = reqEnv('CDN_HOST');           // e.g. "markcutz-mixes.b-cdn.net"
const PLAYER_HOST        = process.env.PLAYER_HOST || CDN_HOST;

// Bunny Storage HTTP endpoint (global works for PUT; LA also fine)
const BUNNY_STORAGE_HOST = process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com';

// ---------- Small utils ----------
function reqEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}
function tmpFile(ext = '') {
  const id = crypto.randomBytes(8).toString('hex');
  return path.join(os.tmpdir(), `${id}${ext}`);
}
function slugify(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    || `mix-${Date.now()}`;
}

// Force host, de-double-encode, encode once
function cleanSourceUrl(u) {
  let s = String(u || '').trim();

  try {
    const url = new URL(s);
    url.hostname = PLAYER_HOST;
    s = url.toString();
  } catch {
    s = s.replace(/^https?:\/\/(MarkcutzMusic|markcutzmusic)\.b-cdn\.net/i,
                  `https://${PLAYER_HOST}`);
  }
  try { s = decodeURIComponent(s); } catch {}
  s = encodeURI(s);
  return s;
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url, {
    headers: {
      // Help when referrer checks are enabled
      'User-Agent': 'peaks-service/1.0',
      'Referer': 'https://www.markcutz.com/admin-peaks'
    }
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed ${res.status} ${res.statusText}`);
  }
  const nodeStream = Readable.fromWeb(res.body);
  await pipeline(nodeStream, fs.createWriteStream(destPath));
  return destPath;
}

// Run bbc/audiowaveform to raw JSON (8-bit) then normalize to [-1..1]
function runAudiowaveform(inputFile, outJsonFile, pixels = 4000) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputFile,
      '--output-format', 'json',
      '-o', outJsonFile,
      '--pixels', String(pixels),
      '--bits', '8',
      '--no-progress'
    ];
    const proc = spawn('audiowaveform', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => reject(new Error(
      `audiowaveform spawn failed: ${err.message}. Is it installed?`
    )));
    proc.on('close', code => {
      if (code === 0) resolve(outJsonFile);
      else reject(new Error(`audiowaveform exited ${code}: ${stderr.trim()}`)));
    });
  });
}

async function convertRawJsonToPeaks(rawJsonPath, outPeaksPath) {
  const raw = JSON.parse(await fsp.readFile(rawJsonPath, 'utf8'));
  const data = raw.data || raw.samples || [];
  const peaks = Array.from(data, (v) => {
    const n = Number(v);
    const clamped = Math.max(0, Math.min(255, isFinite(n) ? n : 128));
    return (clamped - 128) / 128; // [-1..~0.99]
  });
  await fsp.writeFile(outPeaksPath, JSON.stringify(peaks));
  return outPeaksPath;
}

// Upload buffer to Bunny Storage (HTTP API, AccessKey header)
async function uploadToBunnyStorage(filename, buffer, contentType = 'application/json') {
  const url = `https://${BUNNY_STORAGE_HOST}/${BUNNY_STORAGE_NAME}/${BUNNY_FOLDER}/${filename}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'AccessKey': BUNNY_ACCESS_KEY, 'Content-Type': contentType },
    body: buffer
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Bunny upload failed ${res.status}: ${text}`);
  }
  return `https://${CDN_HOST}/${BUNNY_FOLDER}/${filename}`;
}

// ---------- Routes ----------
app.get('/', (_req, res) => res.type('text').send('peaks-service up'));
app.get('/health', (_req, res) => res.type('text').send('ok'));

/**
 * POST /peaks
 * body: { sourceUrl: string, outName?: string, pixels?: number }
 */
app.post('/peaks', async (req, res) => {
  const t0 = Date.now();
  let tmpIn, tmpRaw, tmpPeaks;

  try {
    const { sourceUrl, outName, pixels } = req.body || {};
    if (!sourceUrl || typeof sourceUrl !== 'string') {
      return res.status(400).json({ error: 'Missing body.sourceUrl' });
    }

    const finalUrl = cleanSourceUrl(sourceUrl);
    const PIXELS = Math.max(1000, Math.min(16000, Number(pixels) || 4000));

    // Fast HEAD check to give a precise error + URL
    const head = await fetch(finalUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': 'peaks-service/1.0', 'Referer': 'https://www.markcutz.com/admin-peaks' }
    });
    if (!head.ok) {
      return res.status(404).json({ error: `Source not reachable (${head.status}). URL: ${finalUrl}` });
    }

    // Work files
    tmpIn    = tmpFile('.mp3');
    tmpRaw   = tmpFile('.raw.json');
    tmpPeaks = tmpFile('.peaks.json');

    // 1) Download MP3
    await downloadToFile(finalUrl, tmpIn);

    // 2) Raw waveform
    await runAudiowaveform(tmpIn, tmpRaw, PIXELS);

    // 3) Normalize to WS peaks
    await convertRawJsonToPeaks(tmpRaw, tmpPeaks);

    // 4) Upload
    const base = outName ? slugify(outName) : slugify(path.parse(finalUrl).name);
    const filename = `${base}.peaks.json`;
    const buffer   = await fsp.readFile(tmpPeaks);
    const cdnUrl   = await uploadToBunnyStorage(filename, buffer, 'application/json');

    const ms = Date.now() - t0;
    const count = JSON.parse(buffer.toString()).length;
    return res.json({ ok: true, cdnUrl, count, ms });
  } catch (err) {
    console.error('[peaks] error', err);
    return res.status(500).json({ error: String(err?.message || err) });
  } finally {
    for (const f of [tmpIn, tmpRaw, tmpPeaks]) { if (f) fsp.unlink(f).catch(() => {}); }
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`peaks-service listening on :${PORT}`);
  console.log(`Using Bunny host: ${BUNNY_STORAGE_HOST} (zone=${BUNNY_STORAGE_NAME}, folder=${BUNNY_FOLDER})`);
});
