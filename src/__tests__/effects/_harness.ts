/**
 * Shared harness for effect-engine contract tests.
 *
 * The Backend Engineer is implementing src/effects/* in parallel. These tests
 * must compile and express their intent regardless of whether those modules
 * exist yet. If the modules are missing at runtime, BACKEND_READY is false and
 * each test suite flips to describe.skip with a TODO note. Once the handoff
 * lands, the same suites light up without edits.
 *
 * All public types mirror spec sections 12 and 18 verbatim. If the Backend
 * export names drift from the spec, fix the spec first and then this file,
 * not the other way around.
 */

// ---------------------------------------------------------------------------
// Spec types (section 12 and 18). Kept local so this file typechecks alone.
// ---------------------------------------------------------------------------

export type PlayerId = string;
export type InstanceId = string;
export type BattlefieldId = string;
export type GameTick = number;
export type Domain = 'fury' | 'calm' | 'mind' | 'body' | 'chaos' | 'order';

export type Location =
  | { kind: 'battlefield'; battlefieldId: BattlefieldId }
  | { kind: 'base'; player: PlayerId };

export type Zone =
  | 'board'
  | 'chain'
  | 'hand'
  | 'main-deck'
  | 'rune-deck'
  | 'trash'
  | 'banishment'
  | 'champion-zone';

export interface Patch {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: unknown;
}

export interface LogEntry {
  tick: GameTick;
  kind: string;
  payload: unknown;
}

export type TriggerType =
  | 'on_play'
  | 'on_play_other_spell'
  | 'on_play_other_unit'
  | 'on_conquer'
  | 'on_hold'
  | 'on_move'
  | 'on_kill'
  | 'on_unit_dies_other'
  | 'on_damage_dealt'
  | 'on_damage_taken'
  | 'on_channel'
  | 'on_buff'
  | 'on_draw'
  | 'on_recycle'
  | 'at_start_of_combat'
  | 'at_end_of_combat'
  | 'equip_trigger'
  | 'on_move_other'
  | 'reflexive';

export interface EventSnapshot {
  kind: string;
  payload: Record<string, unknown>;
}

export interface TriggerFire {
  triggerType: TriggerType;
  sourceInstanceId: InstanceId;
  sourceController: PlayerId;
  eventSnapshot: EventSnapshot;
  referents?: Record<string, unknown>;
}

export interface OpResult {
  patches: Patch[];
  triggeredAbilities: TriggerFire[];
  log: LogEntry[];
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  // For move_unit that must convert to recall per 442.2.c
  substituteOp?: EffectOp;
  // For channel_rune clamped to runeDeck.length per 315.3.b.1
  effectiveCount?: number;
}

export interface GrantedKeyword {
  source: InstanceId;
  keyword: string;
  value?: number;
  duration: 'this_turn' | 'while_attached' | 'while_on_board' | 'while_in_zone' | GameTick;
}

export interface CardInstance {
  instanceId: InstanceId;
  cardId: string | null;
  templateId?: string;
  isToken?: boolean;
  owner: PlayerId;
  controller: PlayerId;
  zone: Zone;
  location?: Location;
  cardType?: 'Unit' | 'Gear' | 'Spell' | 'Rune' | 'Battlefield' | 'Legend';
  might?: number;
  printedMight?: number;
  state: {
    exhausted: boolean;
    damage: number;
    hasBuffCounter: boolean;
    facedown: boolean;
    stunned?: boolean;
  };
  attachments: {
    attachedTo?: InstanceId;
    topMostAttachments: InstanceId[];
  };
  grantedKeywords: GrantedKeyword[];
  temporaryMightMod: number;
  lastKnownLocation?: Location;
  lastKnownMight?: number;
  lastKnownController?: PlayerId;
  tags?: string[];
  keywords?: string[];
}

export interface BattlefieldState {
  battlefieldId: BattlefieldId;
  owner: PlayerId;
  controller: PlayerId | null;
  contested: boolean;
  presentUnits: InstanceId[];
  attachedGear: InstanceId[];
  facedown: Record<PlayerId, InstanceId[]>;
  scoredBy: Record<PlayerId, 'conquer' | 'hold' | null>;
}

export interface BaseState {
  player: PlayerId;
  presentUnits: InstanceId[];
  presentGear: InstanceId[];
}

