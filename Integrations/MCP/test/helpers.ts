import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server as HttpServer } from "node:http";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { QuotaCache } from "../src/cache.js";
import { normalizeSnapshot } from "../src/normalize.js";
import type { RawEntry, RosterEntry } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_JS = join(here, "..", "src", "server.js");

export const ROSTER_JSON = '[{"provider":"codex","displayName":"Codex","enabled":true}]';
export const USAGE_JSON =
  '[{"provider":"codex","source":"oauth","usage":{"updatedAt":"2026-10-13T05:00:00Z","primary":null,' +
  '"secondary":{"windowMinutes":10080,"usedPercent":42.4,"resetsAt":"2026-12-01T00:00:00Z"},"tertiary":null}}]';

const FAKE_SCRIPT = `#!/bin/sh
if [ -n "$TRACE_FILE" ]; then echo "start $(date +%s) $$ $*" >> "$TRACE_FILE"; fi
if [ "$1" = "--version" ]; then echo "CodexBar 9.9.9"; exit 0; fi
if [ "$1" = "config" ]; then
  if [ -n "$PROBE_DELAY" ]; then sleep "$PROBE_DELAY"; fi
  if [ -n "$TRACE_FILE" ]; then echo "config-done $(date +%s) $$" >> "$TRACE_FILE"; fi
  if [ -n "$PROBE_SLEEP" ]; then
    echo $$ > "$PROBE_PIDFILE"
    sleep 999 &
    echo $! > "$PROBE_CHILD_PIDFILE"
    wait
    exit 0
  fi
  printf '%s' "$ROSTER_JSON"
  exit 0
fi
if [ -n "$SLEEP_FOREVER" ]; then
  echo $$ > "$PIDFILE"
  sleep 999 &
  echo $! > "$CHILD_PIDFILE"
  wait
  exit 0
fi
case "$*" in
  *--provider*)
    if [ -n "$TARGETED_HANG" ]; then sleep 999; exit 0; fi
    if [ -n "$TARGETED_FAIL_FILE" ] && [ -f "$TARGETED_FAIL_FILE" ]; then
      sleep "\${TARGETED_DELAY:-0}"
      exit 64
    fi
    ;;
esac
if [ -n "$GUARD_DIR" ]; then
  mkdir "$GUARD_DIR" 2>/dev/null || echo 1 > "$OVERLAP_FILE"
fi
n=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > "$COUNTER_FILE"
if [ -n "$ARGS_LOG" ]; then echo "$*" >> "$ARGS_LOG"; fi
if [ -n "$FORK_DESCENDANT" ]; then
  sleep 999 &
  echo $! > "$CHILD_PIDFILE"
fi
sleep "\${COUNT_DELAY:-0}"
if [ -n "$GUARD_DIR" ]; then rmdir "$GUARD_DIR" 2>/dev/null; fi
if [ -z "$EMPTY_OUTPUT" ]; then printf '%s' "$USAGE_JSON"; fi
exit "\${EXIT_CODE:-0}"
`;

export interface Sandbox {
  dir: string;
  bin: string;
  cacheDir: string;
  counterFile: string;
  pidFile: string;
  childPidFile: string;
  probePidFile: string;
  probeChildPidFile: string;
  argsLog: string;
  traceFile: string;
  guardDir: string;
  overlapFile: string;
}

const createdDirs: string[] = [];

/** Remove every sandbox directory created by makeSandbox (call from an `after` hook). */
export function cleanupSandboxes(): void {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "codexbar-mcp-test-"));
  createdDirs.push(dir);
  const bin = join(dir, "codexbar");
  writeFileSync(bin, FAKE_SCRIPT);
  chmodSync(bin, 0o755);
  return {
    dir,
    bin,
    cacheDir: join(dir, "cache"),
    counterFile: join(dir, "counter"),
    pidFile: join(dir, "pid"),
    childPidFile: join(dir, "child-pid"),
    probePidFile: join(dir, "probe-pid"),
    probeChildPidFile: join(dir, "probe-child-pid"),
    argsLog: join(dir, "args.log"),
    traceFile: join(dir, "trace.log"),
    guardDir: join(dir, "guard"),
    overlapFile: join(dir, "overlap"),
  };
}

export function readArgsLog(sb: Sandbox): string[] {
  return existsSync(sb.argsLog)
    ? readFileSync(sb.argsLog, "utf8").split("\n").filter((l) => l.length > 0)
    : [];
}

export function readCounter(sb: Sandbox): number {
  return existsSync(sb.counterFile) ? Number(readFileSync(sb.counterFile, "utf8").trim()) : 0;
}

