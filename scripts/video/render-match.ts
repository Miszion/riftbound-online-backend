/**
 * Riftbound Online - Match Replay Video Renderer
 *
 * Reads a JSONL event log produced by scripts/test/self-play.ts, renders each
 * event as a frame inside the match template using Playwright, and stitches
 * the frames into an MP4 with ffmpeg. Every frame shows the game state plus
 * a human-readable commentary line describing what just happened, so the
 * video is a faithful replay of an accurate engine run.
 *
 * Usage:
 *   npm run video:render -- --input=<path.jsonl> [--out=<path.mp4>]
 *                           [--fps=2] [--holdStart=2] [--holdEnd=4]
 *                           [--framesDir=<tmp>] [--keepFrames]
 *
 * Examples:
 *   npm run video:render -- --input=/Users/miszion/workplace/nexus-data/riftbound-games/match-20260417-025359-42.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  input: string;
  out: string;
  fps: number;
  holdStart: number;
  holdEnd: number;
  framesDir: string;
  keepFrames: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const map = new Map<string, string>();
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const [keyRaw, ...rest] = raw.slice(2).split('=');
    map.set(keyRaw, rest.length > 0 ? rest.join('=') : 'true');
  }
  const input = map.get('input');
  if (!input) {
    throw new Error('Missing --input=<path.jsonl>');
  }
  const absIn = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
  if (!fs.existsSync(absIn)) {
    throw new Error(`Input not found: ${absIn}`);
  }
  const defaultOut = path.join(
    path.dirname(absIn),
    path.basename(absIn, path.extname(absIn)) + '.mp4'
  );
  return {
    input: absIn,
    out: path.resolve(map.get('out') || defaultOut),
    fps: Number(map.get('fps') || 2),
    holdStart: Number(map.get('holdStart') || 2),
    holdEnd: Number(map.get('holdEnd') || 4),
    framesDir:
      map.get('framesDir') ||
      fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'riftbound-video-')),
    keepFrames: map.get('keepFrames') === 'true'
  };
}

// ---------------------------------------------------------------------------
// JSONL event shape (matches self-play.ts output)
// ---------------------------------------------------------------------------

interface JsonlEvent {
  matchId: string;
  gameIndex: number;
  seed: number;
  eventIndex: number;
  timestamp: string;
  turn: number;
  phase: string;
  activePlayer: string | null;
  actor: string;
  action: { kind: string; [k: string]: unknown } | null;
  vp?: Record<string, number>;
  hp?: Record<string, number>;
  mana?: Record<string, number>;
  stateDelta?: {
    handSizeP1?: number;
    handSizeP2?: number;
    deckSizeP1?: number;
    deckSizeP2?: number;
    boardCountP1?: number;
    boardCountP2?: number;
    graveyardCountP1?: number;
    graveyardCountP2?: number;
    battlefields?: Array<{ id: string; controller: string | null; contestedBy: string[] }>;
  };
  priorityHolder?: string | null;
  windowType?: string | null;
  cardPlayed?: {
    id: string;
    name: string;
    type: string;
    energyCost?: number;
    domain?: string;
    power?: number;
    toughness?: number;
    text?: string;
  };
  target?: string | null;
  terminal?: {
    winner: string | null;
    loser: string | null;
    reason: string;
    turns: number;
    totalEvents: number;
    violations: unknown[];
    durationMs: number;
  };
  meta?: { rolesByPlayer?: Record<string, string> };
}

// ---------------------------------------------------------------------------
// Commentary — plain-English description of an action
// ---------------------------------------------------------------------------

interface CommentaryLine {
  who: string;
  what: string;
  why: string;
  actorCls: 'p1' | 'p2' | 'system';
}

function actorCls(actor: string): 'p1' | 'p2' | 'system' {
  if (actor === 'P1') return 'p1';
  if (actor === 'P2') return 'p2';
  return 'system';
}

function prettyPhase(phase: string): string {
  return phase ? phase.replace(/_/g, ' ') : 'unknown';
}

function describeAction(e: JsonlEvent, prev: JsonlEvent | null): CommentaryLine {
  const a = e.action;
  const cls = actorCls(e.actor);
  const phaseLabel = prettyPhase(e.phase);
  const who = `${e.actor} during ${phaseLabel} on turn ${e.turn}`;

  if (a === null) {
    if (e.terminal) {
      const t = e.terminal;
      const winner = t.winner ? t.winner : 'no one';
      return {
        who: 'Match over',
        what: `${winner} wins by ${t.reason.replace(/_/g, ' ')}`,
        why: `${t.turns} turns, ${t.totalEvents} events, ${t.durationMs} ms of engine time`,
        actorCls: 'system'
      };
    }
    return {
      who: 'System',
      what: 'State tick',
      why: `Phase ${phaseLabel}, active ${e.activePlayer || '-'}`,
      actorCls: 'system'
    };
  }

  switch (a.kind) {
    case 'advance_phase': {
      const prevPhase = prev && prev.phase !== e.phase ? prev.phase : null;
      const whyParts: string[] = [];
      if (prevPhase) whyParts.push(`moved from ${prettyPhase(prevPhase)} to ${phaseLabel}`);
      whyParts.push(`active player is now ${e.activePlayer || '-'}`);
      return {
        who,
        what: `${e.actor} advances the phase`,
        why: whyParts.join(', '),
        actorCls: cls
      };
    }
    case 'play_card': {
      const card = e.cardPlayed;
      const name = card ? card.name : `card #${(a as any).cardIndex}`;
      const cost = card?.energyCost != null ? `${card.energyCost} mana` : 'unknown cost';
      const type = card?.type || 'card';
      const target = e.target || (a as any).destinationId || null;
      return {
        who,
        what: `${e.actor} plays ${name}`,
        why: `${type}, ${cost}${target ? `, destined for ${target}` : ''}${card?.text ? ` — ${card.text}` : ''}`,
        actorCls: cls
      };
    }
    case 'deploy_leader': {
      const dest = (a as any).destinationId || 'the base';
      return {
        who,
        what: `${e.actor} deploys their leader`,
        why: `sent to ${dest}`,
        actorCls: cls
      };
    }
    case 'activate_legend':
      return { who, what: `${e.actor} activates their legend`, why: 'legend ability triggered', actorCls: cls };
    case 'hide_card': {
      const bf = (a as any).battlefieldId || 'battlefield';
      return {
        who,
        what: `${e.actor} hides a card at ${bf}`,
        why: `card #${(a as any).cardIndex} set face-down`,
        actorCls: cls
      };
    }
    case 'move_unit': {
      const dest = (a as any).destinationId || 'another battlefield';
      return {
        who,
        what: `${e.actor} moves a unit`,
        why: `unit ${(a as any).creatureInstanceId} repositioned to ${dest}`,
        actorCls: cls
      };
    }
    case 'commence_battle': {
      const bf = (a as any).battlefieldId || 'battlefield';
      return {
        who,
        what: `${e.actor} commences battle at ${bf}`,
        why: `combat priority opens at ${bf}`,
        actorCls: cls
      };
    }
    case 'pass_priority':
      return { who, what: `${e.actor} passes priority`, why: 'no action this window', actorCls: cls };
    case 'respond_chain': {
      const passed = (a as any).pass;
      return {
        who,
        what: passed ? `${e.actor} passes the chain` : `${e.actor} responds on the chain`,
        why: passed ? 'chain can resolve if both sides pass' : 'added to the reaction chain',
        actorCls: cls
      };
    }
    case 'resolve_prompt_discard':
      return {
        who,
        what: `${e.actor} resolves a discard prompt`,
        why: `discarded ${(a as any).instanceIds?.length ?? 0} card(s)`,
        actorCls: cls
      };
    case 'resolve_prompt_target':
      return {
        who,
        what: `${e.actor} resolves a targeting prompt`,
        why: `selected ${(a as any).selectionIds?.length ?? 0} target(s)`,
        actorCls: cls
      };
    case 'mulligan': {
      const n = ((a as any).indices as number[] | undefined)?.length ?? 0;
      return {
        who,
        what: `${e.actor} mulligans ${n} card(s)`,
        why: 'replacing opener before the match begins',
        actorCls: cls
      };
    }
    case 'submit_initiative':
      return {
        who,
        what: `${e.actor} picks initiative choice ${(a as any).choice}`,
        why: 'bidding for turn order',
        actorCls: cls
      };
    case 'select_battlefield':
      return {
        who,
        what: `${e.actor} selects a battlefield`,
        why: `chose ${(a as any).battlefieldId}`,
        actorCls: cls
      };
    case 'concede':
      return { who, what: `${e.actor} concedes`, why: 'match ends immediately', actorCls: cls };
    default:
      return { who, what: `${e.actor} takes action ${a.kind}`, why: '', actorCls: cls };
  }
}

// ---------------------------------------------------------------------------
// Frame builder (matches window.setFrame() in match-template.html)
// ---------------------------------------------------------------------------

interface LogLine {
  idx: number;
  text: string;
  cls: 'p1' | 'p2' | 'system';
}

interface Frame {
  matchId: string;
  turn: number;
  phase: string;
  activePlayer: string | null;
  priorityHolder: string | null;
  eventIndex: number;
  eventTotal: number;
  mana: Record<string, number>;
  vp: Record<string, number>;
  hp: Record<string, number>;
  stateDelta: JsonlEvent['stateDelta'];
  rolesByPlayer: Record<string, string>;
  commentary: CommentaryLine;
  logLines: LogLine[];
  terminal?: {
    bannerTitle: string;
    bannerReason: string;
    bannerStats: string;
  };
}

function buildFrames(events: JsonlEvent[]): Frame[] {
  const frames: Frame[] = [];
  const log: LogLine[] = [];
  const rolesByPlayer = events[0]?.meta?.rolesByPlayer || { P1: 'bot', P2: 'bot' };

  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    const prev = i > 0 ? events[i - 1] : null;
    const commentary = describeAction(e, prev);

    log.push({
      idx: e.eventIndex,
      text: `${commentary.what}${commentary.why ? ` — ${commentary.why}` : ''}`,
      cls: commentary.actorCls
    });

    const frame: Frame = {
      matchId: e.matchId,
      turn: e.turn,
      phase: e.phase,
      activePlayer: e.activePlayer,
      priorityHolder: e.priorityHolder ?? null,
      eventIndex: e.eventIndex,
      eventTotal: events.length,
      mana: e.mana || { P1: 0, P2: 0 },
      vp: e.vp || { P1: 0, P2: 0 },
      hp: e.hp || { P1: 0, P2: 0 },
      stateDelta: e.stateDelta || {},
      rolesByPlayer,
      commentary,
      logLines: log.slice()
    };

    if (e.terminal) {
      const t = e.terminal;
      const winner = t.winner || 'no one';
      frame.terminal = {
        bannerTitle: `${winner} wins`,
        bannerReason: `by ${t.reason.replace(/_/g, ' ')} after ${t.turns} turns`,
        bannerStats: `${t.totalEvents} events, ${t.violations.length} violations, ${t.durationMs} ms`
      };
    }

    frames.push(frame);
  }
  return frames;
}

// ---------------------------------------------------------------------------
// JSONL loader
// ---------------------------------------------------------------------------

function loadEvents(filePath: string): JsonlEvent[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const out: JsonlEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch (err) {
      console.warn('[render-match] skipping bad JSONL line:', err);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  console.log('[render-match] input:', args.input);
  console.log('[render-match] output:', args.out);
  console.log('[render-match] frames dir:', args.framesDir);

  const events = loadEvents(args.input);
  if (events.length === 0) {
    throw new Error('No events found in JSONL input');
  }
  console.log(`[render-match] loaded ${events.length} events`);

  const frames = buildFrames(events);

  if (!fs.existsSync(args.framesDir)) {
    fs.mkdirSync(args.framesDir, { recursive: true });
  }

  const templatePath = path.join(__dirname, 'match-template.html');
  const templateUrl = 'file://' + templatePath;

  // Playwright 1.55+ ships a separate headless shell binary. If it is not
  // installed, fall back to the full chromium channel so the renderer works
  // with whatever was cached by `npm install`.
  const shellPath = path.join(
    require('node:os').homedir(),
    'Library/Caches/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-mac-arm64/chrome-headless-shell'
  );
  const useChannel = !fs.existsSync(shellPath);
  const launchOpts: Parameters<typeof chromium.launch>[0] = { headless: true };
  if (useChannel) {
    (launchOpts as { channel?: string }).channel = 'chromium';
  }
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();
  await page.goto(templateUrl);
  await page.waitForFunction(() => (window as any).ready === true, { timeout: 15000 });

  const pad = String(frames.length).length;
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    await page.evaluate((f) => (window as any).setFrame(f), frame as unknown as Record<string, unknown>);
    const pngPath = path.join(args.framesDir, `frame-${String(i).padStart(pad, '0')}.png`);
    await page.screenshot({ path: pngPath, type: 'png' });
    if (i % 25 === 0 || i === frames.length - 1) {
      console.log(`[render-match] frame ${i + 1}/${frames.length}`);
    }
  }

  await browser.close();

  // Build the ffmpeg concat file so we can hold the first and last frames
  // longer — makes the opening and final score actually readable.
  const firstFrame = path.join(args.framesDir, `frame-${'0'.padStart(pad, '0')}.png`);
  const lastFrame = path.join(args.framesDir, `frame-${String(frames.length - 1).padStart(pad, '0')}.png`);
  const concatPath = path.join(args.framesDir, 'concat.txt');
  const fpsDuration = 1 / args.fps;
  const concatLines: string[] = [];
  // Hold opening frame
  for (let i = 0; i < Math.max(1, Math.round(args.holdStart * args.fps)); i += 1) {
    concatLines.push(`file '${firstFrame}'`);
    concatLines.push(`duration ${fpsDuration.toFixed(6)}`);
  }
  for (let i = 0; i < frames.length; i += 1) {
    const p = path.join(args.framesDir, `frame-${String(i).padStart(pad, '0')}.png`);
    concatLines.push(`file '${p}'`);
    concatLines.push(`duration ${fpsDuration.toFixed(6)}`);
  }
  // Hold closing frame
  for (let i = 0; i < Math.max(1, Math.round(args.holdEnd * args.fps)); i += 1) {
    concatLines.push(`file '${lastFrame}'`);
    concatLines.push(`duration ${fpsDuration.toFixed(6)}`);
  }
  // ffmpeg concat demuxer requires the last file to be listed again without duration
  concatLines.push(`file '${lastFrame}'`);
  fs.writeFileSync(concatPath, concatLines.join('\n'));

  // Stitch with ffmpeg
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  const result = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatPath,
      '-vf', `fps=${args.fps},format=yuv420p`,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '20',
      args.out
    ],
    { stdio: 'inherit' }
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg exited with code ${result.status}`);
  }
  console.log(`[render-match] wrote ${args.out}`);

  if (!args.keepFrames) {
    fs.rmSync(args.framesDir, { recursive: true, force: true });
    console.log('[render-match] cleaned up frames dir');
  } else {
    console.log(`[render-match] frames kept at ${args.framesDir}`);
  }
}

main().catch((err) => {
  console.error('[render-match] fatal:', err);
  process.exit(1);
});