export interface PlayerState {
  playerId: PlayerId;
  points: number;
  victoryPoints?: number;
  scoredThisTurnByBattlefield: Set<BattlefieldId>;
  runePool: {
    energy: number;
    power: Record<string, number>;
  };
}

export interface EngineCtx {
  players: PlayerState[];
  turnPlayerId: PlayerId;
  priorityHolder: PlayerId | null;
  focusHolder: PlayerId | null;
  zones: {
    board: {
      battlefields: Record<BattlefieldId, BattlefieldState>;
      bases: Record<PlayerId, BaseState>;
    };
    chain: unknown[];
    hands: Record<PlayerId, CardInstance[]>;
    mainDecks: Record<PlayerId, CardInstance[]>;
    runeDecks: Record<PlayerId, CardInstance[]>;
    trashes: Record<PlayerId, CardInstance[]>;
    banishments: Record<PlayerId, CardInstance[]>;
    championZones: Record<PlayerId, CardInstance | null>;
    runesOnBoard?: Record<PlayerId, CardInstance[]>;
  };
  turnState: {
    turnNumber: number;
    phase: 'awaken' | 'beginning' | 'channel' | 'draw' | 'main' | 'ending' | 'expiration';
    mode: 'neutral_open' | 'neutral_closed' | 'showdown_open' | 'showdown_closed';
    combat: unknown;
    showdown: unknown;
    onceThisTurnUsed: Record<string, number>;
    triggeredThisTurn: Record<string, number>;
    payCostsInProgress?: boolean;
    extraActionsGrantedTo?: Record<PlayerId, number>;
    skipPriorityPasses?: Record<PlayerId, number>;
  };
  replacementRegistry: {
    applyTo: (op: EffectOp, ctx: EngineCtx, source: CardInstance) => {
      appliedReplacementIds: string[];
      ops: EffectOp[];
    };
  };
  delayedAbilities: unknown[];
  temporaryMods: unknown[];
  scoringRestrictions?: unknown[];
  rng: { seed: string; cursor: number };
  tick: GameTick;
  log: LogEntry[];
  // warnings collected by dispatcher for unknown ops / stripped markers
  warnings?: Array<{ code: string; payload: unknown }>;
}

export type EffectOp = RiftboundOp | { type: string; [k: string]: unknown };