export function serverEnv(sb: Sandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CODEXBAR_MCP_NESTED;
  delete env.CODEXBAR_SERVE_URL;
  return {
    ...env,
    CODEXBAR_BIN: sb.bin,
    CODEXBAR_MCP_CACHE_DIR: sb.cacheDir,
    ROSTER_JSON,
    USAGE_JSON,
    COUNTER_FILE: sb.counterFile,
    PIDFILE: sb.pidFile,
    CHILD_PIDFILE: sb.childPidFile,
    PROBE_PIDFILE: sb.probePidFile,
    PROBE_CHILD_PIDFILE: sb.probeChildPidFile,
    ARGS_LOG: sb.argsLog,
    TRACE_FILE: sb.traceFile,
    GUARD_DIR: sb.guardDir,
    OVERLAP_FILE: sb.overlapFile,
    ...extra,
  };
}

type Json = Record<string, any>;

export class Rpc {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  private pending = new Map<number, (message: Json) => void>();
  /**
   * EVERY server-initiated notification received, oldest first. Entries stay until a
   * waitForNotification consumes them, so a notification that arrived before the wait started is
   * still seen (this used to be lost when a timed-out waiter stayed registered and swallowed it).
   */
  private notifications: string[] = [];
  private notificationWaiters: Array<{ method: string; timer: NodeJS.Timeout; wake: () => void }> = [];
  private nextId = 1;

  constructor(env: NodeJS.ProcessEnv, execArgv: string[] = []) {
    this.child = spawn(process.execPath, [...execArgv, SERVER_JS], { env, stdio: ["pipe", "pipe", "ignore"] });
    const rl = createInterface({ input: this.child.stdout as NodeJS.ReadableStream });
    if (process.env.WIRE_LOG) {
      this.child.stdout?.on("data", (chunk) => {
        try {
          appendFileSync(process.env.WIRE_LOG as string, String(chunk).split("\n").filter(Boolean).map((l) => `${Date.now()} ${l.slice(0, 200)}`).join("\n") + "\n");
        } catch {
          // diagnostics only
        }
      });
    }
    rl.on("line", (line) => {
      let message: Json;
      try {
        message = JSON.parse(line) as Json;
      } catch {
        return;
      }
      if (message.id === undefined && typeof message.method === "string") {
        this.onNotification(message.method);
        return;
      }
      const resolver = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (resolver && typeof message.id === "number") {
        this.pending.delete(message.id);
        resolver(message);
      }
    });
    this.exited = new Promise((resolve) => this.child.on("exit", (code) => resolve(code)));
  }

