// ./server.js (sure-fire download; keep your existing Dockerfile from the ffmpeg-only version)
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

// Bunny/CDN config
const STORAGE_NAME       = (process.env.BUNNY_STORAGE_NAME || "").trim();
const BUNNY_STORAGE_HOST = (process.env.BUNNY_STORAGE_HOST || "storage.bunnycdn.com").trim(); // keep default
const BUNNY_FOLDER       = (process.env.BUNNY_FOLDER || "waveforms").replace(/^\/+/, "");
const CDN_HOST           = (process.env.CDN_HOST || "").trim().toLowerCase();
const ALLOWED_REFERRERS  = (process.env.ALLOWED_REFERRER || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.type("text").send("peaks-service up"));
app.get("/health", (_req, res) => res.type("text").send("ok"));
app.get("/version", (_req, res) => {
  const p = spawn("ffmpeg", ["-hide_banner", "-version"]);
  let out = "";
  p.stdout.on("data", d => (out += d.toString()));
  p.on("close", code => res.json({ code, out: out.slice(0, 200) }));
});

// ---- utils
function reqEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}
const normHost = h => String(h || "").toLowerCase().replace(/^www\./, "");
function isAllowedReferrer(headerValue) {
  if (!ALLOWED_REFERRERS.length) return true;
  try {
    const host = normHost(new URL(headerValue).hostname);
    return ALLOWED_REFERRERS.map(normHost).includes(host);
  } catch { return false; }
}
function tmpFile(ext = "") {
  const id = crypto.randomBytes(8).toString("hex");
  return path.join(os.tmpdir(), `${id}${ext}`);
}
function canonicalPath(p) {
  // Why: fix double-encoding, stray '%' and ensure single pass
  let dec;
  try { dec = decodeURIComponent(p); }
  catch {
    dec = p.replace(/%([0-9a-f]?){0,1}$/i, ""); // strip trailing broken %
  }
  dec = dec.replace(/\/{2,}/g, "/");           // collapse //
  return encodeURI(dec);
}

async function downloadToFile(sourceUrl, destPath) {
  const u = new URL(sourceUrl);
  const canon = canonicalPath(u.pathname);
  const firstAllowed = ALLOWED_REFERRERS[0];

  const candidates = [];
  if (CDN_HOST && normHost(u.hostname) === normHost(CDN_HOST)) {
    // Prefer global host; many region hosts won’t have your object
    candidates.push({
      url: `https://storage.bunnycdn.com/${reqEnv("BUNNY_STORAGE_NAME")}${canon}${u.search || ""}`,
      headers: { AccessKey: reqEnv("BUNNY_ACCESS_KEY") }
    });
    if (BUNNY_STORAGE_HOST !== "storage.bunnycdn.com") {
      candidates.push({
        url: `https://${BUNNY_STORAGE_HOST}/${reqEnv("BUNNY_STORAGE_NAME")}${canon}${u.search || ""}`,
        headers: { AccessKey: reqEnv("BUNNY_ACCESS_KEY") }
      });
    }
    // Last resort: hit CDN with a whitelisted Referer
    candidates.push({
      url: u.toString(),
      headers: firstAllowed ? { Referer: `https://${firstAllowed}/` } : {}
    });
  } else {
    candidates.push({ url: u.toString(), headers: {} });
  }

  let lastErr;
  for (const c of candidates) {
    const r = await fetch(c.url, { headers: c.headers });
    if (r.ok && r.body) {
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(destPath));
      return destPath;
    }
    const body = await r.text().catch(() => "");
    lastErr = new Error(`Download failed ${r.status} ${r.statusText} [${c.url}] ${body ? `– ${body.slice(0, 200).replace(/\s+/g, " ")}` : ""}`);
  }
  throw lastErr || new Error("Download failed");
}

