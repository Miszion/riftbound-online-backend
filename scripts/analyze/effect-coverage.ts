/**
 * Effect Coverage Analysis Script
 *
 * Analyzes the gap between classified card effects and runtime handlers
 * in the game engine.
 *
 * Usage: npx ts-node scripts/analyze/effect-coverage.ts
 */

import * as fs from 'fs';
import * as path from 'path';

interface TaxonomyCard {
  cardId: string;
  name: string;
  classes: string[];
}

interface EffectTaxonomy {
  generatedAt: string;
  cards: TaxonomyCard[];
}

// Categories of effect types by their runtime behavior
const PASSIVE_EFFECTS = [
  // These modify game state continuously without needing explicit handlers
  'aura_buff',           // Continuous modifier on allies
  'location_aura',       // Location-based continuous effect
  'tribal_synergy',      // Tag/type-based continuous buff
  'stat_scaling',        // Dynamic stat calculation
  'conditional_buff',    // Conditional continuous buff
  'cost_reduction',      // Modifies play costs
  'cost_increase',       // Modifies opponent play costs
  'targeting_discount',  // Modifies targeting costs
  'scoring_restriction', // Restricts scoring
  'play_restriction',    // Restricts card plays
  'hide_modifier',       // Modifies hide mechanics
  'solo_combat',         // Combat modifier when alone
  'rune_resource',       // Basic rune - no special effect
] as const;

const KEYWORD_EFFECTS = [
  // Keywords checked via cardHasMechanic or special logic
  'keyword_legion',       // Bonus if another card played this turn
  'keyword_accelerate',   // Can enter ready for extra cost
  'keyword_hidden',       // Can be hidden to react later
  'keyword_deflect',      // Costs more to target
  'keyword_weaponmaster', // Equip gear at discount
  'keyword_ganking',      // Can move battlefield to battlefield
  'keyword_tank',         // Must be targeted first in combat
  'keyword_repeat',       // Can repeat spell effect
] as const;

const TRIGGERED_EFFECTS = [
  // These fire at specific game events
  'on_play_trigger',     // When card enters play
  'death_trigger',       // When card dies
  'combat_trigger',      // When attacking/defending
  'hold_trigger',        // When holding battlefield
  'conquer_trigger',     // When conquering battlefield
  'equip_trigger',       // When equipment attached
  'phase_trigger',       // At phase start/end
  'follow_movement',     // When another unit moves
  'scoring',             // When scoring occurs
] as const;

const ACTIVE_EFFECTS = [
  // These need explicit operation handlers
  'stun',                // Stun/exhaust a target
  'ready',               // Ready/untap a target
  'ability_copy',        // Copy abilities from another card
  'effect_amplifier',    // Multiply/amplify effects
] as const;

function analyzeEffectCoverage(): void {
  const rootDir = path.resolve(__dirname, '../..');

  // Get all effect classes from taxonomy
  const taxonomyPath = path.join(rootDir, 'data/effect-taxonomy.json');
  const taxonomy: EffectTaxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8'));
  const usedClasses = new Set<string>();
  taxonomy.cards.forEach((card) => {
    card.classes.forEach((cls) => usedClasses.add(cls));
  });

  // Get all operation types from card-catalog
  const catalogPath = path.join(rootDir, 'src/card-catalog.ts');
  const catalogSource = fs.readFileSync(catalogPath, 'utf8');
  const opTypeMatch = catalogSource.match(/export type EffectOperationType =([\s\S]*?);/);
  if (!opTypeMatch) {
    console.error('Could not find EffectOperationType in card-catalog.ts');
    process.exit(1);
  }

  const operationTypes = opTypeMatch[1]
    .split('|')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter((s) => s.length > 0);

  // Get handled cases from game-engine
  const enginePath = path.join(rootDir, 'src/game-engine.ts');
  const engineSource = fs.readFileSync(enginePath, 'utf8');
  const handledOps = [...engineSource.matchAll(/case '([^']+)':/g)]
    .map((m) => m[1])
    .filter((s) => operationTypes.includes(s));

  const handledOpsSet = new Set(handledOps);
  const unhandledOps = operationTypes.filter(
    (op) => !handledOpsSet.has(op) && op !== 'generic' && op !== 'combat_bonus'
  );

  // Output analysis
  console.log('=== EFFECT TYPE ANALYSIS ===\n');

  console.log('PASSIVE EFFECTS (need continuous state evaluation):');
  PASSIVE_EFFECTS.forEach((e) => {
    const inUse = usedClasses.has(e);
    console.log(`  ${e}: ${inUse ? '✓ in use' : '○ not used'}`);
  });

  console.log('\nKEYWORD EFFECTS (checked via cardHasMechanic):');
  KEYWORD_EFFECTS.forEach((e) => {
    const inUse = usedClasses.has(e);
    console.log(`  ${e}: ${inUse ? '✓ in use' : '○ not used'}`);
  });

  console.log('\nTRIGGERED EFFECTS (fire at game events):');
  TRIGGERED_EFFECTS.forEach((e) => {
    const inUse = usedClasses.has(e);
    console.log(`  ${e}: ${inUse ? '✓ in use' : '○ not used'}`);
  });

  console.log('\nACTIVE EFFECTS (need executeEffectOperations handlers):');
  ACTIVE_EFFECTS.forEach((e) => {
    const hasHandler = handledOpsSet.has(e);
    const inUse = usedClasses.has(e);
    console.log(
      `  ${e}: ${hasHandler ? '✓ has handler' : '✗ MISSING handler'} ${inUse ? '(in use)' : ''}`
    );
  });

  console.log('\n=== SUMMARY ===');
  console.log(`Total effect classes in use: ${usedClasses.size}`);
  console.log(`Operation types with handlers: ${handledOpsSet.size}`);
  console.log(`Operation types without handlers: ${unhandledOps.length}`);

  if (unhandledOps.length > 0) {
    console.log('\n=== UNHANDLED OPERATION TYPES ===');
    unhandledOps.forEach((op) => console.log(`  - ${op}`));
  }

  // Additional statistics
  console.log('\n=== CARD STATISTICS ===');
  const classUsageCounts = new Map<string, number>();
  taxonomy.cards.forEach((card) => {
    card.classes.forEach((cls) => {
      classUsageCounts.set(cls, (classUsageCounts.get(cls) ?? 0) + 1);
    });
  });

  const sortedClasses = [...classUsageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  console.log('Top 15 effect classes by usage:');
  sortedClasses.forEach(([cls, count]) => {
    console.log(`  ${cls}: ${count} cards`);
  });
}

// Run the analysis
analyzeEffectCoverage();
