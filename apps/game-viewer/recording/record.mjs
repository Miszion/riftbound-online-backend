#!/usr/bin/env node
// Playwright-based recorder for the Riftbound replay viewer.
// Opens each match in a real Chromium window, bumps speed to configured value,
// waits for MATCH OVER, then moves to the next match. One MP4 (webm->mp4) per
// match + a concatenated session MP4.

import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const args = {
    viewerUrl: "http://localhost:4200",
    outDir: path.resolve(__dirname, "../../../../nexus-data/riftbound-videos"),
    fps: 30,
    width: 1920,
    height: 1080,
    matches: 0, // 0 == all
    speed: 4,
    matchTimeoutMs: 180000, // per-match cap
  };
  for (const a of argv.slice(2)) {
    const [k, v] = a.includes("=") ? a.split("=") : [a, ""];
    const key = k.replace(/^--/, "");
    switch (key) {
      case "url": args.viewerUrl = v; break;
      case "output": args.outputOverride = v; break;
      case "outdir": args.outDir = v; break;
      case "fps": args.fps = parseInt(v, 10); break;
      case "resolution": {
        const [w, h] = v.split("x").map((n) => parseInt(n, 10));
        args.width = w; args.height = h; break;
      }
      case "matches": args.matches = parseInt(v, 10); break;
      case "speed": args.speed = parseInt(v, 10); break;
      case "timeout": args.matchTimeoutMs = parseInt(v, 10); break;
    }
  }
  return args;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function waitForViewer(url) {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${url}/manifest.json`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Viewer not reachable at ${url}`);
}

async function recordMatch({ browser, match, args, perMatchDir, index }) {
  const sessionDir = path.join(perMatchDir, `match-${String(index).padStart(2, "0")}`);
  await fs.mkdir(sessionDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: args.width, height: args.height },
    recordVideo: { dir: sessionDir, size: { width: args.width, height: args.height } },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  const url = `${args.viewerUrl}/replay?match=${encodeURIComponent(match.file)}&autoplay=1&chain=none`;
  console.log(`[record] match ${index + 1}: ${match.matchId} -> ${url}`);

  const started = Date.now();
  const result = { matchId: match.matchId, file: match.file, ok: false, reason: "" };
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Wait for loader to disappear and controls to show
    await page.waitForSelector("text=Speed:", { timeout: 30000 });
    // Click the 4x button (or configured speed)
    await page.getByRole("button", { name: `${args.speed}x` }).click();
    // Ensure playing (click Play if paused) - use button with ">" / "Pause"
    // Autoplay=1 should already play; but make sure by dispatching a pause->play cycle if needed.
    // Poll for MATCH OVER banner.
    const deadline = Date.now() + args.matchTimeoutMs;
    let sawMatchOver = false;
    while (Date.now() < deadline) {
      const present = await page.evaluate(() => {
        const txt = document.body.innerText || "";
        return txt.includes("MATCH OVER") || txt.includes("Match Over") || txt.toLowerCase().includes("match over");
      });
      if (present) { sawMatchOver = true; break; }
      await page.waitForTimeout(500);
    }
    // Hold the final frame a bit for visual closure.
    await page.waitForTimeout(1500);
    result.ok = sawMatchOver;
    if (!sawMatchOver) result.reason = "timed out before MATCH OVER";
  } catch (err) {
    result.reason = err.message;
  }
  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
  result.elapsedSec = elapsedSec;

  // Close page + context to flush the webm
  await page.close();
  await context.close();

  // Locate the produced webm (Playwright writes a single file per page)
  const files = (await fs.readdir(sessionDir)).filter((f) => f.endsWith(".webm"));
  if (files.length === 0) {
    result.reason = (result.reason || "") + " (no webm produced)";
    return result;
  }
  const webm = path.join(sessionDir, files[0]);
  const mp4 = path.join(perMatchDir, `match-${String(index).padStart(2, "0")}-${match.matchId}.mp4`);
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-r", String(args.fps), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "veryfast", "-movflags", "+faststart", mp4]);
  result.mp4 = mp4;
  return result;
}

