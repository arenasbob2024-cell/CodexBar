#!/usr/bin/env node
/**
 * CodexBar quota MCP server (stdio). Reports provider quotas; makes no
 * scheduling decisions. See DESIGN.md for the contract.
 *
 * Hygiene invariants:
 *  - no timers other than per-request waits and child hard-timeouts (no polling)
 *  - children get CODEXBAR_MCP_NESTED=1; with that variable already set this
 *    process is inert and never spawns or reads the cache
 *  - single in-flight fetch per process; cross-process via a mkdir lock
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { QuotaCache, lockStaleMsFor } from "./cache.js";
import { Deadline, raceDeadline, raceWithTimeout } from "./wait.js";
import { mergeProviderSnapshot, normalizeSnapshot, projectSnapshot, rebuildForRoster } from "./normalize.js";
import { describeRoster, rosterFromRaw, rosterIds } from "./roster.js";
import {
  fetchCliVersion,
  fetchRosterCli,
  fetchUsageCli,
  fetchUsageServe,
  killAllLiveChildren,
  resolveBinary,
  type UsageResult,
} from "./source.js";
import type { FetchOutcome, InternalSnapshot, RosterEntry, ServiceError } from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const NESTED = process.env.CODEXBAR_MCP_NESTED === "1";
const SERVE_URL = (() => {
  const raw = process.env.CODEXBAR_SERVE_URL?.trim();
  return raw && /^https?:\/\//i.test(raw) ? raw : undefined;
})();
const MODE: "cli" | "serve" = SERVE_URL ? "serve" : "cli";
// The shared disk cache belongs to CLI mode only: a serve-mode process must never present data
// written by a CLI host (or an older source) as its own, and nested mode never reads it at all.
const DISK_ENABLED = MODE === "cli" && !NESTED;
const TTL_SECONDS = intEnv("CODEXBAR_MCP_TTL_SECONDS", 300, 1, 86_400);
const TIMEOUT_SECONDS = intEnv("CODEXBAR_MCP_TIMEOUT_SECONDS", 90, 1, 600);
// How long codexbar_refresh may wait beyond one hard timeout (it can queue behind a targeted fetch).
const REFRESH_SLACK_SECONDS = intEnv("CODEXBAR_MCP_REFRESH_SLACK_SECONDS", 10, 0, 300);
const CACHE_DIR =
  process.env.CODEXBAR_MCP_CACHE_DIR?.trim() || join(homedir(), ".cache", "codexbar-mcp");

const NOT_INSTALLED_HINT =
  "codexbar CLI not found. Install CodexBar (Preferences > Advanced > Install CLI), or set CODEXBAR_BIN to the binary, or set CODEXBAR_SERVE_URL to a running `codexbar serve`. Restart this MCP server afterwards.";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let roster: RosterEntry[] = [];
// true once `config providers` answered successfully (even with an empty list); false = unknown
let rosterKnown = false;
let cliVersion: string | undefined;
let binary: string | null | undefined; // undefined = not resolved yet, null = latched not_installed
let lastFetchFailed = false;
let lastError: ServiceError | null = null;
// Failed TARGETED refreshes, per provider (DESIGN v1.3 5.1, REVERIFY-1 N6). A failure is a state, not an
// event: it stays until a refresh covering that provider succeeds or a newer shared snapshot is adopted,
// whoever has already seen it. Never feeds the global lastFetchFailed/lastError (full fetches only).
const providerFailures = new Map<string, ServiceError>();
let lastExitCode: number | undefined; // exit code of the last successful full CLI fetch

const cache = new QuotaCache({
  cacheDir: CACHE_DIR,
  ttlSeconds: TTL_SECONDS,
  lockStaleMs: lockStaleMsFor(TIMEOUT_SECONDS),
  // The lease this process claims when it takes the lock: its own hard timeout + 30 s.
  leaseMs: TIMEOUT_SECONDS * 1000 + 30_000,
});

/**
 * One fetch request. `scope` null = all providers, otherwise a single provider id (`--provider`).
 * Fetches are serialized: at most one child process at a time, and a request is only merged into
 * an existing/queued fetch whose scope covers it.
 */
