/**
 * Replay reducer fixture — `activate_ability` (champion / permanent ability
 * activation).
 *
 * Motivation
 * ----------
 * The QA audit dated 2026-04-17 observed ZERO `activate_ability` moves across
 * 10 self-play matches, so the reducer branch at
 * lib/replay/reducer.ts:505 has no real-game coverage.
 *
 * Contract under test
 * -------------------
 * Per the reducer's documented behavior, `activate_ability`:
 *   1. Does NOT move the card between zones. The ability fires in place.
 *   2. DOES update `turnNumber`, `currentPhase`, and `currentPlayerIndex`
 *      from the move metadata (applied at the top of `applyMoveForward`).
 *   3. DOES surface `replayHighlight` metadata on the returned state so the
 *      GameBoard can pulse the source card.
 *
 * See `lib/replay/reducer.ts:505-512` for the reducer case this test covers.
 *
 * Hermetic fixture
 * ----------------
 * See adjacent `replay-reducer-hidden-card.test.ts` header — same reasoning.
 * The mirrored reducer surface lives in `./replay-reducer-fixture.ts`.
 */
import {
  stateAtMove,
  type ReplayMove,
  type ReplaySpectatorState,
} from './replay-reducer-fixture';

const CHAMPION_ID = 'champion-akshan';
const PLAYER_ID = 'player-caster';
const OPPONENT_ID = 'player-victim';

const makeInitialState = (): ReplaySpectatorState => ({
  matchId: 'test-activate-ability-match',
  status: 'in_progress',
  currentPhase: 'main_1',
  turnNumber: 1,
  currentPlayerIndex: 0,
  players: [
    {
      playerId: PLAYER_ID,
      name: 'Ability User',
      hand: [],
      board: {
        creatures: [
          {
            cardId: CHAMPION_ID,
            instanceId: CHAMPION_ID,
            name: 'Akshan, the Rogue Sentinel',
            type: 'creature',
            slug: CHAMPION_ID,
            isTapped: false,
            power: 3,
            toughness: 3,
            // Location matters — ability-activation must not clobber it.
            location: {
              zone: 'battlefield',
              battlefieldId: 'bf-skirmish-peak',
            },
          },
        ],
        artifacts: [],
        enchantments: [],
      },
      graveyard: [],
      exile: [],
      // championLegend reference at the player slot — the reducer should
      // leave this untouched when the corresponding ability activates.
      championLegend: {
        cardId: CHAMPION_ID,
        instanceId: CHAMPION_ID,
        name: 'Akshan, the Rogue Sentinel',
        type: 'creature',
        slug: CHAMPION_ID,
      },
    } as any,
    {
      playerId: OPPONENT_ID,
      name: 'Opponent',
      hand: [],
      board: { creatures: [], artifacts: [], enchantments: [] },
      graveyard: [],
      exile: [],
    },
  ],
  battlefields: [],
});

const moves: ReplayMove[] = [
  {
    playerIndex: 0,
    turn: 2,
    phase: 'main_2',
    action: 'activate_ability',
    cardId: CHAMPION_ID,
  },
];

describe('replay reducer — activate_ability', () => {
  it('initial state (move 0) leaves the champion on board, untapped', () => {
    const state = stateAtMove(makeInitialState(), moves, 0);
    const actor = state.players[0]!;
    const creatures = actor.board!.creatures!;
    expect(creatures).toHaveLength(1);
    expect(creatures[0]!.cardId).toBe(CHAMPION_ID);
    expect(creatures[0]!.isTapped).toBe(false);
    // Highlight cleared at move 0 (no prior action).
    expect((state as any).replayHighlight).toBeNull();
  });

  it('after activate_ability: card stays on board, location preserved, zones unchanged', () => {
    const state = stateAtMove(makeInitialState(), moves, 1);
    const actor = state.players[0]!;

    // The champion did NOT leave the battlefield.
    expect(actor.board!.creatures).toHaveLength(1);
    expect(actor.board!.artifacts).toHaveLength(0);
    expect(actor.board!.enchantments).toHaveLength(0);
    expect(actor.graveyard).toHaveLength(0);
    expect(actor.exile).toHaveLength(0);
    expect(actor.hand).toHaveLength(0);

    const champion = actor.board!.creatures![0]!;
    expect(champion.cardId).toBe(CHAMPION_ID);
    // Location must be preserved — this is the reducer's explicit contract
    // for ability activation (no zone transition).
    expect(champion.location).toEqual({
      zone: 'battlefield',
      battlefieldId: 'bf-skirmish-peak',
    });

    // Champion legend reference untouched.
    expect((actor as any).championLegend.cardId).toBe(CHAMPION_ID);
  });

  it('after activate_ability: turn / phase / currentPlayerIndex advance from move metadata', () => {
    const state = stateAtMove(makeInitialState(), moves, 1);
    expect(state.turnNumber).toBe(2);
    expect(state.currentPhase).toBe('main_2');
    expect(state.currentPlayerIndex).toBe(0);
  });

  it('after activate_ability: replayHighlight surfaces the source cardId + action', () => {
    const state = stateAtMove(makeInitialState(), moves, 1) as any;
    expect(state.replayHighlight).toEqual({
      cardId: CHAMPION_ID,
      action: 'activate_ability',
      targetId: null,
    });
  });

  it('scrubbing back to move 0 clears the highlight but keeps board state stable', () => {
    // Simulate the UI scrubbing the slider back to the start after activating.
    const beforeState = stateAtMove(makeInitialState(), moves, 0);
    const afterState = stateAtMove(makeInitialState(), moves, 1);

    // Board state is unchanged between move 0 and move 1 for activate_ability
    // (no zone transition). Only turn/phase/highlight change.
    expect(beforeState.players[0]!.board!.creatures).toHaveLength(1);
    expect(afterState.players[0]!.board!.creatures).toHaveLength(1);
    expect(beforeState.players[0]!.board!.creatures![0]!.cardId).toBe(
      afterState.players[0]!.board!.creatures![0]!.cardId
    );
    expect((beforeState as any).replayHighlight).toBeNull();
    expect((afterState as any).replayHighlight).not.toBeNull();
  });
});
