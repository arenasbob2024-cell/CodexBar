import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mapErrorCode, normalize, normalizeSnapshot, projectSnapshot, redactEmails } from "../src/normalize.js";
import type { RawEntry, RosterEntry } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "..", "..", "fixtures", "usage.v0.60.sample.json"), "utf8"),
) as RawEntry[];

const ROSTER: RosterEntry[] = [
  { id: "codex", displayName: "Codex", enabled: true },
  { id: "claude", displayName: "Claude", enabled: true },
  { id: "cursor", displayName: "Cursor", enabled: true },
  { id: "antigravity", displayName: "Antigravity", enabled: true },
  { id: "zai", displayName: "z.ai / GLM", enabled: true },
];
const NOW = new Date("2026-10-13T05:00:00Z");

function provider(snapshot: ReturnType<typeof normalize>, id: string) {
  const found = snapshot.providers.find((p) => p.provider === id);
  assert.ok(found, `provider ${id} present`);
  return found;
}

test("fixture: providers cover the roster in order with expected statuses", () => {
  const snap = normalize(fixture, ROSTER, NOW);
  assert.deepEqual(
    snap.providers.map((p) => p.provider),
    ["codex", "claude", "cursor", "antigravity", "zai"],
  );
  assert.deepEqual(snap.enabledProviders, ["codex", "claude", "cursor", "antigravity", "zai"]);
  assert.equal(provider(snap, "codex").status, "ok");
  assert.equal(provider(snap, "zai").status, "ok");
  assert.equal(provider(snap, "claude").status, "error");
  assert.equal(provider(snap, "cursor").status, "error");
  assert.equal(provider(snap, "antigravity").status, "offline");
  assert.deepEqual(snap.failedProviders, ["claude", "cursor"]);
  assert.equal(snap.partial, true);
});

test("fixture: error codes are mapped, not unknown", () => {
  const snap = normalize(fixture, ROSTER, NOW);
  assert.equal(provider(snap, "claude").error?.code, "parse");
  assert.equal(provider(snap, "cursor").error?.code, "auth");
});

test("fixture: null window slots are not emitted (codex has only secondary)", () => {
  const snap = normalize(fixture, ROSTER, NOW);
  const codex = provider(snap, "codex");
  assert.deepEqual(codex.windows.map((w) => w.id), ["secondary"]);
  assert.equal(codex.windows[0]?.label, "weekly");
  assert.equal(codex.windows[0]?.usedPercent, 100);
  assert.equal(codex.windows[0]?.remainingPercent, 0);
  assert.equal(codex.bindingWindow, "secondary");
  assert.equal(codex.minRemainingPercent, 0);
  assert.equal(provider(snap, "antigravity").windows.length, 0);
});

test("fixture: zai binding window, pace and no credits", () => {
  const snap = normalize(fixture, ROSTER, NOW);
  const zai = provider(snap, "zai");
  assert.deepEqual(zai.windows.map((w) => w.id), ["primary", "secondary"]);
  assert.equal(zai.windows[0]?.label, "5h");
  assert.equal(zai.windows[0]?.usedPercent, 75.8);
  assert.equal(zai.windows[0]?.remainingPercent, 24.2);
  assert.equal(zai.bindingWindow, "primary");
  assert.equal(zai.minRemainingPercent, 24.2);
  assert.equal(zai.pace?.stage, "farAhead");
  assert.equal(zai.pace?.etaSeconds, 1377);
  // projectedEmptyAt derives from the injected clock, not the wall clock.
  assert.equal(zai.pace?.projectedEmptyAt, "2026-10-13T05:22:57.000Z");
  assert.equal(zai.credits, undefined);
  assert.equal(zai.plan, "pro");
});

test("fixture: codex 0.60.x resetCredits are counted without ids; credits mapped", () => {
  const snap = normalize(fixture, ROSTER, NOW);
  const codex = provider(snap, "codex");
  assert.deepEqual(codex.resetCredits, { available: 3, nextExpiresAt: "2026-10-22T20:21:35.000Z" });
  assert.deepEqual(codex.credits, {
    balance: 33398.606308,
    unit: "Credits",
    updatedAt: "2026-10-13T04:56:09Z",
  });
  // Window ids ("secondary") are part of the schema; CLI credit ids/titles must never appear.
  assert.deepEqual(Object.keys(codex.resetCredits ?? {}).sort(), ["available", "nextExpiresAt"]);
  const json = JSON.stringify(snap);
  assert.ok(!json.includes("codex-reset-credit"), "no credit ids in output");
  assert.ok(!json.includes('"redacted"'), "no placeholder ids in output");
  assert.ok(!json.includes("accountId"), "no account ids in output");
});

