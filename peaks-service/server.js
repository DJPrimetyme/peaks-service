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
const BUNNY_STORAGE_HOST = (process.env.BUNNY_STORAGE_HOST || "storage.bunnycdn.com").trim();
const BUNNY_FOLDER = (process.env.BUNNY_FOLDER || "waveforms").replace(/^\/+/, "");
const CDN_HOST = (process.env.CDN_HOST || "").trim().toLowerCase();

// Accept comma-separated hostnames for referrer lock
const ALLOWED_REFERRERS = (process.env.ALLOWED_REFERRER || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.type("text").send("peaks-service up"));
app.get("/health", (_req, res) => res.type("text").send("ok"));
app.get("/version", (_req, res) => {
  const p = spawn("audiowaveform", ["-v"]);
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d.toString()));
  p.stderr.on("data", (d) => (err += d.toString()));
  p.on("close", (code) => res.json({ code, out: out.trim(), err: err.trim() }));
});

// ---------- helpers ----------
function reqEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}
function normHost(h) { return String(h || "").toLowerCase().replace(/^www\./, ""); }
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
async function downloadToFile(url, destPath) {
  const u = new URL(url);
  const headers = {};
  // Bunny hotlink protection: add a whitelisted Referer for CDN downloads
  if (CDN_HOST && normHost(u.hostname) === normHost(CDN_HOST) && ALLOWED_REFERRERS.length) {
    headers["Referer"] = `https://${ALLOWED_REFERRERS[0]}/`;
  }
  const r = await fetch(u, { headers });
  if (!r.ok || !r.body) throw new Error(`Download failed ${r.status} ${r.statusText}`);
  const readable = Readable.fromWeb(r.body);
  await pipeline(readable, fs.createWriteStream(destPath));
  return destPath;
}
function runAudiowaveform(inputFile, outJsonFile, pixels = 4000) {
  return new Promise((resolve, reject) => {
    const args = ["-i", inputFile, "--output-format", "json", "-o", outJsonFile,
      "--pixels", String(pixels), "--bits", "8", "--no-progress"];
    const proc = spawn("audiowaveform", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => reject(new Error(`audiowaveform spawn failed: ${err.message}`)));
    proc.on("close", (code) => code === 0
      ? resolve(outJsonFile)
      : reject(new Error(`audiowaveform exited ${code}: ${stderr.trim()}`)));
  });
}
async function convertRawJsonToPeaks(rawJsonPath, outPeaksPath) {
  const raw = JSON.parse(await fsp.readFile(rawJsonPath, "utf8"));
  const data = raw.data || raw.samples || [];
  const peaks = Array.from(data, (v) => {
    const n = Math.max(0, Math.min(255, Number(v)));
    return (n - 128) / 128;
  });
  await fsp.writeFile(outPeaksPath, JSON.stringify(peaks));
  return outPeaksPath;
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
function slugify(s) {
  return (
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "") || `mix-${Date.now()}`
  );
}

// ---------- route ----------
app.post("/peaks", async (req, res) => {
  // lock to allowed referrers if configured
  const hdr = req.headers["referer"] || req.headers["origin"] || "";
  if (!isAllowedReferrer(hdr)) return res.status(403).json({ error: "Forbidden (referrer)" });

  let tmpIn, tmpRaw, tmpPeaks;
  try {
    reqEnv("BUNNY_STORAGE_NAME");
    reqEnv("BUNNY_ACCESS_KEY");
    reqEnv("CDN_HOST");

    const { sourceUrl, outName, pixels } = req.body || {};
    if (!sourceUrl || typeof sourceUrl !== "string")
      return res.status(400).json({ error: "Missing body.sourceUrl" });

    const PIXELS = Math.max(1000, Math.min(16000, Number(pixels) || 4000));

    const srcPath = new URL(sourceUrl).pathname;
    tmpIn = tmpFile(path.extname(srcPath) || ".bin");
    tmpRaw = tmpFile(".raw.json");
    tmpPeaks = tmpFile(".peaks.json");

    await downloadToFile(sourceUrl, tmpIn);
    await runAudiowaveform(tmpIn, tmpRaw, PIXELS);
    await convertRawJsonToPeaks(tmpRaw, tmpPeaks);

    const base = slugify(outName || path.parse(srcPath).name);
    const filename = `${base}.peaks.json`;
    const buffer = await fsp.readFile(tmpPeaks);
    const cdnUrl = await uploadToBunnyStorage(filename, buffer, "application/json");
    const count = JSON.parse(buffer.toString()).length;

    return res.json({ ok: true, cdnUrl, count });
  } catch (err) {
    console.error("[peaks] error", err);
    return res.status(500).json({ error: String(err?.message || err) });
  } finally {
    for (const f of [tmpIn, tmpRaw, tmpPeaks]) if (f) fsp.unlink(f).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`peaks-service listening on :${PORT}`);
  console.log(`Bunny host: ${BUNNY_STORAGE_HOST} | CDN: ${CDN_HOST} | Referrers: ${ALLOWED_REFERRERS.join(", ") || "(none)"}`);
});
