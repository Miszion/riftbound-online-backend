import type { Event } from "@/lib/types";
import { commentary } from "@/lib/commentary";

type Props = { events: Event[]; currentIndex: number };

export default function ActionHistory({ events, currentIndex }: Props) {
  const start = Math.max(0, currentIndex - 4);
  const slice = events.slice(start, currentIndex + 1);
  return (
    <div className="flex h-full flex-col rounded-lg border border-neutral-800 bg-neutral-950 p-3">
      <div className="mb-2 text-xs uppercase tracking-widest text-neutral-400">
        Recent actions
      </div>
      <ol className="flex-1 space-y-1 overflow-hidden text-xs">
        {slice.map((ev, idx) => {
          const i = start + idx;
          const isCurrent = i === currentIndex;
          const color =
            ev.actor === "P1"
              ? "text-blue-300"
              : ev.actor === "P2"
                ? "text-red-300"
                : "text-neutral-400";
          return (
            <li
              key={i}
              className={`truncate ${isCurrent ? "font-semibold text-white" : color}`}
            >
              #{i + 1} {commentary(ev)}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