test("identity: no email text in default output; email only with includeIdentity", () => {
  const plain = JSON.stringify(normalize(fixture, ROSTER, NOW));
  assert.ok(!plain.includes("@"));
  const withIdentity = normalize(fixture, ROSTER, NOW, { includeIdentity: true });
  assert.equal(provider(withIdentity, "codex").identity?.accountEmail, "user@example.com");
  assert.equal(provider(withIdentity, "zai").identity, undefined);
});

test("details: only with includeDetails, passed through as strings", () => {
  assert.equal(provider(normalize(fixture, ROSTER, NOW), "zai").details, undefined);
  const withDetails = provider(normalize(fixture, ROSTER, NOW, { includeDetails: true }), "zai");
  assert.ok(withDetails.details && withDetails.details.length > 0);
  const first = withDetails.details?.[0]?.rows[0];
  assert.equal(first?.label, "Credit quota");
  assert.equal(typeof first?.value, "string");
});

test("usageKnown=false window: known=false with null percentages", () => {
  const raw: RawEntry[] = [
    {
      provider: "codex",
      source: "oauth",
      usage: {
        updatedAt: "2026-10-13T04:59:00Z",
        primary: { usageKnown: false, usedPercent: 42, windowMinutes: 300, resetsAt: "2026-10-13T08:00:00Z" },
      },
    },
  ];
  const snap = normalize(raw, [ROSTER[0] as RosterEntry], NOW);
  const w = provider(snap, "codex").windows[0];
  assert.equal(w?.known, false);
  assert.equal(w?.usedPercent, null);
  assert.equal(w?.remainingPercent, null);
  assert.equal(provider(snap, "codex").bindingWindow, undefined);
  assert.equal(provider(snap, "codex").minRemainingPercent, undefined);
});

test("isSyntheticPlaceholder window slots are skipped", () => {
  const raw: RawEntry[] = [
    {
      provider: "codex",
      source: "oauth",
      usage: {
        primary: { isSyntheticPlaceholder: true, usedPercent: 0, windowMinutes: 300 },
        secondary: { usedPercent: 10, windowMinutes: 10080 },
      },
    },
  ];
  const snap = normalize(raw, [ROSTER[0] as RosterEntry], NOW);
  assert.deepEqual(provider(snap, "codex").windows.map((w) => w.id), ["secondary"]);
});

test("usedPercent above 100 is clamped and raw value preserved", () => {
  const raw: RawEntry[] = [
    {
      provider: "codex",
      source: "oauth",
      usage: { primary: { usedPercent: 137.44, windowMinutes: 300, resetsAt: "2026-10-13T08:00:00Z" } },
    },
  ];
  const w = provider(normalize(raw, [ROSTER[0] as RosterEntry], NOW), "codex").windows[0];
  assert.equal(w?.usedPercent, 100);
  assert.equal(w?.rawUsedPercent, 137.44);
  assert.equal(w?.remainingPercent, 0);
});

test("resetPassed: used/remaining null, minutes 0, snapshot stale", () => {
  const raw: RawEntry[] = [
    {
      provider: "codex",
      source: "oauth",
      usage: { primary: { usedPercent: 80, windowMinutes: 300, resetsAt: "2026-10-12T00:00:00Z" } },
    },
  ];
  const snap = normalize(raw, [ROSTER[0] as RosterEntry], NOW);
  const w = provider(snap, "codex").windows[0];
  assert.equal(w?.resetPassed, true);
  assert.equal(w?.resetsInMinutes, 0);
  assert.equal(w?.usedPercent, null);
  assert.equal(w?.remainingPercent, null);
  assert.equal(snap.stale, true);
  assert.equal(provider(snap, "codex").bindingWindow, undefined);
});

test("resetsAt without timezone is omitted", () => {
  const raw: RawEntry[] = [
    { provider: "codex", source: "oauth", usage: { primary: { usedPercent: 5, windowMinutes: 300, resetsAt: "2026-10-13T08:00:00" } } },
  ];
  const w = provider(normalize(raw, [ROSTER[0] as RosterEntry], NOW), "codex").windows[0];
  assert.equal(w?.resetsAt, undefined);
  assert.equal(w?.resetPassed, undefined);
});

