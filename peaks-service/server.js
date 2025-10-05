// ./server.js
// Peaks microservice (Railway + Bunny) without audiowaveform; uses ffmpeg only.
import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Bunny config ----
const BUNNY_STORAGE_HOST = (process.env.BUNNY_STORAGE_HOST || "storage.bunnycdn.com").trim();
const BUNNY_FOLDER = (process.env.BUNNY_FOLDER || "waveforms").replace(/^\/+/, "");
const CDN_HOST = (process.env.CDN_HOST || "").trim().toLowerCase();

// Accept comma-separated allowed referrers
const ALLOWED_REFERRERS = (process.env.ALLOWED_REFERRER || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.type("text").send("peaks-service up"));
app.get("/health", (_req, res) => res.type("text").send("ok"));
app.get("/version", async (_req, res) => {
  // Why: quick sanity check that ffmpeg is present at runtime
  const p = spawn("ffmpeg", ["-hide_banner", "-version"]);
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d.toString()));
  p.stderr.on("data", (d) => (err += d.toString()));
  p.on("close", (code) => res.json({ code, out: out.slice(0, 200), err: err.slice(0, 200) }));
});

// ---------- helpers ----------
function reqEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}
const normHost = (h) => String(h || "").toLowerCase().replace(/^www\./, "");
function isAllowedReferrer(headerValue) {
  if (!ALLOWED_REFERRERS.length) return true;
  try {
    const host = normHost(new URL(headerValue).hostname);
    return ALLOWED_REFERRERS.map(normHost).includes(host);
  } catch {
    return false;
  }
}
function tmpFile(ext = "") {
  const id = crypto.randomBytes(8).toString("hex");
  return path.join(os.tmpdir(), `${id}${ext}`);
}
async function downloadToFile(url, destPath) {
  const u = new URL(url);
  const headers = {};
  // Why: Bunny hotlink protection blocks server-side fetches without Referer
  if (CDN_HOST && normHost(u.hostname) === normHost(CDN_HOST) && ALLOWED_REFERRERS.length) {
    headers["Referer"] = `https://${ALLOWED_REFERRERS[0]}/`;
  }
  const r = await fetch(u, { headers });
  if (!r.ok || !r.body) throw new Error(`Download failed ${r.status} ${r.statusText}`);
  const readable = Readable.fromWeb(r.body);
  await pipeline(readable, fs.createWriteStream(destPath));
  return destPath;
}
function slugify(s) {
  return (
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "") || `mix-${Date.now()}`
  );
}

// ---- Peaks via ffmpeg (no audiowaveform) ----
async function ffprobeDurationSec(inputFile) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      inputFile
    ]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => reject(new Error(`ffprobe spawn failed: ${e.message}`)));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${err.trim()}`));
      try {
        const j = JSON.parse(out);
        const sec = Number(j?.format?.duration);
        if (!isFinite(sec) || sec <= 0) return reject(new Error("duration unknown"));
        resolve(sec);
      } catch (e) {
        reject(new Error(`ffprobe parse error: ${e.message}`));
      }
    });
  });
}

async function computePeaksWithFfmpeg(inputFile, pixels, targetRate = 8000) {
  const durationSec = await ffprobeDurationSec(inputFile);
  const totalSamples = Math.max(1, Math.round(durationSec * targetRate));
  const samplesPerPixel = Math.max(1, Math.floor(totalSamples / pixels));

  return new Promise((resolve, reject) => {
    const peaks = new Array(pixels).fill(0);
    let bucketMax = 0.0;
    let bucketMin = 0.0;
    let sampleIndex = 0;
    let bucketIndex = 0;

    const ff = spawn("ffmpeg", [
      "-nostdin",
      "-hide_banner",
      "-v",
      "error",
      "-i",
      inputFile,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(targetRate),
      "-f",
      "s16le",
      "-" // stdout raw PCM
    ]);

    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += d.toString()));
    ff.on("error", (e) => reject(new Error(`ffmpeg spawn failed: ${e.message}`)));

    ff.stdout.on("data", (chunk) => {
      for (let i = 0; i + 1 < chunk.length; i += 2) {
        const s = chunk.readInt16LE(i) / 32768; // [-1,1]
        if (s > bucketMax) bucketMax = s;
        if (s < bucketMin) bucketMin = s;
        sampleIndex++;
        if (sampleIndex % samplesPerPixel === 0) {
          const val = Math.abs(bucketMin) > bucketMax ? -Math.abs(bucketMin) : bucketMax;
          if (bucketIndex < pixels) peaks[bucketIndex] = Math.max(-1, Math.min(1, val));
          bucketIndex++;
          bucketMax = 0.0;
          bucketMin = 0.0;
        }
      }
    });

    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg failed: ${stderr.trim()}`));
      // Pad/truncate to exactly pixels
      if (bucketIndex < pixels) {
        const last =
          Math.abs(bucketMin) > bucketMax ? -Math.abs(bucketMin) : bucketMax;
        if (bucketIndex < pixels) peaks[bucketIndex] = last;
        for (let i = bucketIndex + 1; i < pixels; i++) peaks[i] = peaks[bucketIndex] || 0;
      }
      resolve(peaks.slice(0, pixels));
    });
  });
}

