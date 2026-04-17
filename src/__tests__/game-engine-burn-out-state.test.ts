/**
 * Burn Out as State (Fix #2) - Skeleton Tests
 *
 * Current behavior: `drawCards` at src/game-engine.ts:3808-3820 calls `burnOut`
 * the moment a player tries to draw from an empty deck, which immediately ends
 * the game via `endGame(opponent, player, 'burn_out')` at src/game-engine.ts:3863.
 * Gap: rules distinguish between REQUIRED draws (draw step, mandatory "draw N"
 * effects) and OPTIONAL draws ("you may draw"). Only required draws on an empty
 * deck should end the game. Empty deck alone is not a loss condition.
 *
 * After the fix:
 *  - drawCards should accept a `required: boolean` flag (or a new signature)
 *  - empty deck + required draw  -> player loses (same end-game path as today)
 *  - empty deck + optional draw  -> no loss; draw silently yields 0 cards
 *  - `PlayerState.burnedOut: boolean` is exposed for the UI and is sticky once
 *    the deck is emptied (even before a loss triggers)
 *  - Player at 0 cards with no pending required draw -> game continues
 *
 * Coverage notes:
 *  - Assumes the fix adds `burnedOut` to PlayerState in src/game-engine.ts:162+.
 *  - Assumes draw_cards effect operation distinguishes may-draw vs must-draw;
 *    the text parser / operation schema change is the backend eng's call.
 *
 * TODO(backend eng): fill in assertions + helpers once the API lands.
 */
import {
  RiftboundGameEngine,
  GameStatus,
  Card
} from '../game-engine';
import {
  createInProgressEngine,
  resetCardCounter
} from './test-helpers';

beforeEach(() => {
  resetCardCounter();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Force the current player's deck to empty so the next draw has nothing left.
 * Mutates engine state in place (test-only).
 */
function emptyCurrentPlayerDeck(engine: RiftboundGameEngine): void {
  const state = engine.getGameState();
  const current = state.players[state.currentPlayerIndex];
  current.deck.length = 0;
}

function getPlayer(engine: RiftboundGameEngine, playerId: string) {
  return engine.getGameState().players.find((p) => p.playerId === playerId)!;
}

// ---------------------------------------------------------------------------
// Required draw on empty deck -> loss
// ---------------------------------------------------------------------------
describe('Burn Out - required draw triggers loss', () => {
  it('ends the game when the draw-step draw finds an empty deck', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    emptyCurrentPlayerDeck(engine);

    // Action: end turn so the opponent enters their beginning phase and draws.
    // Then end their turn too so the original player faces the mandatory draw
    // step with an empty deck.
    // TODO(backend eng): simplest harness = call the internal draw-step path,
    // OR cycle endTurn until the emptied player's BEGIN/DRAW fires.

    // Expected:
    //   - engine.status === GameStatus.WINNER_DETERMINED
    //   - matchResult.reason === 'burn_out'
    //   - matchResult.loser === the emptied player
    //   - emptied player's burnedOut flag is true
    //
    //   expect(engine.status).toBe(GameStatus.WINNER_DETERMINED);
    //   const result = engine.getMatchResult()!;
    //   expect(result.reason).toBe('burn_out');
  });

  it('ends the game on a mandatory "draw N" spell effect when deck is empty', () => {
    // Setup: give current player a spell whose text reads "draw 2 cards" (not "may").
    // Empty their deck. Cast the spell.
    // Expected: burn_out fires because the draw is required.
    //
    // TODO(backend eng):
    //   - construct spell via makeSpell({ text: 'Draw 2 cards.', ... })
    //   - inject into hand, play it
    //   - expect(engine.status).toBe(GameStatus.WINNER_DETERMINED)
  });

  it('sets burnedOut = true on the losing player in the final state', () => {
    // TODO(backend eng): once required draw triggers loss,
    //   expect(getPlayer(engine, loserId).burnedOut).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Optional draw on empty deck -> NO loss
// ---------------------------------------------------------------------------
describe('Burn Out - optional draw does NOT trigger loss', () => {
  it('a "you may draw" effect on empty deck yields 0 cards and does not end the game', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    emptyCurrentPlayerDeck(engine);

    // Setup: cast/trigger an optional draw effect ("you may draw a card").
    // TODO(backend eng): construct a spell with text like "You may draw a card."
    //   or call the effect operation directly with { required: false }.

    // Expected:
    //   - engine.status remains IN_PROGRESS
    //   - hand size unchanged (0 cards drawn)
    //   - no burn_out entry in scoreLog
    //   - burnedOut flag MAY be true (deck is empty) but game has not ended
    //
    //   expect(engine.status).toBe(GameStatus.IN_PROGRESS);
    //   expect(getPlayer(engine, pid).hand.length).toBe(handSizeBefore);
  });

  it('repeated optional draws on empty deck never escalate to a loss', () => {
    // TODO(backend eng): fire 5 optional draws back-to-back; game stays IN_PROGRESS.
  });
});

// ---------------------------------------------------------------------------
// burnedOut flag exposure
// ---------------------------------------------------------------------------
describe('Burn Out - burnedOut flag exposed on PlayerState', () => {
  it('burnedOut is false by default at game start', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const state = engine.getGameState();
    // TODO(backend eng):
    //   expect(state.players[0].burnedOut).toBe(false);
    //   expect(state.players[1].burnedOut).toBe(false);
  });

  it('burnedOut flips to true the first time deck hits 0 (even before a required draw fails)', () => {
    // Setup: empty a player's deck via mill / discard to deck (not a required draw).
    // Expected: burnedOut = true, game still IN_PROGRESS.
    //
    // TODO(backend eng): confirm with backend eng whether burnedOut flips on
    //   "deck became empty" or only on the first required draw attempt.
    //   The ticket says "expose a burnedOut flag for UI" - picking "deck empty"
    //   is the most useful UI signal (shows "danger" state before the loss).
  });

  it('burnedOut is included in the serialized state so restore preserves it', () => {
    // TODO(backend eng): after burnedOut flips, serialize + fromSerializedState,
    //   and assert the flag round-trips.
  });
});

// ---------------------------------------------------------------------------
// Zero-card hand with no pending draw -> no loss
// ---------------------------------------------------------------------------
describe('Burn Out - 0 cards without required draw does not lose', () => {
  it('a player at 0 cards in hand AND 0 cards in deck stays alive until a required draw fires', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    emptyCurrentPlayerDeck(engine);
    const state = engine.getGameState();
    const current = state.players[state.currentPlayerIndex];
    current.hand.length = 0;

    // Expected: game is still IN_PROGRESS; the loss only triggers when the
    // next required draw is attempted (typically next turn's draw step).
    //
    // TODO(backend eng):
    //   expect(engine.status).toBe(GameStatus.IN_PROGRESS);
  });
});
