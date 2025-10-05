// Simple peaks microservice (no Transloadit, no SFTP).
// Reads MP3 via ffmpeg, computes peaks, uploads JSON to Bunny Storage (HTTP API).

const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const axios = require("axios");
const path = require("path");
const crypto = require("crypto");

// ----- ENV VARS (set these on your host) -----
// Bunny Storage API base (do not change host):
//   https://storage.bunnycdn.com/<STORAGE_ZONE>/<path>
const BUNNY_STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE || "markcutz";
const BUNNY_ACCESS_KEY   = process.env.BUNNY_ACCESS_KEY || ""; // Storage Password from Bunny dashboard
const BUNNY_PULL_BASE    = process.env.BUNNY_PULL_BASE || "https://markcutz-mixes.b-cdn.net";
const BUNNY_BASE_DIR     = process.env.BUNNY_BASE_DIR || "/";   // usually "/"
const API_KEY            = process.env.API_KEY || "";           // optional: require header X-API-Key
const PORT               = process.env.PORT || 8080;

// Peak generation settings
const DEFAULT_PPS = 50;        // pixels per second (40–60 good for long mixes)
const SAMPLE_RATE = 11025;     // ffmpeg PCM output rate (mono, s16le)

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Optional API key check
app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (req.headers["x-api-key"] === API_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
});

// Health
app.get("/", (_, res) => res.send("peaks-service OK"));

// Helper: sanitize filename
function safeBaseName(name) {
  const base = name.replace(/\.[^/.]+$/, ""); // strip extension
  return base.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 80) || "audio";
}

// Helper: compute peaks from a PCM s16le mono stream
function computePeaksFromPcmStream(stream, { pps = DEFAULT_PPS, normalize = true }) {
  return new Promise((resolve, reject) => {
    const bytesPerSample = 2; // s16le
    const samplesPerPixel = Math.max(1, Math.round(SAMPLE_RATE / pps));
    const bytesPerPixel = samplesPerPixel * bytesPerSample;

    let buf = Buffer.alloc(0);
    const peaks = [];
    let globalMax = 0;

    stream.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      // Process whole pixel windows
      while (buf.length >= bytesPerPixel) {
        let maxAmp = 0;
        for (let i = 0; i < samplesPerPixel; i++) {
          const sample = buf.readInt16LE(i * 2);
          const amp = Math.abs(sample) / 32768; // 0..1
          if (amp > maxAmp) maxAmp = amp;
        }
        peaks.push(maxAmp);
        if (maxAmp > globalMax) globalMax = maxAmp;
        buf = buf.slice(bytesPerPixel);
      }
    });

    stream.on("end", () => {
      // leftover samples (partial pixel)
      if (buf.length >= bytesPerSample) {
        let maxAmp = 0;
        for (let off = 0; off + 1 < buf.length; off += 2) {
          const sample = buf.readInt16LE(off);
          const amp = Math.abs(sample) / 32768;
          if (amp > maxAmp) maxAmp = amp;
        }
        peaks.push(maxAmp);
        if (maxAmp > globalMax) globalMax = Math.max(globalMax, maxAmp);
      }

      // Normalize if requested
      let out = peaks;
      if (normalize && globalMax > 0) {
        out = peaks.map(v => (v / globalMax));
      }

      resolve(out);
    });

    stream.on("error", reject);
  });
}

// Generate peaks by piping ffmpeg PCM to Node
async function generatePeaks(sourceUrl, { pps = DEFAULT_PPS, normalize = true }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-i", sourceUrl,
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-ac", "1",
      "-ar", String(SAMPLE_RATE),
      "pipe:1"
    ];

    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    let ffErr = "";
    ff.stderr.on("data", (d) => (ffErr += d.toString()));

    computePeaksFromPcmStream(ff.stdout, { pps, normalize })
      .then((peaks) => {
        resolve(peaks);
      })
      .catch((err) => {
        ff.kill("SIGKILL");
        reject(err);
      });

    ff.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}. ${ffErr}`));
      }
    });
  });
}

// Upload to Bunny Storage via HTTP API (no FTP/SFTP ports needed)
async function uploadToBunny(jsonBuffer, remotePath) {
  // Ensure leading slash, and no double slashes
  const rel = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
  const url = `https://storage.bunnycdn.com/${BUNNY_STORAGE_ZONE}${rel}`;

  await axios.put(url, jsonBuffer, {
    headers: {
      "AccessKey": BUNNY_ACCESS_KEY,
      "Content-Type": "application/json"
    },
    maxBodyLength: Infinity
  });

  // Return public CDN URL
  const publicUrl = `${BUNNY_PULL_BASE}${rel}`;
  return publicUrl;
}

app.post("/peaks", async (req, res) => {
  try {
    const { sourceUrl, destDir = "waveforms", pixelsPerSecond, normalize = true, filename } = req.body || {};

    if (!sourceUrl || typeof sourceUrl !== "string") {
      return res.status(400).json({ error: "Missing sourceUrl" });
    }

    const pps = Number(pixelsPerSecond) > 0 ? Number(pixelsPerSecond) : DEFAULT_PPS;

    // Derive a clean base name
    const baseFromUrl = safeBaseName(path.basename(new URL(sourceUrl).pathname || "audio.mp3"));
    const base = filename ? safeBaseName(filename) : baseFromUrl;
    const uid = crypto.randomBytes(4).toString("hex");

    // Build remote path: /<destDir>/<base>-<uid>.peaks.json
    const relPath = `/${destDir.replace(/^\/+|\/+$/g, "")}/${base}-${uid}.peaks.json`;

    // Generate peaks
    const peaks = await generatePeaks(sourceUrl, { pps, normalize: !!normalize });

    // Store JSON (compact)
    const payload = Buffer.from(JSON.stringify({ version: 1, sample_rate: SAMPLE_RATE, pps, normalize: !!normalize, peaks }));
    const peaksUrl = await uploadToBunny(payload, relPath);

    return res.json({ peaksUrl, relPath, count: peaks.length, pps, sampleRate: SAMPLE_RATE });
  } catch (err) {
    console.error("ERROR /peaks:", err);
    return res.status(500).json({ error: String(err && err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`peaks-service listening on :${PORT}`);
  if (!BUNNY_ACCESS_KEY) {
    console.warn("WARNING: BUNNY_ACCESS_KEY not set. Set your Bunny Storage password in env.");
  }
});
