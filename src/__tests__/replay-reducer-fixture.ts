/**
 * Replay-reducer test fixture — a hermetic, backend-local mirror of the
 * frontend replay reducer at:
 *
 *     riftbound-online/lib/replay/reducer.ts
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The QA audit dated 2026-04-17 flagged that the frontend replay reducer has
 * uncovered branches for `hide_card`, `activate_hidden`, and `activate_ability`
 * because self-play never emits those actions. Jest lives in this backend
 * repo, while the reducer lives in the frontend repo. Importing across repos
 * trips the backend's tsc rootDir check.
 *
 * Rather than destabilise the backend's build settings, we mirror the exact
 * subset of the reducer needed to exercise the three audit-flagged actions
 * here. The mirror MUST stay functionally identical to the frontend reducer
 * for the actions we test — if the frontend reducer changes its contract for
 * these actions, update this fixture to match and re-run the tests.
 *
 * Source of truth: `/Users/miszion/workplace/riftbound-online/lib/replay/reducer.ts`.
 * Covered cases here: `hide_card`, `activate_hidden`, `activate_ability`,
 * plus the top-of-`applyMoveForward` turn/phase/currentPlayerIndex update,
 * and `stateAtMove`'s `replayHighlight` attachment.
 *
 * Intentional simplifications versus the real reducer:
 *   - No asset hydration (the real reducer back-fills `card.assets` from CDN
 *     slug). Irrelevant for the branches we cover; omitted to keep the fixture
 *     small.
 *   - No reverseMove path. `stateAtMove` always walks forward from a provided
 *     initial state, which is what our tests do.
 */

export type CardLike = { cardId?: string; instanceId?: string; [key: string]: any };

export type ReplayPlayer = {
  playerId: string;
  name?: string;
  hand?: any[];
  board?: {
    creatures?: any[];
    artifacts?: any[];
    enchantments?: any[];
  };
  graveyard?: any[];
  exile?: any[];
  victoryPoints?: number;
  [key: string]: any;
};

export type ReplayMove = {
  playerIndex?: number;
  turn?: number;
  phase?: string;
  action?: string;
  cardId?: string;
  targetId?: string;
  timestamp?: number;
};

export type ReplaySpectatorState = {
  matchId: string;
  status: string;
  currentPhase: string;
  turnNumber: number;
  currentPlayerIndex?: number | null;
  players: ReplayPlayer[];
  battlefields?: any[];
  moveHistory?: ReplayMove[];
  [key: string]: any;
};

const clone = <T>(value: T): T => {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
};

const boardZones: Array<'creatures' | 'artifacts' | 'enchantments'> = [
  'creatures',
  'artifacts',
  'enchantments',
];

const cardMatches = (cardId: string) => (card: CardLike) =>
  card?.cardId === cardId || card?.instanceId === cardId;

const pluckCardById = (
  player: ReplayPlayer,
  cardId: string
): CardLike | null => {
  const matches = cardMatches(cardId);
  if (Array.isArray(player.hand)) {
    const idx = player.hand.findIndex(matches);
    if (idx >= 0) return player.hand.splice(idx, 1)[0] ?? null;
  }
  if (player.board) {
    for (const zone of boardZones) {
      const list = player.board[zone];
      if (Array.isArray(list)) {
        const idx = list.findIndex(matches);
        if (idx >= 0) return list.splice(idx, 1)[0] ?? null;
      }
    }
  }
  for (const zoneKey of ['graveyard', 'exile'] as const) {
    const list = player[zoneKey];
    if (Array.isArray(list)) {
      const idx = list.findIndex(matches);
      if (idx >= 0) return list.splice(idx, 1)[0] ?? null;
    }
  }
  return null;
};

const ensurePlayer = (
  state: ReplaySpectatorState,
  index: number | undefined
): ReplayPlayer | null => {
  if (index === undefined || index === null) return null;
  return state.players?.[index] ?? null;
};

/**
 * Mirror of the frontend reducer's `applyMoveForward` for the three
 * audit-flagged actions plus the phase/turn update behavior.
 */
const applyMoveForward = (
  state: ReplaySpectatorState,
  move: ReplayMove
): void => {
  if (move.turn) state.turnNumber = move.turn;
  if (move.phase) state.currentPhase = move.phase;
  if (typeof move.playerIndex === 'number') {
    state.currentPlayerIndex = move.playerIndex;
  }

  const actor = ensurePlayer(state, move.playerIndex);
  if (!actor) return;

  const action = move.action;
  const cardId = move.cardId;
  const targetId = move.targetId;

  switch (action) {
    case 'hide_card': {
      if (!cardId) return;
      const card = pluckCardById(actor, cardId);
      if (!card) return;
      (card as any).hidden = true;
      (card as any).location = {
        zone: 'battlefield',
        battlefieldId: targetId ?? null,
      };
      actor.board = actor.board ?? {};
      const list = (actor.board.creatures = actor.board.creatures ?? []);
      list.push(card);
      break;
    }
    case 'activate_hidden': {
      if (!cardId) return;
      if (!actor.board) return;
      for (const zone of boardZones) {
        const list = actor.board[zone];
        if (!Array.isArray(list)) continue;
        const found = list.find(cardMatches(cardId));
        if (found) {
          (found as any).hidden = false;
          break;
        }
      }
      break;
    }
    case 'activate_ability': {
      // Ability activation has no zone change — the reducer only relies on
      // the turn/phase/currentPlayerIndex update applied above, plus the
      // replayHighlight metadata attached by stateAtMove.
      break;
    }
    default:
      break;
  }
};

/**
 * Mirror of the frontend reducer's `stateAtMove`. Walks forward from
 * `initialState` for `index` moves and attaches `replayHighlight`.
 */
export const stateAtMove = (
  initialState: ReplaySpectatorState,
  moves: ReplayMove[],
  index: number
): ReplaySpectatorState => {
  const state = clone(initialState);
  const clamped = Math.max(0, Math.min(index, moves.length));
  for (let i = 0; i < clamped; i += 1) {
    applyMoveForward(state, moves[i]!);
  }
  const lastMove = clamped > 0 ? moves[clamped - 1] : null;
  (state as any).replayHighlight = lastMove
    ? {
        cardId: lastMove.cardId ?? null,
        action: lastMove.action ?? null,
        targetId: lastMove.targetId ?? null,
      }
    : null;
  (state as any).moveHistory = moves.slice(0, clamped);
  return state;
};
