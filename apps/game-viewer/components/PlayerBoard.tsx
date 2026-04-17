import type { Event, Player } from "@/lib/types";

type Props = { event: Event; player: Player };

export default function PlayerBoard({ event, player }: Props) {
  const sd = event.stateDelta;
  const stats =
    player === "P1"
      ? {
          hand: sd.handSizeP1,
          deck: sd.deckSizeP1,
          board: sd.boardCountP1,
          grave: sd.graveyardCountP1,
        }
      : {
          hand: sd.handSizeP2,
          deck: sd.deckSizeP2,
          board: sd.boardCountP2,
          grave: sd.graveyardCountP2,
        };
  const vp = event.vp[player];
  const hp = event.hp[player];
  const mana = event.mana[player];
  const color = player === "P1" ? "border-blue-500 bg-blue-950/40" : "border-red-500 bg-red-950/40";
  const accent = player === "P1" ? "text-blue-300" : "text-red-300";
  const active = event.activePlayer === player;

  return (
    <div className={`flex-1 rounded-lg border-2 p-4 ${color} ${active ? "ring-2 ring-amber-400" : ""}`}>
      <div className="mb-2 flex items-center justify-between">
        <div className={`text-2xl font-bold ${accent}`}>
          {player} {active && <span className="text-sm text-amber-300">(active)</span>}
        </div>
        <div className="font-mono text-sm text-neutral-300">
          {vp} VP &middot; {hp} HP &middot; {mana} mana
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2">
        <Stat label="Hand" value={stats.hand} />
        <Stat label="Deck" value={stats.deck} />
        <Stat label="Board" value={stats.board} />
        <Stat label="Graveyard" value={stats.grave} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-neutral-700 bg-neutral-900/60 px-3 py-2 text-center">
      <div className="text-2xl font-bold text-neutral-100 tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-neutral-400">
        {label}
      </div>
    </div>
  );
}