interface FetchEntry {
  scope: string | null;
  startedAt: number; // 0 while queued
  deadlineMs: number;
  outcome: FetchOutcome | null;
  promise: Promise<void>;
}
let running: FetchEntry | null = null;
const queued: FetchEntry[] = [];
let tail: Promise<void> = Promise.resolve();

function covers(entryScope: string | null, wanted: string | null): boolean {
  return entryScope === null || entryScope === wanted;
}

function enabledIds(): string[] {
  return rosterIds(roster);
}

/**
 * Pick up a snapshot another host wrote to the shared cache (only when strictly newer than ours).
 * Adopting a newer snapshot also clears our own failure flag: the data is good again.
 */
function adoptDisk(): boolean {
  if (!DISK_ENABLED) return false;
  const replaced = cache.loadNewerFromDisk(adaptToRoster);
  if (replaced) {
    lastFetchFailed = false;
    lastError = null;
    providerFailures.clear(); // the data they described has been replaced by a newer shared snapshot
  }
  return replaced;
}

/**
 * A passed reset time re-triggers a refresh at most once per this interval, measured from the last
 * successful fetch. A source that keeps reporting an old `resetsAt` must not cause a 40 s CLI run per call.
 */
const RESET_REFETCH_MIN_MS = 60_000;

/** Adapt any snapshot that did not come from this process's fetch to the current enabled roster. */
function adaptToRoster(snapshot: InternalSnapshot): InternalSnapshot {
  return rebuildForRoster(snapshot, roster, { known: rosterKnown });
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function serviceError(result: UsageResult): ServiceError {
  switch (result.kind) {
    case "timeout":
      return { code: "timeout", message: "The usage fetch exceeded the hard timeout and was killed." };
    case "cli_exit":
      return { code: `cli_exit_${result.exitCode}`, message: "The codexbar CLI exited with an error." };
    case "http_status":
      return { code: `http_${result.status}`, message: "codexbar serve returned an error status." };
    case "http_error":
      return { code: "http_error", message: "codexbar serve could not be reached." };
    case "spawn_error":
      return { code: "spawn_error", message: "The codexbar CLI could not be started." };
    default:
      return { code: "invalid_json", message: "The usage output was not valid JSON." };
  }
}

async function fetchOnce(scope: string | null): Promise<FetchOutcome> {
  let result: UsageResult;
  if (MODE === "serve") {
    result = await fetchUsageServe(SERVE_URL as string, scope, TIMEOUT_SECONDS);
  } else {
    result = await fetchUsageCli(binary as string, scope, TIMEOUT_SECONDS);
  }
  if (result.kind !== "ok") {
    const error = serviceError(result);
    if (scope === null) {
      lastFetchFailed = true;
      lastError = error;
    } else {
      providerFailures.set(scope, error);
    }
    return { kind: "failed", error };
  }

  const now = new Date();
  let snapshot: InternalSnapshot;
  if (scope === null) {
    // Serve mode (or a failed roster command) has no config roster: derive it from the payload.
    if (!rosterKnown && roster.length === 0) {
      roster = rosterFromRaw(result.raw);
      notifyToolsChangedIfSchemaChanged();
    }
    snapshot = normalizeSnapshot(result.raw, roster, now, { source: MODE });
    lastFetchFailed = false;
    lastError = null;
    lastExitCode = result.exitCode;
  } else {
    const base = cache.memGet();
    if (!base) {
      // Targeted fetches are only requested on top of an existing snapshot (see scopeFor).
      return { kind: "failed", error: { code: "unknown", message: "No base snapshot for a targeted refresh." } };
    }
    const single = normalizeSnapshot(
      result.raw,
      roster.filter((r) => r.id === scope),
      now,
      { source: MODE },
    );
    snapshot = mergeProviderSnapshot(base, single, scope);
  }
  cache.memSet(snapshot);
  if (DISK_ENABLED) cache.writeDisk(snapshot);
  // A successful refresh that covers a provider supersedes its recorded failure.
  if (scope === null) providerFailures.clear();
  else providerFailures.delete(scope);
  return { kind: "ok" };
}

async function runFetch(scope: string | null): Promise<FetchOutcome> {
  if (MODE === "serve") return fetchOnce(scope);
  if (!cache.acquireLock()) return { kind: "lock_busy" };
  try {
    // The lock is ours: for a targeted fetch, merge into the NEWEST shared snapshot, not into a
    // stale in-memory one, so another host's newer data is never rolled back by our write.
    if (scope !== null) adoptDisk();
    return await fetchOnce(scope);
  } finally {
    cache.releaseLock();
  }
}

/**
 * Single-flight with scopes. Returns an existing running/queued entry when its scope covers the
 * request; otherwise queues a new one behind everything already pending (still one child at a time).
 */
function requestFetch(scope: string | null): FetchEntry {
  const reusable = [running, ...queued].find((e): e is FetchEntry => e !== null && covers(e.scope, scope));
  if (reusable) return reusable;

  const entry: FetchEntry = {
    scope,
    startedAt: 0,
    deadlineMs: 0,
    outcome: null,
    promise: Promise.resolve(),
  };
  queued.push(entry);
  entry.promise = tail.then(async () => {
    queued.splice(queued.indexOf(entry), 1);
    running = entry;
    entry.startedAt = Date.now();
    entry.deadlineMs = entry.startedAt + TIMEOUT_SECONDS * 1000;
    try {
      entry.outcome = await runFetch(entry.scope);
    } catch {
      const error = { code: "unknown", message: "Unexpected error while fetching usage." };
      if (entry.scope === null) {
        lastFetchFailed = true;
        lastError = error;
      } else {
        providerFailures.set(entry.scope, error);
      }
      entry.outcome = { kind: "failed", error };
    } finally {
      running = null;
    }
  });
  tail = entry.promise;
  return entry;
}

/** Targeted fetches only make sense on top of a known snapshot and roster; otherwise go full. */
function scopeFor(args: { refresh?: boolean; provider?: string }): string | null {
  if (args.refresh && args.provider && roster.length > 0 && cache.memGet() !== null) return args.provider;
  return null;
}

function retryAfterSeconds(): number {
  if (running) {
    return Math.min(60, Math.max(5, Math.ceil((running.deadlineMs - Date.now()) / 1000)));
  }
  return 10;
}

// ---------------------------------------------------------------------------
// Response assembly
// ---------------------------------------------------------------------------

interface BuildArgs {
  snap: InternalSnapshot | null;
  includeIdentity: boolean;
  includeDetails: boolean;
  fetching: boolean;
  waitTimedOut: boolean;
  lockBusy: boolean;
}

function buildResponse(a: BuildArgs): Record<string, unknown> {
  const base = {
    source: MODE,
    ...(cliVersion ? { cliVersion } : {}),
    // exit 1 = some provider failed, 2/3/4 = failure class of a provider; the payload was still used.
    ...(lastExitCode !== undefined && lastExitCode !== 0 ? { cliExitCode: lastExitCode } : {}),
  };
  if (!a.snap) {
    const warming = a.fetching || a.lockBusy;
    return {
      status: warming ? "warming" : "fetch_failed",
      ...base,
      stale: true,
      ...(warming ? { warming: true, retryAfterSeconds: a.lockBusy ? 10 : retryAfterSeconds() } : {}),
      ...(!warming && lastError ? { error: lastError } : {}),
      partial: true,
      failedProviders: [],
      enabledProviders: enabledIds(),
      providers: [],
    };
  }

  const now = new Date();
  const proj = projectSnapshot(a.snap, now, {
    includeIdentity: a.includeIdentity,
    includeDetails: a.includeDetails,
  });
  const ageSeconds = Math.max(0, Math.round((now.getTime() - cache.memFetchedAtMs()) / 1000));
  // A refresh that is still running after the wait counts as "warming" and the data as stale.
  const pending = a.fetching && a.waitTimedOut;
  // stale = TTL expired, last refresh failed, another host holds the lock with old data,
  // a refresh is still pending, or any window's reset time has already passed (projection flags that).
  const stale = ageSeconds > cache.ttlSeconds || lastFetchFailed || a.lockBusy || pending || proj.stale;
  const response: Record<string, unknown> = {
    ...proj,
    // DESIGN 3.4: a failed refresh keeps the last data but the status is fetch_failed.
    status: lastFetchFailed ? "fetch_failed" : stale ? "stale" : "ok",
    ...base,
    ageSeconds,
    stale,
    ...(pending ? { warming: true, retryAfterSeconds: retryAfterSeconds() } : {}),
    ...(!pending && a.lockBusy ? { retryAfterSeconds: 10 } : {}),
    ...(lastFetchFailed && lastError ? { error: lastError } : {}),
  };
  // Targeted-refresh failures are shown on their provider for as long as they are recorded,
  // independent of which call started the refresh or whether that call was still waiting.
  for (const [id, error] of providerFailures) overlayProviderFailure(response, id, error);
  return response;
}

interface QueryArgs {
  provider?: string;
  refresh?: boolean;
  maxAgeSeconds?: number;
  /** The call's single wait budget (probes and fetch share it). */
  deadline: Deadline;
  includeIdentity: boolean;
  includeDetails: boolean;
}

/**
 * A failed TARGETED refresh is reported like a provider failure inside a full fetch (DESIGN v1.3
 * 5.1): the provider is `status: "error"` with an `error.code`, its last known windows are kept,
 * `partial` is true and `failedProviders` lists it. The snapshot-level `status` / `stale` / `error`
 * are NOT touched: they stay driven by data age and by full-fetch outcomes only.
 */
function overlayProviderFailure(response: Record<string, unknown>, provider: string, error: ServiceError): void {
  const code = error.code === "timeout" ? "timeout" : error.code === "invalid_json" ? "parse" : "provider";
  const providers = Array.isArray(response.providers) ? (response.providers as Array<Record<string, unknown>>) : [];
  const target = providers.find((p) => p.provider === provider);
  if (!target) return;
  target.status = "error";
  target.error = { code, message: error.message };
  const failed = Array.isArray(response.failedProviders) ? (response.failedProviders as string[]) : [];
  if (!failed.includes(provider)) response.failedProviders = [...failed, provider];
  response.partial = true;
}

/** The roster query succeeded and nothing is enabled: there is nothing to fetch and nothing to report. */
function answerKnownEmptyRoster(args: { includeIdentity: boolean; includeDetails: boolean }): Record<string, unknown> {
  const mem = cache.memGet();
  if (!mem || mem.providers.length > 0 || mem.enabledProviders.length > 0) {
    cache.memSet(normalizeSnapshot([], [], new Date(), { source: MODE }));
  }
  return buildResponse({
    snap: cache.memGet(),
    includeIdentity: args.includeIdentity,
    includeDetails: args.includeDetails,
    fetching: false,
    waitTimedOut: false,
    lockBusy: false,
  });
}

async function queryUsage(args: QueryArgs): Promise<Record<string, unknown>> {
  if (rosterKnown && roster.length === 0) return answerKnownEmptyRoster(args);
  const maxAgeMs = args.refresh ? -1 : (args.maxAgeSeconds ?? cache.ttlSeconds) * 1000;
  let snap = cache.memGet();
  // Memory empty or expired: another host may already have refreshed the shared cache.
  if (!snap || (!args.refresh && cache.memAgeMs() > maxAgeMs)) {
    if (adoptDisk()) snap = cache.memGet();
  }
  let needsFetch = args.refresh === true || !snap || cache.memAgeMs() > maxAgeMs;
  // A passed reset time also triggers one refresh (the cached window is meaningless now).
  if (!needsFetch && snap) {
    const probe = projectSnapshot(snap, new Date(), { includeIdentity: false, includeDetails: false });
    // Rate limited (60 s since the last good fetch) and never after a failed refresh.
    needsFetch = probe.stale && !lastFetchFailed && cache.memAgeMs() >= RESET_REFETCH_MIN_MS;
  }

  let waitTimedOut = false;
  let lockBusy = false;
  let entry: FetchEntry | null = null;
  let winner: "settled" | "timeout" = "settled";
  if (needsFetch) {
    entry = requestFetch(scopeFor(args));
    winner = await raceDeadline(entry.promise, args.deadline);
    waitTimedOut = winner === "timeout";
    lockBusy = entry.outcome?.kind === "lock_busy";
    if (lockBusy) adoptDisk(); // the lock holder may have finished while we asked
    snap = cache.memGet();
  }
  const response = buildResponse({
    snap,
    includeIdentity: args.includeIdentity,
    includeDetails: args.includeDetails,
    fetching: entry !== null && entry.outcome === null,
    waitTimedOut,
    lockBusy,
  });
  // The one call-level exception (DESIGN v1.3 5.1, point 3): the caller that started this targeted
  // refresh and received its failure within its wait is told "the newer data you asked for did not
  // arrive". Nobody else's snapshot-level state changes.
  if (entry && entry.scope !== null && winner === "settled" && entry.outcome?.kind === "failed") {
    response.stale = true;
    if (response.status === "ok") response.status = "stale";
  }
  return response;
}

async function refreshAll(deadline: Deadline): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  if (rosterKnown && roster.length === 0) {
    return { ok: true, durationMs: 0, snapshot: answerKnownEmptyRoster({ includeIdentity: false, includeDetails: false }) };
  }
  const entry = requestFetch(null);
  // Bounded by the call's single deadline (hard timeout + slack, started when the call began). A fetch
  // queued behind another one (each can hit the hard timeout), or a slow start-up probe, must not hold
  // this call for the sum of them.
  const winner = await raceDeadline(entry.promise, deadline);
  if (winner === "timeout") {
    const snapshot = buildResponse({
      snap: cache.memGet(),
      includeIdentity: false,
      includeDetails: false,
      fetching: true,
      waitTimedOut: true,
      lockBusy: false,
    });
    return { ok: false, warming: true, retryAfterSeconds: retryAfterSeconds(), durationMs: Date.now() - t0, snapshot };
  }
  const ok = entry.outcome?.kind === "ok";
  if (entry.outcome?.kind === "lock_busy") adoptDisk();
  const snapshot = buildResponse({
    snap: cache.memGet(),
    includeIdentity: false,
    includeDetails: false,
    fetching: false,
    waitTimedOut: false,
    lockBusy: entry.outcome?.kind === "lock_busy",
  });
  return { ok, durationMs: Date.now() - t0, snapshot };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const commonArgs = {
  waitSeconds: z.number().int().min(0).max(60).optional(),
  includeIdentity: z.boolean().optional(),
  includeDetails: z.boolean().optional(),
};
const ListArgs = z
  .object({ maxAgeSeconds: z.number().int().min(0).max(86_400).optional(), ...commonArgs })
  .strict();
const GetArgs = z
  .object({ provider: z.string().min(1), refresh: z.boolean().optional(), ...commonArgs })
  .strict();
const RefreshArgs = z.object({}).strict();

function commonProps(): Record<string, unknown> {
  return {
    waitSeconds: {
      type: "integer",
      minimum: 0,
      maximum: 60,
      default: 20,
      description:
        "Max seconds to block when the cache is expired and a refresh is running. On timeout you get the existing data with warming=true, stale=true and retryAfterSeconds.",
    },
    includeIdentity: {
      type: "boolean",
      default: false,
      description: "Include the account email in identity (omitted by default).",
    },
    includeDetails: {
      type: "boolean",
      default: false,
      description:
        "Include provider detail rows (label/value strings passed through verbatim; units are mixed, do not sum).",
    },
  };
}

/** The `provider` property schema as it should be published right now (enum / description from the roster state). */
function providerSchema(): Record<string, unknown> {
  const ids = enabledIds();
  return ids.length
    ? {
        type: "string",
        enum: ids,
        description: `CodexBar provider id. Enabled providers: ${describeRoster(roster)}.`,
      }
    : rosterKnown
      ? {
          type: "string",
          description: "CodexBar provider id. No provider is currently enabled in CodexBar (当前没有启用的 provider).",
        }
      : { type: "string", description: "CodexBar provider id (the enabled-provider list is not known yet)." };
}

function buildToolDescriptors(): unknown[] {
  const providerSchemaNow = providerSchema();
  return [
    {
      name: "codexbar_list_quotas",
      description:
        "Report remaining subscription quota for every enabled CodexBar provider. A provider is a paid plan that backs a sub-agent (e.g. codex, claude, zai). " +
        "Each provider has windows (primary = short session window, secondary = weekly, ...) with usedPercent/remainingPercent, resetsAt and resetsInMinutes; " +
        "bindingWindow is the tightest known window; null percentages or an empty windows list mean the usage is unknown, NOT unlimited. " +
        "pace.projectedEmptyAt estimates exhaustion at the current burn rate. resetCredits are free reset tokens and are not included in remainingPercent. " +
        "Data comes from a local cache that refreshes lazily after the TTL (default 300s); a full refresh takes tens of seconds. " +
        "stale=true means the data may be outdated (TTL expired, last refresh failed, or a window reset already passed); warming=true means a refresh is still running, retry after retryAfterSeconds. " +
        "This tool only reports; it never recommends which provider to use.",
      inputSchema: {
        type: "object",
        properties: {
          maxAgeSeconds: {
            type: "integer",
            minimum: 0,
            maximum: 86_400,
            description:
              "Accept cached data younger than this many seconds (overrides the server TTL). 0 forces a refresh.",
          },
          ...commonProps(),
        },
        additionalProperties: false,
      },
    },
    {
      name: "codexbar_get_quota",
      description:
        "Report quota for ONE provider (same fields as codexbar_list_quotas, filtered to a single entry in the providers array). " +
        "With refresh=true it runs a targeted fetch for just that provider (about 10s) and merges it into the cache; otherwise it reads the cache like list_quotas. " +
        "provider must be one of the enabled ids.",
      inputSchema: {
        type: "object",
        properties: {
          provider: providerSchemaNow,
          refresh: {
            type: "boolean",
            default: false,
            description: "Force a targeted fetch for this provider (slower).",
          },
          ...commonProps(),
        },
        required: ["provider"],
        additionalProperties: false,
      },
    },
    {
      name: "codexbar_refresh",
      description:
        "Force a full re-fetch of all providers. 慢（约 45 秒）。list_quotas 已自动按 TTL 刷新，仅当 updatedAt 比你需要的更旧时才调用。" +
        " (Slow, about 45 seconds: list_quotas already refreshes automatically per TTL; only call this when updatedAt is older than you need.) " +
        "Returns { ok, durationMs, snapshot }. It waits at most one hard timeout plus a few seconds; if it is still queued or running after that it returns { ok: false, warming: true, retryAfterSeconds, snapshot } and the refresh continues in the background.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function jsonResult(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function resolveBinaryOnce(): boolean {
  if (MODE === "serve") return true;
  if (binary === undefined) binary = resolveBinary();
  return binary !== null; // a null result is latched: never retried
}

async function handleToolCall(name: string, rawArgs: unknown): Promise<ToolResult> {
  if (name !== "codexbar_list_quotas" && name !== "codexbar_get_quota" && name !== "codexbar_refresh") {
    return errorResult(`Unknown tool: ${name}`);
  }
  // Inert mode: never spawn, never touch the cache.
  if (NESTED) return jsonResult({ status: "nested", providers: [] });
  if (!resolveBinaryOnce()) return jsonResult({ status: "not_installed", hint: NOT_INSTALLED_HINT });

  const input = rawArgs ?? {};
  if (name === "codexbar_refresh") {
    const parsed = RefreshArgs.safeParse(input);
    if (!parsed.success) return errorResult("Invalid arguments: codexbar_refresh takes no parameters.");
    // One budget for the whole call, started now: hard timeout + slack. The start-up probe wait and the
    // queued fetch wait share it (REVERIFY-2 D3). Same wait path (and so the same number of async hops)
    // as the other tools: requests must reach the fetch queue in the order they arrived.
    const deadline = new Deadline((TIMEOUT_SECONDS + REFRESH_SLACK_SECONDS) * 1000);
    try {
      await raceDeadline(probesReady, deadline, PROBE_WAIT_MS);
      return jsonResult(await refreshAll(deadline));
    } finally {
      deadline.cancel();
    }
  }

  if (name === "codexbar_list_quotas") {
    const parsed = ListArgs.safeParse(input);
    if (!parsed.success) return errorResult(`Invalid arguments: ${parsed.error.issues[0]?.message ?? "bad input"}`);
    const a = parsed.data;
    // One budget for the whole call: the start-up probes and the fetch wait share it.
    const deadline = new Deadline((a.waitSeconds ?? 20) * 1000);
    try {
      await raceDeadline(probesReady, deadline, PROBE_WAIT_MS);
      return jsonResult(
        await queryUsage({
          maxAgeSeconds: a.maxAgeSeconds,
          deadline,
          includeIdentity: a.includeIdentity ?? false,
          includeDetails: a.includeDetails ?? false,
        }),
      );
    } finally {
      deadline.cancel();
    }
  }

  const parsed = GetArgs.safeParse(input);
  if (!parsed.success) return errorResult(`Invalid arguments: ${parsed.error.issues[0]?.message ?? "bad input"}`);
  const a = parsed.data;
  const deadline = new Deadline((a.waitSeconds ?? 20) * 1000);
  try {
    await raceDeadline(probesReady, deadline, PROBE_WAIT_MS);
    const ids = enabledIds();
    if (rosterKnown && ids.length === 0) {
      return errorResult("No provider is currently enabled in CodexBar (当前没有启用的 provider).");
    }
    if (ids.length > 0 && !ids.includes(a.provider)) {
      return errorResult(`Unknown provider "${a.provider}". Enabled providers: ${describeRoster(roster)}.`);
    }
    const result = await queryUsage({
      provider: a.provider,
      refresh: a.refresh ?? false,
      deadline,
      includeIdentity: a.includeIdentity ?? false,
      includeDetails: a.includeDetails ?? false,
    });
    if (Array.isArray(result.providers)) {
      const only = (result.providers as Array<{ provider?: string }>).filter((p) => p.provider === a.provider);
      if (result.providers.length > 0 && only.length === 0) {
        return errorResult(`Provider "${a.provider}" is not present in the current snapshot.`);
      }
      result.providers = only;
    }
    return jsonResult(result);
  } finally {
    deadline.cancel();
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  killAllLiveChildren();
  try {
    cache.releaseLock();
  } catch {
    // ignore
  }
  process.exit(0);
}

let probesReady: Promise<void> = Promise.resolve();
// tools/list can be answered before the roster is final (slow probe, serve mode): the provider enum is
// missing or provisional. Remember what the LAST tools/list actually published (the serialized provider
// schema; undefined = never listed) and send tools/list_changed whenever the roster changes the schema
// we would publish now, so a host that cached the old one lists again - once per real change, not once.
let serverRef: Server | null = null;
let announcedProviderSchema: string | undefined;

function notifyToolsChangedIfSchemaChanged(): void {
  if (announcedProviderSchema === undefined || serverRef === null) return; // nothing published yet
  const current = JSON.stringify(providerSchema());
  if (current === announcedProviderSchema) return; // the host already has this schema
  announcedProviderSchema = current;
  serverRef.sendToolListChanged().catch(() => undefined); // best effort: the host may be gone
}
const PROBE_WAIT_MS = 2000;

/** Roster + version probes; started only after the handlers and the transport are in place. */
function startProbes(): void {
  if (NESTED || MODE !== "cli" || !binary) return;
  const bin = binary;
  probesReady = (async () => {
    const [rosterResult, versionResult] = await Promise.allSettled([
      fetchRosterCli(bin),
      fetchCliVersion(bin),
    ]);
    if (rosterResult.status === "fulfilled" && rosterResult.value) {
      roster = rosterResult.value;
      rosterKnown = true; // an empty array is an answer: nothing is enabled
      const mem = cache.memGet();
      if (mem) cache.memSet(adaptToRoster(mem)); // cached snapshot may predate a roster change
      notifyToolsChangedIfSchemaChanged();
    }
    if (versionResult.status === "fulfilled" && versionResult.value) cliVersion = versionResult.value;
  })();
}

async function main(): Promise<void> {
  // Handlers first: nothing may be spawned before a host going away is guaranteed to clean up.
  // The SDK stdio transport does not report stdin EOF as a close, so watch it directly.
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  if (!NESTED) {
    if (MODE === "cli") binary = resolveBinary();
    if (DISK_ENABLED) cache.preloadFromDisk(adaptToRoster);
  }

  const server = new Server(
    { name: "codexbar-mcp", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  serverRef = server;
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Bounded wait so a hung CLI can never stall tools/list: without a roster the schema degrades.
    await raceWithTimeout(probesReady, PROBE_WAIT_MS);
    const tools = buildToolDescriptors();
    announcedProviderSchema = JSON.stringify(providerSchema()); // exactly what this answer published
    return { tools: tools as never };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await handleToolCall(request.params.name, request.params.arguments);
    } catch {
      return errorResult("Internal error while handling the tool call.");
    }
  });

  const transport = new StdioServerTransport();
  transport.onclose = shutdown;
  await server.connect(transport);
  if (process.stdin.readableEnded || process.stdin.destroyed) {
    shutdown();
    return;
  }
  startProbes();
}

main().catch((error: unknown) => {
  console.error("codexbar-mcp failed to start:", error instanceof Error ? error.message : "unknown error");
  process.exit(1);
});