export type RiftboundOp =
  | {
      type: 'control_battlefield';
      battlefieldId: BattlefieldId;
      mode: 'gain' | 'contest' | 'lose';
      forPlayer: PlayerId;
    }
  | {
      type: 'manipulate_priority';
      variant:
        | 'action_tagged'
        | 'reaction_tagged'
        | 'add_reaction'
        | 'take_focus'
        | 'grant_priority'
        | 'extra_action'
        | 'skip_priority_pass';
      targetPlayer?: PlayerId;
      windowScope?: 'this_chain' | 'this_showdown' | 'this_turn';
    }
  | {
      type: 'modify_stats';
      target: InstanceId;
      mightMod?: number;
      duration?: 'this_turn' | 'permanent';
      addBuffCounter?: boolean;
    }
  | {
      type: 'on_play_trigger';
      source: InstanceId;
      predicate?: unknown;
    }
  | {
      type: 'attach_gear';
      gearInstance: InstanceId;
      target: InstanceId;
      reason: 'equip_activation' | 'weaponmaster' | 'quickdraw' | 'card_effect';
      detachFromPrior?: InstanceId;
    }
  | {
      type: 'draw_cards';
      player: PlayerId;
      count: number;
    }
  | {
      type: 'move_unit';
      unit: InstanceId;
      to: Location;
      reason: 'standard_move' | 'ganking' | 'card_effect' | 'combat_cleanup';
      batchId?: string;
    }
  | {
      type: 'ready';
      target: InstanceId;
    }
  | {
      type: 'create_token';
      player: PlayerId;
      templateId: string;
      count?: number;
      location?: Location;
      enteredExhausted?: boolean;
    }
  | {
      type: 'equip_trigger';
      source: InstanceId;
      predicate:
        | { kind: 'when_equipped_to_me' }
        | { kind: 'when_i_equip_something' }
        | { kind: 'when_any_equipment_attached'; scope: 'friendly' | 'any' };
    }
  | {
      type: 'remove_permanent';
      target: InstanceId;
      mode: 'kill' | 'banish' | 'return_to_hand';
    }
  | {
      type: 'recycle_card';
      target: InstanceId;
      destination: 'main-deck' | 'rune-deck';
    }
  | {
      type: 'conquer_trigger';
      source: InstanceId;
    }
  | {
      type: 'combat_bonus';
      target: InstanceId;
      mightMod: number;
      duration: 'this_combat' | 'this_turn';
    }
  | {
      type: 'gain_resource';
      player: PlayerId;
      kind: 'energy' | 'power';
      domain?: Domain | 'universal';
      amount: number;
      synchronous?: boolean;
    }
  | {
      type: 'keyword_hidden';
      source: InstanceId;
    }
  | {
      type: 'channel_rune';
      player: PlayerId;
      count: number;
      enteredExhausted?: boolean;
      predicate?: { domain?: Domain };
    }
  | {
      type: 'combat_trigger';
      source: InstanceId;
    }
  | {
      type: 'deal_damage';
      source: InstanceId;
      target: InstanceId;
      amount: number;
    }
  | {
      type: 'stun';
      target: InstanceId;
    }
  | {
      type: 'keyword_ganking';
      source: InstanceId;
    }
  | {
      type: 'keyword_accelerate';
      source: InstanceId;
    }
  | {
      type: 'keyword_deflect';
      source: InstanceId;
      value?: number;
    }
  | {
      type: 'death_trigger';
      source: InstanceId;
    }
  | {
      // Classification-only marker. Dispatcher should strip it at catalog build.
      type: 'rune_resource';
      runeCardId: string;
    }
  // ---------------------------------------------------------------------------
  // Phase 3 long-tail ops. Shapes below are the contract the QA tests expect.
  // Where spec sections 12-18 define a shape directly, we mirror that verbatim.
  // Where the spec only names the op in the frequency CSV (sections 13-17 list
  // coverage volumes), we propose a minimal dispatchable shape derived from
  // the rules anchors noted in each test file. Backend Engineer may widen
  // these at handler time; these are lower bounds for dispatch.
  // ---------------------------------------------------------------------------
  | {
      // Section 13.2: scoring (20). Awards points outside the normal
      // conquer/hold flow or piggybacks on one.
      type: 'scoring';
      player: PlayerId;
      battlefieldId: BattlefieldId | null;
      reason: 'conquer' | 'hold' | 'effect';
      amount: number;
    }
  | {
      // Section 13.2: scoring_restriction (2). Registration op for a passive
      // predicate that blocks scoring. Installed on ETB, removed on leave.
      type: 'scoring_restriction';
      source: InstanceId;
      predicateKind:
        | 'per_battlefield_turn_gate'
        | 'per_player_while_present'
        | 'custom';
      predicatePayload: unknown;
    }
  | {
      // Section 15.2: follow_movement (2). Registration op installing an
      // on_move_other observer. Shape per spec 18.
      type: 'follow_movement';
      source: InstanceId;
      trigger: {
        originMatch: 'self_location';
        controllerMatch: 'friendly';
      };
      action: 'may_follow';
    }
  // Zones: summon_unit / return_to_hand / return_from_graveyard / discard_cards
  | {
      // summon_unit (25). Instantiates a unit from a template into a zone
      // (usually board) for a player. Rules anchor: rules 176-184 (tokens are
      // a subset), rules 5 (Zone Changes), 146 (Units).
      // Shape note: we reuse templateId + location shapes from create_token;
      // the distinction from create_token is that summon_unit operates on
      // non-token unit cards (e.g., a unit from deck into play without normal
      // cost flow).
      type: 'summon_unit';
      player: PlayerId;
      templateId: string;
      location?: Location;
      enteredExhausted?: boolean;
      fromZone?: Zone;
    }
  | {
      // return_to_hand (24). Analog of remove_permanent mode='return_to_hand'
      // but expressed as its own op for data-shape parity. Spec 7
      // (Banish/Return/Recall). Target may be in any zone (spec section 7
      // text line 454).
      type: 'return_to_hand';
      target: InstanceId;
      fromZone?: Zone;
    }
  | {
      // return_from_graveyard (8). Spec section 5 anchor (Trash -> Hand card
      // specific per table at spec line 332, plus Trash -> Board variants).
      type: 'return_from_graveyard';
      target: InstanceId;
      destination: 'hand' | 'board';
      to?: Location;
    }
  | {
      // discard_cards (21). Rule 408 (Discard action). A player sends cards
      // from hand to trash.
      type: 'discard_cards';
      player: PlayerId;
      count: number;
      chooser?: PlayerId;
    }
  // Combat: shield / heal / solo_combat
  | {
      // shield (24). Registers a damage-prevention amount per rule 417.5.
      // Shape mirrors keyword_deflect: a source + value that stacks.
      type: 'shield';
      source: InstanceId;
      value: number;
    }
  | {
      // heal (5). Removes damage from a target (rule 141.2 / 419).
      type: 'heal';
      target: InstanceId;
      amount: number;
    }
  | {
      // solo_combat (4). Marks a unit as eligible to fight alone (rule 458
      // interaction). Registration-shaped; installs a combat modifier.
      type: 'solo_combat';
      source: InstanceId;
    }
  // Costs: cost_reduction / cost_increase / targeting_discount
  | {
      // cost_reduction (24). Section 10 (Cost Modifiers). Registration-shaped
      // predicate that reduces one or more cards' printed costs.
      type: 'cost_reduction';
      source: InstanceId;
      amount: number;
      kind?: 'energy' | 'power' | 'any';
      selector?: unknown;
    }
  | {
      // cost_increase (10). Section 10 (Cost Modifiers). Inverse of
      // cost_reduction; sign-flipped but same shape.
      type: 'cost_increase';
      source: InstanceId;
      amount: number;
      kind?: 'energy' | 'power' | 'any';
      selector?: unknown;
    }
  | {
      // targeting_discount (2). Registration of a conditional cost reduction
      // that applies only when the played card targets a specific predicate.
      type: 'targeting_discount';
      source: InstanceId;
      amount: number;
      targetPredicate: unknown;
    }
  // Stats auras / buffs
  | {
      // aura_buff (10). Registration of a passive stat aura.
      type: 'aura_buff';
      source: InstanceId;
      mightMod: number;
      selector: unknown;
    }
  | {
      // conditional_buff (2). Registration of a stat buff that only applies
      // while a predicate is true.
      type: 'conditional_buff';
      source: InstanceId;
      mightMod: number;
      predicate: unknown;
    }
  | {
      // stat_scaling (3). Stat buff whose magnitude depends on a count-
      // expression at read time (e.g., "+1 per gear you control").
      type: 'stat_scaling';
      source: InstanceId;
      formula: 'per_friendly_unit' | 'per_gear' | 'per_card_in_hand' | 'custom';
      selector?: unknown;
    }
  | {
      // effect_amplifier (5). Amplifies other cards' effects (e.g., "damage
      // you deal is doubled"). Registration-shaped.
      type: 'effect_amplifier';
      source: InstanceId;
      amplifies: 'damage_dealt' | 'healing' | 'draw' | 'custom';
      magnitude: number;
    }
  // Keywords
  | {
      // keyword_weaponmaster (17). Rule 821.
      type: 'keyword_weaponmaster';
      source: InstanceId;
    }
  | {
      // keyword_tank (17). Rule 823 (Tank).
      type: 'keyword_tank';
      source: InstanceId;
    }
  | {
      // keyword_repeat (16). Rule 820 (Repeat).
      type: 'keyword_repeat';
      source: InstanceId;
    }
  | {
      // keyword_legion (16). Rule 817 (Legion).
      type: 'keyword_legion';
      source: InstanceId;
    }
  | {
      // tribal_synergy (17). Registration of a tribal bonus keyed on tags.
      type: 'tribal_synergy';
      source: InstanceId;
      tribe: string;
      effect: 'might' | 'keyword_grant' | 'trigger' | 'custom';
      magnitude?: number;
    }
  // Triggers
  | {
      // hold_trigger (24). Registration op, spec 13.4 on_hold trigger.
      type: 'hold_trigger';
      source: InstanceId;
    }
  | {
      // phase_trigger (19). Registration op for at_start_of_*_phase triggers.
      type: 'phase_trigger';
      source: InstanceId;
      phase: 'awaken' | 'beginning' | 'channel' | 'draw' | 'main' | 'ending' | 'expiration';
      when: 'start' | 'end';
    }
  | {
      // interact_legend (11). Registration of a Legend-zone-interaction
      // predicate. Rules anchor: rule 173-175 (Legends).
      type: 'interact_legend';
      source: InstanceId;
      predicateKind: 'on_legend_enters_play' | 'on_legend_leaves_play' | 'while_legend_present';
    }
  // Battlefield ambient
  | {
      // location_aura (7). Registration of a battlefield-local aura emanating
      // from a battlefield card.
      type: 'location_aura';
      source: InstanceId;
      battlefieldId: BattlefieldId;
      effect: 'might_bonus' | 'keyword_grant' | 'cost_modifier' | 'custom';
      magnitude?: number;
    }
  | {
      // play_restriction (2). Registration of a predicate that gates
      // playability. Rules anchor: rule 355 (cast/play restrictions).
      type: 'play_restriction';
      source: InstanceId;
      predicateKind: 'by_player' | 'by_card_type' | 'custom';
      predicatePayload: unknown;
    }
  // Misc
  | {
      // generic (4). Escape hatch for cards whose effects do not reduce to
      // one of the above ops. The handler is expected to no-op with a warn.
      type: 'generic';
      source: InstanceId;
      note?: string;
    }
  | {
      // ability_copy (3). Copies another card's ability onto this one. Rule
      // 386 (Copy Ability).
      type: 'ability_copy';
      source: InstanceId;
      targetAbilitySource: InstanceId;
    }
  // Gear
  | {
      // hide_modifier (1). Registration of a keyword-modifier hide that
      // conceals a granted modifier until revealed. Rule 472 (Layers) adj.
      type: 'hide_modifier';
      source: InstanceId;
    };

