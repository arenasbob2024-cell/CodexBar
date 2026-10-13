/**
 * Data sources: the codexbar CLI (spawned in its own process group) and
 * `codexbar serve` over HTTP. All child processes get CODEXBAR_MCP_NESTED=1
 * (DESIGN.md §3.2) and stderr is discarded.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { parseRoster } from "./roster.js";
import type { RawEntry, RosterEntry } from "./types.js";

export const BINARY_CANDIDATES = [
  "/opt/homebrew/bin/codexbar",
  "/usr/local/bin/codexbar",
  "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI",
];

const MAX_STDOUT_BYTES = 20_000_000;
/** Startup probes (roster, version) are quick local commands; a hung one must not outlive a host's start-up budget. */
export const PROBE_TIMEOUT_SECONDS = 5;

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * CODEXBAR_BIN wins and is exclusive (a bad value never falls back to another
 * binary); otherwise the known install locations are tried in order.
 */
export function resolveBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.CODEXBAR_BIN?.trim();
  if (fromEnv) return isExecutable(fromEnv) ? fromEnv : null;
  for (const candidate of BINARY_CANDIDATES) {
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Process-group management
// ---------------------------------------------------------------------------

const liveChildren = new Set<ChildProcess>();

export function killProcessGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Kill every in-flight child's whole process group (shutdown path). */
export function killAllLiveChildren(): void {
  for (const child of [...liveChildren]) killProcessGroup(child);
}

export function liveChildCount(): number {
  return liveChildren.size;
}

export interface RawRun {
  timedOut: boolean;
  overflow: boolean;
  spawnError: boolean;
  exitCode: number | null;
  stdout: string;
}

/** Spawn `bin args...` detached (own process group) with a hard timeout. */
export function runCli(bin: string, args: string[], timeoutSeconds: number): Promise<RawRun> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
        env: { ...process.env, CODEXBAR_MCP_NESTED: "1" },
      });
    } catch {
      resolve({ timedOut: false, overflow: false, spawnError: true, exitCode: null, stdout: "" });
      return;
    }
    liveChildren.add(child);

    let settled = false;
    let stdout = "";
    let timedOut = false;
    let overflow = false;

    const finish = (result: RawRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveChildren.delete(child);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, timeoutSeconds * 1000);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_STDOUT_BYTES && !overflow) {
        overflow = true;
        killProcessGroup(child);
      }
    });
    // The CLI may leave descendants behind in its (detached) process group, e.g. a PTY-probed
    // `claude`. When the leader exits, sweep the group; this also releases pipes they still hold,
    // so `close` fires. process.kill(-pid) on a gone group is a harmless ESRCH.
    child.on("exit", () => killProcessGroup(child));
    child.on("error", () =>
      finish({ timedOut, overflow, spawnError: true, exitCode: null, stdout: "" }),
    );
    child.on("close", (code) => {
      killProcessGroup(child);
      finish({ timedOut, overflow, spawnError: false, exitCode: code, stdout });
    });
  });
}

// ---------------------------------------------------------------------------
// CLI source
// ---------------------------------------------------------------------------

export type UsageResult =
  | { kind: "ok"; raw: RawEntry[]; exitCode?: number }
  | { kind: "timeout" }
  | { kind: "invalid_json" }
  | { kind: "cli_exit"; exitCode: number }
  | { kind: "spawn_error" }
  | { kind: "http_status"; status: number }
  | { kind: "http_error" };

/**
 * Exit codes 0-4 all carry a printed payload (DESIGN 3.4): 1 = some provider failed,
 * 2/3/4 = the failure class of a provider (not installed / parse error / timeout), but the
 * JSON array is still printed in full. So any parseable array on those codes is a normal result.
 * Only empty/unparseable stdout, or other codes (64 usage error, ...), are service-level errors.
 */
const PAYLOAD_EXIT_CODES = new Set([0, 1, 2, 3, 4]);

export async function fetchUsageCli(
  bin: string,
  provider: string | null,
  timeoutSeconds: number,
): Promise<UsageResult> {
  const args = ["usage", "--format", "json", "--json-only", "--log-level", "error"];
  if (provider) args.push("--provider", provider);
  const run = await runCli(bin, args, timeoutSeconds);
  if (run.timedOut) return { kind: "timeout" };
  if (run.overflow) return { kind: "invalid_json" };
  if (run.spawnError) return { kind: "spawn_error" };
  const exitCode = run.exitCode ?? -1;
  if (PAYLOAD_EXIT_CODES.has(exitCode)) {
    try {
      const parsed: unknown = JSON.parse(run.stdout);
      if (Array.isArray(parsed)) return { kind: "ok", raw: parsed as RawEntry[], exitCode };
    } catch {
      // fall through: no usable payload
    }
    // 0/1 with garbage output is a JSON problem; 2/3/4 with nothing printed is reported by code.
    return exitCode === 0 || exitCode === 1 ? { kind: "invalid_json" } : { kind: "cli_exit", exitCode };
  }
  return { kind: "cli_exit", exitCode };
}

export async function fetchRosterCli(bin: string): Promise<RosterEntry[] | null> {
  const run = await runCli(bin, ["config", "providers", "--format", "json"], PROBE_TIMEOUT_SECONDS);
  if (run.timedOut || run.spawnError || run.exitCode !== 0) return null;
  try {
    return parseRoster(JSON.parse(run.stdout));
  } catch {
    return null;
  }
}

export async function fetchCliVersion(bin: string): Promise<string | null> {
  const run = await runCli(bin, ["--version"], PROBE_TIMEOUT_SECONDS);
  if (run.timedOut || run.spawnError || run.exitCode !== 0) return null;
  const match = /(\d+\.\d+(?:\.\d+)?(?:[-+.\w]*)?)/.exec(run.stdout);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// serve source (never spawns)
// ---------------------------------------------------------------------------

export async function fetchUsageServe(
  baseUrl: string,
  provider: string | null,
  timeoutSeconds: number,
): Promise<UsageResult> {
  const base = baseUrl.replace(/\/+$/, "");
  const url = provider ? `${base}/usage?provider=${encodeURIComponent(provider)}` : `${base}/usage`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
      headers: { accept: "application/json" },
    });
    if (res.status !== 200) return { kind: "http_status", status: res.status };
    const parsed: unknown = await res.json();
    return Array.isArray(parsed) ? { kind: "ok", raw: parsed as RawEntry[] } : { kind: "invalid_json" };
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return { kind: "timeout" };
    }
    if (error instanceof SyntaxError) return { kind: "invalid_json" };
    return { kind: "http_error" };
  }
}
