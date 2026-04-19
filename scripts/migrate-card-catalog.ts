/**
 * scripts/migrate-card-catalog.ts
 *
 * Phase 3 ETL migration. Two data-quality fixes to data/cards.enriched.json:
 *
 *   Fix 1 - strip `rune_resource` classification leaks from
 *           card.effectProfile.operations[] and card.abilities[].operations[].
 *           Per riftbound-effect-spec.md section 16.5, `rune_resource` is a
 *           classification label, not an op. The runtime filter in
 *           src/effects/index.ts stays in place as a defensive guard.
 *
 *   Fix 2 - split `manipulate_priority` variants 1-3 into a new top-level
 *           card.timingTags: string[] field. Variants 1-3 are
 *           `action_tagged`, `reaction_tagged`, and `add_reaction`, which per
 *           riftbound-effect-spec.md section 17 are timing classifications,
 *           not imperative ops. Variants 4+ (`take_focus`, `grant_priority`,
 *           `extra_action`, `skip_priority_pass`) remain in operations[] as
 *           genuine priority manipulation.
 *
 * PHASE 8b UPDATE (2026-04-18): Fix 1 and Fix 2 are now handled upstream in
 * the enricher itself (scripts/data/transformChampionDump.ts + its mirror in
 * src/card-catalog.ts). Both fixes SHOULD be a no-op on fresh catalogs.
 * This script is retained as defense-in-depth so a future enricher
 * regression can be rolled forward without re-scraping the source dump.
 * See docs/phase-3-etl-migration.md and docs/phase-7-coverage-audit.md.
 *
 * Idempotent: running the script twice is a no-op after the first pass.
 * Logs ETL-style counters to stdout. --dry-run skips the disk write.
 *
 * Usage:
 *   npx tsx scripts/migrate-card-catalog.ts [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';

const ENRICHED_PATH = path.resolve(
  __dirname,
  '..',
  'data',
  'cards.enriched.json'
);

// The three manipulate_priority variants that are timing classifications,
// not real priority manipulation. Section 17.3 variants 1-3.
type TimingTag = 'action' | 'reaction' | 'add_reaction';

interface Op {
  type: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface Ability {
  operations?: Op[];
  [key: string]: unknown;
}

interface Card {
  id: string;
  type?: string | null;
  effect?: string | null;
  effectProfile?: {
    operations: Op[];
    [key: string]: unknown;
  };
  abilities?: Ability[];
  timingTags?: string[];
  [key: string]: unknown;
}

interface Catalog {
  generatedAt?: string;
  totalCards?: number;
  cards: Card[];
  [key: string]: unknown;
}

interface Stats {
  cardsScanned: number;
  runeResourceStripped: {
    fromEffectProfile: number;
    fromAbilities: number;
    cardsTouched: number;
    cardIds: string[];
  };
  manipulatePriority: {
    cardsWithAnyOp: number;
    opsMovedToTimingTags: number;
    opsRemainingAsGenuine: number;
    cardsWithNonEmptyTimingTags: number;
    cardsWithEmptyTimingTags: number;
    tagDistribution: Record<string, number>;
    unmatchedCards: string[]; // cards with op but no derivable variant
    abilitiesOpsMoved: number;
  };
}

/**
 * Classify a `manipulate_priority` op based on the card's printed effect
 * text. Returns null if the card does not plausibly fit one of the three
 * timing-tag variants; in that case the op is left in place as a potential
 * variant 4+ candidate.
 *
 * Heuristics tuned against the 146 cards in the current catalog:
 *   - `[Action]` or bare ACTION at start of a clause   -> action
 *   - `[Reaction]` or bare REACTION at start of clause -> reaction
 *   - Reaction + activated-cost (`:rb_exhaust:`, `[tap]`, `Kill this:`,
 *     energy/rune payment) + ADD/[Add]                 -> add_reaction
 */
