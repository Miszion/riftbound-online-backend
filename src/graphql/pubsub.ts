import { PubSub } from 'graphql-subscriptions';

// Create a singleton PubSub instance
export const pubSub = new PubSub();

// Define subscription event names
export enum SubscriptionEvents {
  GAME_STATE_CHANGED = 'GAME_STATE_CHANGED',
  PLAYER_GAME_STATE_CHANGED = 'PLAYER_GAME_STATE_CHANGED',
  MATCH_COMPLETED = 'MATCH_COMPLETED',
  LEADERBOARD_UPDATED = 'LEADERBOARD_UPDATED',
  CARD_PLAYED = 'CARD_PLAYED',
  ATTACK_DECLARED = 'ATTACK_DECLARED',
  PHASE_CHANGED = 'PHASE_CHANGED',
  MATCHMAKING_STATUS_UPDATED = 'MATCHMAKING_STATUS_UPDATED',
}

// Helper functions to publish events
export const publishGameStateChange = (matchId: string, gameState: any) => {
  pubSub.publish(`${SubscriptionEvents.GAME_STATE_CHANGED}:${matchId}`, {
    gameStateChanged: gameState,
  });
};

export const publishPlayerGameStateChange = (matchId: string, playerId: string, playerView: any) => {
  pubSub.publish(`${SubscriptionEvents.PLAYER_GAME_STATE_CHANGED}:${matchId}:${playerId}`, {
    playerGameStateChanged: playerView,
  });
};

export const publishMatchCompletion = (matchId: string, matchResult: any) => {
  pubSub.publish(`${SubscriptionEvents.MATCH_COMPLETED}:${matchId}`, {
    matchCompleted: matchResult,
  });
};

export const publishLeaderboardUpdate = (leaderboardData: any) => {
  pubSub.publish(SubscriptionEvents.LEADERBOARD_UPDATED, {
    leaderboardUpdated: leaderboardData,
  });
};

export const publishCardPlayed = (matchId: string, event: any) => {
  pubSub.publish(`${SubscriptionEvents.CARD_PLAYED}:${matchId}`, {
    cardPlayed: event,
  });
};

export const publishAttackDeclared = (matchId: string, event: any) => {
  pubSub.publish(`${SubscriptionEvents.ATTACK_DECLARED}:${matchId}`, {
    attackDeclared: event,
  });
};

export const publishPhaseChange = (matchId: string, event: any) => {
  pubSub.publish(`${SubscriptionEvents.PHASE_CHANGED}:${matchId}`, {
    phaseChanged: event,
  });
};
