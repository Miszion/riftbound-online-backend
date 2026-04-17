import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const BACKEND = process.env.BACKEND_URL || 'http://localhost:4000';
const PUBLIC_HOST = process.env.PUBLIC_HOST || '10.0.0.97';
const OUT_FILE =
  process.env.OUT_FILE ||
  path.join(__dirname, '..', '..', '..', 'nexus-data', 'research', 'spectate-url.txt');

type Card = {
  id: string;
  name: string;
  slug?: string;
  type?: string;
  cost?: { energy?: number } | number | null;
  tags?: string[];
  colors?: string[];
  effect?: string;
};

function shuffle<T>(arr: T[]): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function loadCards(): Card[] {
  const dataPath = path.join(__dirname, '..', '..', 'data', 'cards.enriched.json');
  const raw = JSON.parse(readFileSync(dataPath, 'utf-8'));
  if (Array.isArray(raw)) return raw as Card[];
  if (raw && Array.isArray(raw.cards)) return raw.cards as Card[];
  throw new Error('Unexpected cards.enriched.json shape');
}

function isBattlefield(c: Card): boolean {
  const tags = (c.tags ?? []).map((t) => t.toLowerCase());
  const type = (c.type ?? '').toLowerCase();
  return tags.includes('battlefield') || type === 'battlefield';
}

function buildDeck(pool: Card[]) {
  const playable = pool.filter((c) => {
    const t = (c.type ?? '').toLowerCase();
    if (!['unit', 'spell', 'gear'].includes(t)) return false;
    if (isBattlefield(c)) return false;
    return true;
  });
  const battlefields = pool.filter(isBattlefield);

  const mainDeck: string[] = [];
  const shuffled = shuffle(playable);
  for (let i = 0; mainDeck.length < 40 && i < shuffled.length * 3; i += 1) {
    mainDeck.push(shuffled[i % shuffled.length].id);
  }

  const runeDeck = Array.from({ length: 12 }).map((_, i) => ({
    id: `live-rune-${i}`,
    name: `Live Rune ${i}`,
    slug: `live-rune-${i}`,
    domain: ['Fury', 'Mind', 'Body', 'Calm', 'Chaos', 'Order'][i % 6],
    energyValue: 1,
    powerValue: 1,
    isTapped: false,
    assets: null,
    cardSnapshot: null,
  }));

  const bfPicks = shuffle(battlefields).slice(0, 3).map((r) => r.id);

  return {
    mainDeck,
    runeDeck,
    battlefields: bfPicks.length > 0 ? bfPicks : [battlefields[0]?.id].filter(Boolean),
  };
}

async function main() {
  const cards = loadCards();
  console.log(`Loaded ${cards.length} cards from enriched dataset`);

  const matchId = `live-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const player1 = 'p1-bot';
  const player2 = 'p2-bot';

  const deckA = buildDeck(cards);
  const deckB = buildDeck(cards);

  console.log(
    `Match ${matchId} | main=${deckA.mainDeck.length}/${deckB.mainDeck.length} runes=${deckA.runeDeck.length}/${deckB.runeDeck.length} bf=${deckA.battlefields.length}/${deckB.battlefields.length}`,
  );

  const body = {
    matchId,
    player1,
    player2,
    decks: {
      [player1]: deckA,
      [player2]: deckB,
    },
    playerProfiles: {
      [player1]: { username: 'Baseline Bot' },
      [player2]: { username: 'Heuristic Bot' },
    },
  };

  const res = await fetch(`${BACKEND}/matches/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`init status=${res.status}`);
  console.log(text.slice(0, 800));

  if (!res.ok) {
    process.exit(1);
  }

  const url = `http://${PUBLIC_HOST}:3000/spectate/?matchId=${matchId}`;
  writeFileSync(OUT_FILE, `${url}\nmatchId=${matchId}\n`);
  console.log(`WROTE ${OUT_FILE}`);
  console.log(`SPECTATE URL: ${url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
