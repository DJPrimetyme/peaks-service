// Minimal peaks microservice for Railway + Bunny Storage (FFmpeg version)

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

const PORT = process.env.PORT || 3000;

// Bunny config (required)
const BUNNY_STORAGE_NAME = process.env.BUNNY_STORAGE_NAME; // e.g. "markcutz"
const BUNNY_FOLDER       = process.env.BUNNY_FOLDER || 'waveforms';
const BUNNY_ACCESS_KEY   = process.env.BUNNY_ACCESS_KEY;   // Storage Password
const CDN_HOST           = process.env.CDN_HOST;           // e.g. "markcutz-mixes.b-cdn.net"
const BUNNY_STORAGE_HOST = process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => res.type('text').send('peaks-service up'));
app.get('/health', (_req, res) => res.type('text').send('ok'));

function reqEnv(name){
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}
function tmpFile(ext = ''){
  const id = crypto.randomBytes(8).toString('hex');
  return path.join(os.tmpdir(), `${id}${ext}`);
}
function slugify(s){
  return String(s).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '') || `mix-${Date.now()}`;
}
async function downloadToFile(url, destPath){
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed ${res.status} ${res.statusText}`);
  const readable = Readable.fromWeb(res.body);
  await pipeline(readable, fs.createWriteStream(destPath));
  return destPath;
}

function ffprobeDurationSeconds(inputFile){
  return new Promise((resolve) => {
    const args = [
      '-v','error',
      '-show_entries','format=duration',
      '-of','default=nw=1:nk=1',
      inputFile
    ];
    const p = spawn('ffprobe', args, { stdio: ['ignore','pipe','ignore'] });
    let out = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.on('close', () => {
      const secs = parseFloat(out.trim());
      resolve(isFinite(secs) ? secs : null);
    });
    p.on('error', () => resolve(null));
  });
}

/**
 * Stream-decode to mono float32 via ffmpeg and build a peaks array of length ~pixels
 * Returns an array of numbers in [0..1]
 */
async function buildPeaksWithFfmpeg(inputFile, pixels = 4000, sampleRate = 11025){
  const duration = await ffprobeDurationSeconds(inputFile);
  const rate = sampleRate;

  // If we know the duration, we can compute precise bin size
  const estimatedTotalSamples = duration ? Math.max(1, Math.floor(duration * rate)) : null;
  const binSize = estimatedTotalSamples
    ? Math.max(1, Math.floor(estimatedTotalSamples / pixels))
    : Math.max(1, Math.floor(rate * 0.05)); // fallback ~50ms windows

  return await new Promise((resolve, reject) => {
    const args = [
      '-v','error',
      '-i', inputFile,
      '-ac','1',
      '-filter:a', `aresample=${rate}`,
      '-f','f32le',
      'pipe:1'
    ];
    const ff = spawn('ffmpeg', args, { stdio: ['ignore','pipe','pipe'] });

    let peaks = [];
    let samplesInBin = 0;
    let curMax = 0;

    ff.stdout.on('data', (chunk) => {
      // chunk is raw f32le PCM
      const count = Math.floor(chunk.length / 4);
      // Use a Float32Array view without copying
      const floats = new Float32Array(chunk.buffer, chunk.byteOffset, count);

      for (let i = 0; i < floats.length; i++) {
        const val = Math.abs(floats[i]);           // magnitude only (0..1)
        if (val > curMax) curMax = val;
        samplesInBin++;
        if (samplesInBin >= binSize) {
          peaks.push(Math.max(0, Math.min(1, curMax)));
          samplesInBin = 0;
          curMax = 0;
        }
      }
    });

    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });

    ff.on('close', (code) => {
      if (samplesInBin > 0) {
        peaks.push(Math.max(0, Math.min(1, curMax)));
      }
      if (code !== 0 && peaks.length === 0) {
        return reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
      }

      // Normalize length to ~pixels (down/up sample if needed)
      if (peaks.length > pixels) {
        const ratio = peaks.length / pixels;
        const down = new Array(pixels);
        for (let i = 0; i < pixels; i++) {
          down[i] = peaks[Math.floor(i * ratio)];
        }
        peaks = down;
      } else if (peaks.length < Math.max(16, Math.floor(pixels * 0.5))) {
        // if very short, pad (rare for long mixes)
        while (peaks.length < pixels) peaks.push(peaks[peaks.length - 1] || 0);
      }

      resolve(peaks);
    });

    ff.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
  });
}

async function uploadToBunnyStorage(filename, buffer, contentType = 'application/json'){
  const zone  = reqEnv('BUNNY_STORAGE_NAME');
  const host  = BUNNY_STORAGE_HOST;
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
  return `https://${reqEnv('CDN_HOST')}/${BUNNY_FOLDER}/${filename}`;
}

app.post('/peaks', async (req, res) => {
  const t0 = Date.now();
  let tmpIn;

  try {
    // validate env early
    reqEnv('BUNNY_STORAGE_NAME');
    reqEnv('BUNNY_ACCESS_KEY');
    reqEnv('CDN_HOST');

    const { sourceUrl, outName, pixels } = req.body || {};
    if (!sourceUrl || typeof sourceUrl !== 'string') {
      return res.status(400).json({ error: 'Missing body.sourceUrl' });
    }
    const PIXELS = Math.max(1000, Math.min(16000, Number(pixels) || 4000));

    tmpIn = tmpFile('.mp3');
    await downloadToFile(sourceUrl, tmpIn);

    const peaks = await buildPeaksWithFfmpeg(tmpIn, PIXELS, 11025);

    const base = outName ? slugify(outName) : slugify(path.parse(sourceUrl).name);
    const filename = `${base}.peaks.json`;
    const buf = Buffer.from(JSON.stringify(peaks));
    const cdnUrl = await uploadToBunnyStorage(filename, buf, 'application/json');

    res.json({
      ok: true,
      cdnUrl,
      count: peaks.length,
      ms: Date.now() - t0
    });
  } catch (err) {
    console.error('[peaks] error:', err);
    res.status(500).json({ status: 'error', message: String(err?.message || err) });
  } finally {
    if (tmpIn) fsp.unlink(tmpIn).catch(()=>{});
  }
});

app.listen(PORT, () => {
  console.log(`peaks-service listening on :${PORT}`);
  console.log(`Using Bunny host: ${BUNNY_STORAGE_HOST}`);
});