async function uploadToBunnyStorage(filename, buffer, contentType = "application/json") {
  const zone = reqEnv("BUNNY_STORAGE_NAME");
  const url = `https://${BUNNY_STORAGE_HOST}/${zone}/${BUNNY_FOLDER}/${filename}`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      AccessKey: reqEnv("BUNNY_ACCESS_KEY"), // Bunny Storage Password
      "Content-Type": contentType,
      "Content-Length": String(buffer.length)
    },
    body: buffer
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Bunny upload failed ${r.status}: ${t}`);
  }
  const cdn = reqEnv("CDN_HOST");
  return `https://${cdn}/${BUNNY_FOLDER}/${filename}`;
}

// ---------- route ----------
app.post("/peaks", async (req, res) => {
  const hdr = req.headers["referer"] || req.headers["origin"] || "";
  if (!isAllowedReferrer(hdr)) return res.status(403).json({ error: "Forbidden (referrer)" });

  let tmpIn;
  try {
    reqEnv("BUNNY_STORAGE_NAME");
    reqEnv("BUNNY_ACCESS_KEY");
    reqEnv("CDN_HOST");

    const { sourceUrl, outName, pixels } = req.body || {};
    if (!sourceUrl || typeof sourceUrl !== "string")
      return res.status(400).json({ error: "Missing body.sourceUrl" });

    const PIXELS = Math.max(1000, Math.min(16000, Number(pixels) || 4000));

    const srcUrl = new URL(sourceUrl);
    tmpIn = tmpFile(path.extname(srcUrl.pathname) || ".bin");
    await downloadToFile(sourceUrl, tmpIn);

    const peaks = await computePeaksWithFfmpeg(tmpIn, PIXELS, 8000); // stable + small memory
    const buf = Buffer.from(JSON.stringify(peaks));
    const base = slugify(outName || path.parse(srcUrl.pathname).name);
    const filename = `${base}.peaks.json`;
    const cdnUrl = await uploadToBunnyStorage(filename, buf, "application/json");

    return res.json({ ok: true, cdnUrl, count: peaks.length });
  } catch (err) {
    console.error("[peaks] error", err);
    return res.status(500).json({ error: String(err?.message || err) });
  } finally {
    if (tmpIn) fsp.unlink(tmpIn).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`peaks-service listening on :${PORT}`);
  console.log(
    `Bunny host: ${BUNNY_STORAGE_HOST} | CDN: ${CDN_HOST} | Referrers: ${
      ALLOWED_REFERRERS.join(", ") || "(none)"
    }`
  );
});
