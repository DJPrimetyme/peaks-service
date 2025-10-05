// server.js
// Minimal peaks microservice for Railway + Bunny Storage
// ESM module (package.json should include: { "type": "module" })

import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;

const BUNNY_STORAGE_NAME = process.env.BUNNY_STORAGE_NAME; // e.g. "markcutz"
const BUNNY_FOLDER       = process.env.BUNNY_FOLDER || 'waveforms';
const BUNNY_ACCESS_KEY   = process.env.BUNNY_ACCESS_KEY;   // Storage Password
const CDN_HOST           = process.env.CDN_HOST;           // e.g. "markcutz-mixes.b-cdn.net"
const BUNNY_STORAGE_HOST = process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com';
const DOWNLOAD_REFERER   = process.env.DOWNLOAD_REFERER || 'https://www.markcutz.com/';

// ---------- APP ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => res.type('text').send('peaks-service up'));
app.get('/health', (_req, res) => res.type('text').send('ok'));

// ---------- Helpers ----------
function reqEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}
function tmpFile(ext = '') {
  const id = crypto.randomBytes(8).toString('hex');
  return path.join(os.tmpdir(), `${id}${ext}`);
}
function slugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '') || `mix-${Date.now()}`;
}

// Decode once if double-encoded (%2520 etc.), then return the string
function decodeOnce(u) {
  const s = String(u).trim();
  if (/%25[0-9A-Fa-f]{2}/.test(s)) {
    try { return decodeURI(s); } catch {}
  }
  return s;
}

// Normalize path: decode once then encode once
function singleEncodeUrl(u) {
  const raw = decodeOnce(u);
  const url = new URL(raw);
  try {
    url.pathname = encodeURI(decodeURI(url.pathname));
  } catch {
    url.pathname = encodeURI(url.pathname);
  }
  return url.toString();
}

async function headOk(url) {
  const r = await fetch(url, {
    method: 'HEAD',
    headers: { Referer: DOWNLOAD_REFERER, 'User-Agent': 'peaks-service/1.0' },
  });
  return r.ok;
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url, {
    headers: { Referer: DOWNLOAD_REFERER, 'User-Agent': 'peaks-service/1.0' },
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`Download failed ${res.status} ${res.statusText}${text ? ` — ${text.slice(0,120)}` : ''}`);
  }
  const readable = Readable.fromWeb(res.body);
  await pipeline(readable, fs.createWriteStream(destPath));
  return destPath;
}

// Invoke bbc/audiowaveform
function runAudiowaveform(inputFile, outJsonFile, pixels = 4000) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputFile,
      '--output-format', 'json',
      '-o', outJsonFile,
      '--pixels', String(pixels),
      '--bits', '8',
      '--no-progress',
    ];
    const proc = spawn('audiowaveform', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`audiowaveform spawn failed: ${err.message}. Is it installed?`)));
    proc.on('close', (code) => {
      if (code === 0) return resolve(outJsonFile);
      reject(new Error(`audiowaveform exited ${code}: ${stderr.trim()}`));
    });
  });
}

// Convert AW 8-bit JSON data -> normalized floats [-1..1]
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

// Upload to Bunny Storage via HTTP API (AccessKey)
async function uploadToBunnyStorage(filename, buffer, contentType = 'application/json') {
  const zone = reqEnv('BUNNY_STORAGE_NAME');
  const host = BUNNY_STORAGE_HOST; // e.g. storage.bunnycdn.com or la.storage.bunnycdn.com
  const url  = `https://${host}/${zone}/${BUNNY_FOLDER}/${filename}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'AccessKey': reqEnv('BUNNY_ACCESS_KEY'),
      'Content-Type': contentType,
    },
    body: buffer
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Bunny upload failed ${res.status}: ${text}`);
  }

  // Return CDN URL for public access
  const cdn = reqEnv('CDN_HOST');
  return `https://${cdn}/${BUNNY_FOLDER}/${filename}`;
}

// ---------- Route ----------
/**
 * POST /peaks
 * body: { sourceUrl: string, outName?: string, pixels?: number }
 */
app.post('/peaks', async (req, res) => {
  const t0 = Date.now();
  let tmpIn, tmpRaw, tmpPeaks;

  try {
    // Ensure envs exist
    reqEnv('BUNNY_STORAGE_NAME'); reqEnv('BUNNY_ACCESS_KEY'); reqEnv('CDN_HOST');

    const { sourceUrl, outName, pixels } = req.body || {};
    if (!sourceUrl || typeof sourceUrl !== 'string') {
      return res.status(400).json({ error: 'Missing body.sourceUrl' });
    }

    // Normalize incoming URL to avoid 404 from double-encoding
    const normalizedUrl = singleEncodeUrl(sourceUrl);
    const PIXELS = Math.max(1000, Math.min(16000, Number(pixels) || 4000));

    // Optional HEAD probe (clearer error than a stream failure)
    const ok = await headOk(normalizedUrl);
    if (!ok) {
      return res.status(404).json({ error: 'Download failed 404 Not Found' });
    }

    // Prepare temp files
    tmpIn    = tmpFile('.mp3');
    tmpRaw   = tmpFile('.raw.json');
    tmpPeaks = tmpFile('.peaks.json');

    // 1) Download MP3
    await downloadToFile(normalizedUrl, tmpIn);

    // 2) Generate raw waveform JSON
    await runAudiowaveform(tmpIn, tmpRaw, PIXELS);

    // 3) Convert to normalized peaks array
    await convertRawJsonToPeaks(tmpRaw, tmpPeaks);

    // 4) Upload to Bunny
    const base = outName ? slugify(outName) : slugify(path.parse(new URL(normalizedUrl).pathname).name);
    const filename = `${base}.peaks.json`;
    const buffer   = await fsp.readFile(tmpPeaks);
    const cdnUrl   = await uploadToBunnyStorage(filename, buffer, 'application/json');

    const elapsedMs = Date.now() - t0;
    const count = JSON.parse(buffer.toString()).length;

    return res.json({ ok: true, cdnUrl, count, ms: elapsedMs });
  } catch (err) {
    console.error('[peaks] error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  } finally {
    for (const f of [tmpIn, tmpRaw, tmpPeaks]) {
      if (f) fsp.unlink(f).catch(() => {});
    }
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`peaks-service listening on :${PORT}`);
  console.log(`Using Bunny host: ${BUNNY_STORAGE_HOST}`);
});
