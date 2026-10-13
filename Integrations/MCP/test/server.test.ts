import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { QuotaCache, LOCK_STALE_MS } from "../src/cache.js";
import { normalizeSnapshot } from "../src/normalize.js";
import {
  Rpc,
  makeSandbox,
  readCounter,
  readPid,
  serverEnv,
  untilDead,
  type Sandbox,
} from "./helpers.js";

function start(sb: Sandbox, extra: Record<string, string> = {}): Rpc {
  return new Rpc(serverEnv(sb, extra));
}

test("tools/list: exactly three tools; provider is an enum from the roster", async () => {
  const sb = makeSandbox();
  const rpc = start(sb);
  try {
    const init = await rpc.initialize();
    assert.ok(init.result.serverInfo);
    const tools = await rpc.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["codexbar_get_quota", "codexbar_list_quotas", "codexbar_refresh"],
    );
    const get = tools.find((t) => t.name === "codexbar_get_quota");
    assert.deepEqual(get?.inputSchema.properties.provider.enum, ["codex"]);
    assert.ok(String(get?.inputSchema.properties.provider.description).includes("codex (Codex)"));
    const refresh = tools.find((t) => t.name === "codexbar_refresh");
    assert.ok(String(refresh?.description).includes("慢（约 45 秒）"));
    assert.equal(readCounter(sb), 0, "listing tools never fetches usage");
  } finally {
    await rpc.close();
  }
});

test("list_quotas: ok result, cache hit is fast and does not respawn, maxAgeSeconds=0 refetches", async () => {
  const sb = makeSandbox();
  const rpc = start(sb);
  try {
    await rpc.initialize();
    const first = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    assert.equal(first.payload.status, "ok");
    assert.equal(first.payload.stale, false);
    assert.equal(first.payload.source, "cli");
    assert.equal(first.payload.cliVersion, "9.9.9");
    assert.deepEqual(first.payload.enabledProviders, ["codex"]);
    assert.equal(first.payload.providers[0].windows[0].id, "secondary");
    assert.ok(!first.text.includes("@"), "no email-like text in the default response");
    assert.equal(readCounter(sb), 1);

    const t0 = Date.now();
    const second = await rpc.callTool("codexbar_list_quotas", {});
    assert.ok(Date.now() - t0 < 1000, "cache hit answers in under a second");
    assert.equal(second.payload.status, "ok");
    assert.equal(readCounter(sb), 1);

    const forced = await rpc.callTool("codexbar_list_quotas", { maxAgeSeconds: 0, waitSeconds: 30 });
    assert.equal(forced.payload.status, "ok");
    assert.equal(readCounter(sb), 2);
  } finally {
    await rpc.close();
  }
});

test("TTL expiry counts as stale", async () => {
  const sb = makeSandbox();
  // Pre-seed the shared disk cache with a snapshot older than the TTL, and make the
  // refresh fail so the old data is what gets returned.
  const old = normalizeSnapshot(
    JSON.parse(`[{"provider":"codex","source":"oauth","usage":{"updatedAt":"2026-10-13T04:00:00Z","primary":{"usedPercent":10,"windowMinutes":300,"resetsAt":"2099-01-01T00:00:00Z"}}}]`),
    [{ id: "codex", displayName: "Codex", enabled: true }],
    new Date(Date.now() - 3600_000),
  );
  const seed = new QuotaCache({ cacheDir: sb.cacheDir, ttlSeconds: 300 });
  seed.writeDisk(old);
  // Hold the cross-process lock so this host cannot refresh: stale data must be flagged.
  mkdirSync(join(sb.cacheDir, "usage.lock"), { recursive: true });
  writeFileSync(join(sb.cacheDir, "usage.lock", "owner.json"), JSON.stringify({ pid: 1, at: Date.now() }));
  const rpc = start(sb);
  try {
    await rpc.initialize();
    const res = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 5 });
    assert.equal(res.payload.stale, true);
    assert.equal(res.payload.status, "stale");
    assert.ok(res.payload.ageSeconds >= 3500);
    assert.equal(typeof res.payload.retryAfterSeconds, "number");
    assert.equal(readCounter(sb), 0, "lock busy: this host did not fetch");
    // maxAgeSeconds larger than the age still reports stale relative to the server TTL.
    const lenient = await rpc.callTool("codexbar_list_quotas", { maxAgeSeconds: 86400, waitSeconds: 5 });
    assert.equal(lenient.payload.stale, true);
    assert.equal(readCounter(sb), 0);
  } finally {
    await rpc.close();
  }
});

test("stale lock (>120s) is preempted", () => {
  const dir = mkdtempSync(join(tmpdir(), "codexbar-mcp-lock-"));
  const a = new QuotaCache({ cacheDir: dir, ttlSeconds: 300 });
  const b = new QuotaCache({ cacheDir: dir, ttlSeconds: 300 });
  assert.equal(a.acquireLock(), true);
  assert.equal(b.acquireLock(), false);
  const lockPath = join(dir, "usage.lock");
  writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 1, at: Date.now() - LOCK_STALE_MS - 1000 }));
  const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
  utimesSync(lockPath, old, old);
  assert.equal(b.acquireLock(), true);
  b.releaseLock();
  assert.equal(existsSync(lockPath), false);
});