export interface OpHandler<TOp extends EffectOp = EffectOp> {
  op: string;
  validate?(ctx: EngineCtx, op: TOp, source: CardInstance): ValidationResult;
  execute(ctx: EngineCtx, op: TOp, source: CardInstance): OpResult;
}

// ---------------------------------------------------------------------------
// Dynamic import of the Backend Engineer's outputs.
// ---------------------------------------------------------------------------

export interface EffectsModule {
  buildDefaultRegistry: () => {
    get: (opType: string) => OpHandler | undefined;
    register: (h: OpHandler) => void;
  };
  runOp: (ctx: EngineCtx, op: EffectOp, source: CardInstance) => OpResult;
  // triggers.ts - the TriggerRegistry from spec section 1.2
  TriggerRegistry?: new () => {
    register: (t: {
      triggerType: TriggerType;
      sourceInstanceId: InstanceId;
      sourceController: PlayerId;
      predicate?: (ev: EventSnapshot) => boolean;
    }) => void;
    fire: (ev: EventSnapshot, ctx: EngineCtx) => TriggerFire[];
    list: () => Array<{ triggerType: TriggerType; sourceInstanceId: InstanceId }>;
  };
  loadCatalog?: (cards: unknown[]) => {
    cards: Array<{ id: string; operations: Array<{ type: string }> }>;
    stats: { stripped: Record<string, number> };
  };
}

