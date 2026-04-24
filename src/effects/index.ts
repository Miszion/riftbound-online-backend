import logger from '../logger';
import type { EffectOperation } from '../card-catalog';
import { OpHandlerRegistry } from './registry';
import type { EffectOp, OpHandler } from './types';

import { drawCardsHandler } from './handlers/draw';
import {
  modifyStatsHandler,
  combatBonusHandler,
  auraBuffHandler,
  statScalingHandler,
  conditionalBuffHandler,
  effectAmplifierHandler
} from './handlers/stats';
import {
  dealDamageHandler,
  stunHandler,
  shieldHandler,
  healHandler,
  soloCombatHandler
} from './handlers/combat';
import {
  removePermanentHandler,
  recycleCardHandler,
  returnToHandHandler,
  returnFromGraveyardHandler,
  discardCardsHandler,
  summonUnitHandler,
  millCardsHandler,
  adjustMulliganHandler
} from './handlers/zones';
import { createTokenHandler } from './handlers/tokens';
import { attachGearHandler, hideModifierHandler } from './handlers/gear';
import { moveUnitHandler, followMovementHandler } from './handlers/movement';
import {
  controlBattlefieldHandler,
  scoringHandler,
  scoringRestrictionHandler,
  locationAuraHandler,
  playRestrictionHandler
} from './handlers/battlefield';
import {
  channelRuneHandler,
  gainResourceHandler,
  runeResourceHandler
} from './handlers/runes';
import { readyHandler } from './handlers/ready';
import { manipulatePriorityHandler } from './handlers/priority';
import {
  keywordHiddenHandler,
  keywordGankingHandler,
  keywordAccelerateHandler,
  keywordDeflectHandler,
  keywordWeaponmasterHandler,
  keywordTankHandler,
  keywordRepeatHandler,
  keywordLegionHandler,
  tribalSynergyHandler
} from './handlers/keywords';
import {
  onPlayTriggerHandler,
  equipTriggerHandler,
  conquerTriggerHandler,
  combatTriggerHandler,
  deathTriggerHandler,
  holdTriggerHandler,
  phaseTriggerHandler,
  interactLegendHandler
} from './handlers/triggers';
import {
  costReductionHandler,
  costIncreaseHandler,
  targetingDiscountHandler
} from './handlers/costs';
import { genericHandler, abilityCopyHandler } from './handlers/misc';
import { transformHandler } from './handlers/transform';

export { OpHandlerRegistry } from './registry';
export { TriggerRegistry } from './triggers';
export { runOp, runOpSequence } from './dispatcher';
export {
  createStatsRecorder,
  recordOp,
  formatStatsSummary,
  topHandledOps,
  type DispatcherStats,
  type OpOutcome
} from './instrumentation';
export * from './types';

/**
 * Builds the registry with the 56-op set (Phase 2 top-24 + Phase 3
 * long-tail 30 + Phase 7 rune_resource defense-in-depth + Phase 8a
 * `transform`). Call once at engine boot. Ops outside this list fail
 * soft via the dispatcher (warn + empty OpResult).
 */
