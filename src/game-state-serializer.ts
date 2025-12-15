import type {
  BoardCard,
  Card,
  GameState,
  PlayerState,
  PlayerBoard,
  RuneCard,
  TemporaryEffect
} from './game-engine';

export type PlayerVisibility = 'self' | 'opponent' | 'spectator';

interface SerializeGameStateOptions {
  viewerId?: string | null;
}

const toDate = (value?: number | null): Date | null => {
  if (!value && value !== 0) {
    return null;
  }
  try {
    return new Date(value);
  } catch {
    return null;
  }
};

const abilityLabels = (card: Card): string[] => {
  if (!card.abilities || card.abilities.length === 0) {
    return [];
  }
  return card.abilities
    .map((ability) => ability.name || ability.description || '')
    .filter((label): label is string => Boolean(label && label.trim().length > 0));
};

const isBoardCard = (card: Card | BoardCard): card is BoardCard => {
  return typeof (card as BoardCard).instanceId === 'string';
};

const serializeActivationState = (card: BoardCard) => {
  const state = card.activationState;
  if (!state) {
    return null;
  }

  return {
    cardId: state.cardId,
    isStateful: state.isStateful,
    active: state.active,
    lastChangedAt: toDate(state.lastChangedAt),
    history:
      state.history?.map((entry) => ({
        at: toDate(entry.at),
        reason: entry.reason,
        active: entry.active
      })) ?? []
  };
};

const serializeCardSnapshot = (card: Card | BoardCard) => {
  const base = {
    cardId: card.id,
    instanceId: isBoardCard(card) ? card.instanceId : null,
    name: card.name,
    type: card.type,
    rarity: card.rarity ?? null,
    cost: card.energyCost ?? card.manaCost ?? null,
    power: card.power ?? null,
    toughness: card.toughness ?? null,
    currentToughness: isBoardCard(card) ? card.currentToughness ?? card.toughness ?? null : card.toughness ?? null,
    keywords: card.keywords ?? [],
    tags: card.tags ?? [],
    abilities: abilityLabels(card),
    text: card.text ?? null,
    assets: card.assets ?? null,
    metadata: card.metadata ?? null
  };

  if (!isBoardCard(card)) {
    return {
      ...base,
      isTapped: null,
      summoned: null,
      counters: null,
      activationState: null
    };
  }

  return {
    ...base,
    isTapped: card.isTapped,
    summoned: card.summoned,
    counters: card.counters ?? null,
    activationState: serializeActivationState(card)
  };
};

const serializeCardZone = (cards: (Card | BoardCard)[]) => cards.map((card) => serializeCardSnapshot(card));

const serializePlayerBoard = (board: PlayerBoard) => ({
  creatures: serializeCardZone(board.creatures),
  artifacts: serializeCardZone(board.artifacts),
  enchantments: serializeCardZone(board.enchantments)
});

const serializeRuneCard = (rune: RuneCard) => ({
  runeId: rune.id,
  name: rune.name,
  domain: rune.domain ?? null,
  energyValue: rune.energyValue ?? null,
  powerValue: rune.powerValue ?? null
});

const serializeTemporaryEffect = (effect: TemporaryEffect) => ({
  id: effect.id,
  affectedCards: effect.affectedCards ?? [],
  affectedPlayer: effect.affectedPlayer ?? null,
  duration: effect.duration,
  effect: {
    type: effect.effect.type,
    value: effect.effect.value ?? null
  }
});

export const serializePlayerState = (player: PlayerState, visibility: PlayerVisibility) => {
  const hideHand = visibility === 'opponent';
  const hideRuneDeck = visibility === 'opponent';

  return {
    playerId: player.playerId,
    name: player.name,
    victoryPoints: player.victoryPoints,
    victoryScore: player.victoryScore,
    mana: player.mana,
    maxMana: player.maxMana,
    handSize: player.hand.length,
    deckCount: player.deck.length,
    runeDeckSize: player.runeDeck.length,
    hand: hideHand ? [] : serializeCardZone(player.hand),
    board: serializePlayerBoard(player.board),
    graveyard: serializeCardZone(player.graveyard),
    exile: serializeCardZone(player.exile),
    resources: {
      energy: player.resources.energy,
      universalPower: player.resources.universalPower,
      power: { ...player.resources.power }
    },
    channeledRunes: player.channeledRunes.map(serializeRuneCard),
    runeDeck: hideRuneDeck ? [] : player.runeDeck.map(serializeRuneCard),
    temporaryEffects: player.temporaryEffects.map(serializeTemporaryEffect)
  };
};

export const serializeGameState = (state: GameState, options?: SerializeGameStateOptions) => {
  const viewerId = options?.viewerId ?? null;
  return {
    matchId: state.matchId,
    players: state.players.map((player) =>
      serializePlayerState(
        player,
        viewerId
          ? viewerId === player.playerId
            ? 'self'
            : 'opponent'
          : 'spectator'
      )
    ),
    currentPlayerIndex: state.currentPlayerIndex,
    currentPhase: state.currentPhase,
    turnNumber: state.turnNumber,
    status: state.status,
    winner: state.winner ?? null,
    moveHistory: state.moveHistory,
    timestamp: toDate(state.timestamp),
    victoryScore: state.victoryScore,
    scoreLog: state.scoreLog.map((entry) => ({
      playerId: entry.playerId,
      amount: entry.amount,
      reason: entry.reason,
      sourceCardId: entry.sourceCardId ?? null,
      timestamp: toDate(entry.timestamp)
    })),
    endReason: state.endReason ?? null
  };
};

export const buildOpponentView = (state: GameState, playerId: string) => {
  const opponent = state.players.find((p) => p.playerId !== playerId);
  if (!opponent) {
    return {
      playerId: null,
      victoryPoints: 0,
      victoryScore: state.victoryScore,
      handSize: 0,
      board: {
        creatures: [],
        artifacts: [],
        enchantments: []
      }
    };
  }

  const snapshot = serializePlayerState(opponent, 'opponent');
  return {
    playerId: opponent.playerId,
    victoryPoints: opponent.victoryPoints,
    victoryScore: opponent.victoryScore ?? state.victoryScore,
    handSize: opponent.hand?.length || 0,
    board: snapshot.board || {
      creatures: [],
      artifacts: [],
      enchantments: []
    }
  };
};
