#!/usr/bin/env node
// Generates public/manifest.json from all .jsonl files in public/matches/.
// Run automatically by `npm run dev` and `npm run build`.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const MATCHES_DIR = path.join(ROOT, "public", "matches");
const MANIFEST_PATH = path.join(ROOT, "public", "manifest.json");

async function main() {
  let files = [];
  try {
    files = await fs.readdir(MATCHES_DIR);
  } catch (err) {
    if (err.code === "ENOENT") {
      await fs.mkdir(MATCHES_DIR, { recursive: true });
      console.log("Created empty public/matches/ - no JSONL files found.");
      await fs.writeFile(MANIFEST_PATH, "[]\n");
      return;
    }
    throw err;
  }
  const jsonl = files.filter((f) => f.endsWith(".jsonl")).sort();
  const entries = [];
  for (const f of jsonl) {
    const full = path.join(MATCHES_DIR, f);
    const text = await fs.readFile(full, "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    let matchId = f.replace(/\.jsonl$/, "");
    if (lines.length > 0) {
      try {
        const first = JSON.parse(lines[0]);
        if (first.matchId) matchId = first.matchId;
      } catch {
        // keep filename as fallback
      }
    }
    entries.push({
      matchId,
      file: f,
      path: `/matches/${f}`,
      events: lines.length,
    });
  }
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(entries, null, 2) + "\n");
  console.log(`Wrote manifest with ${entries.length} matches to ${MANIFEST_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
