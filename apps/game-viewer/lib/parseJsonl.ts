import type { Event } from "./types";

export function parseJsonl(text: string): Event[] {
  const out: Event[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Event);
    } catch (err) {
      console.warn("failed to parse JSONL line", err);
    }
  }
  return out;
}
