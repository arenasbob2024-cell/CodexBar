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
import { QuotaCache } from "./cache.js";
import { mergeProviderSnapshot, normalizeSnapshot, projectSnapshot } from "./normalize.js";
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
const TTL_SECONDS = intEnv("CODEXBAR_MCP_TTL_SECONDS", 300, 1, 86_400);
const TIMEOUT_SECONDS = intEnv("CODEXBAR_MCP_TIMEOUT_SECONDS", 90, 1, 600);
const CACHE_DIR =
  process.env.CODEXBAR_MCP_CACHE_DIR?.trim() || join(homedir(), ".cache", "codexbar-mcp");

const NOT_INSTALLED_HINT =
  "codexbar CLI not found. Install CodexBar (Preferences > Advanced > Install CLI), or set CODEXBAR_BIN to the binary, or set CODEXBAR_SERVE_URL to a running `codexbar serve`. Restart this MCP server afterwards.";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let roster: RosterEntry[] = [];
let cliVersion: string | undefined;
let binary: string | null | undefined; // undefined = not resolved yet, null = latched not_installed
let lastFetchFailed = false;
let lastError: ServiceError | null = null;

const cache = new QuotaCache({ cacheDir: CACHE_DIR, ttlSeconds: TTL_SECONDS });

interface Inflight {
  provider: string | null;
  startedAt: number;
  deadlineMs: number;
  outcome: FetchOutcome | null;
  promise: Promise<void>;
}
let inflight: Inflight | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enabledIds(): string[] {
  return rosterIds(roster);
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

async function fetchOnce(provider: string | null): Promise<FetchOutcome> {
  let result: UsageResult;
  if (MODE === "serve") {
    result = await fetchUsageServe(SERVE_URL as string, provider, TIMEOUT_SECONDS);
  } else {
    result = await fetchUsageCli(binary as string, provider, TIMEOUT_SECONDS);
  }
  if (result.kind !== "ok") {
    lastFetchFailed = true;
    lastError = serviceError(result);
    return { kind: "failed", error: lastError };
  }

  const now = new Date();
  // Serve mode (or a failed roster command) has no config roster: derive it from the payload.
  if (roster.length === 0) roster = rosterFromRaw(result.raw);
  let snapshot: InternalSnapshot;
  if (provider) {
    const single = normalizeSnapshot(
      result.raw,
      roster.filter((r) => r.id === provider),
      now,
      { source: MODE },
    );
    snapshot = mergeProviderSnapshot(cache.memGet(), single, provider, roster, now);
  } else {
    snapshot = normalizeSnapshot(result.raw, roster, now, { source: MODE });
  }
  cache.memSet(snapshot);
  if (MODE === "cli") cache.writeDisk(snapshot);
  lastFetchFailed = false;
  lastError = null;
  return { kind: "ok" };
}

async function runFetch(provider: string | null): Promise<FetchOutcome> {
  if (MODE === "serve") return fetchOnce(provider);
  if (!cache.acquireLock()) return { kind: "lock_busy" };
  try {
    return await fetchOnce(provider);
  } finally {
    cache.releaseLock();
  }
}

/** Single-flight: at most one fetch in flight per process; callers share it. */
function startInflight(provider: string | null): Inflight {
  if (inflight) return inflight;
  const startedAt = Date.now();
  const entry: Inflight = {
    provider,
    startedAt,
    deadlineMs: startedAt + TIMEOUT_SECONDS * 1000,
    outcome: null,
    promise: Promise.resolve(),
  };
  entry.promise = (async () => {
    try {
      entry.outcome = await runFetch(provider);
    } catch {
      lastFetchFailed = true;
      lastError = { code: "unknown", message: "Unexpected error while fetching usage." };
      entry.outcome = { kind: "failed", error: lastError };
    } finally {
      inflight = null;
    }
  })();
  inflight = entry;
  return entry;
}

function retryAfterSeconds(): number {
  if (inflight) {
    return Math.min(60, Math.max(5, Math.ceil((inflight.deadlineMs - Date.now()) / 1000)));
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
  const base = { source: MODE, ...(cliVersion ? { cliVersion } : {}) };
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
  // stale = TTL expired, last refresh failed, another host holds the lock with old data,
  // or any window's reset time has already passed (projection flags that).
  const stale = ageSeconds > cache.ttlSeconds || lastFetchFailed || a.lockBusy || proj.stale;
  const pending = a.fetching && a.waitTimedOut;
  return {
    ...proj,
    status: stale ? "stale" : "ok",
    ...base,
    ageSeconds,
    stale,
    ...(pending ? { warming: true, retryAfterSeconds: retryAfterSeconds() } : {}),
    ...(!pending && a.lockBusy ? { retryAfterSeconds: 10 } : {}),
    ...(lastFetchFailed && lastError ? { error: lastError } : {}),
  };
}

interface QueryArgs {
  provider?: string;
  refresh?: boolean;
  maxAgeSeconds?: number;
  waitSeconds: number;
  includeIdentity: boolean;
  includeDetails: boolean;
}

async function queryUsage(args: QueryArgs): Promise<Record<string, unknown>> {
  const maxAgeMs = args.refresh ? -1 : (args.maxAgeSeconds ?? cache.ttlSeconds) * 1000;
  let snap = cache.memGet();
  let needsFetch = args.refresh === true || !snap || cache.memAgeMs() > maxAgeMs;
  // A passed reset time also triggers one refresh (the cached window is meaningless now).
  if (!needsFetch && snap) {
    const probe = projectSnapshot(snap, new Date(), { includeIdentity: false, includeDetails: false });
    needsFetch = probe.stale;
  }

  let waitTimedOut = false;
  let lockBusy = false;
  if (needsFetch) {
    const entry = startInflight(args.refresh && args.provider ? args.provider : null);
    const winner = await Promise.race([
      entry.promise.then(() => "settled" as const),
      sleep(args.waitSeconds * 1000).then(() => "timeout" as const),
    ]);
    waitTimedOut = winner === "timeout";
    lockBusy = entry.outcome?.kind === "lock_busy";
    snap = cache.memGet();
  }
  return buildResponse({
    snap,
    includeIdentity: args.includeIdentity,
    includeDetails: args.includeDetails,
    fetching: inflight !== null,
    waitTimedOut,
    lockBusy,
  });
}

async function refreshAll(): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const entry = startInflight(null);
  await entry.promise;
  const ok = entry.outcome?.kind === "ok";
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

function buildToolDescriptors(): unknown[] {
  const ids = enabledIds();
  const providerSchema: Record<string, unknown> = ids.length
    ? {
        type: "string",
        enum: ids,
        description: `CodexBar provider id. Enabled providers: ${describeRoster(roster)}.`,
      }
    : { type: "string", description: "CodexBar provider id (the enabled-provider list is not known yet)." };

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
          provider: providerSchema,
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
        "Returns { ok, durationMs, snapshot }.",
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
    return jsonResult(await refreshAll());
  }

  if (name === "codexbar_list_quotas") {
    const parsed = ListArgs.safeParse(input);
    if (!parsed.success) return errorResult(`Invalid arguments: ${parsed.error.issues[0]?.message ?? "bad input"}`);
    const a = parsed.data;
    return jsonResult(
      await queryUsage({
        maxAgeSeconds: a.maxAgeSeconds,
        waitSeconds: a.waitSeconds ?? 20,
        includeIdentity: a.includeIdentity ?? false,
        includeDetails: a.includeDetails ?? false,
      }),
    );
  }

  const parsed = GetArgs.safeParse(input);
  if (!parsed.success) return errorResult(`Invalid arguments: ${parsed.error.issues[0]?.message ?? "bad input"}`);
  const a = parsed.data;
  const ids = enabledIds();
  if (ids.length > 0 && !ids.includes(a.provider)) {
    return errorResult(`Unknown provider "${a.provider}". Enabled providers: ${describeRoster(roster)}.`);
  }
  const result = await queryUsage({
    provider: a.provider,
    refresh: a.refresh ?? false,
    waitSeconds: a.waitSeconds ?? 20,
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

async function main(): Promise<void> {
  if (!NESTED) {
    if (MODE === "cli") {
      binary = resolveBinary();
      if (binary) {
        const [rosterResult, versionResult] = await Promise.allSettled([
          fetchRosterCli(binary),
          fetchCliVersion(binary),
        ]);
        if (rosterResult.status === "fulfilled" && rosterResult.value) roster = rosterResult.value;
        if (versionResult.status === "fulfilled" && versionResult.value) cliVersion = versionResult.value;
      }
    }
    cache.preloadFromDisk();
    // Serve mode derives its roster from the cached payload when available.
    if (roster.length === 0) {
      const snap = cache.memGet();
      if (snap) {
        roster = snap.providers.map((p) => ({ id: p.provider, displayName: p.displayName, enabled: true }));
      }
    }
  }

  const server = new Server(
    { name: "codexbar-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolDescriptors() as never,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await handleToolCall(request.params.name, request.params.arguments);
    } catch {
      return errorResult("Internal error while handling the tool call.");
    }
  });

  const transport = new StdioServerTransport();
  transport.onclose = shutdown;
  // The SDK stdio transport does not report stdin EOF as a close, so watch it directly:
  // a host going away must take the in-flight child process group down with us.
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await server.connect(transport);
  if (process.stdin.readableEnded || process.stdin.destroyed) shutdown();
}

main().catch((error: unknown) => {
  console.error("codexbar-mcp failed to start:", error instanceof Error ? error.message : "unknown error");
  process.exit(1);
});
