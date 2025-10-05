# peaks-service

A tiny service that turns an MP3 URL into a WaveSurfer-compatible peaks JSON,
and uploads that JSON straight to Bunny Storage (no Transloadit, no SFTP).

## Files
- `peaks-service/server.js` — Express server with `/peaks` endpoint (uses ffmpeg under the hood)
- `peaks-service/package.json` — Node dependencies
- `peaks-service/Dockerfile` — Container with Node + ffmpeg

## Run locally (needs ffmpeg installed)
```bash
npm install
export BUNNY_STORAGE_ZONE=markcutz
export BUNNY_ACCESS_KEY=<your bunny storage password>
export BUNNY_PULL_BASE=https://markcutz-mixes.b-cdn.net
node server.js
```

## Deploy on Railway / Render
Create a new project from this folder/repo. Set env vars:
- `BUNNY_STORAGE_ZONE = markcutz`
- `BUNNY_ACCESS_KEY   = <your bunny storage password>`
- `BUNNY_PULL_BASE    = https://markcutz-mixes.b-cdn.net`
- `API_KEY` (optional)

## Test
```bash
curl -X POST http://localhost:8080/peaks -H "Content-Type: application/json" -d '{
  "sourceUrl": "https://markcutz-mixes.b-cdn.net/mixes2025/example.mp3",
  "destDir": "waveforms",
  "pixelsPerSecond": 50,
  "normalize": true
}'
```
