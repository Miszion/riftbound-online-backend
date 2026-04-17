"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import type { Event } from "@/lib/types";
import { parseJsonl } from "@/lib/parseJsonl";
import PhaseBanner from "@/components/PhaseBanner";
import Battlefield from "@/components/Battlefield";
import PlayerBoard from "@/components/PlayerBoard";
import CommentaryOverlay from "@/components/CommentaryOverlay";
import Controls from "@/components/Controls";
import ActionHistory from "@/components/ActionHistory";

type ManifestEntry = { matchId: string; path: string; file: string; events: number };

type ReplayState = {
  index: number;
  playing: boolean;
  speed: number; // 1x, 2x, 4x
};

type Action =
  | { type: "play" }
  | { type: "pause" }
  | { type: "toggle" }
  | { type: "step_forward"; total: number }
  | { type: "step_back" }
  | { type: "seek"; index: number; total: number }
  | { type: "speed"; speed: number }
  | { type: "reset" };

function reducer(state: ReplayState, action: Action): ReplayState {
  switch (action.type) {
    case "play":
      return { ...state, playing: true };
    case "pause":
      return { ...state, playing: false };
    case "toggle":
      return { ...state, playing: !state.playing };
    case "step_forward": {
      const max = Math.max(0, action.total - 1);
      const next = Math.min(max, state.index + 1);
      return { ...state, index: next };
    }
    case "step_back":
      return { ...state, index: Math.max(0, state.index - 1) };
    case "seek": {
      const max = Math.max(0, action.total - 1);
      const clamped = Math.max(0, Math.min(max, action.index));
      return { ...state, index: clamped };
    }
    case "speed":
      return { ...state, speed: action.speed };
    case "reset":
      return { ...state, index: 0 };
  }
}

const BASE_INTERVAL_MS = 1000; // 1x
const DEFAULT_SPEED = 2; // 2x -> 500ms per event

export default function ReplayClient() {
  const params = useSearchParams();
  const matchFile = params.get("match");
  const autoplayParam = params.get("autoplay");
  const autoplay = autoplayParam === null ? true : autoplayParam === "1";
  const chain = params.get("chain");

  const [events, setEvents] = useState<Event[] | null>(null);
  const [manifest, setManifest] = useState<ManifestEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [state, dispatch] = useReducer(reducer, {
    index: 0,
    playing: autoplay,
    speed: DEFAULT_SPEED,
  });
  const [matchOverHeld, setMatchOverHeld] = useState(false);
  const chainTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load manifest (for chaining next match)
  useEffect(() => {
    fetch("/manifest.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((m: ManifestEntry[]) => setManifest(m))
      .catch(() => setManifest([]));
  }, []);

  // Load match JSONL
  useEffect(() => {
    if (!matchFile) return;
    setEvents(null);
    setError(null);
    fetch(`/matches/${encodeURIComponent(matchFile)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`failed to load match (${r.status})`);
        return r.text();
      })
      .then((text) => {
        const evs = parseJsonl(text);
        if (evs.length === 0) throw new Error("no events found in match");
        setEvents(evs);
        dispatch({ type: "reset" });
        if (autoplay) dispatch({ type: "play" });
      })
      .catch((err: Error) => setError(err.message));
  }, [matchFile, autoplay]);

  const total = events?.length ?? 0;
  const currentEvent = events && total > 0 ? events[Math.min(state.index, total - 1)] : null;
  const atEnd = total > 0 && state.index >= total - 1;
  const matchOver = !!currentEvent && (currentEvent.actor === "system" || !!currentEvent.result);

  // Auto-advance timer
  useEffect(() => {
    if (!state.playing || !events || total === 0) return;
    if (atEnd) return;
    const interval = BASE_INTERVAL_MS / state.speed;
    const timer = setTimeout(() => {
      dispatch({ type: "step_forward", total });
    }, interval);
    return () => clearTimeout(timer);
  }, [state.playing, state.speed, state.index, events, total, atEnd]);

  // At end of match: pause, hold banner, optionally chain to next match
  useEffect(() => {
    if (!atEnd || !events) return;
    if (state.playing) dispatch({ type: "pause" });
    setMatchOverHeld(true);

    if (chain === "next" && manifest.length > 0 && matchFile) {
      const idx = manifest.findIndex((m) => m.file === matchFile);
      const next = idx >= 0 ? manifest[idx + 1] : null;
      if (next) {
        if (chainTimeoutRef.current) clearTimeout(chainTimeoutRef.current);
        chainTimeoutRef.current = setTimeout(() => {
          const sp = new URLSearchParams();
          sp.set("match", next.file);
          sp.set("autoplay", "1");
          sp.set("chain", "next");
          window.location.href = `/replay?${sp.toString()}`;
        }, 5000);
      }
    }
    return () => {
      if (chainTimeoutRef.current) clearTimeout(chainTimeoutRef.current);
    };
  }, [atEnd, events, chain, manifest, matchFile, state.playing]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!events) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        dispatch({ type: "toggle" });
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        dispatch({ type: "step_forward", total });
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        dispatch({ type: "step_back" });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [events, total]);

  const onTogglePlay = useCallback(() => dispatch({ type: "toggle" }), []);
  const onStepBack = useCallback(() => dispatch({ type: "step_back" }), []);
  const onStepForward = useCallback(
    () => dispatch({ type: "step_forward", total }),
    [total],
  );
  const onSeek = useCallback(
    (i: number) => dispatch({ type: "seek", index: i, total }),
    [total],
  );
  const onSpeed = useCallback((s: number) => dispatch({ type: "speed", speed: s }), []);

  const header = useMemo(
    () =>
      currentEvent ? (
        <PhaseBanner event={currentEvent} />
      ) : (
        <div className="px-6 py-3 text-neutral-400">Loading...</div>
      ),
    [currentEvent],
  );

  if (!matchFile) {
    return (
      <div className="grid h-screen place-items-center text-neutral-300">
        <div className="text-center">
          <div className="mb-3">No match selected.</div>
          <Link href="/" className="text-blue-400 underline">
            Back to match picker
          </Link>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="grid h-screen place-items-center text-red-300">
        <div className="text-center">
          <div className="mb-3">Error loading match: {error}</div>
          <Link href="/" className="text-blue-400 underline">
            Back to match picker
          </Link>
        </div>
      </div>
    );
  }

  if (!events || !currentEvent) {
    return (
      <div className="grid h-screen place-items-center text-neutral-400">
        Loading match...
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-neutral-950">
      {header}

      <div className="grid flex-1 grid-cols-12 gap-4 overflow-hidden p-4">
        <div className="col-span-7 overflow-hidden">
          <Battlefield battlefields={currentEvent.stateDelta.battlefields} />
        </div>
        <div className="col-span-5 flex flex-col gap-3 overflow-hidden">
          <PlayerBoard event={currentEvent} player="P1" />
          <PlayerBoard event={currentEvent} player="P2" />
          <div className="max-h-40 flex-1 overflow-hidden">
            <ActionHistory events={events} currentIndex={state.index} />
          </div>
        </div>
      </div>

      <CommentaryOverlay event={currentEvent} matchOver={matchOver || matchOverHeld} />

      <Controls
        index={state.index}
        total={total}
        playing={state.playing}
        speed={state.speed}
        onTogglePlay={onTogglePlay}
        onStepBack={onStepBack}
        onStepForward={onStepForward}
        onSeek={onSeek}
        onSpeedChange={onSpeed}
      />
    </div>
  );
}
