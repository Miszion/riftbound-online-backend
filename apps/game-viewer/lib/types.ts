export type Player = "P1" | "P2";

export type Battlefield = {
  id: string;
  controller: Player | null;
  contestedBy: Player[];
};

export type StateDelta = {
  handSizeP1: number;
  handSizeP2: number;
  deckSizeP1: number;
  deckSizeP2: number;
  boardCountP1: number;
  boardCountP2: number;
  graveyardCountP1: number;
  graveyardCountP2: number;
  battlefields: Battlefield[];
};

export type Action =
  | {
      kind: "play_card";
      cardIndex?: number;
      destinationId?: string | null;
      targets?: (string | null)[];
    }
  | { kind: "advance_phase" }
  | { kind: "pass_priority" }
  | { kind: "respond_chain"; pass?: boolean }
  | { kind: "move_unit"; unitId?: string; fromId?: string | null; toId?: string | null }
  | {
      kind: "resolve_prompt_target";
      promptId?: string;
      selectionIds?: string[];
    }
  | { kind: "declare_attackers"; attackers?: string[] }
  | { kind: "claim_battlefield"; battlefieldId?: string; vp?: number }
  | { kind: "resolve_stack" }
  | { kind: "draw"; count?: number }
  | { kind: string; [key: string]: unknown };

export type CardPlayed = {
  id?: string;
  name?: string;
  type?: string;
  energyCost?: number;
  domain?: string;
  text?: string;
};

export type Event = {
  matchId: string;
  gameIndex: number;
  seed: number;
  eventIndex: number;
  timestamp: string;
  turn: number;
  phase: string;
  activePlayer: Player;
  actor: Player | "system";
  action: Action | null;
  vp: { P1: number; P2: number };
  hp: { P1: number; P2: number };
  mana: { P1: number; P2: number };
  stateDelta: StateDelta;
  priorityHolder?: Player;
  windowType?: string;
  cardPlayed?: CardPlayed | null;
  target?: unknown;
  result?: "P1_wins" | "P2_wins" | "draw";
  winReason?: string;
};