function tryRequire(path: string): unknown | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(path);
  } catch {
    return null;
  }
}

export function loadBackend(): EffectsModule | null {
  const index = tryRequire('../../effects/index');
  if (index && typeof (index as EffectsModule).buildDefaultRegistry === 'function') {
    return index as EffectsModule;
  }
  // Try individual pieces if index isn't exported yet.
  const dispatcher = tryRequire('../../effects/dispatcher');
  const registry = tryRequire('../../effects/registry');
  const triggers = tryRequire('../../effects/triggers');
  if (
    dispatcher &&
    registry &&
    typeof (registry as { buildDefaultRegistry?: unknown }).buildDefaultRegistry === 'function'
  ) {
    return {
      buildDefaultRegistry: (registry as { buildDefaultRegistry: EffectsModule['buildDefaultRegistry'] })
        .buildDefaultRegistry,
      runOp: (dispatcher as { runOp: EffectsModule['runOp'] }).runOp,
      TriggerRegistry: (triggers as { TriggerRegistry?: EffectsModule['TriggerRegistry'] } | null)
        ?.TriggerRegistry,
    };
  }
  return null;
}

export const BACKEND: EffectsModule | null = loadBackend();
export const BACKEND_READY: boolean = BACKEND !== null;

export const describeIfBackend: typeof describe = BACKEND_READY ? describe : describe.skip;