export function buildDefaultRegistry(): OpHandlerRegistry {
  const registry = new OpHandlerRegistry();
  const handlers: OpHandler<EffectOp>[] = [
    // Phase 2 (24 core handlers + rune_resource classification fall-through)
    drawCardsHandler,
    recycleCardHandler,
    runeResourceHandler,
    modifyStatsHandler,
    combatBonusHandler,
    dealDamageHandler,
    stunHandler,
    removePermanentHandler,
    createTokenHandler,
    attachGearHandler,
    moveUnitHandler,
    controlBattlefieldHandler,
    channelRuneHandler,
    gainResourceHandler,
    readyHandler,
    manipulatePriorityHandler,
    keywordHiddenHandler,
    keywordGankingHandler,
    keywordAccelerateHandler,
    keywordDeflectHandler,
    onPlayTriggerHandler,
    equipTriggerHandler,
    conquerTriggerHandler,
    combatTriggerHandler,
    deathTriggerHandler,
    // Phase 3 long-tail (30 handlers)
    summonUnitHandler,
    holdTriggerHandler,
    returnToHandHandler,
    costReductionHandler,
    shieldHandler,
    discardCardsHandler,
    scoringHandler,
    phaseTriggerHandler,
    keywordWeaponmasterHandler,
    keywordTankHandler,
    tribalSynergyHandler,
    keywordRepeatHandler,
    keywordLegionHandler,
    interactLegendHandler,
    auraBuffHandler,
    costIncreaseHandler,
    returnFromGraveyardHandler,
    locationAuraHandler,
    effectAmplifierHandler,
    healHandler,
    genericHandler,
    soloCombatHandler,
    statScalingHandler,
    abilityCopyHandler,
    scoringRestrictionHandler,
    targetingDiscountHandler,
    playRestrictionHandler,
    followMovementHandler,
    conditionalBuffHandler,
    hideModifierHandler,
    millCardsHandler,
    adjustMulliganHandler,
    // Phase 8a: covers UNL-081 "Keeper of Masks" "become copies of me"
    // (docs/effect-ops-frequency-phase7.csv line 56, count=1).
    transformHandler
  ] as unknown as OpHandler<EffectOp>[];
  registry.registerAll(handlers);
  return registry;
}

/**
 * Strip `rune_resource` entries from a card's operations list during
 * catalog load. Per the Phase 2b spec section 16.5 and the Tech Lead note,
 * `rune_resource` is a classification label that leaked into the op list,
 * not an op. We drop it on load to keep the dispatcher clean and log the
 * count so regressions in the enricher are easy to spot.
 */
export function stripRuneResourceOps(
  operations: EffectOperation[],
  counters: { stripped: number }
): EffectOperation[] {
  const before = operations.length;
  const filtered = operations.filter((op) => op.type !== 'rune_resource');
  counters.stripped += before - filtered.length;
  return filtered;
}

/**
 * Iterate an enriched catalog and mutate each card's effectProfile to drop
 * rune_resource ops. Returns the total stripped count. Emits one info
 * log at end of iteration so the boot line reads cleanly.
 *
 * Phase 3 update: the Phase 3 ETL migration
 * (scripts/migrate-card-catalog.ts) moves this strip upstream, so at steady
 * state this function will find zero leaks. When that is the case we log
 * `OP_REGISTRY_FILTER_NOOP` to confirm the ETL is doing its job. If the
 * count is non-zero the ETL has regressed and we still remove the leaks as
 * defense-in-depth.
 *
 * Phase 5a update: the enricher (scripts/data/transformChampionDump.ts and
 * src/card-catalog.ts) no longer emits `rune_resource` ops at all; the
 * `rune_type` text classifier was removed and `card.isRuneResource` is now
 * derived from `card.type === 'Rune'`. A build-time assertion in the
 * enricher throws if any `rune_resource` op appears in operations[].
 * This filter remains in place as belt-and-suspenders defense-in-depth for
 * stale S3 catalogs, rollback scenarios, and partial fixture records
 * (see docs/phase-4-enricher-fix-spec.md section 3.2).
 */
export function filterCatalogRuneResourceOps(
  cards: Array<{
    id: string;
    effectProfile?: { operations: EffectOperation[] };
  }>
): number {
  const counters = { stripped: 0 };
  for (const card of cards) {
    const profile = card.effectProfile;
    if (!profile) continue;
    profile.operations = stripRuneResourceOps(profile.operations, counters);
  }
  if (counters.stripped > 0) {
    logger.info('[effects] stripped rune_resource entries from catalog', {
      count: counters.stripped
    });
  } else {
    logger.info('OP_REGISTRY_FILTER_NOOP', {
      filter: 'rune_resource',
      cards: cards.length
    });
  }
  return counters.stripped;
}
