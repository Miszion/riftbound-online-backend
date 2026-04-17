import type { Event } from "@/lib/types";

type Props = { event: Event };

export default function PhaseBanner({ event }: Props) {
  const phaseName = event.phase.replace("_", " ");
  return (
    <div className="flex items-center justify-between gap-6 border-b border-neutral-800 bg-neutral-950 px-6 py-3">
      <div className="text-2xl font-semibold tracking-tight">
        Turn {event.turn} &middot; {phaseName} &middot;{" "}
        <span className={event.activePlayer === "P1" ? "text-blue-400" : "text-red-400"}>
          {event.activePlayer}&apos;s turn
        </span>
      </div>
      <div className="flex items-center gap-4 text-xl font-mono">
        <Score player="P1" vp={event.vp.P1} hp={event.hp.P1} mana={event.mana.P1} />
        <span className="text-neutral-700">|</span>
        <Score player="P2" vp={event.vp.P2} hp={event.hp.P2} mana={event.mana.P2} />
      </div>
    </div>
  );
}

function Score({
  player,
  vp,
  hp,
  mana,
}: {
  player: "P1" | "P2";
  vp: number;
  hp: number;
  mana: number;
}) {
  const color = player === "P1" ? "text-blue-400" : "text-red-400";
  return (
    <span className={color}>
      <span className="font-bold">{player}</span>: {vp} VP, {hp} HP, {mana} mana
    </span>
  );
}