// ---------------------------------------------------------------------------
// ETL migration gating. Phase 3 ETL migration (Data Analyst) moves
// manipulate_priority marker variants out of operations[] into a new
// card.timingTags[] field and strips rune_resource ops entirely. Until the
// migration lands, describeIfEtl skips so tests light up automatically.
//
// We probe lazily: load the enriched catalog once, check the first card that
// has a defined timingTags array. If any card has the field, the migration
// is considered "landed" and ETL gated tests run.
// ---------------------------------------------------------------------------

export interface EnrichedCard {
  id: string;
  name?: string;
  type?: string;
  timingTags?: string[];
  effectProfile?: {
    operations?: Array<{ type: string; [k: string]: unknown }>;
  };
  abilities?: Array<{
    operations?: Array<{ type: string; [k: string]: unknown }>;
  }>;
}

let _enrichedCache: EnrichedCard[] | null = null;
let _enrichedCacheAttempted = false;

export function loadEnrichedCatalog(): EnrichedCard[] | null {
  if (_enrichedCacheAttempted) return _enrichedCache;
  _enrichedCacheAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const target = path.resolve(__dirname, '../../../data/cards.enriched.json');
    if (!fs.existsSync(target)) return null;
    const raw = fs.readFileSync(target, 'utf8');
    const parsed = JSON.parse(raw) as EnrichedCard[] | { cards: EnrichedCard[] };
    _enrichedCache = Array.isArray(parsed) ? parsed : parsed.cards ?? null;
  } catch {
    _enrichedCache = null;
  }
  return _enrichedCache;
}

export function etlMigrationLanded(): boolean {
  const cards = loadEnrichedCatalog();
  if (!cards) return false;
  return cards.some(
    (c) => Array.isArray(c.timingTags) && c.timingTags.length > 0,
  );
}

export const ETL_READY: boolean = etlMigrationLanded();
export const describeIfEtl: typeof describe = ETL_READY ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Ctx factory. Deterministic, no RNG noise.
// ---------------------------------------------------------------------------

let instanceCounter = 0;
export function resetInstanceCounter(): void {
  instanceCounter = 0;
}

export function makeInstanceId(prefix = 'i'): InstanceId {
  instanceCounter += 1;
  return `${prefix}-${instanceCounter}`;
}

export function makeUnit(overrides: Partial<CardInstance> = {}): CardInstance {
  return {
    instanceId: overrides.instanceId ?? makeInstanceId('unit'),
    cardId: overrides.cardId ?? 'test-unit',
    owner: overrides.owner ?? 'p1',
    controller: overrides.controller ?? overrides.owner ?? 'p1',
    zone: overrides.zone ?? 'board',
    location: overrides.location,
    cardType: overrides.cardType ?? 'Unit',
    might: overrides.might ?? 3,
    printedMight: overrides.printedMight ?? overrides.might ?? 3,
    state: {
      exhausted: false,
      damage: 0,
      hasBuffCounter: false,
      facedown: false,
      stunned: false,
      ...(overrides.state ?? {}),
    },
    attachments: {
      topMostAttachments: [],
      ...(overrides.attachments ?? {}),
    },
    grantedKeywords: overrides.grantedKeywords ?? [],
    temporaryMightMod: overrides.temporaryMightMod ?? 0,
    tags: overrides.tags ?? [],
    keywords: overrides.keywords ?? [],
  };
}

export function makeGear(overrides: Partial<CardInstance> = {}): CardInstance {
  return makeUnit({
    cardId: 'test-gear',
    cardType: 'Gear',
    might: undefined,
    printedMight: undefined,
    ...overrides,
  });
}

export function makeBattlefield(overrides: Partial<BattlefieldState> = {}): BattlefieldState {
  return {
    battlefieldId: overrides.battlefieldId ?? 'bf-1',
    owner: overrides.owner ?? 'p1',
    controller: overrides.controller ?? null,
    contested: overrides.contested ?? false,
    presentUnits: overrides.presentUnits ?? [],
    attachedGear: overrides.attachedGear ?? [],
    facedown: overrides.facedown ?? { p1: [], p2: [] },
    scoredBy: overrides.scoredBy ?? { p1: null, p2: null },
  };
}

