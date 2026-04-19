# Riftbound Effect Engine Specification (Phase 1)

Status: spec-only. No code changes in this phase. Phase 2 will introduce the dispatcher and per-op handlers based on this document.

Audience: an engineer implementing the dispatcher and op handlers next week. Assume familiarity with TCG engine concepts but not with Riftbound specifics.

Rules source: `docs/riftbound-core-rules.pdf` (text mirror: `docs/riftbound-core-rules.txt`). Rule numbers cited inline use the `rule ###.##` format from that document.

Terminology note: Riftbound uses its own vocabulary. This spec uses the rules' terms, not Magic/Hearthstone analogs.

| Rules term | Informal analog | Notes |
|---|---|---|
| Chain | Stack | The non-board zone where playing/activating items queue. Rule 327. |
| Pending / Finalized Chain Item | Being cast / on the stack | Items are Pending during steps 1-5 of Playing, Finalized after step 6. Rule 329. |
| Trash | Graveyard / Discard | Unordered, public. Rule 108.2. |
| Banishment | Exile | Unordered, public. Rule 108.6. |
| Rune Pool | Mana pool | Empties at end of draw phase and end of turn. Rule 164-166. |
| Channel | "Tap a land for turn" analog | Puts top N runes of Rune Deck onto the Board. Rule 430. |
| Kill | Destroy | Permanent goes from Board to Trash. Rule 428. |
| Recall | Bounce to your own base (not hand) | Not a Move, not a Kill. Rule 449. |
| Recycle | Shuffle/mill-to-bottom | Puts card on the bottom of its corresponding deck. Rule 416. |
| Burn Out | Deck-out | Recycle your trash into Main Deck, give an opponent 1 point, continue. Rule 431. |
| Exhaust / Ready | Tap / Untap | Rule 414 / 415. |
| Might (`[M]`) | Power/Attack stat | Damage >= Might kills the unit. Rule 143.2. |
| Buff (counter) | +1/+1 with a binary cap | A unit has either 0 or 1 Buff counter; it does not stack. Rule 426. |
| XP | Champion level fuel | Per-player counter used by `[Level N]` keyword gating. Rule 728. |
| Showdown | Priority window at a contested battlefield | Open or Closed, with Focus rotating. Rule 341. |
| Focus | "Priority owner during a Showdown" | Player with Focus and Priority may act. Rule 313. |
| FEPR / HOT FEPR | Stack resolution loop | Handle Outstanding Tasks; then Finalize, Execute, Pass, Resolve. Rule 335. |

---

## 1. Triggered Abilities

Rules 382-392. Triggered abilities are of the form `When <condition>, <effect>` or `At <timing>, <effect>` or `The Nth time <condition>, <effect>`. When the condition is met, the ability is added to the Chain as a Pending Item (rule 383.3), then proceeds through the normal Playing-a-Card finalization steps.

### 1.1 Taxonomy

The rules define named trigger categories; we implement each as a distinct `TriggerType` for dispatch speed and clarity.

| TriggerType | Rules anchor | Fires when | Source zone checked at |
|---|---|---|---|
| `on_play` (Play Effect) | 383.4.a | The permanent (self) is Finalized on the Chain and enters the Board | Board (self) |
| `on_play_other_spell` | 419.4 | A spell (other) completes resolution and is placed in Trash | Anywhere source is active; most commonly Board |
| `on_play_other_unit` | 419.4 | Any unit (other) is played (resolution completes) | Board |
| `on_play_self_was_played` | 419.4 | Self has been played (used for "after I'm played" checks) | Board |
| `on_choose` (Targeting Effect) | 383.4.b | Self (or a referenced object) is Targeted during step 2 of Playing | Board |
| `on_attack` (Attack Trigger) | 383.4.e | Self gains the Attacker designation for the first time in a combat | Board |
| `on_defend` (Defend Trigger) | 383.4.f | Self gains the Defender designation for the first time in a combat | Board |
| `on_conquer` (Conquer Effect) | 383.4.c | A conquer happens involving self, or player controlling source performs a conquer | Board |
| `on_hold` (Hold Effect) | 383.4.d | A hold-and-score happens during Beginning Phase scoring step | Board |
| `on_move` | 420, 440 | A unit moves (from or to a specified origin/destination) | Board (either trigger on self move or on friendly/any move) |
| `on_kill` (Deathknell) | 808 | Self is Killed and sent to Trash (replacement-saved kills do NOT trigger) | Board, snapshotted at death |
| `on_unit_dies_other` | 428 + 383 | A different unit dies | Board (source must remain in valid zone per 383.2.c.2) |
| `on_damage_dealt` | 417 + 383 | A Deal-damage action actually deals `>= 1` damage to a valid target | Board |
| `on_damage_taken` | 417 + 383 | Self takes Deal damage (not assigned combat damage in some cases; see 417.3.a) | Board |
| `on_channel` | 430 | A rune is channeled (entered Board from Rune Deck) | Board |
| `on_buff` | 426 | A unit becomes Buffed (buff counter placed; no-op if it already had one) | Board |
| `on_draw` | 413 | A card is drawn by the controller of the source (or any player if specified) | Board |
| `on_recycle` | 416 | A card is recycled to a deck | Board |
| `on_banish` | 427 | A card is banished | Board |
| `at_start_of_turn` | 315 | Start of Turn phases begin (subdivided: awaken, beginning, channel, draw) | Board |
| `at_start_of_beginning_phase` | 315.2, 816 | Beginning Phase begins (before scoring). `Temporary` kill trigger fires here. | Board |
| `at_start_of_your_turn` | 315 | Only when controller == turn player | Board |
| `at_end_of_turn` | 317.1 | Ending Step. `this turn` buffs expire AFTER (in Expiration Step, 317.2). | Board |
| `at_start_of_combat` | 454 | A Combat is initiated at a battlefield | Board |
| `at_end_of_combat` | 461 | Combat Cleanup begins | Board |
| `reflexive` (Do this / Do one of the following) | 386-388 | The ability's instructions add a new chain item | Chain |
| `delayed` | 389-392 | A triggered ability created by another effect fires at its specified time | Conceptual zone (not bound to a permanent) |

Keyword-sourced triggers map onto the above:
- `Deathknell` -> `on_kill` (rule 808)
- `Vision` -> `on_play` self (rule 817)
- `Temporary` -> `at_start_of_beginning_phase` self (rule 816) with an implicit kill-self effect
- `Weaponmaster` -> `on_play` self (rule 821), creating a Reflexive Equip opportunity
- `Hunt` -> union of `on_conquer` + `on_hold` on self (rule 823)

### 1.2 Trigger `ctx` info

Every trigger fire must capture a `TriggerCtx` sufficient to resolve it later even if the source has changed state. Key fields:

```ts
interface TriggerCtx {
  triggerType: TriggerType;            // see taxonomy above
  sourceInstanceId: string;            // the ability's source (card, ability, battlefield, legend)
  sourceController: PlayerId;          // per rule 188.4 (controller of ability != controller of source object after gain-control effects)
  eventSnapshot: EventSnapshot;        // the inciting event (see below)
  referents: Record<string, Ref>;      // "here", "me", "it" resolved per rule 359.3.f
  delayedUntil?: GameTick;             // for delayed abilities; see rule 389
  onceThisTurnKey?: string;            // for "once each turn" (371, 383.3.f)
  linkedGroupId?: string;              // for linked abilities per rule 393
}

interface EventSnapshot {
  kind: string;                        // mirrors TriggerType
  // Trigger-specific payload. Examples:
  // on_damage_dealt -> { sourceOfDamage, target, amount, isBonusDamage }
  // on_move        -> { unitId, originLocation, destinationLocation }
  // on_kill        -> { killedInstanceId, lastLocation, lastMight, lastController, attributedTo[] }
  // on_play        -> { playedInstanceId, controller, fromZone, toZone }
  // on_conquer     -> { battlefieldId, conqueringPlayer, unitsPresent[] }
  // on_channel     -> { runeInstanceId, controller, enteredExhausted }
  payload: Record<string, unknown>;
}
```

Snapshotting rules:
- Per 359.3.f.3 and 808.1.d.3, capture the source's attributes at trigger-condition time (e.g., `killedUnit.lastMight`, `killedUnit.lastLocation`). Re-reading state when the trigger resolves is wrong for Deathknell and similar.
- Per 359.3.f.4, "enemy" / "friendly" status is re-evaluated at execution, because a gain-control effect in-between can flip it.
- Per 355.10.c, trigger conditions themselves do not create targets; target choice happens in the Pending->Finalized "Make relevant choices" step of the trigger, not when the condition was met.

### 1.3 Ordering (APNAP - Active Player, Non-Active Player)

Rule 383.3.d: when multiple triggered abilities trigger simultaneously:
1. Group triggers by controller (`sourceController`, not source-object controller).
2. Starting with the Turn Player, then proceeding in Turn Order, each player orders their own batch of triggers onto the Chain in the order they choose.
3. All triggers for a given player must be queued before the next player's turn to order.

Within a single player's batch, ordering is player choice (no automatic tiebreak). In 2-player matches this is simply `Turn Player first, then opponent`; in multiplayer modes iterate `turnOrder` from the turn player.

Engine contract: when `runOp` emits `OpResult.triggeredAbilities`, the dispatcher collects them, then partitions by controller, then invokes a player-ordering prompt for each controller in turn order before pushing them onto the Chain as Pending Items. All triggers must be pushed before `HOT FEPR` resumes.

Edge cases:
- "The Nth time ... each turn" with multiple simultaneous matches: controller picks one match to serve as the trigger (rule 383.1.b). Others are discarded - the ability still only triggers once.
- A trigger with a conditional tail (`At end of your turn, if I'm at a battlefield, ...`): evaluate the condition at the moment it would go onto the Chain (rule 383.3.e). If false, skip; it does not reschedule.
- Zone-check at trigger time: per 383.2.c.1/2, the source must be in its "active from" zone both when the condition fires AND immediately after the inciting event. If the source itself died in the same cleanup as its condition, the trigger does not go on the Chain (exception: `Deathknell`, by rule 808.1.d).

---

## 2. Replacement Effects

Rules 367-375. Replacement Effects intercept an event or instruction and substitute a different event/instruction. Identified by "would ... instead" phrasing.

### 2.1 Core principle

A Replacement Effect is NOT a triggered ability. It does not use the Chain. It applies inline, during the resolution of the event it replaces. Crucially (rule 370.2, 808.1.d.1):

> If a replacement effect applies to a kill event and replaces it with a recall, the kill event did not happen. Deathknell does not fire. "When a unit dies" triggers do not fire.

Replacement applies first, trigger may not fire.

### 2.2 When replacements apply

Any event that:
1. Matches a registered replacement's predicate,
2. Affects an object whose controller/owner owns the replacement, OR affects any object in a zone where the replacement is active.

Engine maintains a `ReplacementRegistry` keyed on event kind. Before dispatching an event (e.g. `KILL`, `DEAL_DAMAGE`, `DRAW`, `CHANNEL`, `PLAY_TOKEN`), the dispatcher asks the registry for all candidate replacements.

### 2.3 Layered ordering (rule 372-373)

When multiple replacements match a single event:
1. The **owner of the object being acted on** chooses the order in which they apply. If the affected thing is a player, that player chooses. If it is an uncontrolled battlefield, the Turn Player chooses (rule 372.2).
2. Apply the chosen replacement. This may produce a new event (e.g. "die -> recall"). That new event is itself subject to the remaining replacements, EXCEPT the one just applied cannot re-apply to the event it created (rule 370.2). This is enforced by a per-event `appliedReplacementIds: Set<string>`.
3. Repeat until no more applicable replacements.

Simultaneous-event handling (rule 373): each event is processed independently. A single replacement may only be applied in one sequence to any number of simultaneous events (rule 373.2; see the Soraka+Guardian Angel example).

"Once each turn" replacements (rule 371) prompt the controller `may apply?` on each candidate event and consume the turn-budget only when applied.

### 2.4 Replacement-effect taxonomy

