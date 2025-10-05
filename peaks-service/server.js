// Minimal peaks microservice with Bunny CDN -> Storage fallback
// Works on Railway. Generates WaveSurfer-compatible peaks JSON.

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

const PORT = process.env.PORT || 3000;

// ---- Required ENV ----
const CDN_HOST            = envReq("CDN_HOST");            // e.g. "markcutz-mixes.b-cdn.net"
const BUNNY_STORAGE_NAME  = envReq("BUNNY_STORAGE_NAME");  // e.g. "markcutz"
const BUNNY_ACCESS_KEY    = envReq("BUNNY_ACCESS_KEY");    // Storage Password
const BUNNY_FOLDER        = process.env.BUNNY_FOLDER || "waveforms";
const BUNNY_STORAGE_HOST  = process.env.BUNNY_STORAGE_HOST || "storage.bunnycdn.com"; // or region host
const ALLOWED_REFERRER    = (process.env.ALLOWED_REFERRER || "").trim().toLowerCase(); // e.g. "www.markcutz.com" (no scheme)
const ALT_CDN_HOST        = (process.env.ALT_CDN_HOST || "").trim(); // optional second pull zone

function envReq(k){ const v = process.env[k]; if(!v) throw new Error(`Missing env ${k}`); return v; }

// ---- App / CORS ----
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

// Health
app.get("/", (_req, res) => res.type("text").send("peaks-service up"));
app.get("/health", (_req, res) => res.type("text").send("ok"));

// ---- Small utils ----
function tmpFile(ext=""){ return path.join(os.tmpdir(), crypto.randomBytes(8).toString("hex") + ext); }
function slugify(s){ return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)+/g,"") || `mix-${Date.now()}`; }

async function saveStreamTo(destPath, webReadable){
  const nodeStream = Readable.fromWeb(webReadable);
  await pipeline(nodeStream, fs.createWriteStream(destPath));
}

// Tries CDN, then ALT_CDN (if set), then Bunny Storage (authorized GET)
async function downloadFromBunnyAny(sourceUrl, destPath){
  const u = new URL(sourceUrl);
  const wantedPath = u.pathname; // "/Uploads%202025/2025%20Mixes/xxx.mp3"

  // 1) Try original URL as-is
  let r = await fetch(sourceUrl).catch(()=>null);
  if (r?.ok && r.body) { await saveStreamTo(destPath, r.body); return; }

  // 2) If host differs from your primary pull zone, try your primary pull zone
  const cdnUrl = `https://${CDN_HOST}${wantedPath}`;
  if (new URL(sourceUrl).host.toLowerCase() !== CDN_HOST.toLowerCase()){
    r = await fetch(cdnUrl).catch(()=>null);
    if (r?.ok && r.body) { await saveStreamTo(destPath, r.body); return; }
  }

  // 3) Try optional alternate pull zone
  if (ALT_CDN_HOST){
    const altUrl = `https://${ALT_CDN_HOST}${wantedPath}`;
    r = await fetch(altUrl).catch(()=>null);
    if (r?.ok && r.body) { await saveStreamTo(destPath, r.body); return; }
  }

  // 4) Final fallback: direct from Bunny Storage (authorized GET)
  const storageUrl = `https://${BUNNY_STORAGE_HOST}/${BUNNY_STORAGE_NAME}${wantedPath}`;
  r = await fetch(storageUrl, { headers: { "AccessKey": BUNNY_ACCESS_KEY } }).catch(()=>null);
  if (r?.ok && r.body) { await saveStreamTo(destPath, r.body); return; }

  const status = r ? `${r.status} ${r.statusText}` : "network error";
  throw new Error(`Download failed ${status}`);
}

function runAudiowaveform(inputFile, outJsonFile, pixels=4000){
  return new Promise((resolve, reject) => {
    const args = [
      "-i", inputFile,
      "--output-format", "json",
      "-o", outJsonFile,
      "--pixels", String(Math.max(1000, Math.min(16000, pixels))),
      "--bits", "8",
      "--no-progress",
    ];
    const p = spawn("audiowaveform", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", d => { stderr += d.toString(); });
    p.on("error", err => reject(new Error(`audiowaveform spawn failed: ${err.message}. Is it installed?`)));
    p.on("close", code => code === 0 ? resolve(outJsonFile) : reject(new Error(`audiowaveform exited ${code}: ${stderr.trim()}`)));
  });
}

// convert 8-bit JSON -> normalized [-1..1] array
async function toPeaks(rawJsonPath, outPeaksPath){
  const raw = JSON.parse(await fsp.readFile(rawJsonPath, "utf8"));
  const data = raw.data || raw.samples || [];
  const peaks = Array.from(data, (v) => {
    const n = Number(v); const c = Math.max(0, Math.min(255, isFinite(n) ? n : 128));
    return (c - 128) / 128;
  });
  await fsp.writeFile(outPeaksPath, JSON.stringify(peaks));
  return outPeaksPath;
}

async function uploadToBunny(filename, buffer, contentType="application/json"){
  const url = `https://${BUNNY_STORAGE_HOST}/${BUNNY_STORAGE_NAME}/${BUNNY_FOLDER}/${filename}`;
  const r = await fetch(url, {
    method: "PUT",
    headers: { "AccessKey": BUNNY_ACCESS_KEY, "Content-Type": contentType },
    body: buffer
  });
  if (!r.ok){
    const t = await r.text().catch(()=> "");
    throw new Error(`Bunny upload failed ${r.status}: ${t}`);
  }
  return `https://${CDN_HOST}/${BUNNY_FOLDER}/${filename}`;
}

function refAllowed(req){
  if (!ALLOWED_REFERRER) return true; // no restriction
  const ref = req.get("referer") || req.get("origin") || "";
  if (!ref) return true; // allow server-to-server / curl
  try{
    const host = new URL(ref).hostname.toLowerCase();
    return host === ALLOWED_REFERRER;
  }catch{ return true; }
}

// ---- API ----
app.post("/peaks", async (req, res) => {
  if (!refAllowed(req)) return res.status(403).json({ error: "Forbidden" });

  const { sourceUrl, outName, pixels } = req.body || {};
  if (!sourceUrl || typeof sourceUrl !== "string"){
    return res.status(400).json({ error: "Missing body.sourceUrl" });
  }

  let inTmp, rawTmp, peaksTmp;
  try{
    inTmp    = tmpFile(".mp3");
    rawTmp   = tmpFile(".raw.json");
    peaksTmp = tmpFile(".peaks.json");

    // Download with robust fallback
    await downloadFromBunnyAny(sourceUrl, inTmp);

    // Generate
    await runAudiowaveform(inTmp, rawTmp, Number(pixels) || 4000);
    await toPeaks(rawTmp, peaksTmp);

    const base = outName ? slugify(outName) : slugify(path.parse(new URL(sourceUrl).pathname).name);
    const filename = `${base}.peaks.json`;
    const buf = await fsp.readFile(peaksTmp);
    const cdnUrl = await uploadToBunny(filename, buf);

    res.json({ ok: true, cdnUrl, count: JSON.parse(buf.toString()).length });
  }catch(err){
    res.status(500).json({ error: String(err?.message || err) });
  }finally{
    for (const f of [inTmp, rawTmp, peaksTmp]) if (f) fsp.unlink(f).catch(()=>{});
  }
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`peaks-service listening on :${PORT}`);
});
