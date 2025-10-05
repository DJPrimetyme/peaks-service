// server.js
// Minimal peaks microservice for Railway + Bunny Storage

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

// Bunny config (required)
const BUNNY_STORAGE_NAME = process.env.BUNNY_STORAGE_NAME; // e.g. "markcutz"
const BUNNY_FOLDER       = process.env.BUNNY_FOLDER || 'waveforms';
const BUNNY_ACCESS_KEY   = process.env.BUNNY_ACCESS_KEY;   // Storage Password
const CDN_HOST           = process.env.CDN_HOST;           // e.g. "markcutz-mixes.b-cdn.net"

// Use the *regional* host that worked for you:
const BUNNY_STORAGE_HOST = process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com';

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
  const f  = path.join(os.tmpdir(), `${id}${ext}`);
  return f;
}

function slugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    || `mix-${Date.now()}`;
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed ${res.status} ${res.statusText}`);
  }
  // Convert Web ReadableStream -> Node stream for pipeline
  const readable = Readable.fromWeb(res.body);
  await pipeline(readable, fs.createWriteStream(destPath));
  return destPath;
}

/**
 * Run bbc/audiowaveform to create a JSON file with peaks.
 * @returns {Promise<string>} path to raw JSON file produced by audiowaveform
 */
// replace your runAudiowaveform() with this version
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

    // ⬇️ this line is the important new bit
    proc.on('error', (err) => reject(new Error(`audiowaveform spawn failed: ${err.message}. Is it installed in the image?`)));

    proc.on('close', (code) => {
      if (code === 0) return resolve(outJsonFile);
      reject(new Error(`audiowaveform exited ${code}: ${stderr.trim()}`));
    });
  });
}


/**
 * Convert audiowaveform 8-bit JSON -> normalized float array [-1..1]
 * Output is a plain array so WaveSurfer can use it directly.
 */
async function convertRawJsonToPeaks(rawJsonPath, outPeaksPath) {
  const raw = JSON.parse(await fsp.readFile(rawJsonPath, 'utf8'));
  const data = raw.data || raw.samples || [];
  // audiowaveform 8-bit is unsigned [0..255] where 128 is center
  const peaks = Array.from(data, (v) => {
    const n = Number(v);
    // clamp and normalize
    const clamped = Math.max(0, Math.min(255, isFinite(n) ? n : 128));
    return (clamped - 128) / 128; // -> [-1..~0.99]
  });

  await fsp.writeFile(outPeaksPath, JSON.stringify(peaks));
  return outPeaksPath;
}

/**
 * Upload a file Buffer to Bunny Storage using the HTTP API (AccessKey header)
 * Returns the *public CDN URL*.
 */
async function uploadToBunnyStorage(filename, buffer, contentType = 'application/json') {
  const zone  = reqEnv('BUNNY_STORAGE_NAME');
  const host  = BUNNY_STORAGE_HOST; // regional host works for your zone
  const url   = `https://${host}/${zone}/${BUNNY_FOLDER}/${filename}`;

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

  // Build CDN URL for public access
  const cdn = reqEnv('CDN_HOST');
  return `https://${cdn}/${BUNNY_FOLDER}/${filename}`;
}

// ---------- Routes ----------
/**
 * POST /peaks
 * body: { sourceUrl: string, outName?: string, pixels?: number }
 * returns: { ok: true, cdnUrl: string, count: number }
 */
app.post('/peaks', async (req, res) => {
  const t0 = Date.now();
  let tmpIn, tmpRaw, tmpPeaks;

  try {
    // Validate envs early
    reqEnv('BUNNY_STORAGE_NAME');
    reqEnv('BUNNY_ACCESS_KEY');
    reqEnv('CDN_HOST');

    const { sourceUrl, outName, pixels } = req.body || {};
    if (!sourceUrl || typeof sourceUrl !== 'string') {
      return res.status(400).json({ error: 'Missing body.sourceUrl' });
    }
    const PIXELS = Math.max(1000, Math.min(16000, Number(pixels) || 4000));

    // Prepare temp files
    tmpIn    = tmpFile('.mp3');
    tmpRaw   = tmpFile('.raw.json');
    tmpPeaks = tmpFile('.peaks.json');

    // 1) Download MP3
    await downloadToFile(sourceUrl, tmpIn);

    // 2) Generate raw waveform JSON
    await runAudiowaveform(tmpIn, tmpRaw, PIXELS);

    // 3) Convert to normalized peaks array
    await convertRawJsonToPeaks(tmpRaw, tmpPeaks);

    // 4) Upload to Bunny
    const base = outName ? slugify(outName) : slugify(path.parse(sourceUrl).name);
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
    // Cleanup
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
