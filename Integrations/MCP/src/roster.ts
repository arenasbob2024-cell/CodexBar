/** Provider roster helpers (output of `codexbar config providers --format json`). */

import type { RawEntry, RosterEntry } from "./types.js";

/** Parse the CLI roster JSON; returns only enabled providers, in CLI order. */
export function parseRoster(json: unknown): RosterEntry[] | null {
  if (!Array.isArray(json)) return null;
  const entries: RosterEntry[] = [];
  for (const item of json) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.provider === "string" ? r.provider : undefined;
    if (!id) continue;
    const displayName = typeof r.displayName === "string" && r.displayName ? r.displayName : id;
    entries.push({ id, displayName, enabled: r.enabled === true });
  }
  return entries.filter((e) => e.enabled);
}

/** Fallback roster derived from a usage payload (serve mode, or roster command failed). */
export function rosterFromRaw(raw: unknown): RosterEntry[] {
  const seen = new Set<string>();
  const out: RosterEntry[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw as RawEntry[]) {
    const id = item && typeof item === "object" ? item.provider : undefined;
    if (typeof id === "string" && id && !seen.has(id)) {
      seen.add(id);
      out.push({ id, displayName: id, enabled: true });
    }
  }
  return out;
}

export function rosterIds(roster: RosterEntry[]): string[] {
  return roster.map((r) => r.id);
}

/** "codex (Codex), zai (z.ai / GLM)" — for tool descriptions. */
export function describeRoster(roster: RosterEntry[]): string {
  return roster.map((r) => `${r.id} (${r.displayName})`).join(", ");
}
