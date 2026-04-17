"use client";

import type { Event } from "@/lib/types";
import { commentary } from "@/lib/commentary";

type Props = {
  event: Event;
  matchOver: boolean;
};

export default function CommentaryOverlay({ event, matchOver }: Props) {
  const text = commentary(event);
  const actorColor =
    event.actor === "P1"
      ? "bg-blue-600"
      : event.actor === "P2"
        ? "bg-red-600"
        : "bg-neutral-700";
  return (
    <div
      className={`flex min-h-[160px] items-center border-t-4 px-8 py-6 ${
        matchOver
          ? "border-amber-400 bg-amber-950/80"
          : "border-neutral-800 bg-neutral-950"
      }`}
    >
      <div
        className={`mr-6 rounded px-3 py-1 text-sm font-semibold uppercase tracking-widest text-white ${actorColor}`}
      >
        {event.actor}
      </div>
      <div
        className={`flex-1 font-semibold leading-tight ${
          matchOver ? "text-amber-200" : "text-neutral-100"
        }`}
        style={{ fontSize: "48pt" }}
      >
        {text}
      </div>
    </div>
  );
}
