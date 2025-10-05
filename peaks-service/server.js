// server.js — peaks microservice using ffmpeg (no audiowaveform dependency)

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;

// Bunny Storage config
const BUNNY_STORAGE_NAME = process.env.BUNNY_STORAGE_NAME; // e.g. "markcutz"
const BUNNY_FOLDER       = process.env.BUNNY_FOLDER || 'waveforms';
const BUNNY_ACCESS_KEY   = process.env.BUNNY_ACCESS_KEY;   // Storage "Password"
const CDN_HOST           = process.env.CDN_HOST;           // e.g. "markcutz-mixes.b-cdn.net"

// Use regional host if you want (fallback to global)
const BUNNY_STORAGE_HOST = process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com';

// Optional: used as Referer when downloading from Bunny CDN (to satisfy Allowed Referrers)
const ALLOWED_REFERRER   = process.env.ALLOWED_REFERRER || 'https://www.markcutz.com';

// ffmpeg settings
const RESAMPLE_RATE = 11025; // mono PCM rate for peak calc
const MAX_PIXELS    = 16000;
const MIN_PIXELS    = 1000;

// ---------- APP ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => res.type('text').send('peaks-service up'));
app.get('/health', (_req, res) => res.type('text').send('ok'));

// ---------- helpers ----------
function reqEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function tmpFile(ext = '') {
  const id = crypto.randomBytes(8).toString('hex');
  return path.join(os.tmpdir(), `${id}${ext}`);
}

// Normalize the MP3 source URL coming from Wix/Bunny
function normalizeSourceUrl(u) {
  if (!u) return '';
  let s = String(u).trim();

  // Force your player CDN host (case-insensitive variants)
  s = s.replace(/^https:\/\/MarkcutzMusic\.b-cdn\.net/i, `https://${CDN_HOST}`)
       .replace(/^https:\/\/markcutzmusic\.b-cdn\.net/i, `https://${CDN_HOST}`);

  // Ensure host is exactly your player host
  try {
    const url = new URL(s);
    url.hostname = CDN_HOST; // e.g. markcutz-mixes.b-cdn.net
    // Keep the exact path but encode spaces and @ etc.
    url.pathname = encodeURI(url.pathname);
    return url.toString();
  } catch {
    // fallback: encode spaces
    return encodeURI(s.replace('https://MarkcutzMusic.b-cdn.net', `https://${CDN_HOST}`));
  }
}

async function downloadToFile(url, destPath) {
  // Add a Referer header because your Bunny “Allowed referrers” is enabled
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'peaks-service/1.0',
      'Accept': '*/*',
      'Referer': ALLOWED_REFERRER
    }
  });

  if (!res.ok || !res.body) {
    throw new Error(`Download failed ${res.status} ${res.statusText}`);
  }
  const readable = Readable.fromWeb(res.body);
  await pipeline(readable, fs.createWriteStream(destPath));
  return destPath;
}

