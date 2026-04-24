#!/usr/bin/env node
/*
 * Spins up a live bot-vs-bot match via GraphQL, opens the /spectate page in a
 * headless Chromium with the REAL <GameBoard /> component rendering, and
 * records the viewport to MP4 via ffmpeg driven by Playwright's built-in
 * recordVideo (WebM) and then transcodes to MP4.
 *
 * Usage:
 *   node capture-live-bots.js --out /path/to/out.mp4 --seconds 180
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const arg = (flag, fallback) => {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  return process.argv[idx + 1];
};

const outMp4 = arg('--out', '/tmp/riftbound-bots.mp4');
const captureSeconds = Number(arg('--seconds', '180'));
const frontendBase = arg('--frontend', 'http://localhost:3000');
const backendGraphql = arg('--graphql', 'http://localhost:4000/graphql');
const strategyA = arg('--strategyA', 'heuristic');
const strategyB = arg('--strategyB', 'aggro');
const intervalMs = Number(arg('--intervalMs', '900'));

async function startBotMatch() {
  const query =
    'mutation($a:String,$b:String,$i:Int){ startBotMatch(strategyA:$a, strategyB:$b, intervalMs:$i){ matchId players strategies spectatorPath } }';
  const body = JSON.stringify({
    query,
    variables: { a: strategyA, b: strategyB, i: intervalMs },
  });
  const res = await fetch(backendGraphql, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const json = await res.json();
  if (json.errors) throw new Error('GraphQL error: ' + JSON.stringify(json.errors));
  return json.data.startBotMatch;
}

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg exited ' + r.status);
}

(async () => {
  console.log('[capture] starting bot match...');
  const match = await startBotMatch();
  console.log('[capture] matchId:', match.matchId);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-capture-'));
  const videoDir = path.join(tmpDir, 'video');
  fs.mkdirSync(videoDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error('[page-error]', err.message));
  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) {
      console.log(`[console.${msg.type()}]`, msg.text());
    }
  });

  const url = `${frontendBase}/spectate?matchId=${match.matchId}`;
  console.log('[capture] navigating to', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

  // Wait for the live spectate board wrapper (the one that contains <GameBoard matchId={liveMatchId} />)
  await page.waitForSelector('[data-testid="spectate-live-board"]', { timeout: 45000 });
  console.log('[capture] spectate-live-board mounted');

  // Wait until the GameBoard is past loading state: loading-overlay should be gone
  // AND at least one recognizable battlefield/hand element should be present.
  try {
    await page.waitForFunction(
      () => {
        const board = document.querySelector('.game-board');
        if (!board) return false;
        const hasLoading = board.querySelector('.loading-overlay');
        if (hasLoading) return false;
        // Any of these indicates a real board view rendered
        const hints = [
          '.battlefield-row',
          '.battlefield',
          '.hand-zone',
          '.player-hand',
          '.board-row',
          '.card-img',
        ];
        return hints.some((sel) => document.querySelector(sel));
      },
      { timeout: 60000, polling: 500 }
    );
    console.log('[capture] GameBoard past loading state');
  } catch (err) {
    const screenshot = path.join(tmpDir, 'wait-failed.png');
    await page.screenshot({ path: screenshot, fullPage: false });
    const html = await page.content();
    fs.writeFileSync(path.join(tmpDir, 'wait-failed.html'), html);
    console.error('[capture] TIMEOUT waiting for GameBoard. screenshot:', screenshot);
    await context.close();
    await browser.close();
    throw err;
  }

  console.log(`[capture] recording ${captureSeconds}s of gameplay...`);
  const start = Date.now();
  const deadline = start + captureSeconds * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const status = await page.evaluate(() => {
        const board = document.querySelector('.game-board');
        if (!board) return { state: 'no-board' };
        if (board.querySelector('.loading-overlay')) return { state: 'loading' };
        const status = board.querySelector('.status-bar')?.textContent || null;
        const turn = document.querySelector('[data-testid="turn-indicator"]')?.textContent || null;
        return { state: 'live', status, turn };
      });
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`[capture] t+${elapsed}s`, status);
    } catch (err) {
      console.log('[capture] status poll failed:', err.message);
    }
  }

  // Close to flush the WebM recording
  const pageVideo = page.video();
  await context.close();
  await browser.close();

  const webmPath = pageVideo ? await pageVideo.path() : null;
  if (!webmPath || !fs.existsSync(webmPath)) {
    throw new Error('No webm video file was produced');
  }
  console.log('[capture] webm at', webmPath, 'size=', fs.statSync(webmPath).size);

  // Transcode WebM -> MP4 (H.264 + AAC silent audio not needed, -an keeps it silent)
  console.log('[capture] transcoding to mp4:', outMp4);
  fs.mkdirSync(path.dirname(outMp4), { recursive: true });
  ffmpeg([
    '-y',
    '-i',
    webmPath,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    outMp4,
  ]);
  console.log('[capture] DONE ->', outMp4, 'size=', fs.statSync(outMp4).size);
})().catch((err) => {
  console.error('[capture] FAILED:', err);
  process.exit(1);
});
