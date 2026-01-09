import fs from 'node:fs';
import path from 'node:path';
import { getCardCatalog, parseTokenSpecs, TokenSpec } from '../../src/card-catalog';

const OUTPUT_PATH = path.resolve(process.cwd(), 'data', 'token-creators.json');

type TokenCreatorRecord = {
  id: string;
  slug?: string;
  name: string;
  type: string;
  effect: string;
};

type TokenFamily = {
  token: TokenSpec;
  cards: TokenCreatorRecord[];
};

const ensureDir = (filepath: string) => {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const groupKey = (spec: TokenSpec) =>
  [
    spec.name.toLowerCase(),
    spec.might,
    spec.location,
    spec.entersReady ? 'ready' : 'tapped',
    spec.keywords?.slice().sort().join('-') ?? 'none'
  ].join('__');

const main = () => {
  const catalog = getCardCatalog();
  const groups = new Map<string, TokenFamily>();
  let tokenCardCount = 0;
  const tokenTextMatches: TokenCreatorRecord[] = [];
  const unmatched: TokenCreatorRecord[] = [];

  catalog.forEach((card) => {
    const effectText = card.effect ?? card.text ?? '';
    if (/unit token/i.test(effectText)) {
      tokenTextMatches.push({
        id: card.id,
        slug: card.slug,
        name: card.name,
        type: card.type,
        effect: effectText
      });
    }
    const specs = parseTokenSpecs(effectText);
    if (specs.length === 0) {
      if (/unit token/i.test(effectText)) {
        unmatched.push({
          id: card.id,
          slug: card.slug,
          name: card.name,
          type: card.type,
          effect: effectText
        });
      }
      return;
    }
    tokenCardCount += 1;
    specs.forEach((spec) => {
      const key = groupKey(spec);
      if (!groups.has(key)) {
        groups.set(key, {
          token: spec,
          cards: []
        });
      }
      const family = groups.get(key)!;
      family.cards.push({
        id: card.id,
        slug: card.slug,
        name: card.name,
        type: card.type,
        effect: effectText
      });
    });
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    totalCards: catalog.length,
    tokenCreatorCards: tokenCardCount,
    detectedTokenText: tokenTextMatches.length,
    unmatchedTokenText: unmatched.length,
    tokenFamilies: Array.from(groups.values()).map((family) => ({
      token: family.token,
      cards: family.cards.sort((a, b) => a.name.localeCompare(b.name))
    })),
    unmatched
  };

  ensureDir(OUTPUT_PATH);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  console.log(
    `[token-creators] cataloged ${payload.tokenFamilies.length} token families across ${tokenCardCount} cards (${unmatched.length} unmatched token texts) -> ${OUTPUT_PATH}`
  );
};

main();