Implementation creates a `ReplacementHandler` for each. Non-exhaustive list to seed the registry:
- `WouldDie -> Banish/Recall/Return-to-hand instead` (rule 369.1)
- `WouldDealDamage -> Prevent` (rule 437; Prevent is itself a delayed replacement)
- `BurnOut` (rule 431.5 - burning out is a replacement over the draw-beyond-deck event)
- `WouldDraw -> Banish/Reveal/etc.` (card-specific)
- `WouldPlayToken -> PlayAdditionalCopy` (rule 375 example)
- `WouldBeChanneled -> Banish` (rare, card-specific)
- `WouldEnterReady/Exhausted -> state-override` (Accelerate per 805.6 is technically an ETB modifier rather than a replacement; model it via the Play pipeline's entry-state slot)

### 2.5 Modification inheritance (rule 375)

If an event is modified by other effects before a replacement applies (e.g. "play this token exhausted"), the replacement inherits those modifications. When a replacement spawns a new event, the new event starts from the modified event's state.

---

## 3. The Chain (Stack) and Priority

Rules 327-348. The Chain is the non-board zone that temporarily exists when a card is played or an ability is activated.

### 3.1 States of the Turn

Per rules 308-310 every turn is in exactly one of four states. Gate every player-initiated action behind these:

| State | Chain exists | Combat/Showdown in progress | Who can act |
|---|---|---|---|
| Neutral Open | no | no | Turn Player only, any legally-timed card/ability |
| Neutral Closed | yes | no | Priority holder; non-Reaction cards illegal unless they Closed the state |
| Showdown Open | no | yes | Focus holder, Action or Reaction only |
| Showdown Closed | yes | yes | Priority holder, Reaction only |

### 3.2 HOT FEPR loop (rule 335-340)

```
loop:
  handleOutstandingTasks()            // cleanups, start-of-phase tasks, combat steps, end-of-turn tasks
  if chain has Pending items:
    FINALIZE()                        // step 1: run finalization pipeline for each pending item in append order
  if chain has only Finalized items and a player holds Priority:
    EXECUTE()                         // step 2: priority holder plays/activates or passes
  if all players passed without adding items:
    RESOLVE()                         // step 4: top item resolves
  if chain is empty and phase conditions met:
    advance to next phase/step
```

Key rules:
- A Chain is created by the first card/ability played; subsequent plays stack onto the same Chain (rule 330.2).
- Creation of a Chain grants Priority to the player who created it (rule 333.1).
- Step 1 Finalize does NOT pass priority (rule 337.1.a). Items are finalized in append order.
- Units, Gear, and `Add` abilities resolve immediately at Finalize; they do NOT progress to Execute (rule 337.1.c, rule 400.2, rule 429.2). This means playing a unit does not create a response window for the unit's on-play trigger alone; the unit resolves, triggers go on the chain, THEN priority opens.
- Resolve is LIFO (rule 340.1: "the newest item on the Chain resolves").
- A spell resolving pauses all other activity (rule 157.3). New triggers incurred during resolution are captured as Outstanding Tasks and handled after the resolving item finishes (rule 335.2.a).

### 3.3 Priority passes

Rule 339: if all players have passed Priority without adding items, resolve the top of the chain. Otherwise priority moves to the next player in turn order. In showdowns, Focus and Priority move together on pass (rule 313.2, 346).

Focus does NOT pass automatically when a triggered ability chain resolves (rule 346.1): the initial chain's resolution does not cause focus to change hands. Engine must special-case this.

### 3.4 Summoning-sickness analog

Riftbound does not use classic "summoning sickness." Instead: `Units enter the Board exhausted` (rule 143.4). Exhaustion itself gates Standard Move and most activated abilities. The `Accelerate` keyword (rule 805) is the only first-party "enter ready" mechanism. Engine contract: `ETB` (enter-the-battlefield) goes through an `EntryState` slot that defaults to `exhausted` for units, `ready` for gear (rule 149.1), and can be swapped by Accelerate or by token-spec overrides (rule 181.1).

---

## 4. Targeting Resolution

Rules 355.6-355.17 and 359.3.e.

### 4.1 When targets are chosen

Targets are chosen during step 2 of Playing a Card / Activating an Ability ("Make relevant choices"), before costs are determined (rule 355). Once chosen, they cannot be changed (rule 355.15).

Exception: choices described as "on resolution" (rule 355.17) or "Each player chooses a unit to kill" (rule 355.10.e) are made during Resolution, not during step 2, and are not targets.

### 4.2 What is a target

Per 355.10, a mention of a game object, player, or zone is a target UNLESS:
- Its zone is not Public (355.10.a). Main Deck and Hand are not public; Trash, Banishment, Legend Zone, Champion Zone, Bases, Battlefields, and Facedown Zones are.
- It is a targeting restriction nested inside another target (355.10.b). "Unit at a battlefield" targets the unit; the battlefield is a restriction.
- It is part of a cost, trigger condition, or replacement effect (355.10.c).
- It is programmatically "all" or the only possible object (355.10.d).
- It is chosen by a different player (355.10.e).
- It is introduced by a "must" instruction executed on resolution (355.10.f).

### 4.3 Legal target predicate

Define once:

```ts
// Returns ok when `candidate` satisfies every restriction of the targeting clause in `ctx`.
function isLegalTarget(candidate: GameObject, clause: TargetClause, ctx: EngineCtx, source: CardInstance): boolean;
```

`TargetClause` is compiled from card text and carries:
- `zone`: the expected zone ("battlefield", "base", "trash", "chain", "champion-zone", etc.)
- `type`: "unit" | "gear" | "rune" | "permanent" | "spell" | "ability" | "battlefield" | "legend" | "facedown-card" | "card" | "player"
- `controllerRel`: "friendly" | "enemy" | "any"
- `predicates`: array of attribute checks (might >= N, has-tag, has-keyword, is-exhausted, etc.)
- `exclusions`: e.g. `not self` (rule 355.9.c - a spell that says "Counter a spell" cannot target itself)

### 4.4 Cast-time vs. resolution-time validation

- Cast-time (step 5 of Playing, rule 358): every chosen target must be legal. If any is illegal, the entire play is undone and the card returns to its source zone.
- Resolution-time (rule 359.3.e): the spell resolves even if some/all targets became illegal.
  - Illegal targets are unaffected; the rest of the instruction still executes for the still-legal targets.
  - If ALL targets of a given instruction are illegal, that instruction is skipped (rule 359.3.e.7).
  - If ALL of a spell's instructions have all targets illegal and no non-targeted effects, the spell has no effect but is still considered Played (rule 359.3.e.10). Non-targeted triggers from "when you play a spell" still fire.

A target is illegal at resolution if (359.3.e.2):
- It no longer meets any targeting restriction, OR
- It changed zones to or from a Non-Board zone (rule 359.3.e.4: returning later does not restore legality; the object is considered "different" after crossing a zone-privacy boundary).

### 4.5 Fizzle

"Fizzle" means every instruction of a spell was skipped. Not a rules term, but useful in logs. The spell still resolves (is considered Played), is placed in the Trash, and any triggers on "when you play a spell" still fire (rule 359.3.e.10 example).

### 4.6 Partial targets and groups

Rule 355.11: some targets are grouped by a collective restriction ("any number of units with total Might 4 or less"). If the group restriction fails at resolution, the controller chooses a legal subset of the original targets to affect. They may NOT bring in new targets that were not originally chosen (the Fox-Fire example in 355.11.b). Engine: retain the original chosen set; at resolution, offer the controller a subset choice filtered by `isLegalTarget` and the group predicate.

Rule 355.14 (Splitting damage): damage is split among chosen units, actual division decided at resolution. Each target counts individually for "Chosen" triggers.

### 4.7 Referents

Rule 359.3.f. Words like `here`, `me`, `my`, `it`, `this` are Referents. Engine resolves these to concrete object IDs at the appropriate time:
- Trigger-condition referents (`here` at trigger time) - resolved when the trigger condition fires (359.3.f.3).
- Instruction referents (`deal damage equal to my Might`) - resolved at execution of the instruction (359.3.f.2).
- Enemy/friendly referents - re-evaluated at execution (359.3.f.4).

Store as `TriggerCtx.referents` and `OpContext.referents`.

---

## 5. Zone Changes

Rule 110 and 128: every change to or from a Non-Board Zone clears temporary modifications (damage, buffs, granted keywords). Every zone change may trigger replacements and abilities, per section 1 and 2 above.

### 5.1 Zones

Per 107-108:

| Zone | Per-player | Privacy | On Board? |
|---|---|---|---|
| Base | yes | Public | yes |
| Battlefield Zone (holds multiple Battlefields) | shared | Public | yes |
| Facedown Zone (one per Battlefield) | yes (controller) | Private | yes (not a location) |
| Legend Zone | yes | Public | yes |
| Chain | shared | Public | no |
| Trash | yes | Public | no |
| Banishment | yes | Public | no |
| Hand | yes | Private | no |
| Main Deck Zone | yes | Secret | no |
| Rune Deck Zone | yes | Secret | no |
| Champion Zone | yes | Public | no |

### 5.2 Zone-change matrix

Each arrow lists the Riftbound action, the `EffectOp.type` we will implement in Phase 2, and what it triggers.

| From -> To | Action (rule) | Op type | Primary triggers |
|---|---|---|---|
| Board -> Trash | Kill (428) | `kill_permanent` | `on_kill` (Deathknell, 808), `on_unit_dies_other` |
| Board -> Banishment | Banish from board (427) | `banish` | `on_banish`; bypasses `on_kill` |
| Hand -> Trash | Discard | `discard` | `on_discard` |
| Hand -> Banishment | Banish from hand (427) | `banish` | `on_banish` |
| Main Deck -> Hand | Draw (413) | `draw` | `on_draw`; may trigger Burn Out (431) |
| Main Deck -> Trash | Mill (card-specific) | `mill_to_trash` | `on_mill`; may trigger Burn Out |
| Main Deck -> Banishment | Banish from deck (427) | `banish_from_deck` | `on_banish` |
| Trash -> Hand | Return (card-specific) | `return_to_hand` | `on_return`, `on_draw` if the card text also says draw (separate op) |
| Trash -> Board | Reanimate / play-from-trash (card-specific, e.g. Immortal Phoenix rule 383.2.c.1) | `play_from_zone` (zone=trash) | `on_play_other_unit`, `on_play` (self) |
| Trash -> Main Deck bottom | Recycle (416) | `recycle_to_main_deck` | `on_recycle` |
| Trash -> Rune Deck bottom | Recycle a rune (416.1.b) | `recycle_to_rune_deck` | `on_recycle` |
| Banishment -> Hand | Return from banishment (rare, card-specific) | `return_from_banishment` | `on_return` |
| Board -> Base (non-Move) | Recall (449) | `recall` | No `on_move` triggers (451.1) |
| Board -> Hand | Return to hand (bounce) | `return_permanent_to_hand` | `on_return`; clears temp mods (rule 110) |
| Rune Deck -> Board | Channel (430) | `channel_rune` | `on_channel` |
| Rune Deck (top N) -> Trash/Banishment | Mill/banish runes (card-specific) | `mill_runes` | `on_mill_runes` |
| Board <-> Attached | Attach / Detach (434/435) | `attach` / `detach` | Equip triggers (818); Effect Text activates (136) |

### 5.3 State-based check points

Rule 318-323: Cleanups are the state-based check points. They run:
- After any state transition between Open/Closed
- After any phase transition (unless specified otherwise)
- After a Pending Item is added to the Chain
- After a Pending Item becomes a Legal Item on the Chain
- After a Chain Item is removed from the Chain for any reason
- After any zone changes involving Board objects
- After any status change on a Game Object
- After a Move completes

Cleanup steps (rule 323), in order:
1. Check win condition (VP >= Victory Score and strictly more than any opponent).
2. Assign/remove Attacker/Defender designations if combat is ongoing.
3. 3a. Trigger Deathknells for units with lethal damage; 3b. Send those units to Trash (rule 323.4, 323.5).
4. If Open State: un-claim empty Battlefields with no combat/showdown (323.6).
5. Recall unattached non-Unit Gear from Battlefields; recall permanents in foreign bases; send Hidden cards to Trash if the controller no longer controls the battlefield (323.7).
6. Mark Showdowns and Combats as Staged at contested battlefields (323.8, 323.9).
7. Open a Showdown or Combat if Neutral Open state conditions are met (323.11-14).

Cleanups recurse: any state change during cleanup triggers another cleanup (rule 322). Engine loop: `while (cleanupProducedChanges) runCleanup();`.

### 5.4 What triggers on each zone change

- Entering Board (play or channel): `on_play` self-trigger (Play Effect), `on_play_other_*` triggers on other permanents, `on_channel` for runes, `Vision` (817) if self has it.
- Leaving Board to Trash via Kill: `on_kill` self (Deathknell), `on_unit_dies_other`. Snapshotted at death.
- Leaving Board any other way (Banish, Recall, Return-to-hand, Attach-transition to inactive): NO `on_kill`. `on_banish` or `on_return` as appropriate.
- Drawing: `on_draw` after the card lands in hand.
- Discarding: `on_discard`.
- Recycling: `on_recycle`.
- Channeling: `on_channel`.

Remember the 383.2.c.2 gotcha: if the source of a trigger leaves its active zone in the SAME game action as the trigger condition (same cleanup), the trigger fails to register.

---

## 6. Token Creation and Tracking

Rules 176-184.

### 6.1 Instantiation

Tokens are Created (rule 439) on the Board or the Chain. They are not cards (rule 182). A token is spawned from a template:

```ts
interface TokenTemplate {
  templateId: string;          // e.g. "recruit-1m", "sprite-3m-temporary"
  type: CardType;              // usually Unit, can be Gear, Battlefield, Rune
  might?: number;              // for unit tokens
  tags: string[];              // e.g. ["Recruit"], ["Fae"]
  keywords: string[];          // e.g. ["Temporary"], ["Deflect"]
  rulesText?: AbilityIR[];     // granted passive/triggered abilities (for gear and battlefield tokens)
  defaultEntryState: 'exhausted' | 'ready';
  domain: null;                // per 182.2.b, tokens have no domain
  cost: 0;                     // per 182.2.a, cost is treated as 0
}

interface TokenInstance extends CardInstance {
  isToken: true;
  templateId: string;
  instanceId: string;          // freshly allocated; unique across the game
  controller: PlayerId;        // per rule 179
  owner: PlayerId;             // player who controlled the creating effect, rule 180
}
```

Catalog: `data/token-creators.json` already lists the templates referenced by 184.1-184.9. Phase 2 will validate this catalog against the enum of TemplateIDs at load time.

### 6.2 Unique IDs

Every spawned token gets a fresh `instanceId` (same type as non-token `CardInstance.instanceId`). Consumers must not key off `templateId` when tracking an individual token. Multiple simultaneously-created tokens of the same template are distinct objects.

### 6.3 Cleanup rule

Per rule 183.1: if a token enters any Non-Board zone other than the Chain, it ceases to exist immediately upon arrival. Engine impl: in the `onZoneChange` hook, if `instance.isToken && !isBoardZone(newZone) && newZone !== 'chain'`, splice it out of the zone and mark it deleted. No further triggers fire on it once deleted (the zone-change event itself was already dispatched, so `on_kill` / `on_banish` / `on_return` fire, and only THEN the token is deleted).

For replay determinism, record a `token_deleted` log entry.

### 6.4 Tokens copying real cards

Some effects create a token copy of a real card ("Create a token copy of target unit"). The token is still a token (deleted on leaving play) but snapshots the template-equivalent of the copied card's public characteristics at creation time. Copies do not inherit damage, buffs, attachments, or granted temporary keywords (per rule 110, but we also explicitly strip these when snapshotting the template). Tokens cannot be a Chosen Champion.

Phase 2 TODO: decide whether token-copies snapshot printed text vs. currently-active text. Default to printed text; we expect no card in the current pool to hinge on this distinction. Validate by scanning `cards.enriched.json` at dispatcher build time.

---

## 7. Banish / Return-to-Hand / Return-to-Deck

### 7.1 Banish (exile)

Rule 427. Banish sends a card (from any zone) to Banishment. It is NOT a Kill and NOT a Discard (427.2.a, 427.2.b). Banishment is public (rule 108.6.e).

Cards can reference "cards banished by this" (rule 427.3). Engine needs `BanishLink` records keyed on the source instance that performed the banish. These links are per-instance, not per-named-card.

### 7.2 Bounce (return permanent to hand)

Not a named rules action; implemented by card text like "Return a unit to its owner's hand." Clear all temporary modifications per rule 110. The card becomes a new "logical object" on return (359.3.e.4) - any in-flight targets pointing at its previous board instance are broken.

### 7.3 Recall

Rule 449-451. Recall is NOT a Move (451.1). It relocates a permanent from anywhere to its controller's Base. Does not trigger Move abilities. Can be corrective (cleanup recalls unattached gear at battlefields, 323.7) or card-effect-driven. Temp mods are cleared if the permanent is going from a Board zone to a Non-Board zone, but a Recall keeps it on the Board - temp mods survive. (Rule 110 keys on Non-Board crossings.)

### 7.4 Return to Deck

Two variants based on card text:
- Return to top (rarely used): the card is placed on top of the specified deck in the specified order.
- Return to bottom = `Recycle` (rule 416). Multiple cards recycled to Main Deck simultaneously are randomized (416.5). Multiple cards recycled to Rune Deck simultaneously are placed in the order of the owner's choosing (416.5.a).

Op types:
```
return_to_hand        // target may be in any zone
return_to_deck_top    // rare, card-specific
recycle               // = return_to_deck_bottom
```

---

## 8. Counter Manipulation

### 8.1 Buff counters

Rule 426, 701. A unit has AT MOST ONE Buff counter. `Buff a unit` is a no-op if the unit already has a counter (426.1.b.1). This is very different from MTG +1/+1 counters. The buff counter grants a stat-modifying effect defined elsewhere in card text (e.g. "buffed friendly units have +1 Might").

### 8.2 Temporary modifications ("this turn" buffs)

Rule 110 and 317.2.c. Temporary effects:
- Stat modifications from "Give X +N [M] this turn"
- Granted keywords from "Give X [Assault 2] this turn"
- Delayed passive abilities with "this turn" window

Engine representation:

```ts
interface TemporaryMod {
  id: string;
  appliedTo: InstanceId;
  source: InstanceId;
  kind: 'might' | 'keyword' | 'passive';
  payload: unknown;           // +N, keyword name, passive clause
  expiresAt: 'end_of_turn' | GameTick;
}
```

All `this turn` mods expire SIMULTANEOUSLY in the Expiration Step of the End Phase (rule 317.2.c step 2d). This is a batched operation - not per-card. Triggers that fire "when a unit loses keyword X" (none currently printed but plausible) would all fire in the same batch.

### 8.3 Permanent-ish counters

Riftbound's printed pool uses: Buff counters, Damage counters (marked on units), XP (player-level counter). There is no generic "+1/+1 counter" pool. Phase 2 implements these as distinct fields on `CardInstance` / `PlayerState` rather than a generic counter map, unless card text later demands generic counters.

- Damage: tracked as `CardInstance.damage: number`. Healed at end of each turn (rule 143.3.b.1) and during Combat Cleanup (rule 461).
- XP: tracked as `PlayerState.xp: number`. Source: `Hunt` (rule 823), other cards. Used by `[Level N]` gating (rule 824).

### 8.4 Stacking and removal

Rule 807.2, 814.2: multiple granted keyword instances with numeric values sum (Assault 1 + Assault 3 = Assault 4). Granted keywords without numeric value (Tank, Shield without value, Temporary) are redundant and stack as boolean-OR (rule 815.2, 810.2).

"Remove all +1/+1 counters" style effects: for Riftbound specifically, the closest is "remove a buff counter." Buff counters are binary, so "remove a buff counter" sets `hasBuffCounter = false`. No bulk-counter-strip op needed.

### 8.5 Expiration semantics

At the Expiration Step (rule 317.2, steps 2c-2e):
1. All units are healed (damage cleared).
2. All "this turn" effects expire simultaneously.
3. Each player's Rune Pool empties.

Any triggers that would fire off these (rare) are batched and go through the normal APNAP ordering.

---

## 9. Draw / Mill / Tutor

### 9.1 Draw

Rule 413. `Draw X` takes X cards from the top of the Main Deck to the drawing player's Hand.

Empty deck: engine must invoke Burn Out (rule 431). Burn Out sequence:
1. Perform as much of the prescribed action as possible (draw the last card).
2. Recycle the entire Trash into the Main Deck (randomize).
3. Choose an opponent to gain 1 point.
4. Complete the remainder of the action (draw the rest of the N).

Repeated Burn Out with an empty trash gives points to an opponent each time. Points granted post-first-Burn-Out cannot be replaced or prevented (rule 431.3.b). If an opponent crosses Victory Score this way, they win immediately without waiting for a cleanup (rule 431.3.b).

Op types:
```
draw               { player, count }
burn_out           { player }            // internal; spawned by draw/mill when deck is exhausted
```

### 9.2 Mill

Not a named rules term; implemented by card text like "Put the top N cards of your Main Deck into your Trash." Use `mill_to_trash`. Empty-deck handling: Burn Out applies per rule 431.1.b (any forced-move out of Main Deck in excess of remaining cards).

### 9.3 Tutor (search deck)

Card text like "Search your Main Deck for a card with X, reveal it, put it into your hand, then recycle [shuffle bottom] your deck." Op:

```ts
type TutorOp = {
  type: 'tutor';
  player: PlayerId;
  zone: 'main-deck' | 'rune-deck' | 'trash' | 'banishment';
  predicate: CardPredicate;         // compiled from card text
  revealToOpponents: boolean;       // most tutors reveal
  destinationZone: 'hand' | 'board' | 'chain';
  onFound: 'all' | 'one' | { count: number };
  afterward: 'recycle-all' | 'no-op' | 'shuffle-deck';  // most Main Deck searches end with a recycle-all per rule 416
};
```

Key: searching the Main Deck makes it temporarily visible to the searcher only (privacy temporarily downgraded). After the search, the deck is recycled (bottom-placed in random order per rule 416.5). Engine MUST randomize the deck using the RNG seed on the EngineCtx for replay determinism.

Empty-or-insufficient-results: if no matching card, the instruction partially-follows per rule 431.1.c.1 and 055: do as much as possible, ignore the rest. No Burn Out for LOOK-only actions (rule 431.1.c).

---

## 10. Cost Modifiers

Rule 356-358. Costs have components: Energy cost, Power cost (per-domain), and non-standard costs (e.g. "kill a friendly unit").

### 10.1 Application order (rule 356)

Costs are computed as a pipeline during step 3 of Playing:

```
1. Base cost                              (printed cost; rule 356.1)
   - "Play for [Cost]" overrides all base costs (356.1.a)
   - "Ignoring costs" sets Energy+Power to 0 (356.1.b)
2. + Additional costs                     (356.2)
   - Mandatory ("as an additional cost to play me, kill a friendly unit")
   - Optional ("as you play me, you may discard 1 ...") - only if player opted in at step 2
3. + Cost increases                       (356.3)
   - e.g. Deflect adds Power per target (809)
4. - Discounts                            (356.4)
   - Component-specific discounts first (356.4.c)
   - Then total-cost discounts (356.4.d)
   - Multiple same-layer discounts: applier chooses order (356.4.c.1, 356.4.d.1)
   - Minimum-cost discounts floor at the discount's declared minimum (356.4.e), not at 0
5. Floor Energy and Power at 0           (356.5)
```

Non-standard costs are added to `additionalCosts[]` and paid in step 4 (Pay Costs) in any order (357.2).

### 10.2 Channeling costs (printed cost for spells/permanents)

The "Channeling cost" on a card is the printed cost. It is NOT paid with channeled runes directly - channeled runes produce Energy and Power when Exhausted (`[E]: Add [1]`) or when Recycled (`Recycle this: Add [C]`). The player taps runes to add to their Rune Pool, then spends from the pool.

Rune pool flushes at end of Draw Phase and end of Turn (rule 166). Unspent energy/power is lost.

### 10.3 Alt-costs

Handled as "Play for [Cost]" (356.1.a). Examples:
- Hidden + "play from Hidden ignoring its base cost" (rule 811.1.b)
- Weaponmaster applying a reduced Equip cost to a unit (821)

Engine: `PlayContext.playMode: 'normal' | 'for-cost' | 'ignoring-costs' | 'from-hidden'` selects which branch of the cost pipeline to run.

### 10.4 Discounts

Model each discount as:

```ts
interface CostDiscount {
  source: InstanceId;
  appliesTo: 'energy' | 'power' | 'total' | 'additional-power';
  amount: number | 'minimum-1' | 'by-variable';
  variableFn?: (ctx: EngineCtx) => number;
  minimumAfterDiscount?: number;        // rule 356.4.e
  conditionFn?: (ctx: EngineCtx) => boolean;
}
```

### 10.5 Additional costs

```ts
interface AdditionalCost {
  source: InstanceId;
  kind: 'mandatory' | 'optional';
  paymentOp: EffectOp;                  // e.g. kill_permanent, discard, exhaust-unit
  optedIn?: boolean;                    // for optional costs; set in step 2
}
```

Costs paid but replaced by Replacement Effects still count as paid (rule 357.2.a - the Cruel Patron + Zhonya's example).

### 10.6 Repeat

Rule 820. Repeat is an optional additional cost; paying it instructs the engine to execute the spell's effect one additional time on resolution. Choices for the repeat execution are made in step 2 and may differ from the initial choices. A spell with N instances of Repeat, all paid, executes its instructions N+1 times.

Model:

```ts
interface RepeatInstance {
  cost: Cost;
  optedIn: boolean;
  extraChoices?: ChoiceSet;
}
// On resolution: execute instructions once, then once per optedIn RepeatInstance with its choices.
```

---

## 11. Keyword Granting

Rule 801.3. Keywords can be granted (added) or removed by other effects.
- Granted keywords with a duration: the duration is specified. "This turn" -> expires in Expiration Step.
- Granted keywords without a duration: persist as long as the object remains on the Board or in its current Non-Board zone (rule 801.3.a.3). Crossing a zone boundary clears them per rule 110.

### 11.1 Keyword list (from rules 805-826)

Source of truth for engine keyword enum. Each comes with a metadata record: whether it is passive / triggered / activated / dependent / permissive, what it's valid on, whether it takes a numeric value, and whether multiple instances stack or are redundant.

| Keyword | Rule | Kind | On | Value | Stack behavior |
|---|---|---|---|---|---|
| Accelerate | 805 | Optional additional cost | Unit | none | redundant |
| Action | 806 | Permissive | Cards, Abilities | none | boolean |
| Assault N | 807 | Passive | Unit | numeric | sums |
| Deathknell | 808 | Triggered | Permanent | text | each triggers separately |
| Deflect N | 809 | Passive (cost-increase) | Permanent | numeric | sums (per rule 809, though not explicitly stated; treat like Assault) |
| Ganking | 810 | Passive | Unit | none | redundant |
| Hidden | 811 | Discretionary-action prereq | Spell/Unit/Gear | none | redundant |
| Legion | 812 | Dependent | Card | text | satisfied once per turn once any other card played |
| Reaction | 813 | Permissive (superset of Action) | Cards, Abilities | none | boolean |
| Shield N | 814 | Passive | Unit | numeric | sums |
| Tank | 815 | Passive | Unit | none | redundant |
| Temporary | 816 | Triggered (kill-self at Beginning Phase) | Permanent | none | redundant |
| Vision | 817 | Triggered | Permanent | none | each triggers separately |
| Equip [Cost] | 818 | Activated | Gear | cost | multiple Equip = multiple activated abilities |
| Quick-Draw | 819 | Triggered + Permissive | Gear w/ Equip | none | redundant |
| Repeat [Cost] | 820 | Optional additional cost | Spell | cost | each instance paid separately |
| Weaponmaster | 821 | Triggered (Play Effect) | Unit | none | each triggers separately |
| Ambush | 822 | Passive | Unit | none | redundant |
| Hunt N | 823 | Triggered (Conquer + Hold) | Unit | numeric | sums |
| Level N | 824 | Dependent | Card | numeric | each ability gated independently |
| Unique | 825 | Deck-construction only | Card | none | n/a in-game |
| Backline | 826 | Passive | Unit | none | redundant |

No other keywords are currently printed. `src/keywords.ts` does not exist yet; this table is the seed for its creation in Phase 2.

### 11.2 Grant vs. remove model

```ts
interface GrantedKeyword {
  source: InstanceId;
  keyword: KeywordId;
  value?: number;                 // for Shield/Assault/Hunt/Deflect/Level
  duration: 'this_turn' | 'while_attached' | 'while_on_board' | 'while_in_zone' | GameTick;
}

// Effective keywords = printed keywords ∪ granted keywords (minus removed).
// Stack logic per 11.1 table applied at read time.
```

Static "as long as" grants (rule 364 passive abilities like "Friendly Yordles at my battlefield have [Shield]") are NOT stored as granted keywords on the target unit; they are computed by the passive ability's evaluator and baked into effective-keyword lookups. Do not persist them on the affected objects; persist on the source and resolve when queried, so removing the source removes the grant automatically.

Per-turn grants ("Give X Assault 3 this turn") ARE stored on the target as `GrantedKeyword` with `duration: 'this_turn'` and are cleared in the Expiration Step.

---

## 12. Skeleton OpHandler Interface

Phase 2 will implement a dispatcher `runOp(ctx, op, source)` that looks up the right `OpHandler` from a registry keyed on `op.type`.

```ts
// Every effect op implements this.
export interface OpHandler<TOp extends EffectOp = EffectOp> {
  op: TOp['type'];

  // Pre-check that the op can be executed in the current ctx.
  // Used for targeting pre-checks during the Make-Relevant-Choices step of Playing.
  // Also used by UI to filter selectable targets.
  validate?(ctx: EngineCtx, op: TOp, source: CardInstance): ValidationResult;

  // Execute the op. Must NOT mutate ctx directly; returns patches so the engine
  // can record them for replay, rollback (on failed cost pipelines), and network sync.
  execute(ctx: EngineCtx, op: TOp, source: CardInstance): OpResult;
}

export interface EngineCtx {
  // Players, in turn order. Index 0 is the First Player for the match.
  players: PlayerState[];
  turnPlayerId: PlayerId;
  priorityHolder: PlayerId | null;
  focusHolder: PlayerId | null;       // null outside showdowns

  // Zones (owned per-player for most, shared for some).
  zones: {
    board: BoardState;                // battlefields, bases, legend zones, facedown zones
    chain: ChainState;                // ordered list of Pending + Finalized items
    hands: Record<PlayerId, CardInstance[]>;
    mainDecks: Record<PlayerId, CardInstance[]>;
    runeDecks: Record<PlayerId, CardInstance[]>;
    trashes: Record<PlayerId, CardInstance[]>;
    banishments: Record<PlayerId, CardInstance[]>;
    championZones: Record<PlayerId, CardInstance | null>;
  };

  // Turn state machine.
  turnState: {
    turnNumber: number;
    phase: 'awaken' | 'beginning' | 'channel' | 'draw' | 'main' | 'ending' | 'expiration';
    mode: 'neutral_open' | 'neutral_closed' | 'showdown_open' | 'showdown_closed';
    combat: CombatState | null;
    showdown: ShowdownState | null;
    onceThisTurnUsed: Record<string, number>;   // trigger/replacement budgets (rule 371, 383.3.f)
    triggeredThisTurn: Record<string, number>;  // e.g. for Legion (rule 812)
  };

  // Effect-tracking.
  replacementRegistry: ReplacementRegistry;
  delayedAbilities: DelayedAbility[];
  temporaryMods: TemporaryMod[];

  // Replay determinism.
  rng: { seed: string; cursor: number };
  tick: GameTick;
  log: LogEntry[];
}

export interface CardInstance {
  instanceId: string;
  cardId: string;                     // catalog key; null for tokens
  templateId?: string;                // for tokens, per rule 176+
  isToken?: boolean;
  owner: PlayerId;
  controller: PlayerId;               // may differ from owner after gain-control
  zone: Zone;                         // current zone
  location?: Location;                // base / battlefield-id for on-board permanents
  state: {
    exhausted: boolean;
    damage: number;
    hasBuffCounter: boolean;
    facedown: boolean;
  };
  attachments: {
    attachedTo?: InstanceId;          // if this card is Attached
    topMostAttachments: InstanceId[]; // if this card is a Top-Most Card
  };
  grantedKeywords: GrantedKeyword[];
  temporaryMightMod: number;          // sum of this-turn Might mods
  // Snapshots used by triggers that "look back" at death / zone change.
  lastKnownLocation?: Location;
  lastKnownMight?: number;
  lastKnownController?: PlayerId;
}

export interface EffectOp {
  type: string;
  // Op-specific fields. See Section 5.2 table for op-type -> required fields.
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;                    // machine-readable code for UI
}

export interface OpResult {
  patches: Patch[];                   // Immer-style JSON Patch operations
  triggeredAbilities: TriggerFire[];  // collected; dispatcher pushes onto Chain via APNAP
  log: LogEntry[];
}

export interface Patch {
  op: 'add' | 'remove' | 'replace';
  path: string;                       // JSON pointer into EngineCtx
  value?: unknown;
}

export interface TriggerFire {
  triggerType: TriggerType;
  sourceInstanceId: string;
  sourceController: PlayerId;
  eventSnapshot: EventSnapshot;
  referents?: Record<string, Ref>;
}

export interface LogEntry {
  tick: GameTick;
  kind: string;
  payload: unknown;
}
```

### 12.1 Dispatcher contract (Phase 2 preview)

Phase 2 will implement:

```ts
// Registry
const handlers = new Map<string, OpHandler>();
function registerHandler(h: OpHandler): void { handlers.set(h.op, h); }

// Dispatch
function runOp(ctx: EngineCtx, op: EffectOp, source: CardInstance): OpResult {
  const h = handlers.get(op.type);
  if (!h) throw new UnknownOpError(op.type);

  // 1. Ask registered replacements if they want to substitute this op.
  const replaced = ctx.replacementRegistry.applyTo(op, ctx, source);
  if (replaced.appliedReplacementIds.length > 0) {
    // Recurse on the substituted op(s). Replacements cannot re-apply to their own products.
    return runOpsSequence(ctx, replaced.ops, source, replaced.appliedReplacementIds);
  }

  // 2. Execute.
  const result = h.execute(ctx, op, source);

  // 3. Append to log; patches are applied by the outer engine transaction, not here.
  return result;
}
```

Triggers produced in `OpResult.triggeredAbilities` are NOT pushed onto the Chain inside `runOp`. The outer engine runs one HOT FEPR loop iteration after each op completes: it collects pending triggers across the batch, partitions by controller, prompts controllers in turn order for their ordering (APNAP), and pushes Pending Items onto the Chain. Only then does it resume the HOT FEPR loop.

### 12.2 What Phase 2 will NOT do

- Rewrite `src/game-engine.ts` to use handlers immediately. Phase 2 will introduce handlers and dispatcher alongside the existing engine and route individual op types through them one at a time behind a feature flag. The full cutover is a later phase.
- Support arbitrary card text parsing. Phase 2 targets the ops listed in Section 5.2 plus the keyword triggers in 11.1. Cards whose text does not reduce to these ops will log `UNIMPLEMENTED_EFFECT` and be played as no-ops for now (rule 055.1 covers us legally: "if all of a card's instructions are impossible, it is still played and resolved, but nothing happens").

---

## Riftbound-specific subsystems

Phase 2a addendum. The ops below appear in `docs/effect-ops-frequency.csv` with high volume but do not reduce cleanly to the generic primitives in sections 1-11. This section closes those gaps so the dispatcher has a complete contract for the first pass of handlers.

Counts in each subsection header are the op-type counts from the frequency CSV. Where a card appears under multiple ops, it is counted in each row - the frequency table is per-op, not per-card.

### 13. Battlefields + Scoring

Covers: `control_battlefield` (168), `scoring` (20), `scoring_restriction` (2).

#### 13.1 Rules anchor

- Rule 107.2: Battlefield Zone. Houses multiple Battlefields; each is a Location; public.
- Rule 107.3: Facedown Zone, one per Battlefield, tied to the Battlefield's controller.
- Rule 169: Battlefields are Game Objects. Owned, never shuffled, cannot be Killed, cannot be Moved, are Locations, can be targets, can hold Passive / Triggered abilities.
- Rule 169.10: Battlefield adjective states - `occupied`, `uncontrolled`, `open`.
- Rule 170: Battlefields are not Permanents.
- Rule 171: Count of Battlefields set by Mode of Play (Duel = 2; see 480.4).
- Rule 187.1-187.6: Control. Binary for Battlefields. Contested status applied when a non-controlling player's unit becomes present. Control is established at the end of a Showdown or Combat after Contested is applied. Losing all your units while the turn is Open and no combat/showdown is ongoing removes Control in the next Cleanup (rule 187.4.c).
- Rule 316.5 and 341-348: Showdown mechanics (already covered by section 3; repeated here because `control_battlefield` often fires as a consequence of a Showdown resolving).
- Rule 445-447: A Move that applies Contested to an uncontrolled battlefield opens a Showdown; a Move that brings opposing-controlled units together opens a Combat.
- Rule 462-467: Scoring. A Score is either a Conquer (gaining control of a Battlefield not already scored this turn, rule 464.1) or a Hold (maintaining control during your Beginning Phase, rule 464.2). Hardcap: one Score per Battlefield per player per turn (rule 465). The Winning Point has extra conditions (rule 466.1.a and 466.1.b). Win condition checked at Cleanup (rule 467).
- Rule 461.5.d: Establishing Control as part of the Combat Resolution Step is also a Conquer if not yet scored this turn.
- Rule 315.2.b: Scoring Step of Beginning Phase. The Turn Player Holds all battlefields they Control. Teammate-held battlefields are disqualified from Conquer this turn (rule 464.1.a).

#### 13.2 Ops in this subsystem

- `control_battlefield` (168) - any effect whose text refers to battlefield control transitions or queries controlled battlefields.
- `scoring` (20) - effects that award points outside the normal Conquer/Hold flow, or that piggyback scoring off a Hold/Conquer trigger.
- `scoring_restriction` (2) - battlefield or static effects that block scoring under a condition.

#### 13.3 State shape

Battlefields live on the shared board, not in any per-player zone. Extend `BoardState`:

```ts
interface BoardState {
  battlefields: Record<BattlefieldId, BattlefieldState>;
  bases: Record<PlayerId, BaseState>;
  legendZones: Record<PlayerId, LegendState>;
}

interface BattlefieldState {
  battlefieldId: BattlefieldId;
  owner: PlayerId;                 // who brought this battlefield to the match (rule 169.1)
  controller: PlayerId | null;     // null = uncontrolled (rule 187.2.b)
  contested: boolean;              // rule 187.3
  presentUnits: InstanceId[];      // all units at this battlefield, any controller
  attachedGear: InstanceId[];      // unattached-at-battlefield gear, recalled in cleanup per 149.3
  facedown: Record<PlayerId, InstanceId[]>;   // rule 107.3; one slot per player
  scoredBy: Record<PlayerId, 'conquer' | 'hold' | null>;  // reset at End of Turn; rule 465
  combat: CombatState | null;      // reference into turnState.combat when one is staged here
  showdown: ShowdownState | null;  // reference into turnState.showdown
  passiveAbilities: PassiveAbilityRef[];
}

interface PlayerState {
  // ...existing fields...
  points: number;             // rule 466.1
  scoredThisTurnByBattlefield: Set<BattlefieldId>;  // also enforced via BattlefieldState.scoredBy but duplicated here for O(1) check
}
```

"Control" is resolved by a single authority field `BattlefieldState.controller`, not by counting presence or most-Might. Presence is tracked in `presentUnits` so predicates can read it, but control transitions only during Cleanup or during Step 3 of Combat (rule 461.5). A player losing their last unit at a battlefield does NOT lose control immediately - they lose it at the next Cleanup while the turn is Open and no combat/showdown is live (rule 187.4.c). This is important because `control_battlefield` handlers must not mutate `controller` inline - they request a Cleanup and let the cleanup loop reconcile.

`scoring_restriction` is stored as a passive ability on the battlefield (rule 169.8). It does not mutate state directly; it is consulted by `scoring` op `validate` hooks.

#### 13.4 Key triggers

- `on_conquer` (rule 383.4.c) fires when a Score occurs via Conquer at a Battlefield.
- `on_hold` (rule 383.4.d) fires during Scoring Step of Beginning Phase for each held battlefield.
- `on_move` (rule 420, 440) fires when a unit's movement causes Contested or establishes presence at a battlefield.
- `at_start_of_beginning_phase` (rule 315.2, used by `Temporary`) fires before Scoring Step.
- `at_start_of_combat` / `at_end_of_combat` (rule 454, 461) fire at the battlefield-local combat boundaries.
- Win-condition check happens in Cleanup (rule 323.1, already called out in section 5.3); scoring itself does not trigger a win check inline. Burn Out is the exception (rule 431.3.b) and stays in its existing replacement path.

#### 13.5 Handler notes

`control_battlefield`:
- `validate(ctx, op, source)`: the targeted `battlefieldId` exists; if `mode === 'contest'` the source's controller does not already control it; if `mode === 'lose'` the source's controller currently controls it.
- `execute(ctx, op, source)`: emits patches that mutate `presentUnits` and `contested`. Does not touch `controller`. Emits an outstanding Cleanup task. The Cleanup's Control-reconciliation step (engineered per rule 187.4 + 461.5) resolves the actual `controller` transition and, if a Conquer occurred, applies `scoring` as a side effect and fires `on_conquer` triggers.
- Mode `gain` is a directly-granted control grant by card effect (rare - usually control flows out of combat). Mode `contest` is the normal path. Mode `lose` is card-forced removal of control.

`scoring`:
- `validate`: reads every active `scoring_restriction` passive ability against `(player, battlefield, reason)` and returns `ok: false` if any blocks. Also checks `scoredThisTurnByBattlefield` for the rule-465 cap when `reason` is Conquer or Hold. Card-effect scoring outside Conquer/Hold is exempt from 465 but still respects Winning-Point rules (rule 466.1.a.1).
- `execute`: increments `points`, adds to `scoredThisTurnByBattlefield`, sets `BattlefieldState.scoredBy[player]`, and emits `on_conquer` or `on_hold` triggers per 466.2. Winning-Point gating from 466.1.b is handled inline: if the incoming point would be the Winning Point and the Conquer path has not yet scored every battlefield this turn, the point is replaced by a card draw (rule 466.1.b.2); this replacement is applied inside the handler, not via `ReplacementRegistry`, because it is a rules-baked non-optional behavior.

`scoring_restriction`:
- No `execute`. It is a passive the engine installs when the source (typically a Battlefield) enters the Board and removes when the source leaves. It registers a predicate in `ctx.scoringRestrictions[]` that the `scoring.validate` hook consults.

#### 13.6 Concrete examples

- OGN-056 Adaptatron: "When I conquer, you may kill a gear. If you do, buff me." Op chain: the `on_conquer` trigger fires from the Conquer that came out of combat resolution; the ability's Chain Item runs `remove_permanent` (the gear, optional) and `modify_stats` (buff self via the Buff counter set). `control_battlefield` is listed in the effectProfile because the card's text gates off control status, not because it mutates control directly.
- SFD-148 Draven - Audacious: "The first time I win a combat each turn, you score 1 point." The "win a combat" check is a combat-resolution trigger, not a Conquer - so this is a `scoring` op with `reason: 'effect'` bypassing rule 465's per-battlefield cap (but still respecting 466.1.a.1 on the Winning Point). The second line "When I die in combat, choose an opponent. They score 1 point." is another `scoring` op with the target being an opponent (third-party scoring).
- OGN-066 Ahri - Alluring: "When I hold, you score 1 point." The `on_hold` trigger from rule 466.2.b fires, and its Chain Item is a `scoring` op with `reason: 'effect'`. The point from the Hold itself has already been awarded by the built-in rule 466.1 flow at this point; Ahri's ability is an EXTRA point, which is why it uses `reason: 'effect'` rather than `reason: 'hold'`.
- SFD-209 Forgotten Monument (battlefield): "Players can't score here until their third turn." Registers a `scoring_restriction` predicate keyed on `(battlefield = self, turnNumber < 3)`. `scoring.validate` returns `ok: false, reason: 'battlefield_score_locked'` for the first two turns.
- SFD-060 Tianna Crownguard: "While I'm at a battlefield, opponents can't score points." Global `scoring_restriction` predicate keyed on `(scoringPlayer = enemy-of-controller, Tianna.presentAtBattlefield === true)`. Expires when Tianna leaves the board.

Open question for Phase 2b: OGN-276 Aspirant's Climb says "Increase the points needed to win the game by 1." This modifies `VictoryScore` rather than scoring mechanics. Model it as a separate `modify_victory_score` op or overload `scoring_restriction` with a victory-score sublayer. Recommendation: separate op, since the frequency is low and conflating would muddy the validator.

### 14. Gear attachment

Covers: `attach_gear` (113), `equip_trigger` (59).

#### 14.1 Rules anchor

- Rule 147-151: Gear fundamentals. Gear are permanents (147); have Intrinsic Properties (149); have a Location (151.1).
- Rule 149.1: Gear enter ready by default.
- Rule 149.3: Unattached Gear at a Battlefield is recalled to its controller's Base in the next Cleanup (this is 323.7's corrective recall).
- Rule 434: Attach. The act of linking two cards on the board. Produces one Attached card and one Top-Most Card (or a stack of Attached + one Top-Most).
- Rule 434.1.c: The Top-Most Card appends all Effect Text of all cards Attached to it to its Rules Text.
- Rule 434.1.d: Top-Most Card's Might is modulated by Might Bonuses of Attached cards.
- Rule 434.1.e: Attached cards' Rules Text becomes Inactive while attached.
- Rule 434.1.f: Attaching to a new Top-Most Card auto-detaches from the current one.
- Rule 434.4: When a card Attaches, its Location becomes the new Top-Most Card's Location. This is NOT a Move (434.4.a), so `on_move` does not fire.
- Rule 435: Detach. Inverse of attach.
- Rule 452.1: When Equipment's unit dies (or otherwise leaves), the gear is at the battlefield unattached; during the next Cleanup it is Recalled to its controller's Base (rule 449, 323.7).
- Rule 716-720: Attachment as a permanent-state concept.
- Rule 818: Equip keyword. Activated ability. Cost + `Attach this gear to a unit you control`. Multiple Equip abilities are independent (818.4).
- Rule 818.2: Completion of the Equip Attach creates an `Equipped by` event other effects can reference.
- Rule 818.3: Equipped state. A Top-Most Card is Equipped as long as one or more Attached cards are Equipment.
- Rule 819: Quick-Draw. Reaction + auto-attach on play.
- Rule 821: Weaponmaster. A Play Effect that chooses an Equipment you control and allows paying its Equip cost (reduced by [A]) out-of-turn to attach it to the Weaponmaster unit.

#### 14.2 Ops in this subsystem

- `attach_gear` (113) - the physical Attach action, whether driven by Equip, Weaponmaster, Quick-Draw, or bespoke card text.
- `equip_trigger` (59) - triggered abilities that fire as a consequence of an Equip / Attach completing.

#### 14.3 State shape

Attachments live ON the Top-Most Card (already on `CardInstance.attachments` per section 12). Clarify the semantics:

```ts
interface CardInstance {
  // ...existing fields...
  attachments: {
    attachedTo?: InstanceId;          // If set, this card is Attached. Its zone stays 'board'
                                      // but its Location mirrors attachedTo's Location (rule 434.4).
                                      // Its Rules Text is Inactive (rule 434.1.e).
    topMostAttachments: InstanceId[]; // If this card is the Top-Most Card, ids of all cards Attached
                                      // to it. Order is irrelevant for rules (434.1.b.1) but stored
                                      // insertion-ordered for replay determinism.
  };
}
```

Gear does not get its own "attached zone." It stays in the Board zone; its Location follows its Top-Most Card. When it becomes Attached, its own `grantedKeywords` and `temporaryMods` remain on the gear instance, but are read-through via the Top-Most Card's effective ruleset (handled in the layers engine per rule 472).

When the bearer dies, bounces, or is banished:
- Kill (Board -> Trash): the Attached gear is NOT killed. It stays on the Board but becomes unattached (rule 434.1.f only covers re-attach; the orphan case is covered by rule 323.7 + 452.1). It lands at its own Location-of-record (usually the battlefield where the unit died). The next Cleanup recalls it to the Base per 149.3.
- Bounce (Board -> Hand): the unit crossing a Non-Board boundary clears temp mods per rule 110; the attached gear stays on the Board and becomes unattached per the same orphan rule. It is NOT bounced with the unit.
- Banish (Board -> Banishment): same as Bounce. Gear stays, becomes unattached, awaits recall.
- Recall of the unit (not a Non-Board crossing): the unit changes Location. Per rule 434.4, attached gear's Location follows the unit. So Recall of an Equipped unit brings the gear to the unit's Base with it, still attached. No recall cleanup fires on the gear because it is still attached.

Stacking multiple gears: rule 434.1.b.1 and 818.3.b explicitly support multiple Attached cards on one Top-Most. Each contributes its Effect Text and Might Bonus. Each of their Equip-derived Equipped states independently satisfies "is Equipped". `topMostAttachments` is a list, not a single slot.

#### 14.4 Key triggers

- `equip_trigger` is our custom trigger-type alias. It maps onto `on_play_other_unit`-adjacent shape but for Attach events. Formal definition: fires when an Attach Action completes (rule 434 + 818.2) where either (a) the source of the trigger is the Top-Most Card being Equipped, or (b) the source is the Equipment itself, or (c) card text explicitly names `when an Equipment is attached to X`.
- Triggers from rule 818.2 "Equipped by" events are a subset of `equip_trigger`.
- `on_play` (rule 383.4.a) of the gear fires when the gear enters the board from Hand. It is distinct from `equip_trigger`: a gear played via Quick-Draw into an auto-Attach fires both `on_play` AND `equip_trigger`, and both go on the Chain in a single APNAP-ordered batch.

Gotcha: Weaponmaster's Attach is part of the Weaponmaster trigger's resolution (rule 821.1.c), not a new Equip activation. So a Weaponmaster-driven Attach fires `equip_trigger` (the Attach event) but does NOT fire any "when you activate an Equip ability" triggers.

#### 14.5 Handler notes

`attach_gear`:
- `validate(ctx, op, source)`: `op.gearInstance` is a Gear on the Board owned/controlled by the correct player per the calling card's text (typically "gear you control"); `op.target` is a unit on the Board; both survive between cast-time and resolution-time per 4.4. If Weaponmaster-sourced, also validate the source unit still exists and has Weaponmaster.
- `execute`: performs the Attach state update (set `gear.attachments.attachedTo = target.instanceId`; push to `target.attachments.topMostAttachments`; detach from prior Top-Most if any per 434.1.f). Recalculates `target`'s effective Might/abilities (the layers engine does this on read, so the handler just flags "dirty" via the normal layer-invalidation path). Updates `gear.location` to mirror `target.location`. Emits an `attach_event` into the EventSnapshot bus with `{gearInstance, target, wasAlreadyAttachedTo, reason}` so `equip_trigger` observers can fire.
- Reason codes: `'equip_activation' | 'weaponmaster' | 'quickdraw' | 'card_effect'`.

`equip_trigger`:
- Handler treats this as a trigger-registration op, not a state mutation. When a card with an `equip_trigger` ability enters the board, the handler registers an observer with the event bus keyed on the relevant `attach_event` predicate. When the predicate matches, the observer produces a `TriggerFire` per section 1.2 and returns it through the normal `OpResult.triggeredAbilities` path.

#### 14.6 Concrete examples

- OGN-179 Acceptable Losses: "Each player kills one of their gear." Not an attach op - the card's `attach_gear` effectProfile label is misleading; this is `kill_permanent` targeted per-player with scope `gear`. `attach_gear` ends up on its classes list because the card's subject is Gear. Handler dispatcher must key on the op type in `operations`, not on `classes`. Phase 2b engineer: treat this as an acceptance test that the dispatcher is driven by `operations[].type`, not `classes`.
- SFD-109 Akshan - Mischievous: "[Weaponmaster] ... When you play me, if you paid the additional cost, move an enemy gear to your base. You control it until I leave the board. If it's an Equipment, attach it to me." Op sequence from on-play resolution: `move_unit` (gear, destination = controller's base) with a control-grant side effect, then conditional `attach_gear` (gear -> self) if `gear.hasTag('Equipment')`. The Weaponmaster Play Effect is a separate reflexive ability; see section 14.4 note.
- SFD-224 Aphelios - Exalted: "When you attach an Equipment to me, choose one that hasn't been chosen this turn - Ready 2 runes. / Channel 1 rune exhausted. / Buff a friendly unit." `equip_trigger` observer registered when Aphelios enters. Predicate: `attach_event.target === Aphelios && attached.hasTag('Equipment')`. On fire, the Chain Item is a reflexive mode-choice that dispatches one of `ready_runes`, `channel_rune`, or `modify_stats(+buff)` under a once-this-turn-per-mode budget (tracked via `onceThisTurnUsed[aphelios-equip-mode-{modeIndex}]`, rule 383.3.f). Note this card illustrates why `equip_trigger` cannot be reduced to `on_play_other_*`: it fires on attach, which may happen turns after the attached Equipment was played.
- OGN-056 Adaptatron (secondary example): `attach_gear` appears because the card interacts with gear via "kill a gear" not via attaching. See OGN-179 note.

Open question for Phase 2b: the data's `attach_gear` label is overloaded between "this op attaches gear" and "this card's subject is gear." The dispatcher must only route the former; confirm the ETL that produced `effect-ops-frequency.csv` agrees, and add a test that cards with `attach_gear` in `classes` but no attach verb in `effect` do not register an Attach handler.

### 15. Positional movement

Covers: `move_unit` (86), `follow_movement` (2).

#### 15.1 Rules anchor

- Rule 141.1.a.1: Units are at one of several Locations while on the Board: a Battlefield or their Base.
- Rule 144.4: Standard Move. Base -> Battlefield, Battlefield -> Base, Battlefield -> Battlefield via Ganking (rule 810).
- Rule 144.4.a.1: A unit may not move to a Battlefield that already has units from 2 other players (multiplayer rule; in Duel this is a no-op constraint since there are only 2 players).
- Rule 420: Move as a Limited Action. Standard Move itself is Discretionary (420.3); engine-driven moves are Limited.
- Rule 440-448: Movement semantics. Moving is instantaneous (441.3); defined by Origin and Destination (442); only Units can Move (442.3); Moving does not use the Chain and cannot be Reacted to (441.3.c); after a Move completes, a Cleanup runs (448).
- Rule 442.2.c: If a Move would take a Unit to an invalid Destination, it Recalls instead (449).
- Rule 445: Destination becomes Contested if it's a Battlefield not controlled by the moving unit's controller.
- Rule 446-447: A Move can open a Showdown (446) or a Combat (447).
- Rule 449-453: Recall. NOT a Move (451); does not fire Move triggers (451.1); relocates to the controller's Base. A Recall keeps the permanent on the Board, so temp mods survive (rule 110 keys on Non-Board crossings; rule 453.1 confirms Damage/Exhausted/Buffed/Layer alterations are unaffected).

#### 15.2 Ops in this subsystem

- `move_unit` (86) - any op that relocates a unit between Locations via the Move rules.
- `follow_movement` (2) - a triggered-replacement hybrid: a unit may piggyback another unit's Move.

#### 15.3 State shape

Positions are Locations, not arbitrary board slots. The only positional values are:

```ts
type Location =
  | { kind: 'battlefield'; battlefieldId: BattlefieldId }
  | { kind: 'base'; player: PlayerId };
```

There are no sub-slots within a Battlefield; any number of units can be present (rule 169.6). Presence lists on Battlefield / Base state are the source of truth for predicates:

```ts
interface BaseState {
  player: PlayerId;
  presentUnits: InstanceId[];
  presentGear: InstanceId[];         // unattached gear lives in a base by default after recall (149.3)
}

interface CardInstance {
  location?: Location;               // undefined while in any Non-Board zone; required on Board
}
```

Move mechanics produce a standard event stream:

```ts
interface MoveEvent {
  unit: InstanceId;
  origin: Location;
  destination: Location;
  reason: MoveReason;                 // see below
  causedByInstance?: InstanceId;      // source of the move effect (for attribution; rule 451 exclusion)
  batch?: MoveBatchId;                // moves in the same instruction share a batch id for follow_movement
}

type MoveReason =
  | 'standard_move'            // unit Standard Move, 144.4
  | 'ganking'                  // Battlefield-to-Battlefield via Ganking, 144.4.c.1 + 810
  | 'card_effect'              // arbitrary card text move
  | 'combat_cleanup'           // forced relocation coming out of Combat Resolution Step
  | 'replacement_recall';      // rule 442.2.c - invalid move becomes a recall; recorded for audit
                               // (note: the Recall itself is a separate op, not a move_unit)
```

#### 15.4 Key triggers

- `on_move` (rule 420, 440; already in section 1 table) fires after a Move completes. Payload: `{unitId, origin, destination}`. Triggers only fire for Moves, not Recalls (rule 451.1).
- The movement completion runs a Cleanup (rule 448) which handles Contested application, Showdown/Combat opening, and any follow-on triggers (rule 445-447).
- `at_start_of_combat` / `at_end_of_combat` may fire as a consequence of the Cleanup from the Move, not as direct move triggers.

#### 15.5 Handler notes

`move_unit`:
- `validate(ctx, op, source)`: unit exists and is on the Board; destination is a valid Location (both restrictions from 442.2 apply: mode-of-play-specific battlefield blockers, and combat-staged-battlefield blockers). If validation fails because destination is invalid but the unit is on the Board, do NOT reject - the rules (442.2.c) convert the invalid move into a Recall. The `validate` hook returns `{ok: true, substituteOp: { type: 'recall', unit, to: controllerBase } }` to let the dispatcher swap the op. This is similar to (but distinct from) a Replacement Effect.
- `execute`: updates `unit.location`, removes from origin's `presentUnits`, pushes to destination's `presentUnits`. Applies Contested if 445 applies. Emits `on_move` trigger fire via the event bus. Spawns a Cleanup request (rule 448). Temp mods stay intact (the unit never crossed a Non-Board zone).

`follow_movement`:
- Not a standalone move. It is an OBSERVER that reacts to a `MoveEvent` for another unit. Semantically it is a Triggered Ability (rule 382), not a Replacement Effect: it fires AFTER the primary move completes, adds a Pending Item to the Chain, and when that Item resolves it performs its own `move_unit` with destination = primary mover's new location.
- Proposed model: `follow_movement` installs an `on_move_other` observer when the unit enters the board. The observer predicate is `movedUnit.origin === self.location && friendly(self, movedUnit)`. On match, the observer produces a TriggerFire with a reflexive "I may be moved to the destination" effect. If the controller opts in (per the "I may be moved" wording), the reflexive op dispatches `move_unit(self, destination)`. If opts out, no-op.
- Validation gate: when the follow resolves, the destination might be invalid (combat staged there, etc.); in that case, per 442.2.c, the follower Recalls instead.
- Chaining: a `follow_movement` that causes its own Move fires another `on_move` event which can chain another `follow_movement`. To prevent infinite loops, the observer tags its produced Move events with the original `batch` id and skips re-entry for the same batch.

#### 15.6 Concrete examples

- SFD-041 Apprentice Smith: "When I move, reveal the top card of your Main Deck. If it's a gear, draw it. Otherwise, recycle it." This is `on_move` self-trigger (section 1 table) producing a reflexive reveal-then-conditional-draw-or-recycle. The `move_unit` op in the card's profile reflects the move being the trigger subject, not an op the card performs.
- SFD-050 Azir - Ascendant: "[Calm rune]: [Action] - Choose a unit you control. Move me to its location and it to my original location. If it's equipped, you may attach one of its Equipment to me. Use only once per turn." Activated ability with paired `move_unit` ops (swap). Both moves share a batch id so that `follow_movement` observers do not double-fire. Post-move, an optional `attach_gear` op transfers an Equipment from the target to Azir. The `[Calm rune]` cost is a unique cost (a tapped-rune payment); the once-per-turn budget is enforced via `onceThisTurnUsed[azir-swap]`.
- OGN-177 Stealthy Pursuer: "When a friendly unit moves from my location, I may be moved with it." Textbook `follow_movement`. Observer predicate: `movedUnit.origin === self.location && movedUnit.controller === self.controller && movedUnit !== self`. Action: reflexive opt-in move of self to `movedUnit.destination`. Variant card OGN-177-P has the same text.
- SFD-109 Akshan - Mischievous (re-use): "move an enemy gear to your base" - `move_unit` on a Gear? Rule 442.3 says only Units can Move. This is not a Move; it is a `recall`-shaped relocation dressed in move language, or a zone-transition. Phase 2b must decode: the correct op is `recall_permanent` with destination = controller's Base, because Gear cannot Move. The `move_unit` label in the data is inaccurate for this case. Flag in the dispatcher with a test.

Open question for Phase 2b: the CSV's `move_unit` count (86) includes cards like SFD-109 where Gear is the subject. Before wiring handlers, re-label those entries to `recall_permanent` or add a Gear-specific move variant that internally dispatches to the recall path. Do not implement a generic "move any permanent" op - rule 442.3 forbids it.

### 16. Runes + resources

Covers: `channel_rune` (38), `rune_resource` (26), `gain_resource` (47).

#### 16.1 Rules anchor

- Rule 159-163: Runes. A Card Type (160), not a Main Deck card (160.1), not a Permanent (160.1.a). Kept in the Rune Deck (160.2); exactly 12 per deck (160.2.a). Recycled back to the Rune Deck, not the Main Deck (160.2.b).
- Rule 161-162: Runes produce Energy and Power. Energy has no domain (162.1.a); Power is domain-typed (162.2.a). Universal Power exists and pays any domain (162.2.b).
- Rule 163.2: Basic Runes have `[E]: [Reaction] - Add [1]` and `Recycle this: [Reaction] - Add [C]`.
- Rule 164-166: Rune Pool. A conceptual collection of Energy + Power available to pay Costs. Empties at end of Draw Phase and end of Turn (166). Unspent resources are lost.
- Rule 315.3: Channel Phase. Turn Player channels 2 runes from Rune Deck.
- Rule 315.4.d: Rune Pool empties at end of Draw Phase.
- Rule 317.2.d: Rune Pool also empties in Expiration Step at end of Turn.
- Rule 416.1.b: Recycle a rune to Rune Deck bottom.
- Rule 429: Add action. Spells/triggered/activated abilities that Add resources finalize immediately (429.2); do not pass Priority/Focus (429.2.a); Reaction-tagged Add abilities can be activated during Pay Costs step of another spell (429.3). Also see section 10.2.
- Rule 430: Channel action. Takes top N runes of a player's Rune Deck and puts them on the Board. May specify entry state (e.g., `Channel 1 rune exhausted`, 430.2).

#### 16.2 Ops in this subsystem

- `channel_rune` (38) - any card that instructs a player to Channel runes (outside the Beginning-of-Turn automatic channel).
- `rune_resource` (26) - the Rune-card-intrinsic "I produce Energy/Power" ability. Not a game action; a modeling tag on the card itself.
- `gain_resource` (47) - any card that Adds Energy or Power directly to a Rune Pool without first channeling a rune (e.g., "Add [1]", "Add [C]").

#### 16.3 State shape

Runes live in a dedicated Rune Deck zone (already in `EngineCtx.zones.runeDecks`) and, when channeled, on the Board at their controller's Base (rule 430.1). Runes are not Permanents (rule 160.1.a), so they are stored separately from unit/gear instances despite also being on-board Board objects.

```ts
interface EngineCtx {
  // ...existing...
  zones: {
    // ...existing...
    runeDecks: Record<PlayerId, CardInstance[]>;  // already exists
    runesOnBoard: Record<PlayerId, RuneInstance[]>;
  };
}

interface RuneInstance {
  instanceId: string;
  cardId: string;                   // e.g., "body-rune"
  domain: Domain | null;            // null only if the rune is a hypothetical domainless rune
  controller: PlayerId;
  owner: PlayerId;
  exhausted: boolean;               // rune entered ready per default; or exhausted per 430.2 modifier
  isChanneled: true;                // a channeled rune is on Board; distinguishes from Rune Deck copies
}

interface PlayerState {
  // ...existing...
  runePool: {
    energy: number;
    power: Record<Domain | 'universal', number>;
  };
}
```

Channeling is NOT a Cost in the general sense. It is a Limited Action performed when a Game Effect instructs it (rule 430.3). The "Channeling cost" printed on Main Deck cards is the card's cost to be paid from Rune-Pool resources, not a payment made with rune-instances directly. The player gets resources into the pool by Exhausting (tapping) channeled runes via their `[E]: Add [1]` activated ability (rule 163.2.a), or by Recycling a channeled rune via `Recycle this: Add [C]` (rule 163.2.b). The flow is:

```
Channel (action)     : RuneDeck -> runesOnBoard
Exhaust + Add (429)  : runesOnBoard[rune].exhausted = true  AND  runePool.energy += 1 (or power+=1)
Play a spell (349)   : runePool drains during Pay Costs step
Draw Phase end / EOT : runePool empties (rule 166)
```

Resources ARE typed. Energy is generic; Power carries a Domain label matching the producing rune (rule 162.2.a.1). A cost like `[2][C][G]` requires 2 Energy + 1 universal-or-any-domain Power + 1 Calm Power. `[C]` Power from a Recycle-this ability matches the rune's own domain (rule 163.2.b.1). Universal Power (rule 162.2.b) is modeled as `domain: 'universal'` and can satisfy any domain requirement.

#### 16.4 Key triggers

- `on_channel` (rule 430, already in section 1 table) fires after a rune enters the Board from the Rune Deck. Payload: `{runeInstanceId, controller, enteredExhausted}`.
- `gain_resource` does NOT fire an `on_channel` - it bypasses the Channel step entirely. If a card needs to trigger on Add, the trigger type is `on_add_resource` (not in section 1's table; flagged for addition in Phase 2b if any card needs it - current survey shows none).
- `rune_resource` is not a trigger; it is an intrinsic activated ability on every Rune card.

#### 16.5 Handler notes

`channel_rune`:
- `validate(ctx, op, source)`: the player's Rune Deck has at least `op.count` cards. Per rule 315.3.b.1, if fewer, channel as many as possible - so validate as `{ok: true, effectiveCount: min(op.count, runeDeck.length)}`. If `op.requireSpecificDomain` is set (no current printed card does this, but syntactically supported), the next-N runes must satisfy the predicate; if not, partial-follow per rule 431.1.c.
- `execute`: moves the top `effectiveCount` runes from `runeDecks[player]` to `runesOnBoard[player]`. Applies entry-state modifier (default ready; `exhausted` if `op.enteredExhausted` is true per 430.2). Emits one `on_channel` trigger fire per rune. Does NOT auto-add to `runePool` - that requires a separate Exhaust + Add activation.
- Channel does not directly produce resources. A card that says "Channel 1 rune and add [1]" translates to two ops: `channel_rune` + `gain_resource(energy=1)`.

`rune_resource`:
- Not a dispatcher target. It is a data-layer tag that the Rune card's intrinsic abilities (`[E]: Add [1]` and `Recycle this: Add [C]`) are registered as activated abilities on every Rune instance. These abilities dispatch to the general `gain_resource` handler when activated.
- Recommendation: remove `rune_resource` from the dispatcher op table entirely; it's a classification label, not an op. Phase 2b engineer: strip it from `operations[]` during dispatcher build or route it as a no-op with a diagnostic log.

`gain_resource`:
- `validate`: always `ok` unless the engine is in a state that forbids resource adds (none currently known; rule 429.4.a says only when Game Effects direct).
- `execute`: mutates `ctx.players[playerIdx].runePool`. Increments `energy` or `power[domain]` by `op.amount`. Triggers the `on_add_resource` hook if registered (see 16.4). Immediately finalizes per rule 429.2.a - no priority pass.
- Timing window: if activated as a Reaction during another spell's Pay Costs step (rule 429.3), the handler must not enqueue onto the Chain; instead it synchronously updates `runePool` and returns. The dispatcher identifies this case by checking `ctx.turnState.payCostsInProgress === true`.

#### 16.6 Concrete examples

- OGN-126 Body Rune: intrinsic abilities `[E]: Add [1]` (Energy) and `Recycle this: Add [Y]` (1 Body Power). Both are `gain_resource` ops. `rune_resource` is the classification tag; the card itself has no printed effect text.
- OGN-088 Mega-Mech: labeled `rune_resource` in the CSV but it's a 7-cost unit with no effect text. This is an ETL classification artifact - `rune_resource` shows up because the card references runes obliquely (the Mech tag, or the cost has rune symbols). Flag for Phase 2b: the enricher should not tag non-Rune cards with `rune_resource`. Handler-side, treat as no-op.
- OGN-230 Albus Ferros: "When you play me, spend any number of buffs. For each buff spent, channel 1 rune exhausted." Op sequence from the on-play trigger's Chain Item: enter a player choice loop consuming `N` friendly buff counters, then `channel_rune(count=N, enteredExhausted=true)`. The "spend a buff" cost is a non-standard cost paid at resolution (rule 355.10.c.1). Each channeled rune fires an `on_channel` - in APNAP batches if triggers exist.
- SFD-224 Aphelios - Exalted (re-use from section 14): one mode is "Channel 1 rune exhausted." - straight `channel_rune(count=1, enteredExhausted=true)`. Another mode is "Ready 2 runes." - that is `ready` op with target scope `runesOnBoard`, NOT a channel.
- SFD-049 (referenced in CSV as both channel_rune and gain_resource example): typical pattern is "Channel 1 rune. Add [1]." which is `channel_rune(1) + gain_resource(energy=1)`. They are distinct ops that share a producing card.

Open question for Phase 2b: should Exhaust-a-rune-to-Add be modeled as a single `gain_resource` op (with an `exhaustCost` field) or as two ops (`exhaust_permanent` + `gain_resource`)? Recommendation: two ops. The Exhaust is a payment that can independently fail (if the rune is already exhausted), and keeping them separate lets replacement effects intercept either in isolation. Same argument applies to Recycle-this-for-[C].

### 17. Priority manipulation

Covers: `manipulate_priority` (146).

#### 17.1 Rules anchor

- Rule 311-313: Priority and Focus. Priority is the singular exclusive right to take Discretionary Actions (312.1). A player receives Priority in specific windows: Main Phase Neutral Open (312.2.a), gaining Focus during a Showdown (312.2.b), controlling the next Chain item in a Closed state (312.2.c), or being next-in-turn-order during a Closed state on pass (312.2.d). Focus is the Showdown-state analog (313).
- Rule 339-348: Priority passing, Focus passing, Showdown open/close.
- Rule 346.1: Focus does NOT pass when the Initial Chain opened from a triggered ability resolves. Engine special-case.
- Rule 806: Action keyword - permits a card/ability to be played in a Showdown Open state during the controller's own Focus window.
- Rule 813: Reaction keyword - superset of Action; permits play during any open state, including during the resolution of another spell in the Pay Costs step (rule 429.3 for Add abilities).
- Rule 429.2.a: Add abilities do not pass Priority or Focus on finalize/resolve.
- Rule 459.2.d-g: Combat Chain ordering. Attacker (with Focus) places triggered abilities first, then non-defender players in Turn Order, then Defender. Focus does not pass on Combat Chain closure (459.2.g).

#### 17.2 Ops in this subsystem

- `manipulate_priority` (146) - the broadest Riftbound-specific op. High volume because the data's ETL uses it as a catch-all marker for any card that interacts with the Action/Reaction timing system. The spec must define it precisely so the dispatcher does not become a gutter.

Note: the core rules PDF does not define a rule called "manipulate_priority." This is a data-layer convention from `effect-ops-frequency.csv`. The spec below proposes a reasonable model derived from inspecting the example cards and is explicit about that fact.

#### 17.3 Sub-variants observed in card data

From sampling the example IDs (OGN-179, SFD-001, SFD-117, SFD-200, SFD-050) and scanning the broader pool, `manipulate_priority` collapses several behaviors that do NOT share a uniform mechanical shape:

1. `action_tagged` - card has `[Action]` keyword, which merely widens playable windows to include Showdown Open (rule 806). No engine-visible "priority manipulation" beyond keyword gating during `canPlay` checks. Example: OGN-179 Acceptable Losses, SFD-200 Arcane Shift.
2. `reaction_tagged` - card has `[Reaction]` keyword (rule 813). Example: SFD-001 Against the Odds, SFD-117 Ancient Henge.
3. `add_reaction` - the card is an Add ability tagged Reaction, subject to rule 429.3 (can be activated during Pay Costs of another spell). Example: SFD-117 Ancient Henge (`[E]: [Reaction] - Pay any amount of Energy to [Add] that much rainbow`).
4. `takes_focus` - card causes Focus to change hands. Rare; mostly not printed in current set.
5. `extra_action` - card gives its controller an extra Discretionary Action in the current window. Rare.
6. `once_per_turn_budget` - card text like "Use only once per turn" consuming `onceThisTurnUsed` (rule 371). Example: SFD-050 Azir swap ability. This is NOT priority manipulation per se; it's a budget counter. Data-layer mis-labels it as such because the restriction appears adjacent to a `[Action]` tag.

In practice, 90%+ of cards tagged `manipulate_priority` fall into variants 1-3 and are fully served by the existing keyword metadata (section 11.1 table rows for Action 806 and Reaction 813). The card's text-level behavior is actually one of the other ops; `manipulate_priority` is only a classification label reflecting "this card interacts with the timing system."

#### 17.4 Interaction with HOT FEPR (section 3)

Every variant above affects WHEN a card can enter the HOT FEPR loop, not the loop's mechanics:

- `action_tagged` / `reaction_tagged`: affects the `canPlay` predicate. When the dispatcher asks "may this player play this card now?", the predicate consults the card's keyword list and the current `turnState.mode`. No op execution.
- `add_reaction`: affects the `canActivate` predicate AND enables a synchronous path during another spell's Pay Costs (rule 429.3). The `gain_resource` handler already handles the synchronous path; the priority layer only needs to allow entry.
- `takes_focus` / `extra_action` (rare): these are the only true priority-manipulation variants that need a dedicated handler. They modify `ctx.priorityHolder` or `ctx.focusHolder` directly and schedule a Cleanup. The HOT FEPR loop reads those fields at the top of each iteration, so the manipulation takes effect on the very next pass.

Critically, none of the variants break the HOT FEPR invariants: the Chain itself is untouched by a priority manipulation; only the holder of the permission-to-act changes. Resolution order, APNAP ordering of triggers, and LIFO Chain resolution are unaffected.

#### 17.5 Proposed single op shape

```ts
type PriorityVariant =
  | 'action_tagged'          // permits play in Showdown Open (Action keyword, rule 806). Data-layer marker; no execute-time work.
  | 'reaction_tagged'        // permits play any open state (Reaction keyword, rule 813). Data-layer marker.
  | 'add_reaction'           // Reaction-tagged Add ability; activatable during Pay Costs (rule 429.3).
  | 'take_focus'             // force Focus (and therefore Priority) to a specific player during a Showdown.
  | 'grant_priority'         // grant Priority to a player outside the normal pass flow (Closed state).
  | 'extra_action'           // grant one additional Discretionary Action to the controller in the current Main Phase window.
  | 'skip_priority_pass';    // consume the opponent's upcoming priority window without them acting. Not observed in current set; included for future-proofing.

interface ManipulatePriorityOp {
  type: 'manipulate_priority';
  variant: PriorityVariant;
  targetPlayer?: PlayerId;           // for take_focus, grant_priority, skip_priority_pass
  windowScope?: 'this_chain' | 'this_showdown' | 'this_turn';  // duration of the effect
}
```

The `validate` hook:
- `action_tagged` / `reaction_tagged` / `add_reaction`: always `ok` at execute-time; they should have been consumed during the `canPlay` / `canActivate` checks and never actually dispatched as ops. If the dispatcher receives one, log `PRIORITY_TAG_DISPATCHED_AS_OP` and no-op. These variants exist in the type for data-round-trip fidelity only.
- `take_focus` / `grant_priority`: the current `turnState.mode` must permit the requested transfer. A `take_focus` is illegal outside a Showdown state; return `ok: false` with reason `not_in_showdown`.
- `extra_action`: only legal during your own Main Phase Neutral Open.
- `skip_priority_pass`: only legal during Closed state with Priority held by the source's controller.

The `execute` hook:
- `action_tagged` / `reaction_tagged` / `add_reaction`: no-op (see above).
- `take_focus`: patch `ctx.focusHolder = targetPlayer` and `ctx.priorityHolder = targetPlayer` (rule 313.2). Schedule a Cleanup.
- `grant_priority`: patch `ctx.priorityHolder = targetPlayer`. Do NOT touch focus (leaves Focus with its current holder).
- `extra_action`: increments a `ctx.turnState.extraActionsGrantedTo[targetPlayer]` counter. The Main Phase loop checks this counter when deciding whether to advance to Ending Phase.
- `skip_priority_pass`: increments a `ctx.turnState.skipPriorityPasses[targetPlayer]` counter. The Priority-pass logic decrements this counter instead of transferring when appropriate.

#### 17.6 Concrete examples

- OGN-179 Acceptable Losses ("[Action] ... Each player kills one of their gear"): variant `action_tagged`. The op in the data reflects the [Action] tag; the real work is `kill_permanent` per player. Dispatcher: consume the [Action] tag at canPlay time, do NOT dispatch `manipulate_priority` at resolve time.
- SFD-001 Against the Odds ("[Reaction] ... Give a friendly unit at a battlefield +2 Might this turn for each enemy unit there"): variant `reaction_tagged`. Real work is `modify_stats` with a count-dependent magnitude. Keyword consumed at canPlay time.
- SFD-117 Ancient Henge ("[Exhaust]: [Reaction] - Pay any amount of Energy to [Add] that much rainbow"): variant `add_reaction`. Activated ability with Reaction tag feeding into a `gain_resource` op. Rule 429.3 permits activation during another spell's Pay Costs.
- SFD-050 Azir - Ascendant ("[Calm rune]: [Action] - ... Use only once per turn"): variant `action_tagged` for the timing permission; the "once per turn" clause is `onceThisTurnUsed` budget, not priority manipulation. Two independent mechanics stapled together in the data label.
- SFD-200 Arcane Shift ("[Action] ... Banish a friendly unit, then its owner plays it, ignoring its cost. Deal 3 to an enemy unit. Banish this."): variant `action_tagged`. The real op chain is `banish` -> `play_from_zone` (with `ignoreCost: true`) -> `deal_damage` -> `banish` (self). None of that involves mutating priority.

Open question for Phase 2b: `manipulate_priority` (146 cards) is the single largest catch-all in the frequency CSV. Recommendation is that the dispatcher does NOT register a primary handler for variants 1-3 and instead strips them from `operations[]` at catalog-build time (moving the timing tag into a separate `timingTags` field on the card record). This collapses `manipulate_priority`'s effective volume from 146 to the handful of cards using variants 4-7. Confirm with the Data Analyst that re-running the enricher with this flattening produces a frequency delta consistent with this expectation before wiring handlers.

### 18. RiftboundOp type extensions

These extend the Phase 1 `EffectOp` union (section 12). All op shapes below are dispatched through the same `runOp` pipeline and respect the `ReplacementRegistry` pre-check in section 12.1.

```ts
// Primitives
export type BattlefieldId = string;
export type InstanceId = string;
export type PlayerId = string;
export type Domain = 'fury' | 'calm' | 'mind' | 'body' | 'chaos' | 'order';

export type Location =
  | { kind: 'battlefield'; battlefieldId: BattlefieldId }
  | { kind: 'base'; player: PlayerId };

// Op union extension
export type RiftboundOp =
  // Section 13 - Battlefields + Scoring
  | {
      type: 'control_battlefield';
      battlefieldId: BattlefieldId;
      mode: 'gain' | 'contest' | 'lose';
      forPlayer: PlayerId;                  // the player whose control is being mutated
    }
  | {
      type: 'scoring';
      player: PlayerId;
      battlefieldId: BattlefieldId | null;  // null when the score is effect-driven and not tied to a battlefield
      reason: 'conquer' | 'hold' | 'effect';
      amount: number;                        // almost always 1 per rule 466.1; effect-driven can be higher
    }
  | {
      type: 'scoring_restriction';
      // Registration op. Installed when a source enters the board; removed when it leaves.
      // Does not mutate score state; publishes a predicate into ctx.scoringRestrictions.
      source: InstanceId;
      predicateKind:
        | 'per_battlefield_turn_gate'       // SFD-209
        | 'per_player_while_present'        // SFD-060
        | 'custom';
      predicatePayload: unknown;             // compiled from card text
    }

  // Section 14 - Gear attachment
  | {
      type: 'attach_gear';
      gearInstance: InstanceId;
      target: InstanceId;
      reason: 'equip_activation' | 'weaponmaster' | 'quickdraw' | 'card_effect';
      detachFromPrior?: InstanceId;          // set when re-attaching from an existing top-most card (434.1.f)
    }
  | {
      type: 'equip_trigger';
      // Registration op for an equip-triggered ability. Same shape concept as scoring_restriction.
      source: InstanceId;
      predicate:
        | { kind: 'when_equipped_to_me' }                                // SFD-224
        | { kind: 'when_i_equip_something' }                             // generic weaponmaster cascade
        | { kind: 'when_any_equipment_attached'; scope: 'friendly' | 'any' };
    }

  // Section 15 - Positional movement
  | {
      type: 'move_unit';
      unit: InstanceId;
      to: Location;
      reason: 'standard_move' | 'ganking' | 'card_effect' | 'combat_cleanup';
      batchId?: string;                      // shared across simultaneous moves; follow_movement uses this to dedupe
    }
  | {
      type: 'follow_movement';
      // Registration op. Installs an on_move_other observer for the given unit.
      source: InstanceId;                    // the follower
      trigger: {
        originMatch: 'self_location';        // only observed variant: move from my current location
        controllerMatch: 'friendly';         // only observed variant: a friendly unit
      };
      action: 'may_follow';                  // the follower may opt in; reflexive
    }

  // Section 16 - Runes + resources
  | {
      type: 'channel_rune';
      player: PlayerId;
      count: number;                         // effective count clamped to runeDeck.length per 315.3.b.1
      enteredExhausted?: boolean;            // 430.2 modifier; default false (enters ready)
      predicate?: { domain?: Domain };       // rare; for "channel N Fury runes" style (no current printed use)
    }
  | {
      // Classification-only marker. The dispatcher should strip this at catalog build.
      // Included for round-trip with the frequency CSV; execute is a no-op with a diagnostic.
      type: 'rune_resource';
      runeCardId: string;
    }
  | {
      type: 'gain_resource';
      player: PlayerId;
      kind: 'energy' | 'power';
      domain?: Domain | 'universal';         // required when kind === 'power'
      amount: number;
      synchronous?: boolean;                 // true when activated under rule 429.3 Pay-Costs-step fast path
    }

  // Section 17 - Priority manipulation
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
      targetPlayer?: PlayerId;               // required for variants take_focus, grant_priority, extra_action, skip_priority_pass
      windowScope?: 'this_chain' | 'this_showdown' | 'this_turn';
    }
  ;

// Extend the Phase 1 EffectOp union
export type EffectOp = /* existing Phase 1 variants */ | RiftboundOp;
```

Validation pre-contract for Phase 2b handlers (each handler implements these or explicitly declares them trivial):

- Every op above must implement `validate`. The three registration-only ops (`scoring_restriction`, `equip_trigger`, `follow_movement`) validate that the source is on the Board in a zone that permits registration.
- `execute` must not mutate `ctx`; it returns patches. Follow the OpResult shape in section 12.
- Where this section noted "emit a Cleanup", that means pushing a cleanup task onto the outstanding-tasks queue (section 5.3), not running the Cleanup inline.
- Where this section noted "emit a trigger fire", that means appending a `TriggerFire` to `OpResult.triggeredAbilities` for the outer engine to APNAP-order (section 1.3).
