import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_JS = join(here, "..", "src", "server.js");

export const ROSTER_JSON = '[{"provider":"codex","displayName":"Codex","enabled":true}]';
export const USAGE_JSON =
  '[{"provider":"codex","source":"oauth","usage":{"updatedAt":"2026-10-13T05:00:00Z","primary":null,' +
  '"secondary":{"windowMinutes":10080,"usedPercent":42.4,"resetsAt":"2026-12-01T00:00:00Z"},"tertiary":null}}]';

const FAKE_SCRIPT = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "CodexBar 9.9.9"; exit 0; fi
if [ "$1" = "config" ]; then printf '%s' "$ROSTER_JSON"; exit 0; fi
if [ -n "$SLEEP_FOREVER" ]; then
  echo $$ > "$PIDFILE"
  sleep 999 &
  echo $! > "$CHILD_PIDFILE"
  wait
  exit 0
fi
n=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > "$COUNTER_FILE"
sleep "\${COUNT_DELAY:-0}"
printf '%s' "$USAGE_JSON"
`;

export interface Sandbox {
  dir: string;
  bin: string;
  cacheDir: string;
  counterFile: string;
  pidFile: string;
  childPidFile: string;
}

export function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "codexbar-mcp-test-"));
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
  };
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
    ...extra,
  };
}

type Json = Record<string, any>;

export class Rpc {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  private pending = new Map<number, (message: Json) => void>();
  private nextId = 1;

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [SERVER_JS], { env, stdio: ["pipe", "pipe", "ignore"] });
    const rl = createInterface({ input: this.child.stdout as NodeJS.ReadableStream });
    rl.on("line", (line) => {
      let message: Json;
      try {
        message = JSON.parse(line) as Json;
      } catch {
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