function deriveTimingTag(effectText: string | null | undefined): TimingTag | null {
  const e = String(effectText ?? '');
  const hasAction = /\[Action\]/i.test(e) || /\bACTION\b/.test(e);
  const hasReaction = /\[Reaction\]/i.test(e) || /\bREACTION\b/.test(e);
  const isActivated =
    /:rb_exhaust:|\[tap\]|:rb_rune_[a-z]+:|:rb_energy_\d+:|\bKill\s+this\s*:/i.test(e);
  const hasAdd =
    /\[Add\]/i.test(e) ||
    /\bADD\b/.test(e) ||
    /\badd\b\s*(?:that\s+much|any\s+amount|\[|:rb_)/i.test(e);
  if (hasReaction && (isActivated || hasAdd) && hasAdd) return 'add_reaction';
  if (hasReaction) return 'reaction';
  if (hasAction) return 'action';
  return null;
}

/**
 * True if the op is already classified as a variant 4+ (real priority
 * manipulation). In the current dataset no ops carry a `variant` key, so
 * this only fires if a future ETL run stamps that metadata.
 */
function isGenuinePriorityVariant(op: Op): boolean {
  const variant = op.metadata && (op.metadata as Record<string, unknown>).variant;
  if (typeof variant !== 'string') return false;
  const genuine = new Set([
    'take_focus',
    'grant_priority',
    'extra_action',
    'skip_priority_pass'
  ]);
  return genuine.has(variant);
}

/**
 * Fix 1 + Fix 2 applied to a single card in place. Returns whether any
 * change was made; used only for diagnostics, not correctness.
 */
function migrateCard(card: Card, stats: Stats): void {
  stats.cardsScanned++;

  // --- Fix 1: strip rune_resource from effectProfile.operations ---
  let cardTouchedByFix1 = false;
  if (card.effectProfile && Array.isArray(card.effectProfile.operations)) {
    const before = card.effectProfile.operations.length;
    card.effectProfile.operations = card.effectProfile.operations.filter(
      (op) => op.type !== 'rune_resource'
    );
    const removed = before - card.effectProfile.operations.length;
    if (removed > 0) {
      stats.runeResourceStripped.fromEffectProfile += removed;
      cardTouchedByFix1 = true;
    }
  }

  // --- Fix 1 (continued): strip rune_resource from abilities[].operations ---
  if (Array.isArray(card.abilities)) {
    for (const ability of card.abilities) {
      if (!Array.isArray(ability.operations)) continue;
      const before = ability.operations.length;
      ability.operations = ability.operations.filter(
        (op) => op.type !== 'rune_resource'
      );
      const removed = before - ability.operations.length;
      if (removed > 0) {
        stats.runeResourceStripped.fromAbilities += removed;
        cardTouchedByFix1 = true;
      }
    }
  }

  if (cardTouchedByFix1) {
    stats.runeResourceStripped.cardsTouched++;
    stats.runeResourceStripped.cardIds.push(card.id);
  }

  // --- Fix 2: split manipulate_priority into timingTags ---
  // Ensure the field exists exactly once, defaulted to [].
  if (!Array.isArray(card.timingTags)) {
    card.timingTags = [];
  }
  const existingTags = new Set(card.timingTags);

  // --- Fix 2 on effectProfile.operations ---
  if (card.effectProfile && Array.isArray(card.effectProfile.operations)) {
    const ops = card.effectProfile.operations;
    const remaining: Op[] = [];
    let hadAny = false;
    let movedOnThisCard = 0;
    for (const op of ops) {
      if (op.type !== 'manipulate_priority') {
        remaining.push(op);
        continue;
      }
      hadAny = true;
      if (isGenuinePriorityVariant(op)) {
        remaining.push(op);
        stats.manipulatePriority.opsRemainingAsGenuine++;
        continue;
      }
      const tag = deriveTimingTag(card.effect ?? null);
      if (tag === null) {
        // Leave it in place; flag for human review.
        remaining.push(op);
        if (!stats.manipulatePriority.unmatchedCards.includes(card.id)) {
          stats.manipulatePriority.unmatchedCards.push(card.id);
        }
        continue;
      }
      if (!existingTags.has(tag)) {
        card.timingTags.push(tag);
        existingTags.add(tag);
      }
      stats.manipulatePriority.opsMovedToTimingTags++;
      movedOnThisCard++;
    }
    card.effectProfile.operations = remaining;
    if (hadAny) stats.manipulatePriority.cardsWithAnyOp++;
    // movedOnThisCard is used indirectly; tag distribution is computed in
    // the post-pass where every card's final timingTags list is counted.
    void movedOnThisCard;
  }

  // --- Fix 2 on abilities[].operations (same treatment) ---
  if (Array.isArray(card.abilities)) {
    for (const ability of card.abilities) {
      if (!Array.isArray(ability.operations)) continue;
      const remaining: Op[] = [];
      for (const op of ability.operations) {
        if (op.type !== 'manipulate_priority') {
          remaining.push(op);
          continue;
        }
        if (isGenuinePriorityVariant(op)) {
          remaining.push(op);
          stats.manipulatePriority.opsRemainingAsGenuine++;
          continue;
        }
        const tag = deriveTimingTag(card.effect ?? null);
        if (tag === null) {
          remaining.push(op);
          if (!stats.manipulatePriority.unmatchedCards.includes(card.id)) {
            stats.manipulatePriority.unmatchedCards.push(card.id);
          }
          continue;
        }
        if (!existingTags.has(tag)) {
          card.timingTags.push(tag);
          existingTags.add(tag);
        }
        stats.manipulatePriority.opsMovedToTimingTags++;
        stats.manipulatePriority.abilitiesOpsMoved++;
      }
      ability.operations = remaining;
    }
  }
}

function buildStats(): Stats {
  return {
    cardsScanned: 0,
    runeResourceStripped: {
      fromEffectProfile: 0,
      fromAbilities: 0,
      cardsTouched: 0,
      cardIds: []
    },
    manipulatePriority: {
      cardsWithAnyOp: 0,
      opsMovedToTimingTags: 0,
      opsRemainingAsGenuine: 0,
      cardsWithNonEmptyTimingTags: 0,
      cardsWithEmptyTimingTags: 0,
      tagDistribution: {},
      unmatchedCards: [],
      abilitiesOpsMoved: 0
    }
  };
}

/**
 * Re-serialize a card so its keys land in a deterministic order. Most card
 * records already have a stable order from the original ETL. We preserve
 * that order for existing keys and slot `timingTags` in just before
 * `effectProfile` so the diff is compact and readable.
 */
function reorderCardKeys(card: Card): Card {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(card);
  const timingTags = card.timingTags ?? [];
  const keysWithoutTimingTags = keys.filter((k) => k !== 'timingTags');
  // Insert timingTags right before `effectProfile`. If effectProfile is
  // absent, append at the end.
  let inserted = false;
  for (const k of keysWithoutTimingTags) {
    if (!inserted && k === 'effectProfile') {
      out.timingTags = timingTags;
      inserted = true;
    }
    out[k] = card[k];
  }
  if (!inserted) {
    out.timingTags = timingTags;
  }
  return out as Card;
}

/**
 * Quick before-snapshot read so the report can show the delta. We re-parse
 * the file to capture untouched counts of both leaks.
 */
function snapshotBefore(cards: Card[]): {
  runeResourceOps: number;
  manipulatePriorityOps: number;
  cardsWithTimingTags: number;
  topOps: Array<[string, number]>;
} {
  const opCounts = new Map<string, number>();
  let runeResourceOps = 0;
  let manipulatePriorityOps = 0;
  let cardsWithTimingTags = 0;
  for (const card of cards) {
    if (Array.isArray(card.timingTags) && card.timingTags.length > 0) {
      cardsWithTimingTags++;
    }
    const all: Op[] = [];
    if (card.effectProfile && Array.isArray(card.effectProfile.operations)) {
      all.push(...card.effectProfile.operations);
    }
    if (Array.isArray(card.abilities)) {
      for (const a of card.abilities) {
        if (Array.isArray(a.operations)) all.push(...a.operations);
      }
    }
    for (const op of all) {
      opCounts.set(op.type, (opCounts.get(op.type) ?? 0) + 1);
      if (op.type === 'rune_resource') runeResourceOps++;
      if (op.type === 'manipulate_priority') manipulatePriorityOps++;
    }
  }
  const topOps = [...opCounts.entries()].sort((a, b) => b[1] - a[1]);
  return { runeResourceOps, manipulatePriorityOps, cardsWithTimingTags, topOps };
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const raw = fs.readFileSync(ENRICHED_PATH, 'utf-8');
  const catalog = JSON.parse(raw) as Catalog;
  const cards = catalog.cards;
  if (!Array.isArray(cards)) {
    throw new Error('cards.enriched.json missing `cards` array');
  }

  const before = snapshotBefore(cards);
  console.log('[etl] migrate-card-catalog starting');
  console.log(`[etl] input: ${ENRICHED_PATH}`);
  console.log(`[etl] cards scanned: ${cards.length}`);
  console.log(`[etl] before: rune_resource ops=${before.runeResourceOps}`);
  console.log(
    `[etl] before: manipulate_priority ops=${before.manipulatePriorityOps}`
  );
  console.log(
    `[etl] before: cards with non-empty timingTags=${before.cardsWithTimingTags}`
  );

  const stats = buildStats();
  const migrated: Card[] = [];
  for (const card of cards) {
    migrateCard(card, stats);
    migrated.push(reorderCardKeys(card));
  }

  // Post-pass: finalize timingTag distribution + empty/non-empty split.
  for (const card of migrated) {
    const tags = Array.isArray(card.timingTags) ? card.timingTags : [];
    if (tags.length === 0) {
      stats.manipulatePriority.cardsWithEmptyTimingTags++;
    } else {
      stats.manipulatePriority.cardsWithNonEmptyTimingTags++;
      for (const t of tags) {
        stats.manipulatePriority.tagDistribution[t] =
          (stats.manipulatePriority.tagDistribution[t] ?? 0) + 1;
      }
    }
  }

  // Verification: recompute the post-migration residual counts.
  const after = snapshotBefore(migrated);

  console.log('---');
  console.log(
    `[etl] fix1 rune_resource removed: effectProfile=${stats.runeResourceStripped.fromEffectProfile} abilities=${stats.runeResourceStripped.fromAbilities}`
  );
  console.log(
    `[etl] fix1 cards touched: ${stats.runeResourceStripped.cardsTouched}`
  );
  console.log(
    `[etl] fix2 manipulate_priority ops moved to timingTags: ${stats.manipulatePriority.opsMovedToTimingTags}`
  );
  console.log(
    `[etl] fix2 manipulate_priority ops remaining as genuine: ${stats.manipulatePriority.opsRemainingAsGenuine}`
  );
  console.log(
    `[etl] fix2 cards with timingTags populated: ${stats.manipulatePriority.cardsWithNonEmptyTimingTags}`
  );
  console.log(
    `[etl] fix2 cards with empty timingTags: ${stats.manipulatePriority.cardsWithEmptyTimingTags}`
  );
  console.log(
    `[etl] fix2 tag distribution: ${JSON.stringify(stats.manipulatePriority.tagDistribution)}`
  );
  console.log(
    `[etl] fix2 unmatched cards: ${stats.manipulatePriority.unmatchedCards.length}`
  );
  if (stats.manipulatePriority.unmatchedCards.length > 0) {
    console.log(
      `[etl] fix2 unmatched ids: ${stats.manipulatePriority.unmatchedCards.join(',')}`
    );
  }
  console.log('---');
  console.log(
    `[etl] after: rune_resource ops=${after.runeResourceOps}`
  );
  console.log(
    `[etl] after: manipulate_priority ops=${after.manipulatePriorityOps}`
  );
  console.log(
    `[etl] after: cards with non-empty timingTags=${after.cardsWithTimingTags}`
  );

  if (dryRun) {
    console.log('[etl] --dry-run set; not writing');
    return;
  }

  const output: Catalog = {
    ...catalog,
    generatedAt: catalog.generatedAt ?? new Date().toISOString(),
    totalCards: migrated.length,
    cards: migrated
  };
  fs.writeFileSync(ENRICHED_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`[etl] wrote: ${ENRICHED_PATH}`);
}

try {
  main();
} catch (err) {
  console.error('[etl] FATAL', err);
  process.exit(1);
}