test("0.74.x top-level resetCredits are used directly", () => {
  const raw: RawEntry[] = [
    {
      provider: "codex",
      source: "oauth",
      resetCredits: { available: 2, nextExpiresAt: "2026-11-01T00:00:00Z" },
      usage: { primary: { usedPercent: 10, windowMinutes: 300 } },
    },
  ];
  const codex = provider(normalize(raw, [ROSTER[0] as RosterEntry], NOW), "codex");
  assert.deepEqual(codex.resetCredits, { available: 2, nextExpiresAt: "2026-11-01T00:00:00Z" });
});

test("0.60.x resetCredits ignore used and expired credits", () => {
  const raw: RawEntry[] = [
    {
      provider: "codex",
      source: "oauth",
      usage: {
        primary: { usedPercent: 10, windowMinutes: 300 },
        codexResetCredits: {
          credits: [
            { status: "available", expires_at: "2026-10-01T00:00:00Z", id: "a" },
            { status: "used", expires_at: "2026-12-01T00:00:00Z", id: "b" },
            { status: "available", expires_at: "2026-12-05T00:00:00Z", id: "c" },
          ],
        },
      },
    },
  ];
  const codex = provider(normalize(raw, [ROSTER[0] as RosterEntry], NOW), "codex");
  assert.deepEqual(codex.resetCredits, { available: 1, nextExpiresAt: "2026-12-05T00:00:00.000Z" });
});

test("no reset credit data: field omitted", () => {
  const codex = provider(normalize(fixture, ROSTER, NOW), "zai");
  assert.equal(codex.resetCredits, undefined);
});

test("roster provider missing from output is synthesized as error=missing", () => {
  const roster: RosterEntry[] = [...ROSTER, { id: "grok", displayName: "Grok", enabled: true }];
  const snap = normalize(fixture, roster, NOW);
  assert.equal(snap.providers.length, 6);
  const grok = provider(snap, "grok");
  assert.equal(grok.status, "error");
  assert.equal(grok.error?.code, "missing");
  assert.ok(snap.failedProviders.includes("grok"));
});

test("providers outside the roster are dropped", () => {
  const snap = normalize(fixture, [ROSTER[0] as RosterEntry], NOW);
  assert.deepEqual(snap.providers.map((p) => p.provider), ["codex"]);
});

test("error messages have emails redacted", () => {
  const raw: RawEntry[] = [
    { provider: "codex", source: "auto", error: { code: 1, kind: "provider", message: "Sign in failed for someone@example.org today" } },
  ];
  const codex = provider(normalize(raw, [ROSTER[0] as RosterEntry], NOW), "codex");
  assert.equal(codex.error?.message, "Sign in failed for <redacted> today");
  assert.equal(codex.error?.code, "auth");
  assert.ok(!codex.error?.message.includes("@"));
  assert.equal(redactEmails("a@b.co and c@d.io"), "<redacted> and <redacted>");
});

test("mapErrorCode keyword precedence", () => {
  assert.equal(mapErrorCode("Request timed out"), "timeout");
  assert.equal(mapErrorCode("Could not parse Claude usage: without session quota data"), "parse");
  assert.equal(mapErrorCode("No Cursor session found"), "auth");
  assert.equal(mapErrorCode("Please sign in"), "auth");
  assert.equal(mapErrorCode("boom"), "provider");
});

test("projectSnapshot recomputes time fields at call time from the cached snapshot", () => {
  const internal = normalizeSnapshot(fixture, ROSTER, NOW, { source: "cli" });
  const early = projectSnapshot(internal, NOW, { includeIdentity: false, includeDetails: false });
  const late = projectSnapshot(internal, new Date("2026-10-19T00:00:00Z"), {
    includeIdentity: false,
    includeDetails: false,
  });
  assert.equal(early.stale, false);
  assert.equal(late.stale, true);
  const w = late.providers.find((p) => p.provider === "codex")?.windows[0];
  assert.equal(w?.resetPassed, true);
  assert.equal(w?.usedPercent, null);
  assert.ok((late.ageSeconds ?? 0) > (early.ageSeconds ?? 0));
});

test("window label mapping", () => {
  const mk = (m: number): RawEntry[] => [
    { provider: "codex", source: "oauth", usage: { primary: { usedPercent: 1, windowMinutes: m } } },
  ];
  const label = (m: number) =>
    provider(normalize(mk(m), [ROSTER[0] as RosterEntry], NOW), "codex").windows[0]?.label;
  assert.equal(label(300), "5h");
  assert.equal(label(10080), "weekly");
  assert.equal(label(43200), "monthly");
  assert.equal(label(90), "90m");
});