  request(method: string, params: Json = {}, timeoutMs = 120_000): Promise<Json> {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, timeoutMs);
      // A request that never gets a reply (e.g. the server was closed on purpose) must not keep the
      // test process alive for the whole timeout: the child's own handle already does that while it lives.
      timer.unref();
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.child.stdin?.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(method: string, params: Json = {}): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize(): Promise<Json> {
    const reply = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    });
    this.notify("notifications/initialized");
    return reply;
  }

  /** Total number of `method` notifications received so far (consumed or not). */
  notificationCount(method: string): number {
    return this.notifications.filter((m) => m === method).length + this.consumedNotifications.filter((m) => m === method).length;
  }

  private consumedNotifications: string[] = [];

  private onNotification(method: string): void {
    this.notifications.push(method);
    // Wake every pending waiter whose method is now available; each wake consumes one entry.
    for (let i = 0; i < this.notificationWaiters.length; ) {
      const waiter = this.notificationWaiters[i]!;
      if (this.notifications.includes(waiter.method)) {
        this.notificationWaiters.splice(i, 1);
        waiter.wake();
      } else {
        i += 1;
      }
    }
  }

  /** Resolve when `method` has been received: consume one buffered entry, or wait for a new one. */
  waitForNotification(method: string, timeoutMs = 10_000): Promise<void> {
    const consume = (): boolean => {
      const index = this.notifications.indexOf(method);
      if (index < 0) return false;
      this.notifications.splice(index, 1);
      this.consumedNotifications.push(method);
      return true;
    };
    if (consume()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.notificationWaiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.notificationWaiters.splice(i, 1);
        reject(new Error(`no ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();
      this.notificationWaiters.push({
        method,
        timer,
        wake: () => {
          if (consume()) {
            clearTimeout(timer);
            resolve();
          }
        },
      });
    });
  }

  /**
   * tools/list that does not depend on probe timing: if the first answer is not `ready` (the roster was
   * not known yet), wait for the server's tools/list_changed notification and list again.
   */
  async listToolsUntil(ready: (tools: Json[]) => boolean, timeoutMs = 10_000): Promise<Json[]> {
    const first = await this.listTools();
    if (ready(first)) return first;
    await this.waitForNotification("notifications/tools/list_changed", timeoutMs);
    return this.listTools();
  }

  async listTools(): Promise<Json[]> {
    const reply = await this.request("tools/list");
    return reply.result.tools as Json[];
  }

  async callTool(name: string, args: Json = {}): Promise<{ text: string; payload: Json }> {
    const reply = await this.request("tools/call", { name, arguments: args });
    const text = reply.result.content[0].text as string;
    return { text, payload: JSON.parse(text) as Json };
  }

  /** Close stdin (host going away) and wait for the server to exit. */
  async close(timeoutMs = 8000): Promise<void> {
    this.child.stdin?.end();
    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("server did not exit after stdin close")), timeoutMs).unref(),
    );
    await Promise.race([this.exited, timer]);
  }

  kill(): void {
    this.child.kill("SIGKILL");
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function untilDead(pid: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

export function readPid(path: string): number {
  const pid = Number(readFileSync(path, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`bad pid file ${path}`);
  return pid;
}

// ---------------------------------------------------------------------------
// Two-provider fixtures and cache seeding
// ---------------------------------------------------------------------------

export const ROSTER2_JSON =
  '[{"provider":"codex","displayName":"Codex","enabled":true},{"provider":"zai","displayName":"z.ai / GLM","enabled":true}]';
export const ROSTER2: RosterEntry[] = [
  { id: "codex", displayName: "Codex", enabled: true },
  { id: "zai", displayName: "z.ai / GLM", enabled: true },
];
/** What the fake CLI prints: codex weekly 42.4% used, zai 5h 55% used. */
export const USAGE2_JSON = JSON.stringify([
  {
    provider: "codex",
    source: "oauth",
    usage: {
      updatedAt: "2026-10-13T05:00:00Z",
      secondary: { windowMinutes: 10080, usedPercent: 42.4, resetsAt: "2099-12-01T00:00:00Z" },
    },
  },
  {
    provider: "zai",
    source: "api",
    usage: {
      updatedAt: "2026-10-13T05:00:00Z",
      primary: { windowMinutes: 300, usedPercent: 55, resetsAt: "2099-12-01T00:00:00Z" },
    },
  },
]);

/** Write a shared-cache snapshot as another host would have: codex 10% used, zai 20% used. */
export function seedDisk(
  sb: Sandbox,
  opts: { ageSeconds?: number; roster?: RosterEntry[]; usedCodex?: number; usedZai?: number; resetsAt?: string } = {},
): void {
  const at = new Date(Date.now() - (opts.ageSeconds ?? 0) * 1000);
  const raw: RawEntry[] = [
    {
      provider: "codex",
      source: "oauth",
      usage: {
        updatedAt: at.toISOString(),
        secondary: { windowMinutes: 10080, usedPercent: opts.usedCodex ?? 10, resetsAt: opts.resetsAt ?? "2099-12-01T00:00:00Z" },
      },
    },
    {
      provider: "zai",
      source: "api",
      usage: {
        updatedAt: at.toISOString(),
        primary: { windowMinutes: 300, usedPercent: opts.usedZai ?? 20, resetsAt: "2099-12-01T00:00:00Z" },
      },
    },
  ];
  const cache = new QuotaCache({ cacheDir: sb.cacheDir, ttlSeconds: 300 });
  cache.writeDisk(normalizeSnapshot(raw, opts.roster ?? ROSTER2, at, { source: "cli" }));
}

export function windowUsed(payload: Record<string, any>, provider: string, windowId: string): number | null | undefined {
  const p = (payload.providers as Array<Record<string, any>>).find((x) => x.provider === provider);
  return p?.windows?.find((w: Record<string, any>) => w.id === windowId)?.usedPercent;
}

export interface ServeStub {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

/** Minimal `codexbar serve` stand-in: GET /usage and /usage?provider=<id>. */
export async function startServeStub(entries: Array<Record<string, any>>): Promise<ServeStub> {
  const requests: string[] = [];
  const server: HttpServer = createServer((req, res) => {
    requests.push(req.url ?? "");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/usage") {
      res.statusCode = 404;
      res.end();
      return;
    }
    const only = url.searchParams.get("provider");
    const body = only ? entries.filter((e) => e.provider === only) : entries;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A TCP port that nothing listens on. */
export async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
