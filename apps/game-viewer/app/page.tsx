import Link from "next/link";
import { promises as fs } from "node:fs";
import path from "node:path";

type ManifestEntry = {
  matchId: string;
  path: string;
  file: string;
  events: number;
};

async function loadManifest(): Promise<ManifestEntry[]> {
  const manifestPath = path.join(process.cwd(), "public", "manifest.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(raw) as ManifestEntry[];
  } catch {
    return [];
  }
}

export default async function Home() {
  const manifest = await loadManifest();
  return (
    <main className="mx-auto max-w-4xl px-8 py-10">
      <h1 className="mb-2 text-4xl font-bold tracking-tight">
        Riftbound Replay Viewer
      </h1>
      <p className="mb-8 text-neutral-400">
        Pick a match to replay frame-by-frame. Built for video capture at 1920x1080.
      </p>

      {manifest.length === 0 ? (
        <div className="rounded border border-neutral-700 p-6 text-neutral-400">
          No matches found. Run{" "}
          <code className="rounded bg-neutral-800 px-1">npm run build-manifest</code>{" "}
          after placing .jsonl files into <code>public/matches/</code>.
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {manifest.map((m) => (
            <li key={m.file}>
              <Link
                href={`/replay?match=${encodeURIComponent(m.file)}`}
                className="block rounded-lg border border-neutral-700 bg-neutral-900 p-4 transition hover:border-blue-500 hover:bg-neutral-800"
              >
                <div className="font-mono text-sm text-blue-300">{m.matchId}</div>
                <div className="mt-1 text-xs text-neutral-500">
                  {m.file} &middot; {m.events} events
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-10 text-sm text-neutral-500">
        <p>
          Keyboard shortcuts on the replay page: <kbd>Space</kbd> play/pause,
          <kbd className="ml-1">&larr;</kbd> step back,{" "}
          <kbd>&rarr;</kbd> step forward.
        </p>
      </div>
    </main>
  );
}
