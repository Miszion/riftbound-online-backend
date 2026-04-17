import type { Battlefield as BF } from "@/lib/types";

type Props = { battlefields: BF[] };

export default function Battlefield({ battlefields }: Props) {
  const cols = battlefields.length <= 2 ? 2 : battlefields.length <= 4 ? 2 : 3;
  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 text-sm uppercase tracking-widest text-neutral-400">
        Battlefields
      </div>
      <div
        className="grid flex-1 gap-3"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {battlefields.map((b) => (
          <Card key={b.id} bf={b} />
        ))}
        {battlefields.length === 0 && (
          <div className="col-span-full grid place-items-center rounded-lg border border-dashed border-neutral-800 text-neutral-600">
            No active battlefields
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ bf }: { bf: BF }) {
  const controllerBg =
    bf.controller === "P1"
      ? "bg-blue-900/40 border-blue-500"
      : bf.controller === "P2"
        ? "bg-red-900/40 border-red-500"
        : "bg-neutral-900 border-neutral-700";
  const label =
    bf.controller === "P1"
      ? "P1 claimed"
      : bf.controller === "P2"
        ? "P2 claimed"
        : "Neutral";
  return (
    <div className={`rounded-lg border-2 p-4 ${controllerBg} min-h-[110px]`}>
      <div className="mb-1 font-mono text-lg font-bold">{bf.id}</div>
      <div className="text-xs uppercase tracking-wider text-neutral-400">
        {label}
      </div>
      {bf.contestedBy && bf.contestedBy.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {bf.contestedBy.map((p) => (
            <span
              key={p}
              className={`rounded px-2 py-0.5 text-xs font-semibold ${
                p === "P1" ? "bg-blue-600 text-white" : "bg-red-600 text-white"
              }`}
            >
              contested by {p}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