test("disk cache is written atomically with owner-only permissions", async () => {
  const sb = makeSandbox();
  const rpc = start(sb);
  try {
    await rpc.initialize();
    await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    const file = join(sb.cacheDir, "usage.json");
    assert.ok(existsSync(file));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).v, 1);
    assert.equal(existsSync(join(sb.cacheDir, "usage.lock")), false, "lock released");
  } finally {
    await rpc.close();
  }
});

test("single-flight: two concurrent cold list_quotas spawn the CLI once", async () => {
  const sb = makeSandbox();
  const rpc = start(sb, { COUNT_DELAY: "1" });
  try {
    await rpc.initialize();
    const [a, b] = await Promise.all([
      rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 }),
      rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 }),
    ]);
    assert.equal(a.payload.status, "ok");
    assert.equal(b.payload.status, "ok");
    assert.equal(readCounter(sb), 1);
  } finally {
    await rpc.close();
  }
});

test("get_quota refresh=true runs a targeted fetch and merges", async () => {
  const sb = makeSandbox();
  const rpc = start(sb);
  try {
    await rpc.initialize();
    const res = await rpc.callTool("codexbar_get_quota", { provider: "codex", refresh: true, waitSeconds: 30 });
    assert.equal(res.payload.status, "ok");
    assert.equal(res.payload.providers.length, 1);
    assert.equal(res.payload.providers[0].provider, "codex");
    assert.equal(readCounter(sb), 1);
    const bad = await rpc.request("tools/call", { name: "codexbar_get_quota", arguments: { provider: "nope" } });
    assert.equal(bad.result.isError, true);
  } finally {
    await rpc.close();
  }
});

test("codexbar_refresh returns ok, duration and snapshot", async () => {
  const sb = makeSandbox();
  const rpc = start(sb);
  try {
    await rpc.initialize();
    const res = await rpc.callTool("codexbar_refresh", {});
    assert.equal(res.payload.ok, true);
    assert.equal(typeof res.payload.durationMs, "number");
    assert.equal(res.payload.snapshot.status, "ok");
  } finally {
    await rpc.close();
  }
});

test("nested sentinel: inert mode answers list but tool calls spawn nothing", async () => {
  const sb = makeSandbox();
  const rpc = start(sb, { CODEXBAR_MCP_NESTED: "1" });
  try {
    await rpc.initialize();
    const tools = await rpc.listTools();
    assert.equal(tools.length, 3);
    for (const name of ["codexbar_list_quotas", "codexbar_get_quota", "codexbar_refresh"]) {
      const res = await rpc.callTool(name, name === "codexbar_get_quota" ? { provider: "codex" } : {});
      assert.deepEqual(res.payload, { status: "nested", providers: [] });
    }
    assert.equal(readCounter(sb), 0, "no usage spawn");
    assert.equal(existsSync(sb.cacheDir), false, "cache directory never touched");
  } finally {
    await rpc.close();
  }
});

test("missing CODEXBAR_BIN: not_installed, latched, never retried", async () => {
  const sb = makeSandbox();
  const rpc = start(sb, { CODEXBAR_BIN: join(sb.dir, "does-not-exist") });
  try {
    await rpc.initialize();
    const first = await rpc.callTool("codexbar_list_quotas", {});
    assert.equal(first.payload.status, "not_installed");
    assert.equal(typeof first.payload.hint, "string");
    // Even if the binary appears later, the latched state is not re-probed.
    writeFileSync(join(sb.dir, "does-not-exist"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const second = await rpc.callTool("codexbar_list_quotas", {});
    assert.equal(second.payload.status, "not_installed");
    const refresh = await rpc.callTool("codexbar_refresh", {});
    assert.equal(refresh.payload.status, "not_installed");
  } finally {
    await rpc.close();
  }
});

test("hard timeout kills the whole process group and reports a service error", async () => {
  const sb = makeSandbox();
  const rpc = start(sb, { SLEEP_FOREVER: "1", CODEXBAR_MCP_TIMEOUT_SECONDS: "2" });
  try {
    await rpc.initialize();
    const res = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    assert.equal(res.payload.status, "fetch_failed");
    assert.equal(res.payload.error.code, "timeout");
    const shell = readPid(sb.pidFile);
    const sleeper = readPid(sb.childPidFile);
    assert.equal(await untilDead(shell), true, "script process is dead");
    assert.equal(await untilDead(sleeper), true, "its child (same group) is dead too");
    // Server stays responsive and does not retry on its own.
    const again = await rpc.callTool("codexbar_refresh", {});
    assert.equal(again.payload.ok, false);
  } finally {
    await rpc.close();
  }
});

test("cold start with waitSeconds=1 returns warming quickly; stdin close kills the child group", async () => {
  const sb = makeSandbox();
  const rpc = start(sb, { SLEEP_FOREVER: "1", CODEXBAR_MCP_TIMEOUT_SECONDS: "90" });
  let shell = 0;
  let sleeper = 0;
  try {
    await rpc.initialize();
    const t0 = Date.now();
    const res = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 1 });
    assert.ok(Date.now() - t0 < 2500, "returns within ~2s");
    assert.equal(res.payload.status, "warming");
    assert.equal(res.payload.warming, true);
    assert.equal(res.payload.stale, true);
    assert.equal(typeof res.payload.retryAfterSeconds, "number");
    assert.deepEqual(res.payload.providers, []);
    shell = readPid(sb.pidFile);
    sleeper = readPid(sb.childPidFile);
  } finally {
    await rpc.close();
  }
  assert.equal(await untilDead(shell), true);
  assert.equal(await untilDead(sleeper), true);
});