// Get duration (seconds) by ffprobe
function ffprobeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      filePath
    ];
    const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '', err = '';
    proc.stdout.on('data', d => (out += d.toString()));
    proc.stderr.on('data', d => (err += d.toString()));
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${err}`));
      const dur = parseFloat(out.trim());
      if (!isFinite(dur) || dur <= 0) return reject(new Error('ffprobe returned invalid duration'));
      resolve(dur);
    });
  });
}

// Stream PCM from ffmpeg and compute peaks
async function computePeaksWithFfmpeg(inputFile, outPeaksJsonPath, pixels) {
  // 1) Determine duration to set a fixed bin size
  const durationSec = await ffprobeDuration(inputFile);
  const totalSamples = Math.max(1, Math.floor(RESAMPLE_RATE * durationSec));
  const bins = Math.max(MIN_PIXELS, Math.min(MAX_PIXELS, pixels || 4000));
  const samplesPerBin = Math.max(1, Math.floor(totalSamples / bins));

  // 2) Spawn ffmpeg to produce 16-bit mono PCM at RESAMPLE_RATE to stdout
  const args = [
    '-hide_banner',
    '-nostdin',
    '-i', inputFile,
    '-ac', '1',
    '-ar', String(RESAMPLE_RATE),
    '-f', 's16le',
    'pipe:1'
  ];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  ff.stderr.on('data', d => (stderr += d.toString()));

  const peaks = [];
  let binMax = 0;
  let samplesInBin = 0;
  let leftover = Buffer.alloc(0);

  await new Promise((resolve, reject) => {
    ff.on('error', (e) => reject(new Error(`ffmpeg spawn failed: ${e.message}`)));

    ff.stdout.on('data', chunk => {
      // Prepend any leftover bytes to make full samples
      let buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;

      // 2 bytes per sample (signed 16-bit little endian)
      const usable = buf.length - (buf.length % 2); // drop last odd byte
      leftover = buf.subarray(usable);              // carry for next chunk

      for (let i = 0; i < usable; i += 2) {
        // signed int16
        const sample = buf.readInt16LE(i);
        const abs = Math.abs(sample);
        if (abs > binMax) binMax = abs;
        samplesInBin++;

        if (samplesInBin >= samplesPerBin) {
          // normalize to [-1..1], positive side only for mirrored display
          peaks.push(Math.min(1, binMax / 32767));
          binMax = 0;
          samplesInBin = 0;
        }
      }
    });

    ff.stdout.on('end', () => {
      // flush last bin
      if (samplesInBin > 0) {
        peaks.push(Math.min(1, binMax / 32767));
      }
      resolve();
    });

    ff.on('close', code => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
      }
    });
  });

  // If we ended up with a few more/less than desired bins (rounding), resample length
  if (peaks.length !== bins && peaks.length > 0) {
    const normalized = new Array(bins);
    for (let i = 0; i < bins; i++) {
      const idx = Math.floor((i / bins) * peaks.length);
      normalized[i] = peaks[Math.min(idx, peaks.length - 1)];
    }
    await fsp.writeFile(outPeaksJsonPath, JSON.stringify(normalized));
    return { count: normalized.length };
  }

  await fsp.writeFile(outPeaksJsonPath, JSON.stringify(peaks));
  return { count: peaks.length };
}

// Upload a Buffer to Bunny Storage using HTTP API (AccessKey)
async function uploadToBunnyStorage(filename, buffer, contentType = 'application/json') {
  const zone = reqEnv('BUNNY_STORAGE_NAME');
  const url  = `https://${BUNNY_STORAGE_HOST}/${zone}/${BUNNY_FOLDER}/${filename}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'AccessKey': reqEnv('BUNNY_ACCESS_KEY'),
      'Content-Type': contentType
    },
    body: buffer
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Bunny upload failed ${res.status}: ${text}`);
  }

  // Public CDN URL
  const cdn = reqEnv('CDN_HOST');
  return `https://${cdn}/${BUNNY_FOLDER}/${filename}`;
}

// ---------- Routes ----------
/**
 * POST /peaks
 * body: { sourceUrl: string, outName?: string, pixels?: number }
 * returns: { ok: true, cdnUrl, count, ms }
 */
app.post('/peaks', async (req, res) => {
  const t0 = Date.now();
  let tmpIn, tmpPeaks;

  try {
    reqEnv('BUNNY_STORAGE_NAME');
    reqEnv('BUNNY_ACCESS_KEY');
    reqEnv('CDN_HOST');

    const sourceUrlRaw = req.body?.sourceUrl;
    if (!sourceUrlRaw || typeof sourceUrlRaw !== 'string') {
      return res.status(400).json({ error: 'Missing body.sourceUrl' });
    }

    const sourceUrl = normalizeSourceUrl(sourceUrlRaw);
    const pixels = Number(req.body?.pixels) || 4000;
    const baseName =
      (req.body?.outName && String(req.body.outName).trim()) ||
      path.parse(new URL(sourceUrl).pathname).name ||
      `mix-${Date.now()}`;

    // make a sluggy filename
    const safeBase = String(baseName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)+/g, '') || `mix-${Date.now()}`;
    const filename = `${safeBase}.peaks.json`;

    // temp paths
    tmpIn    = tmpFile('.mp3');
    tmpPeaks = tmpFile('.peaks.json');

    // 1) download MP3 (with Referer)
    await downloadToFile(sourceUrl, tmpIn);

    // 2) compute peaks via ffmpeg
    const { count } = await computePeaksWithFfmpeg(tmpIn, tmpPeaks, pixels);

    // 3) upload to Bunny Storage
    const buffer = await fsp.readFile(tmpPeaks);
    const cdnUrl = await uploadToBunnyStorage(filename, buffer, 'application/json');

    const ms = Date.now() - t0;
    return res.json({ ok: true, cdnUrl, count, ms });
  } catch (err) {
    console.error('[peaks] error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  } finally {
    // cleanup
    for (const f of [tmpIn, tmpPeaks]) {
      if (f) fsp.unlink(f).catch(() => {});
    }
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`peaks-service listening on :${PORT}`);
  console.log(`Using Bunny host: ${BUNNY_STORAGE_HOST}`);
});