export function makeCtx(overrides: Partial<EngineCtx> = {}): EngineCtx {
  const bf1 = makeBattlefield({ battlefieldId: 'bf-1' });
  const bf2 = makeBattlefield({ battlefieldId: 'bf-2', owner: 'p2' });
  return {
    players: overrides.players ?? [
      {
        playerId: 'p1',
        points: 0,
        victoryPoints: 0,
        scoredThisTurnByBattlefield: new Set(),
        runePool: { energy: 0, power: { fury: 0, calm: 0, mind: 0, body: 0, chaos: 0, order: 0, universal: 0 } },
      },
      {
        playerId: 'p2',
        points: 0,
        victoryPoints: 0,
        scoredThisTurnByBattlefield: new Set(),
        runePool: { energy: 0, power: { fury: 0, calm: 0, mind: 0, body: 0, chaos: 0, order: 0, universal: 0 } },
      },
    ],
    turnPlayerId: overrides.turnPlayerId ?? 'p1',
    priorityHolder: overrides.priorityHolder ?? 'p1',
    focusHolder: overrides.focusHolder ?? null,
    zones: overrides.zones ?? {
      board: {
        battlefields: { 'bf-1': bf1, 'bf-2': bf2 },
        bases: {
          p1: { player: 'p1', presentUnits: [], presentGear: [] },
          p2: { player: 'p2', presentUnits: [], presentGear: [] },
        },
      },
      chain: [],
      hands: { p1: [], p2: [] },
      mainDecks: { p1: [], p2: [] },
      runeDecks: { p1: [], p2: [] },
      trashes: { p1: [], p2: [] },
      banishments: { p1: [], p2: [] },
      championZones: { p1: null, p2: null },
      runesOnBoard: { p1: [], p2: [] },
    },
    turnState: overrides.turnState ?? {
      turnNumber: 1,
      phase: 'main',
      mode: 'neutral_open',
      combat: null,
      showdown: null,
      onceThisTurnUsed: {},
      triggeredThisTurn: {},
      payCostsInProgress: false,
      extraActionsGrantedTo: {},
      skipPriorityPasses: {},
    },
    replacementRegistry: overrides.replacementRegistry ?? {
      applyTo: () => ({ appliedReplacementIds: [], ops: [] }),
    },
    delayedAbilities: [],
    temporaryMods: [],
    scoringRestrictions: [],
    rng: { seed: 'test-seed-1', cursor: 0 },
    tick: 0,
    log: [],
    warnings: [],
  };
}

/**
 * Apply a JSON-pointer patch to a clone of ctx. Mirrors the Backend's intent
 * that patches are applied by the outer engine transaction. We reimplement a
 * minimal JSON pointer resolver locally so tests don't depend on Backend
 * shipping this utility.
 */
export function applyPatches(ctx: EngineCtx, patches: Patch[]): EngineCtx {
  // structuredClone can't clone functions, and replacementRegistry.applyTo is a
  // function. Patches never write into replacementRegistry, so we pull it out,
  // clone the rest, and re-attach the original reference afterwards.
  const { replacementRegistry, ...rest } = ctx;
  const cloned = structuredClone(rest) as Omit<EngineCtx, 'replacementRegistry'>;
  const next = { ...cloned, replacementRegistry } as EngineCtx;
  for (const p of patches) {
    applyPatch(next, p);
  }
  return next;
}

function applyPatch(root: unknown, patch: Patch): void {
  const segments = patch.path.split('/').filter(Boolean).map(decodeSegment);
  let cursor: Record<string, unknown> = root as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i] as string;
    const child = cursor[seg];
    if (child === undefined || child === null) {
      // Auto-create missing segment as an object so tests still run against
      // handler implementations that write into unpopulated subtrees. Array
      // auto-creation is not needed for the assertions we make.
      cursor[seg] = {};
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1] as string;
  if (patch.op === 'remove') {
    if (Array.isArray(cursor)) {
      (cursor as unknown[]).splice(Number(last), 1);
    } else {
      delete cursor[last];
    }
  } else {
    if (Array.isArray(cursor) && last === '-') {
      (cursor as unknown[]).push(patch.value);
    } else if (Array.isArray(cursor)) {
      (cursor as unknown[])[Number(last)] = patch.value;
    } else {
      cursor[last] = patch.value;
    }
  }
}

function decodeSegment(s: string): string {
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}
