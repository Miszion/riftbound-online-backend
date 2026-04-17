"use client";

type Props = {
  index: number;
  total: number;
  playing: boolean;
  speed: number;
  onTogglePlay: () => void;
  onStepBack: () => void;
  onStepForward: () => void;
  onSeek: (i: number) => void;
  onSpeedChange: (s: number) => void;
};

export default function Controls({
  index,
  total,
  playing,
  speed,
  onTogglePlay,
  onStepBack,
  onStepForward,
  onSeek,
  onSpeedChange,
}: Props) {
  return (
    <div className="flex items-center gap-4 border-t border-neutral-800 bg-neutral-900 px-6 py-3">
      <button
        type="button"
        onClick={onStepBack}
        className="rounded bg-neutral-800 px-3 py-2 font-semibold hover:bg-neutral-700"
        aria-label="Step back"
      >
        &larr; Back
      </button>
      <button
        type="button"
        onClick={onTogglePlay}
        className={`rounded px-4 py-2 font-semibold ${
          playing
            ? "bg-amber-500 text-black hover:bg-amber-400"
            : "bg-emerald-500 text-black hover:bg-emerald-400"
        }`}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? "Pause" : "Play"}
      </button>
      <button
        type="button"
        onClick={onStepForward}
        className="rounded bg-neutral-800 px-3 py-2 font-semibold hover:bg-neutral-700"
        aria-label="Step forward"
      >
        Forward &rarr;
      </button>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-neutral-400">Speed:</span>
        {[1, 2, 4].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSpeedChange(s)}
            className={`rounded px-2 py-1 ${
              speed === s
                ? "bg-blue-600 text-white"
                : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            {s}x
          </button>
        ))}
      </div>

      <div className="flex flex-1 items-center gap-3">
        <input
          type="range"
          min={0}
          max={Math.max(0, total - 1)}
          value={index}
          onChange={(e) => onSeek(Number(e.currentTarget.value))}
          className="flex-1 accent-blue-500"
        />
        <div className="w-24 text-right font-mono text-sm text-neutral-300">
          {index + 1}/{total}
        </div>
      </div>
    </div>
  );
}