async function concatMp4s(mp4Files, outFile) {
  const listPath = outFile + ".concat.txt";
  const body = mp4Files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
  await fs.writeFile(listPath, body);
  // Re-encode to ensure uniform params and broad playability.
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "veryfast", "-movflags", "+faststart", outFile]);
  await fs.unlink(listPath).catch(() => {});
}

async function buildIndexHtml(videosDir, sessionMp4, perMatchMp4s) {
  const rel = (p) => path.relative(videosDir, p);
  const items = [
    { title: "Full Session", file: rel(sessionMp4) },
    ...perMatchMp4s.map((r, i) => ({
      title: `Match ${i + 1}: ${r.matchId}${r.ok ? "" : " (incomplete)"}`,
      file: rel(r.mp4),
    })),
  ];
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Riftbound Bot-vs-Bot Replays</title>
<style>
  body { background:#0b0b0e; color:#e5e7eb; font-family: system-ui, sans-serif; margin: 0; padding: 24px; }
  h1 { margin: 0 0 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 20px; }
  .card { background:#15151b; border:1px solid #2a2a33; border-radius:12px; padding:12px; }
  .card h2 { font-size: 15px; margin: 0 0 8px; color:#cbd5e1; }
  video { width: 100%; border-radius: 8px; background:#000; }
  a { color:#93c5fd; text-decoration: none; }
  .meta { color:#94a3b8; font-size: 12px; margin-top: 6px; }
</style>
</head>
<body>
<h1>Riftbound Bot-vs-Bot Replays</h1>
<div class="grid">
${items.map((it) => `  <div class="card">
    <h2>${it.title}</h2>
    <video controls preload="metadata" src="./${it.file}"></video>
    <div class="meta"><a href="./${it.file}">download</a></div>
  </div>`).join("\n")}
</div>
</body>
</html>
`;
  await fs.writeFile(path.join(videosDir, "index.html"), html);
}

async function main() {
  const args = parseArgs(process.argv);
  await fs.mkdir(args.outDir, { recursive: true });

  const stamp = timestamp();
  const sessionMp4 = args.outputOverride
    ? path.resolve(args.outputOverride)
    : path.join(args.outDir, `session-${stamp}.mp4`);
  const perMatchDir = path.join(args.outDir, `session-${stamp}-parts`);
  await fs.mkdir(perMatchDir, { recursive: true });

  console.log(`[record] viewer: ${args.viewerUrl}`);
  console.log(`[record] out:    ${sessionMp4}`);
  console.log(`[record] parts:  ${perMatchDir}`);

  const manifest = await waitForViewer(args.viewerUrl);
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error("Viewer manifest empty");
  }
  const list = args.matches > 0 ? manifest.slice(0, args.matches) : manifest;
  console.log(`[record] matches to capture: ${list.length}`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });

  const results = [];
  for (let i = 0; i < list.length; i++) {
    const match = list[i];
    let attempt = 0;
    let res;
    while (attempt < 2) {
      res = await recordMatch({ browser, match, args, perMatchDir, index: i });
      if (res.ok || res.mp4) break;
      attempt++;
      console.log(`[record] retry match ${i + 1} (${res.reason})`);
    }
    results.push(res);
    console.log(`[record] done ${i + 1}/${list.length} ok=${res.ok} elapsed=${res.elapsedSec}s file=${res.mp4 || "<none>"}`);
  }

  await browser.close();

  const mp4Files = results.filter((r) => r.mp4).map((r) => r.mp4);
  if (mp4Files.length === 0) {
    throw new Error("No per-match MP4s were produced");
  }
  await concatMp4s(mp4Files, sessionMp4);
  await buildIndexHtml(args.outDir, sessionMp4, results.filter((r) => r.mp4));

  const stat = await fs.stat(sessionMp4);
  const summary = {
    sessionMp4,
    bytes: stat.size,
    matches: results,
  };
  await fs.writeFile(path.join(args.outDir, `session-${stamp}.summary.json`), JSON.stringify(summary, null, 2));
  console.log("[record] summary written");
  console.log(`[record] MP4: ${sessionMp4} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  const incomplete = results.filter((r) => !r.ok);
  if (incomplete.length > 0) {
    console.log(`[record] incomplete: ${incomplete.map((r) => r.matchId).join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