async function ffprobeDurationSec(inputFile) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", ["-v","error","-show_entries","format=duration","-of","json", inputFile]);
    let out = "", err = "";
    p.stdout.on("data", d => (out += d.toString()));
    p.stderr.on("data", d => (err += d.toString()));
    p.on("error", e => reject(new Error(`ffprobe spawn failed: ${e.message}`)));
    p.on("close", code => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${err.trim()}`));
      try {
        const sec = Number(JSON.parse(out)?.format?.duration);
        if (!isFinite(sec) || sec <= 0) return reject(new Error("duration unknown"));
        resolve(sec);
      } catch (e) { reject(new Error(`ffprobe parse error: ${e.message}`)); }
    });
  });
}

async function computePeaksWithFfmpeg(inputFile, pixels, targetRate = 8000) {
  const durationSec = await ffprobeDurationSec(inputFile);
  const totalSamples = Math.max(1, Math.round(durationSec * targetRate));
  const spp = Math.max(1, Math.floor(totalSamples / pixels));

  return new Promise((resolve, reject) => {
    const peaks = new Array(pixels).fill(0);
    let max = 0, min = 0, seen = 0, idx = 0;

    const ff = spawn("ffmpeg", [
      "-nostdin","-hide_banner","-v","error","-i", inputFile,
      "-vn","-ac","1","-ar", String(targetRate), "-f","s16le","-"
    ]);
    let stderr = "";
    ff.stderr.on("data", d => (stderr += d.toString()));
    ff.on("error", e => reject(new Error(`ffmpeg spawn failed: ${e.message}`)));
    ff.stdout.on("data", chunk => {
      for (let i = 0; i + 1 < chunk.length; i += 2) {
        const s = chunk.readInt16LE(i) / 32768;
        if (s > max) max = s;
        if (s < min) min = s;
        if (++seen % spp === 0) {
          const val = Math.abs(min) > max ? -Math.abs(min) : max;
          if (idx < pixels) peaks[idx++] = Math.max(-1, Math.min(1, val));
          max = 0; min = 0;
        }
      }
    });
    ff.on("close", code => {
      if (code !== 0) return reject(new Error(`ffmpeg failed: ${stderr.trim()}`));
      for (; idx < pixels; idx++) peaks[idx] = 0;
      resolve(peaks);
    });
  });
}

async function uploadToBunnyStorage(filename, buffer, contentType = "application/json") {
  const url = `https://${BUNNY_STORAGE_HOST}/${reqEnv("BUNNY_STORAGE_NAME")}/${BUNNY_FOLDER}/${filename}`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      AccessKey: reqEnv("BUNNY_ACCESS_KEY"),
      "Content-Type": contentType,
      "Content-Length": String(buffer.length)
    },
    body: buffer
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Bunny upload failed ${r.status}: ${t}`);
  }
  return `https://${reqEnv("CDN_HOST")}/${BUNNY_FOLDER}/${filename}`;
}

function slugify(s) {
  return (String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)+/g, "")) || `mix-${Date.now()}`;
}

// ---- route
app.post("/peaks", async (req, res) => {
  const hdr = req.headers["referer"] || req.headers["origin"] || "";
  if (!isAllowedReferrer(hdr)) return res.status(403).json({ error: "Forbidden (referrer)" });

  let tmpIn;
  try {
    reqEnv("BUNNY_STORAGE_NAME");
    reqEnv("BUNNY_ACCESS_KEY");
    reqEnv("CDN_HOST");

    const { sourceUrl, outName, pixels } = req.body || {};
    if (!sourceUrl || typeof sourceUrl !== "string") return res.status(400).json({ error: "Missing body.sourceUrl" });
    const PIXELS = Math.max(1000, Math.min(16000, Number(pixels) || 4000));

    const u = new URL(sourceUrl);
    tmpIn = tmpFile(path.extname(u.pathname) || ".bin");

    await downloadToFile(sourceUrl, tmpIn);
    const peaks = await computePeaksWithFfmpeg(tmpIn, PIXELS, 8000);

    const base = slugify(outName || path.parse(u.pathname).name);
    const filename = `${base}.peaks.json`;
    const buf = Buffer.from(JSON.stringify(peaks));
    const cdnUrl = await uploadToBunnyStorage(filename, buf, "application/json");

    res.json({ ok: true, cdnUrl, count: peaks.length });
  } catch (err) {
    console.error("[peaks] error", err);
    res.status(500).json({ error: String(err?.message || err) });
  } finally {
    if (tmpIn) fsp.unlink(tmpIn).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`peaks-service listening on :${PORT}`);
  console.log(`CDN: ${CDN_HOST} | Storage host: ${BUNNY_STORAGE_HOST} | Zone: ${STORAGE_NAME}`);
});
