import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { QuotaCache, LOCK_STALE_MS, lockStaleMsFor } from "../src/cache.js";
import { raceWithTimeout } from "../src/wait.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeSnapshot } from "../src/normalize.js";
import {
  ROSTER2_JSON,
  cleanupSandboxes,
  deadPort,
  startServeStub,
  USAGE2_JSON,
  Rpc,
  makeSandbox,
  seedDisk,
  windowUsed,
  readArgsLog,
  readCounter,
  readPid,
  serverEnv,
  untilDead,
  type Sandbox,
} from "./helpers.js";

after(() => cleanupSandboxes());

function start(sb: Sandbox, extra: Record<string, string> = {}): Rpc {
  return new Rpc(serverEnv(sb, extra));
}

test("tools/list: exactly three tools; provider is an enum from the roster", async () => {
  const sb = makeSandbox();
  const rpc = start(sb);
  try {
    const init = await rpc.initialize();
    assert.ok(init.result.serverInfo);
    const tools = await rpc.listToolsUntil(
      (list) => Array.isArray(list.find((t) => t.name === "codexbar_get_quota")?.inputSchema.properties.provider.enum),
    );
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

// ---------------------------------------------------------------------------
// Audit round 1
// ---------------------------------------------------------------------------

test("F1: exit 2/3/4 with a valid array is a normal result and fills the cache", async () => {
  for (const code of ["2", "3", "4"]) {
    const sb = makeSandbox();
    const rpc = start(sb, { EXIT_CODE: code });
    try {
      await rpc.initialize();
      const first = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
      assert.equal(first.payload.status, "ok", `exit ${code}`);
      assert.equal(first.payload.stale, false);
      assert.equal(first.payload.providers[0].status, "ok");
      assert.equal(first.payload.error, undefined);
      assert.equal(first.payload.cliExitCode, Number(code));
      const second = await rpc.callTool("codexbar_list_quotas", {});
      assert.equal(second.payload.status, "ok");
      assert.equal(readCounter(sb), 1, `exit ${code}: cached, no re-spawn`);
      assert.ok(existsSync(join(sb.cacheDir, "usage.json")), "cache file written");
    } finally {
      await rpc.close();
    }
  }
});

test("F1: exit 4 with empty stdout is fetch_failed; exit 0/1 garbage is invalid_json", async () => {
  const sb = makeSandbox();
  const rpc = start(sb, { EXIT_CODE: "4", EMPTY_OUTPUT: "1" });
  try {
    await rpc.initialize();
    const res = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    assert.equal(res.payload.status, "fetch_failed");
    assert.equal(res.payload.error.code, "cli_exit_4");
    assert.deepEqual(res.payload.providers, []);
  } finally {
    await rpc.close();
  }
  const sb2 = makeSandbox();
  const rpc2 = start(sb2, { EXIT_CODE: "1", EMPTY_OUTPUT: "1" });
  try {
    await rpc2.initialize();
    const res = await rpc2.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    assert.equal(res.payload.status, "fetch_failed");
    assert.equal(res.payload.error.code, "invalid_json");
  } finally {
    await rpc2.close();
  }
});

test("F1: exit 64 is a service error even if stdout happens to be a JSON array", async () => {
  const sb = makeSandbox();
  const rpc = start(sb, { EXIT_CODE: "64" });
  try {
    await rpc.initialize();
    const res = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    assert.equal(res.payload.status, "fetch_failed");
    assert.equal(res.payload.error.code, "cli_exit_64");
    assert.equal(readArgsLog(sb).length, 1);
  } finally {
    await rpc.close();
  }
});

test("F6: live path - emails in details/pace/plan never reach the response, with or without includeDetails", async () => {
  const sb = makeSandbox();
  const mail = "leak.me@example.org";
  const usage = JSON.stringify([
    {
      provider: "codex",
      source: "oauth",
      usage: {
        updatedAt: "2026-10-13T05:00:00Z",
        loginMethod: `pro ${mail}`,
        primary: { usedPercent: 5, windowMinutes: 300, resetsAt: "2099-01-01T00:00:00Z" },
        details: [{ title: `t ${mail}`, rows: [{ label: "l", value: `v ${mail}`, secondaryValue: `s ${mail}` }] }],
      },
      pace: { primary: { summary: `ping ${mail}`, stage: "onTrack" } },
    },
  ]);
  const rpc = start(sb, { USAGE_JSON: usage });
  try {
    await rpc.initialize();
    const plain = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    assert.ok(!plain.text.includes("@"));
    const withDetails = await rpc.callTool("codexbar_list_quotas", { includeDetails: true });
    assert.ok(!withDetails.text.includes("@"));
    assert.ok(withDetails.text.includes("<redacted>"));
    const one = await rpc.callTool("codexbar_get_quota", { provider: "codex", includeDetails: true });
    assert.ok(!one.text.includes("@"));
  } finally {
    await rpc.close();
  }
});

test("F12: closing stdin while the startup probes are still running kills the probe process groups", async () => {
  const sb = makeSandbox();
  const rpc = start(sb, { PROBE_SLEEP: "1" });
  // Do not initialize: the host goes away right after spawning us.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !(existsSync(sb.probePidFile) && existsSync(sb.probeChildPidFile))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(existsSync(sb.probePidFile), "probe was spawned");
  const shell = readPid(sb.probePidFile);
  const sleeper = readPid(sb.probeChildPidFile);
  // Well under the 5 s probe timeout: the death must come from the shutdown path, not the timeout.
  await rpc.close(3000);
  assert.equal(await untilDead(shell, 2500), true, "probe script dead");
  assert.equal(await untilDead(sleeper, 2500), true, "probe sleep child dead");
});

test("F12: SIGTERM during the startup probes kills the probe process groups", async () => {
  const sb = makeSandbox();
  const rpc = start(sb, { PROBE_SLEEP: "1" });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !(existsSync(sb.probePidFile) && existsSync(sb.probeChildPidFile))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const shell = readPid(sb.probePidFile);
  const sleeper = readPid(sb.probeChildPidFile);
  rpc.child.kill("SIGTERM");
  await rpc.exited;
  assert.equal(await untilDead(shell, 2500), true);
  assert.equal(await untilDead(sleeper, 2500), true);
});

test("F13: descendants left behind by a CLI that exited normally are swept", async () => {
  const sb = makeSandbox();
  // The descendant inherits stdout (holds the pipe open) and outlives its parent.
  const rpc = start(sb, { FORK_DESCENDANT: "1" });
  try {
    await rpc.initialize();
    const t0 = Date.now();
    const res = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    assert.equal(res.payload.status, "ok");
    assert.ok(Date.now() - t0 < 10_000, "not held up by the lingering descendant");
    const sleeper = readPid(sb.childPidFile);
    assert.equal(await untilDead(sleeper), true, "descendant killed once the CLI returned");
  } finally {
    await rpc.close();
  }
});

test("F14: a full refresh queued behind a targeted fetch really runs, one child at a time", async () => {
  const sb = makeSandbox();
  seedDisk(sb); // codex 10%, zai 20%, fresh
  const rpc = start(sb, { ROSTER_JSON: ROSTER2_JSON, USAGE_JSON: USAGE2_JSON, COUNT_DELAY: "1" });
  try {
    await rpc.initialize();
    const targeted = rpc.callTool("codexbar_get_quota", { provider: "zai", refresh: true, waitSeconds: 30 });
    const full = rpc.callTool("codexbar_list_quotas", { maxAgeSeconds: 0, waitSeconds: 30 });
    const [t, f] = await Promise.all([targeted, full]);
    assert.equal(t.payload.status, "ok");
    assert.equal(f.payload.status, "ok");
    const log = readArgsLog(sb);
    assert.equal(log.length, 2, "targeted + full = two spawns");
    assert.ok(log[0]?.includes("--provider zai"), "targeted ran first");
    assert.ok(!log[1]?.includes("--provider"), "then the full fetch");
    assert.equal(existsSync(sb.overlapFile), false, "never two children at once");
    // The full refresh really refreshed every provider.
    assert.equal(windowUsed(f.payload, "codex", "secondary"), 42.4);
    assert.equal(windowUsed(f.payload, "zai", "primary"), 55);
  } finally {
    await rpc.close();
  }
});

test("F14: codexbar_refresh waiting behind a targeted fetch returns the result of its own full fetch", async () => {
  const sb = makeSandbox();
  seedDisk(sb);
  const rpc = start(sb, { ROSTER_JSON: ROSTER2_JSON, USAGE_JSON: USAGE2_JSON, COUNT_DELAY: "1" });
  try {
    await rpc.initialize();
    const targeted = rpc.callTool("codexbar_get_quota", { provider: "codex", refresh: true, waitSeconds: 30 });
    const refresh = rpc.callTool("codexbar_refresh", {});
    const [, r] = await Promise.all([targeted, refresh]);
    assert.equal(r.payload.ok, true);
    assert.equal(windowUsed(r.payload.snapshot, "zai", "primary"), 55, "zai refreshed by the full fetch");
    assert.equal(readArgsLog(sb).length, 2);
    assert.equal(existsSync(sb.overlapFile), false);
  } finally {
    await rpc.close();
  }
});

test("F14: same-scope and covered requests still share one fetch", async () => {
  const sb = makeSandbox();
  seedDisk(sb);
  const rpc = start(sb, { ROSTER_JSON: ROSTER2_JSON, USAGE_JSON: USAGE2_JSON, COUNT_DELAY: "1" });
  try {
    await rpc.initialize();
    const results = await Promise.all([
      rpc.callTool("codexbar_list_quotas", { maxAgeSeconds: 0, waitSeconds: 30 }),
      rpc.callTool("codexbar_get_quota", { provider: "zai", refresh: true, waitSeconds: 30 }),
      rpc.callTool("codexbar_list_quotas", { maxAgeSeconds: 0, waitSeconds: 30 }),
    ]);
    for (const r of results) assert.equal(r.payload.status, "ok");
    assert.equal(readCounter(sb), 1, "full fetch covers the targeted request");
  } finally {
    await rpc.close();
  }
});

test("F8: a targeted refresh does not make the other providers' old data look fresh", async () => {
  const sb = makeSandbox();
  seedDisk(sb, { ageSeconds: 3600 }); // everything an hour old
  const rpc = start(sb, { ROSTER_JSON: ROSTER2_JSON, USAGE_JSON: USAGE2_JSON });
  try {
    await rpc.initialize();
    const t = await rpc.callTool("codexbar_get_quota", { provider: "codex", refresh: true, waitSeconds: 30 });
    assert.ok(readArgsLog(sb)[0]?.includes("--provider codex"));
    assert.ok(t.payload.ageSeconds >= 3500, `ageSeconds stays old, got ${t.payload.ageSeconds}`);
    assert.equal(t.payload.stale, true);
    assert.equal(windowUsed(t.payload, "codex", "secondary"), 42.4, "refreshed provider has new data");
    const all = await rpc.callTool("codexbar_list_quotas", { maxAgeSeconds: 86_400 });
    assert.ok(all.payload.ageSeconds >= 3500);
    assert.equal(all.payload.stale, true);
    assert.equal(windowUsed(all.payload, "zai", "primary"), 20, "other provider keeps its old value");
    assert.equal(readCounter(sb), 1, "no extra fetch");
  } finally {
    await rpc.close();
  }
});

test("F2: serve mode, no cache: a first targeted refresh does the full fetch, the roster is not narrowed", async () => {
  const entries = JSON.parse(USAGE2_JSON) as Array<Record<string, any>>;
  const stub = await startServeStub(entries);
  const sb = makeSandbox();
  const rpc = start(sb, { CODEXBAR_SERVE_URL: stub.url });
  try {
    await rpc.initialize();
    const one = await rpc.callTool("codexbar_get_quota", { provider: "zai", refresh: true, waitSeconds: 30 });
    assert.equal(one.payload.status, "ok");
    assert.deepEqual(stub.requests, ["/usage"], "full fetch, not /usage?provider=");
    assert.equal(one.payload.providers.length, 1);
    const all = await rpc.callTool("codexbar_list_quotas", {});
    assert.deepEqual(
      all.payload.providers.map((p: { provider: string }) => p.provider),
      ["codex", "zai"],
    );
    assert.deepEqual(all.payload.enabledProviders, ["codex", "zai"]);
    assert.equal(all.payload.status, "ok");
    assert.equal(stub.requests.length, 1, "list answered from the cache");
    assert.equal(readCounter(sb), 0, "serve mode never spawns");
  } finally {
    await rpc.close();
    await stub.close();
  }
});

test("F3: cold start get_quota refresh=true fetches everything: no synthesized missing, nothing fake on disk", async () => {
  const sb = makeSandbox();
  const rpc = start(sb, { ROSTER_JSON: ROSTER2_JSON, USAGE_JSON: USAGE2_JSON });
  try {
    await rpc.initialize();
    const one = await rpc.callTool("codexbar_get_quota", { provider: "codex", refresh: true, waitSeconds: 30 });
    assert.equal(one.payload.status, "ok");
    assert.ok(!readArgsLog(sb)[0]?.includes("--provider"), "went full because there was no base snapshot");
    const all = await rpc.callTool("codexbar_list_quotas", {});
    for (const p of all.payload.providers) assert.equal(p.status, "ok", `${p.provider} is real data`);
    assert.equal(readCounter(sb), 1);
    const disk = JSON.parse(readFileSync(join(sb.cacheDir, "usage.json"), "utf8"));
    assert.ok(!JSON.stringify(disk).includes('"missing"'), "no synthesized missing entries persisted");
    assert.deepEqual(disk.snapshot.enabledProviders, ["codex", "zai"]);
  } finally {
    await rpc.close();
  }
});

test("F17: providers no longer enabled disappear from a cached snapshot; newly enabled ones appear as missing", async () => {
  const sbA = makeSandbox();
  seedDisk(sbA); // cached: codex + zai, fresh
  const rpcA = start(sbA); // roster is only codex
  try {
    await rpcA.initialize();
    const res = await rpcA.callTool("codexbar_list_quotas", {});
    assert.deepEqual(res.payload.providers.map((p: { provider: string }) => p.provider), ["codex"]);
    assert.deepEqual(res.payload.enabledProviders, ["codex"]);
    assert.equal(readCounter(sbA), 0, "fresh cache, no fetch");
  } finally {
    await rpcA.close();
  }

  const sbB = makeSandbox();
  seedDisk(sbB, { roster: [{ id: "codex", displayName: "Codex", enabled: true }] }); // cached: codex only
  const rpcB = start(sbB, { ROSTER_JSON: ROSTER2_JSON, USAGE_JSON: USAGE2_JSON });
  try {
    await rpcB.initialize();
    const res = await rpcB.callTool("codexbar_list_quotas", {});
    assert.deepEqual(res.payload.providers.map((p: { provider: string }) => p.provider), ["codex", "zai"]);
    assert.equal(res.payload.providers[1].error.code, "missing");
    assert.deepEqual(res.payload.enabledProviders, ["codex", "zai"]);
    assert.equal(readCounter(sbB), 0);
  } finally {
    await rpcB.close();
  }
});

// Round-2 ruling: DESIGN v1.3 5.1 (a targeted failure is a recorded STATE until a refresh covering the
// provider succeeds), REVERIFY-1 N6, FIX-ROUND-2-ADDENDUM. Renamed from the round-1 title
// "F5: a failed targeted refresh stays on that provider; list_quotas keeps reporting fresh data as ok".
// Only the two assertions marked "ruling" changed; status/stale/error stay as they were.
test("F5: a failed targeted refresh is recorded on that provider only; the snapshot-level state stays ok", async () => {
  const sb = makeSandbox();
  const rpc = start(sb, {
    ROSTER_JSON: ROSTER2_JSON,
    USAGE_JSON: USAGE2_JSON,
    TARGETED_HANG: "1",
    CODEXBAR_MCP_TIMEOUT_SECONDS: "2",
  });
  try {
    await rpc.initialize();
    const full = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    assert.equal(full.payload.status, "ok");
    const targeted = await rpc.callTool("codexbar_get_quota", { provider: "codex", refresh: true, waitSeconds: 30 });
    assert.ok(readArgsLog(sb).length === 1, "targeted run hangs before logging; only the full run is logged");
    assert.equal(targeted.payload.providers[0].status, "error");
    assert.equal(targeted.payload.providers[0].error.code, "timeout");
    assert.equal(targeted.payload.stale, true);
    const after = await rpc.callTool("codexbar_list_quotas", {});
    assert.equal(after.payload.status, "ok");
    assert.equal(after.payload.stale, false);
    assert.equal(after.payload.error, undefined, "no snapshot-level error");
    assert.deepEqual(after.payload.failedProviders, ["codex"]); // ruling: was []
    // ruling: was "every provider is ok" - the failed provider keeps its error, the others are ok
    const afterByProvider = Object.fromEntries(
      after.payload.providers.map((p: { provider: string }) => [p.provider, p]),
    ) as Record<string, { status: string; error?: { code: string } }>;
    assert.equal(afterByProvider.codex?.status, "error");
    assert.equal(afterByProvider.codex?.error?.code, "timeout");
    assert.ok(
      Object.entries(afterByProvider).every(([id, p]) => id === "codex" || p.status === "ok"),
      "every other provider is ok",
    );
    // And codexbar_refresh's ok only reflects its own full fetch.
    const refreshed = await rpc.callTool("codexbar_refresh", {});
    assert.equal(refreshed.payload.ok, true);
  } finally {
    await rpc.close();
  }
});

test("F4: releaseLock leaves a lock that now belongs to someone else", () => {
  const dir = mkdtempSync(join(tmpdir(), "codexbar-mcp-lock-"));
  const lockPath = join(dir, "usage.lock");
  // (a) another pid owns it
  const a = new QuotaCache({ cacheDir: dir, ttlSeconds: 300 });
  assert.equal(a.acquireLock(), true);
  writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 1, token: "other", at: Date.now() }));
  a.releaseLock();
  assert.equal(existsSync(lockPath), true, "foreign owner.pid: directory kept");
  rmSync(lockPath, { recursive: true, force: true });

  // (b) same pid (same process) but a different token: a stale holder must not delete the new lease
  const holder = new QuotaCache({ cacheDir: dir, ttlSeconds: 300 });
  const preemptor = new QuotaCache({ cacheDir: dir, ttlSeconds: 300 });
  assert.equal(holder.acquireLock(), true);
  const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
  writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token: "t", at: old.getTime() }));
  assert.equal(preemptor.acquireLock(), true, "stale lock preempted");
  holder.releaseLock(); // the old holder finishes late
  assert.equal(existsSync(lockPath), true, "preemptor's lock survives the late release");
  const third = new QuotaCache({ cacheDir: dir, ttlSeconds: 300 });
  assert.equal(third.acquireLock(), false, "still held by the preemptor");
  preemptor.releaseLock();
  assert.equal(existsSync(lockPath), false, "owner releases its own lock");
});

test("F4: stale threshold follows the hard timeout instead of a fixed 120 s", () => {
  assert.equal(lockStaleMsFor(90), 120_000);
  assert.equal(lockStaleMsFor(600), 630_000);
  const dir = mkdtempSync(join(tmpdir(), "codexbar-mcp-lock-"));
  const a = new QuotaCache({ cacheDir: dir, ttlSeconds: 300, lockStaleMs: lockStaleMsFor(600) });
  const b = new QuotaCache({ cacheDir: dir, ttlSeconds: 300, lockStaleMs: lockStaleMsFor(600) });
  assert.equal(a.acquireLock(), true);
  const lockPath = join(dir, "usage.lock");
  // A healthy fetch that has been running for 150 s (hard timeout 600 s) must not be preempted.
  writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token: "x", at: Date.now() - 150_000 }));
  assert.equal(b.acquireLock(), false);
  a.releaseLock();
});

test("F15: serve mode does not adopt a CLI-written disk cache; a dead serve is a fetch failure", async () => {
  const sb = makeSandbox();
  seedDisk(sb); // a fresh CLI-mode snapshot sits in the shared cache directory
  const port = await deadPort();
  const rpc = start(sb, { CODEXBAR_SERVE_URL: `http://127.0.0.1:${port}` });
  try {
    await rpc.initialize();
    const res = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 10 });
    assert.equal(res.payload.status, "fetch_failed");
    assert.equal(res.payload.source, "serve");
    assert.equal(res.payload.error.code, "http_error");
    assert.deepEqual(res.payload.providers, []);
    assert.equal(readCounter(sb), 0, "serve mode never spawns");
    const disk = JSON.parse(readFileSync(join(sb.cacheDir, "usage.json"), "utf8"));
    assert.equal(disk.snapshot.source, "cli", "the CLI cache file was left untouched");
  } finally {
    await rpc.close();
  }
});

test("F15: serve mode never writes the disk cache either", async () => {
  const stub = await startServeStub(JSON.parse(USAGE2_JSON) as Array<Record<string, any>>);
  const sb = makeSandbox();
  const rpc = start(sb, { CODEXBAR_SERVE_URL: stub.url });
  try {
    await rpc.initialize();
    const res = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 10 });
    assert.equal(res.payload.status, "ok");
    assert.equal(existsSync(join(sb.cacheDir, "usage.json")), false);
  } finally {
    await rpc.close();
    await stub.close();
  }
});

test("F16: an expired in-memory snapshot is replaced by a newer one another host wrote, without fetching", async () => {
  const sb = makeSandbox();
  seedDisk(sb, { ageSeconds: 3600, usedCodex: 10 });
  const rpc = start(sb, { ROSTER_JSON: ROSTER2_JSON, USAGE_JSON: USAGE2_JSON });
  try {
    await rpc.initialize(); // preloads the old snapshot (memory is now expired)
    seedDisk(sb, { ageSeconds: 0, usedCodex: 77 }); // "host A" refreshed the shared cache
    const res = await rpc.callTool("codexbar_list_quotas", {});
    assert.equal(res.payload.status, "ok");
    assert.equal(res.payload.stale, false);
    assert.equal(windowUsed(res.payload, "codex", "secondary"), 77);
    assert.equal(readCounter(sb), 0, "adopted the shared snapshot instead of spawning");
  } finally {
    await rpc.close();
  }
});

test("F16: an empty in-memory cache adopts a snapshot written after startup", async () => {
  const sb = makeSandbox();
  const rpc = start(sb, { ROSTER_JSON: ROSTER2_JSON, USAGE_JSON: USAGE2_JSON });
  try {
    await rpc.initialize(); // nothing on disk yet
    seedDisk(sb, { ageSeconds: 0, usedCodex: 33 });
    const res = await rpc.callTool("codexbar_list_quotas", {});
    assert.equal(res.payload.status, "ok");
    assert.equal(windowUsed(res.payload, "codex", "secondary"), 33);
    assert.equal(readCounter(sb), 0);
  } finally {
    await rpc.close();
  }
});

test("F16: two resident hosts on one cache directory spawn the CLI once between them", async () => {
  const sb = makeSandbox();
  const env = { ROSTER_JSON: ROSTER2_JSON, USAGE_JSON: USAGE2_JSON, COUNT_DELAY: "1" };
  const a = start(sb, env);
  const b = start(sb, env);
  try {
    await Promise.all([a.initialize(), b.initialize()]);
    const first = await a.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    assert.equal(first.payload.status, "ok");
    const second = await b.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    assert.equal(second.payload.status, "ok");
    assert.equal(readCounter(sb), 1, "host B used host A's shared snapshot");
  } finally {
    await a.close();
    await b.close();
  }
});

test("F18: a failed refresh with an old cache keeps the data but reports fetch_failed", async () => {
  for (const code of ["64", "2"]) {
    const sb = makeSandbox();
    seedDisk(sb, { ageSeconds: 3600 });
    const rpc = start(sb, { ROSTER_JSON: ROSTER2_JSON, USAGE_JSON: USAGE2_JSON, EXIT_CODE: code, EMPTY_OUTPUT: "1" });
    try {
      await rpc.initialize();
      const res = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
      assert.equal(res.payload.status, "fetch_failed", `exit ${code}`);
      assert.equal(res.payload.error.code, `cli_exit_${code}`);
      assert.equal(res.payload.stale, true);
      assert.equal(res.payload.providers.length, 2, "old data is still returned");
      assert.equal(windowUsed(res.payload, "codex", "secondary"), 10);
      // The failure did not overwrite the shared cache.
      const disk = JSON.parse(readFileSync(join(sb.cacheDir, "usage.json"), "utf8"));
      assert.equal(disk.snapshot.providers[0].windows[0].usedPercent, 10);
    } finally {
      await rpc.close();
    }
  }
});

test("F19: a wait that times out marks even a TTL-fresh snapshot stale (warming implies stale)", async () => {
  const sb = makeSandbox();
  seedDisk(sb, { ageSeconds: 0 });
  const rpc = start(sb, { ROSTER_JSON: ROSTER2_JSON, USAGE_JSON: USAGE2_JSON, COUNT_DELAY: "2" });
  try {
    await rpc.initialize();
    const res = await rpc.callTool("codexbar_list_quotas", { maxAgeSeconds: 0, waitSeconds: 0 });
    assert.equal(res.payload.warming, true);
    assert.equal(res.payload.stale, true);
    assert.equal(res.payload.status, "stale");
    assert.equal(typeof res.payload.retryAfterSeconds, "number");
    assert.ok(res.payload.ageSeconds < 300, "the snapshot itself is within the TTL");
    assert.equal(res.payload.providers.length, 2);
  } finally {
    await rpc.close();
  }
});

test("F7: a source that always reports a past resetsAt is not re-fetched on every call", async () => {
  const sb = makeSandbox();
  const past = JSON.stringify([
    {
      provider: "codex",
      source: "oauth",
      usage: { updatedAt: "2026-10-13T05:00:00Z", primary: { usedPercent: 50, windowMinutes: 300, resetsAt: "2020-01-01T00:00:00Z" } },
    },
  ]);
  const rpc = start(sb, { USAGE_JSON: past });
  try {
    await rpc.initialize();
    const first = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    assert.equal(first.payload.providers[0].windows[0].resetPassed, true);
    assert.equal(first.payload.stale, true);
    const second = await rpc.callTool("codexbar_list_quotas", {});
    const third = await rpc.callTool("codexbar_list_quotas", {});
    assert.equal(second.payload.stale, true, "still reported as stale");
    assert.equal(third.payload.stale, true);
    assert.equal(readCounter(sb), 1, "one spawn for three calls");
  } finally {
    await rpc.close();
  }
});

test("F7: a reset-driven refresh happens once the snapshot is older than 60 s, but not after a failed refresh", async () => {
  // Old enough (120 s) with a passed reset: one refresh is allowed.
  const sb = makeSandbox();
  seedDisk(sb, { ageSeconds: 120, resetsAt: "2020-01-01T00:00:00Z" });
  const rpc = start(sb, { ROSTER_JSON: ROSTER2_JSON, USAGE_JSON: USAGE2_JSON });
  try {
    await rpc.initialize();
    const res = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    assert.equal(readCounter(sb), 1, "reset-driven refresh ran");
    assert.equal(res.payload.status, "ok");
  } finally {
    await rpc.close();
  }
  // Same situation, but the refresh fails: it is not retried on the following calls.
  const sb2 = makeSandbox();
  seedDisk(sb2, { ageSeconds: 120, resetsAt: "2020-01-01T00:00:00Z" });
  const rpc2 = start(sb2, { ROSTER_JSON: ROSTER2_JSON, USAGE_JSON: USAGE2_JSON, EXIT_CODE: "64", EMPTY_OUTPUT: "1" });
  try {
    await rpc2.initialize();
    const a = await rpc2.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    assert.equal(a.payload.status, "fetch_failed");
    const b = await rpc2.callTool("codexbar_list_quotas", {});
    const c = await rpc2.callTool("codexbar_list_quotas", {});
    assert.equal(b.payload.status, "fetch_failed");
    assert.equal(c.payload.status, "fetch_failed");
    assert.equal(readCounter(sb2), 1, "no retry storm after a failure");
  } finally {
    await rpc2.close();
  }
});

test("F20: a structurally broken shared cache is ignored and the server fetches normally", async () => {
  const good = JSON.parse(
    (() => {
      const sb = makeSandbox();
      seedDisk(sb);
      return readFileSync(join(sb.cacheDir, "usage.json"), "utf8");
    })(),
  ) as { v: number; fetchedAt: string; snapshot: Record<string, any> };
  const now = new Date().toISOString();
  const broken: Array<[string, string]> = [
    ["empty snapshot", JSON.stringify({ v: 1, fetchedAt: now, snapshot: {} })],
    ["providers not an array", JSON.stringify({ v: 1, fetchedAt: now, snapshot: { ...good.snapshot, providers: {} } })],
    ["provider without windows", JSON.stringify({ v: 1, fetchedAt: now, snapshot: { ...good.snapshot, providers: [{ provider: "codex", displayName: "Codex", status: "ok" }] } })],
    ["bad status value", JSON.stringify({ v: 1, fetchedAt: now, snapshot: { ...good.snapshot, providers: [{ provider: "codex", displayName: "Codex", status: "weird", windows: [] }] } })],
    ["window with bad id", JSON.stringify({ v: 1, fetchedAt: now, snapshot: { ...good.snapshot, providers: [{ provider: "codex", displayName: "Codex", status: "ok", windows: [{ id: "x" }] }] } })],
    ["truncated JSON", '{"v":1,"fetchedAt":"2026'],
    ["array instead of object", "[]"],
  ];
  for (const [label, content] of broken) {
    const sb = makeSandbox();
    mkdirSync(sb.cacheDir, { recursive: true });
    writeFileSync(join(sb.cacheDir, "usage.json"), content);
    const rpc = start(sb);
    try {
      await rpc.initialize();
      const res = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
      assert.equal(res.payload.status, "ok", label);
      assert.equal(readCounter(sb), 1, `${label}: fetched normally`);
      assert.equal(res.payload.providers[0].provider, "codex");
      // and the next call is served from the repaired cache
      const again = await rpc.callTool("codexbar_list_quotas", {});
      assert.equal(again.payload.status, "ok");
      assert.equal(readCounter(sb), 1);
    } finally {
      await rpc.close();
    }
  }
});

test("F20: a broken cache written after startup is ignored on the adopt path too", async () => {
  const sb = makeSandbox();
  const rpc = start(sb);
  try {
    await rpc.initialize();
    mkdirSync(sb.cacheDir, { recursive: true });
    writeFileSync(join(sb.cacheDir, "usage.json"), JSON.stringify({ v: 1, fetchedAt: new Date().toISOString(), snapshot: {} }));
    const res = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    assert.equal(res.payload.status, "ok");
    assert.equal(readCounter(sb), 1);
  } finally {
    await rpc.close();
  }
});

test("F21: raceWithTimeout leaves no timer behind when the promise wins, and still times out otherwise", async () => {
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const before = timers();
  assert.equal(await raceWithTimeout(Promise.resolve(), 60_000), "settled");
  assert.equal(await raceWithTimeout(Promise.reject(new Error("boom")), 60_000), "settled");
  assert.equal(timers(), before, "60 s timers were cleared");
  assert.equal(await raceWithTimeout(new Promise(() => {}), 20), "timeout");
  assert.equal(timers(), before, "the fired timer is gone too");
});

function timerPreload(dir: string): string {
  const file = join(dir, "timer-audit.mjs");
  writeFileSync(
    file,
    `import { writeFileSync } from "node:fs";
const live = new Map();
let seq = 0;
const KEY = Symbol("key");
const realSet = globalThis.setTimeout;
const realClear = globalThis.clearTimeout;
globalThis.setTimeout = function (fn, ms, ...rest) {
  const key = ++seq;
  const timer = realSet(function () { live.delete(key); return fn.apply(this, arguments); }, ms, ...rest);
  timer[KEY] = key;
  live.set(key, ms);
  return timer;
};
globalThis.clearTimeout = function (timer) {
  if (timer && timer[KEY]) live.delete(timer[KEY]);
  return realClear(timer);
};
process.on("exit", () => writeFileSync(process.env.TIMER_REPORT, JSON.stringify([...live.values()])));
`,
  );
  return file;
}

test("F21: after a fast fetch no long per-call timer is left alive (observed from inside the server process)", async () => {
  const sb = makeSandbox();
  const report = join(sb.dir, "timers.json");
  const preload = timerPreload(sb.dir);
  const rpc = new Rpc(serverEnv(sb, { TIMER_REPORT: report, COUNT_DELAY: "0.1" }), ["--import", pathToFileURL(preload).href]);
  try {
    await rpc.initialize();
    for (let i = 0; i < 3; i++) {
      const res = await rpc.callTool("codexbar_list_quotas", { maxAgeSeconds: 0, waitSeconds: 60 });
      assert.equal(res.payload.status, "ok");
    }
  } finally {
    const t0 = Date.now();
    await rpc.close(1000); // must exit promptly
    assert.ok(Date.now() - t0 < 1000);
  }
  const outstanding = (JSON.parse(readFileSync(report, "utf8")) as number[]).filter((ms) => ms >= 30_000);
  assert.deepEqual(outstanding, [], "no 60 s wait timer or 90 s hard-timeout timer survived");
});

test("F21: negative control - the same observer does see the timers of a call that is still waiting", async () => {
  const sb = makeSandbox();
  const report = join(sb.dir, "timers.json");
  const preload = timerPreload(sb.dir);
  const rpc = new Rpc(serverEnv(sb, { TIMER_REPORT: report, SLEEP_FOREVER: "1" }), ["--import", pathToFileURL(preload).href]);
  await rpc.initialize();
  void rpc.callTool("codexbar_list_quotas", { waitSeconds: 60 }).catch(() => undefined);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !existsSync(sb.pidFile)) await new Promise((r) => setTimeout(r, 20));
  await rpc.close();
  const outstanding = (JSON.parse(readFileSync(report, "utf8")) as number[]).filter((ms) => ms >= 30_000);
  assert.ok(outstanding.includes(60_000), "wait timer visible while the call is pending");
  assert.ok(outstanding.includes(90_000), "hard-timeout timer visible while the child runs");
});

test("F9: a hung roster probe never delays initialize; tools/list degrades within its cap; the probe is killed at 5 s", async () => {
  const sb = makeSandbox();
  const rpc = start(sb, { PROBE_SLEEP: "1" });
  try {
    const t0 = Date.now();
    await rpc.initialize();
    const initMs = Date.now() - t0;
    assert.ok(initMs < 1500, `initialize answered in ${initMs} ms, independent of the probe`);

    const t1 = Date.now();
    const tools = await rpc.listTools();
    const listMs = Date.now() - t1;
    assert.ok(listMs < 4000, `tools/list answered in ${listMs} ms (cap 2 s)`);
    assert.equal(tools.length, 3);
    const provider = tools.find((t) => t.name === "codexbar_get_quota")?.inputSchema.properties.provider;
    assert.equal(provider.enum, undefined, "no roster yet: plain string schema");

    // Tools keep working without the roster (it is derived from the first payload).
    const res = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    assert.equal(res.payload.status, "ok");
    assert.deepEqual(res.payload.enabledProviders, ["codex"]);

    const shell = readPid(sb.probePidFile);
    const sleeper = readPid(sb.probeChildPidFile);
    assert.equal(await untilDead(shell, 9000), true, "hung probe killed by its 5 s timeout");
    assert.equal(await untilDead(sleeper, 9000), true);
  } finally {
    await rpc.close();
  }
});

// ---------------------------------------------------------------------------
// Audit round 2
// ---------------------------------------------------------------------------

test("G1: a valid disk cache written by the previous normalizer (2939c19de) never leaks addresses after preload", async () => {
  const sb = makeSandbox();
  // Build a REAL old-format snapshot with the baseline normalizer from git history.
  const here = dirname(fileURLToPath(import.meta.url));
  const source = execFileSync("git", ["show", "2939c19de:Integrations/MCP/src/normalize.ts"], {
    cwd: here,
    encoding: "utf8",
  });
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const oldFile = join(sb.dir, "old-normalize.mjs");
  writeFileSync(oldFile, js);
  const old = (await import(pathToFileURL(oldFile).href)) as {
    normalizeSnapshot: (raw: unknown, roster: unknown, now: Date, opts: unknown) => Record<string, unknown>;
  };
  const mail = "legacy.person@example.org";
  const raw = [
    {
      provider: "codex",
      source: "oauth",
      usage: {
        updatedAt: new Date().toISOString(),
        loginMethod: `pro ${mail}`,
        primary: { usedPercent: 12, windowMinutes: 300, resetsAt: "2099-01-01T00:00:00Z" },
        identity: { accountEmail: mail },
        details: [{ title: `t ${mail}`, rows: [{ label: `l ${mail}`, value: `v ${mail}`, secondaryValue: `s ${mail}` }] }],
      },
      pace: { primary: { summary: `deficit ${mail}`, stage: "onTrack" } },
    },
  ];
  const legacy = old.normalizeSnapshot(raw, [{ id: "codex", displayName: "Codex", enabled: true }], new Date(), {
    source: "cli",
  }) as { fetchedAt: string };
  assert.ok(JSON.stringify(legacy).includes("legacy.person@"), "sanity: the old normalizer left the address in the snapshot");
  mkdirSync(sb.cacheDir, { recursive: true });
  writeFileSync(join(sb.cacheDir, "usage.json"), JSON.stringify({ v: 1, fetchedAt: legacy.fetchedAt, snapshot: legacy }));

  const rpc = start(sb);
  try {
    await rpc.initialize();
    const plain = await rpc.callTool("codexbar_list_quotas", {});
    assert.equal(plain.payload.status, "ok", "served from the preloaded cache");
    assert.equal(readCounter(sb), 0);
    assert.ok(!plain.text.includes("@"), "default list has no address");
    const detailed = await rpc.callTool("codexbar_get_quota", { provider: "codex", includeDetails: true });
    assert.ok(!detailed.text.includes("@"), "includeDetails=true without includeIdentity has no address");
    assert.equal(detailed.payload.providers[0].identity, undefined);
    assert.ok(detailed.text.includes("<redacted>"));
    // Only the explicit opt-in releases the identity field, and nothing else.
    const identified = await rpc.callTool("codexbar_list_quotas", { includeIdentity: true, includeDetails: true });
    assert.equal(identified.text.split("@").length - 1, 1);
    assert.equal(identified.payload.providers[0].identity.accountEmail, mail);
  } finally {
    await rpc.close();
  }
});

test("G2: a targeted refresh merges into the newest shared snapshot and never rolls the disk back", async () => {
  const sb = makeSandbox();
  seedDisk(sb, { ageSeconds: 3600, usedCodex: 10, usedZai: 20 }); // old snapshot, loaded at startup
  const rpc = start(sb, { ROSTER_JSON: ROSTER2_JSON, USAGE_JSON: USAGE2_JSON });
  try {
    await rpc.initialize();
    seedDisk(sb, { ageSeconds: 0, usedCodex: 11, usedZai: 90 }); // another host refreshed everything
    const newer = JSON.parse(readFileSync(join(sb.cacheDir, "usage.json"), "utf8"));
    assert.equal(windowUsed({ providers: newer.snapshot.providers }, "zai", "primary"), 90);

    const res = await rpc.callTool("codexbar_get_quota", { provider: "codex", refresh: true, waitSeconds: 30 });
    assert.ok(readArgsLog(sb)[0]?.includes("--provider codex"), "targeted fetch of codex only");
    assert.equal(windowUsed(res.payload, "codex", "secondary"), 42.4);

    const disk = JSON.parse(readFileSync(join(sb.cacheDir, "usage.json"), "utf8"));
    assert.equal(windowUsed({ providers: disk.snapshot.providers }, "zai", "primary"), 90, "zai stays at the newer value");
    assert.equal(windowUsed({ providers: disk.snapshot.providers }, "codex", "secondary"), 42.4, "codex refreshed");
    assert.ok(Date.parse(disk.fetchedAt) >= Date.parse(newer.fetchedAt), "fetchedAt did not move backwards");
    const all = await rpc.callTool("codexbar_list_quotas", {});
    assert.equal(windowUsed(all.payload, "zai", "primary"), 90, "memory agrees with the shared snapshot");
    assert.equal(readCounter(sb), 1);
  } finally {
    await rpc.close();
  }
});

test("G2: writeDisk is monotonic - an older snapshot never replaces a newer one", () => {
  const dir = mkdtempSync(join(tmpdir(), "codexbar-mcp-mono-"));
  try {
    const cache = new QuotaCache({ cacheDir: dir, ttlSeconds: 300 });
    const roster = [{ id: "codex", displayName: "Codex", enabled: true }];
    const raw = (used: number) => [
      { provider: "codex", source: "oauth", usage: { primary: { usedPercent: used, windowMinutes: 300, resetsAt: "2099-01-01T00:00:00Z" } } },
    ];
    const newer = normalizeSnapshot(raw(70), roster, new Date("2026-10-13T10:00:00Z"), { source: "cli" });
    const older = normalizeSnapshot(raw(5), roster, new Date("2026-10-13T09:00:00Z"), { source: "cli" });
    assert.equal(cache.writeDisk(newer), true);
    assert.equal(cache.writeDisk(older), false, "older snapshot refused");
    assert.equal(cache.writeDisk(newer), true, "same fetchedAt may be rewritten (merged targeted result)");
    const disk = JSON.parse(readFileSync(join(dir, "usage.json"), "utf8"));
    assert.equal(disk.snapshot.providers[0].windows[0].usedPercent, 70);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G3: a successful roster query that returns an empty list means nothing is enabled (not 'unknown')", async () => {
  const sb = makeSandbox();
  seedDisk(sb); // fresh cache with codex + zai from an earlier configuration
  const rpc = start(sb, { ROSTER_JSON: "[]" });
  try {
    await rpc.initialize();
    const tools = await rpc.listToolsUntil((list) =>
      String(list.find((t) => t.name === "codexbar_get_quota")?.inputSchema.properties.provider.description).includes(
        "No provider is currently enabled",
      ),
    );
    const provider = tools.find((t) => t.name === "codexbar_get_quota")?.inputSchema.properties.provider;
    assert.equal(provider.enum, undefined, "no enum when nothing is enabled");
    assert.ok(String(provider.description).includes("No provider is currently enabled"));

    const res = await rpc.callTool("codexbar_list_quotas", {});
    assert.deepEqual(res.payload.enabledProviders, []);
    assert.deepEqual(res.payload.providers, []);
    assert.equal(res.payload.status, "ok");
    assert.equal(res.payload.partial, false);
    assert.equal(readCounter(sb), 0, "nothing to fetch");

    const bad = await rpc.request("tools/call", { name: "codexbar_get_quota", arguments: { provider: "codex" } });
    assert.equal(bad.result.isError, true);
    const refreshed = await rpc.callTool("codexbar_refresh", {});
    assert.equal(refreshed.payload.ok, true);
    assert.deepEqual(refreshed.payload.snapshot.providers, []);
    assert.equal(readCounter(sb), 0);
  } finally {
    await rpc.close();
  }
});

test("G3: an unknown roster (probe failed) still leaves the cached snapshot untouched", async () => {
  const sb = makeSandbox();
  seedDisk(sb);
  // `config providers` prints garbage and exits non-zero: the roster stays unknown.
  const rpc = start(sb, { ROSTER_JSON: "not json" });
  try {
    await rpc.initialize();
    const res = await rpc.callTool("codexbar_list_quotas", {});
    assert.deepEqual(res.payload.providers.map((p: { provider: string }) => p.provider), ["codex", "zai"]);
    assert.equal(readCounter(sb), 0);
  } finally {
    await rpc.close();
  }
});

test("G4: a host with a short timeout cannot preempt a lock whose holder leased a longer one", () => {
  const dir = mkdtempSync(join(tmpdir(), "codexbar-mcp-lease-"));
  try {
    const lockPath = join(dir, "usage.lock");
    // Host A: TIMEOUT=600 (stale 630 s, lease 630 s). Host B: TIMEOUT=90 (stale 120 s, lease 120 s).
    const a = new QuotaCache({ cacheDir: dir, ttlSeconds: 300, lockStaleMs: lockStaleMsFor(600), leaseMs: 630_000 });
    const b = new QuotaCache({ cacheDir: dir, ttlSeconds: 300, lockStaleMs: lockStaleMsFor(90), leaseMs: 120_000 });
    assert.equal(a.acquireLock(), true);
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as Record<string, number>;
    assert.ok(owner.leaseUntil! - owner.at! >= 629_000, "owner.json records the holder's own lease");
    // 121 s into A's (healthy) fetch: B's own threshold would call this stale.
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ ...owner, at: Date.now() - 121_000 }));
    assert.equal(b.acquireLock(), false, "B respects A's lease");
    // Once the lease itself has run out, the lock may be taken.
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ ...owner, at: Date.now() - 700_000, leaseUntil: Date.now() - 1000 }));
    assert.equal(b.acquireLock(), true, "expired lease is preemptable");
    b.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G4: a lock with no usable owner record falls back to max(local threshold, 630 s)", () => {
  const dir = mkdtempSync(join(tmpdir(), "codexbar-mcp-lease-"));
  try {
    const lockPath = join(dir, "usage.lock");
    const b = new QuotaCache({ cacheDir: dir, ttlSeconds: 300, lockStaleMs: lockStaleMsFor(90) });
    for (const damage of ["missing", "corrupt"] as const) {
      rmSync(lockPath, { recursive: true, force: true });
      mkdirSync(lockPath, { recursive: true });
      if (damage === "corrupt") writeFileSync(join(lockPath, "owner.json"), "{not json");
      const age = (ms: number) => {
        const t = new Date(Date.now() - ms);
        utimesSync(lockPath, t, t);
      };
      age(200_000); // older than B's own 120 s, younger than 630 s
      assert.equal(b.acquireLock(), false, `${damage}: 200 s old lock is respected`);
      age(700_000);
      assert.equal(b.acquireLock(), true, `${damage}: 700 s old lock is taken`);
      b.releaseLock();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G5: a targeted failure that completes after the caller got 'warming' is still reported until a refresh succeeds", async () => {
  const sb = makeSandbox();
  const failFile = join(sb.dir, "fail-targeted");
  const rpc = start(sb, {
    ROSTER_JSON: ROSTER2_JSON,
    USAGE_JSON: USAGE2_JSON,
    TARGETED_FAIL_FILE: failFile,
    TARGETED_DELAY: "1",
  });
  try {
    await rpc.initialize();
    const full = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    assert.equal(full.payload.status, "ok");

    writeFileSync(failFile, "1");
    const first = await rpc.callTool("codexbar_get_quota", { provider: "zai", refresh: true, waitSeconds: 0 });
    assert.equal(first.payload.warming, true);
    assert.equal(first.payload.stale, true);

    // The failure lands after that call returned; a plain get must still show it.
    let later: Record<string, any> = {};
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      later = (await rpc.callTool("codexbar_get_quota", { provider: "zai" })).payload;
      if (later.providers[0].status === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.equal(later.providers[0].status, "error", "failure recorded after the original call returned");
    assert.equal(later.providers[0].error.code, "provider");
    // DESIGN v1.3 5.1: the snapshot-level state is untouched; the data is within its TTL.
    assert.equal(later.stale, false);
    assert.equal(later.status, "ok");
    assert.ok(later.failedProviders.includes("zai"));
    assert.equal(later.partial, true);
    assert.equal(later.error, undefined, "no snapshot-level error: the global state is untouched");
    assert.ok(later.providers[0].windows.length > 0, "last known windows are kept");
    const list = await rpc.callTool("codexbar_list_quotas", {});
    const byId = Object.fromEntries(list.payload.providers.map((p: { provider: string; status: string }) => [p.provider, p.status]));
    assert.deepEqual(byId, { codex: "ok", zai: "error" });

    // A successful refresh of that provider clears it.
    rmSync(failFile);
    const ok = await rpc.callTool("codexbar_get_quota", { provider: "zai", refresh: true, waitSeconds: 30 });
    assert.equal(ok.payload.providers[0].status, "ok");
    assert.equal(ok.payload.providers[0].error, undefined);
    const plain = await rpc.callTool("codexbar_get_quota", { provider: "zai" });
    assert.equal(plain.payload.providers[0].status, "ok");
    assert.equal(plain.payload.status, "ok");
    assert.equal(plain.payload.stale, false);

    // A full refresh also supersedes a recorded failure.
    writeFileSync(failFile, "1");
    await rpc.callTool("codexbar_get_quota", { provider: "codex", refresh: true, waitSeconds: 0 }); // nobody waits
    let failed: Record<string, any> = {};
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      failed = (await rpc.callTool("codexbar_get_quota", { provider: "codex" })).payload;
      if (failed.providers[0].status === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.equal(failed.providers[0].status, "error");
    const refreshed = await rpc.callTool("codexbar_refresh", {});
    assert.equal(refreshed.payload.ok, true);
    const cleared = await rpc.callTool("codexbar_get_quota", { provider: "codex" });
    assert.equal(cleared.payload.providers[0].status, "ok");
  } finally {
    await rpc.close();
  }
});

test("G6: waitSeconds is one budget for probes and fetch together (hung probes + hung usage, waitSeconds=1)", async () => {
  const sb = makeSandbox();
  const rpc = start(sb, { PROBE_SLEEP: "1", SLEEP_FOREVER: "1", CODEXBAR_MCP_TIMEOUT_SECONDS: "90" });
  try {
    await rpc.initialize();
    const t0 = Date.now();
    const res = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 1 });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1500, `returned in ${elapsed} ms (budget 1 s, not probes 2 s + wait 1 s)`);
    assert.equal(res.payload.warming, true);
    assert.equal(res.payload.stale, true);
    assert.equal(res.payload.status, "warming");

    const t1 = Date.now();
    const res0 = await rpc.callTool("codexbar_list_quotas", { waitSeconds: 0 });
    assert.ok(Date.now() - t1 < 700, "waitSeconds=0 does not wait for the probes at all");
    assert.equal(res0.payload.warming, true);
  } finally {
    await rpc.close();
  }
});

test("G7: a tools/list answered before the roster was known is followed by tools/list_changed, and the next list has the enum", async () => {
  const sb = makeSandbox();
  // The roster probe takes 3 s: longer than tools/list is willing to wait (2 s).
  const rpc = start(sb, { PROBE_DELAY: "3" });
  try {
    const init = await rpc.initialize();
    assert.equal(init.result.capabilities.tools.listChanged, true, "listChanged is declared");
    const first = await rpc.listTools();
    const provider1 = first.find((t) => t.name === "codexbar_get_quota")?.inputSchema.properties.provider;
    assert.equal(provider1.enum, undefined, "degraded answer: roster not ready within the cap");
    assert.equal(first.length, 3);

    await rpc.waitForNotification("notifications/tools/list_changed", 8000);
    const second = await rpc.listTools();
    const provider2 = second.find((t) => t.name === "codexbar_get_quota")?.inputSchema.properties.provider;
    assert.deepEqual(provider2.enum, ["codex"], "after the notification the enum is there");
    assert.ok(String(provider2.description).includes("codex (Codex)"));
  } finally {
    await rpc.close();
  }
});

test("G7: serve mode - the enum appears after the first fetch, announced by tools/list_changed", async () => {
  const stub = await startServeStub(JSON.parse(USAGE2_JSON) as Array<Record<string, any>>);
  const sb = makeSandbox();
  const rpc = start(sb, { CODEXBAR_SERVE_URL: stub.url });
  try {
    await rpc.initialize();
    const first = await rpc.listTools();
    assert.equal(first.find((t) => t.name === "codexbar_get_quota")?.inputSchema.properties.provider.enum, undefined);
    await rpc.callTool("codexbar_list_quotas", { waitSeconds: 10 });
    await rpc.waitForNotification("notifications/tools/list_changed", 5000);
    const second = await rpc.listTools();
    assert.deepEqual(second.find((t) => t.name === "codexbar_get_quota")?.inputSchema.properties.provider.enum, ["codex", "zai"]);
  } finally {
    await rpc.close();
    await stub.close();
  }
});

test("G7: nested (inert) mode never sends tools/list_changed", async () => {
  const sb = makeSandbox();
  const rpc = start(sb, { CODEXBAR_MCP_NESTED: "1" });
  try {
    await rpc.initialize();
    await rpc.listTools();
    await assert.rejects(rpc.waitForNotification("notifications/tools/list_changed", 600));
  } finally {
    await rpc.close();
  }
});

test("G9: codexbar_refresh is bounded (hard timeout + slack) even when queued behind a hanging targeted fetch", async () => {
  const sb = makeSandbox();
  seedDisk(sb); // a base snapshot, so get_quota refresh=true really is a targeted fetch
  // Every usage run hangs until its 2 s hard timeout. Slack 0: the bound is 2 s.
  const rpc = start(sb, {
    ROSTER_JSON: ROSTER2_JSON,
    USAGE_JSON: USAGE2_JSON,
    SLEEP_FOREVER: "1",
    CODEXBAR_MCP_TIMEOUT_SECONDS: "2",
    CODEXBAR_MCP_REFRESH_SLACK_SECONDS: "0",
  });
  try {
    await rpc.initialize();
    // Listing the tools waits for the roster probe, so the targeted request below really is targeted
    // (with waitSeconds=0 and no roster yet it would degrade to a full fetch).
    await rpc.listToolsUntil(
      (list) => Array.isArray(list.find((t) => t.name === "codexbar_get_quota")?.inputSchema.properties.provider.enum),
    );
    const targeted = rpc.callTool("codexbar_get_quota", { provider: "zai", refresh: true, waitSeconds: 0 });
    const t0 = Date.now();
    const refresh = await rpc.callTool("codexbar_refresh", {});
    const elapsed = Date.now() - t0;
    // Queue: targeted (2 s) then the refresh's own full fetch (2 s) = 4 s. The bound cuts it at ~2 s.
    assert.ok(elapsed >= 1800 && elapsed < 3500, `returned after ${elapsed} ms, within the 2 s bound`);
    assert.equal(refresh.payload.ok, false);
    assert.equal(refresh.payload.warming, true);
    assert.equal(typeof refresh.payload.retryAfterSeconds, "number");
    assert.equal(refresh.payload.snapshot.warming, true);
    assert.equal(refresh.payload.snapshot.stale, true);
    assert.ok(refresh.payload.snapshot.providers.length === 2, "last known data is still returned");
    await targeted;
  } finally {
    await rpc.close();
  }
});

test("G5: the failure stays after the caller that waited for it has seen it, until a covering refresh succeeds", async () => {
  const sb = makeSandbox();
  const failFile = join(sb.dir, "fail-targeted");
  const rpc = start(sb, {
    ROSTER_JSON: ROSTER2_JSON,
    USAGE_JSON: USAGE2_JSON,
    TARGETED_FAIL_FILE: failFile,
  });
  try {
    await rpc.initialize();
    await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    writeFileSync(failFile, "1");
    const waited = await rpc.callTool("codexbar_get_quota", { provider: "zai", refresh: true, waitSeconds: 30 });
    // The initiating call, which received the failure inside its wait, is stale (DESIGN v1.3 5.1 point 3)...
    assert.equal(waited.payload.providers[0].status, "error");
    assert.equal(waited.payload.stale, true);
    // ...and status is a DERIVED result, not a second exception (DESIGN v1.3.1 5.1, REVERIFY-2 D2):
    // the cache is fresh and the full fetch succeeded, so stale makes it "stale".
    assert.equal(waited.payload.status, "stale");
    // ...but nobody else's snapshot-level state changes, and the failure is still there for every later call.
    for (let i = 0; i < 3; i++) {
      const again = await rpc.callTool("codexbar_list_quotas", {});
      assert.equal(again.payload.status, "ok");
      assert.equal(again.payload.stale, false);
      assert.equal(again.payload.error, undefined);
      assert.deepEqual(again.payload.failedProviders, ["zai"]);
      assert.equal(again.payload.partial, true);
      const zai = again.payload.providers.find((p: { provider: string }) => p.provider === "zai");
      assert.equal(zai.status, "error");
      assert.ok(zai.error.code.length > 0);
      assert.ok(zai.windows.length > 0);
    }
    // A full refresh covers every provider and clears it.
    rmSync(failFile);
    const refreshed = await rpc.callTool("codexbar_refresh", {});
    assert.equal(refreshed.payload.ok, true);
    const cleared = await rpc.callTool("codexbar_list_quotas", {});
    assert.deepEqual(cleared.payload.failedProviders, []);
    assert.ok(cleared.payload.providers.every((p: { status: string }) => p.status === "ok"));
  } finally {
    await rpc.close();
  }
});

// ---------------------------------------------------------------------------
// Audit round 3
// ---------------------------------------------------------------------------

test("H1: two hosts that loaded the same snapshot and refresh different providers in turn keep both updates (REVERIFY-2 D1)", async () => {
  const sb = makeSandbox();
  seedDisk(sb); // codex 10%, zai 20%
  const diskFile = join(sb.cacheDir, "usage.json");
  const initial = JSON.parse(readFileSync(diskFile, "utf8")) as { rev: number; fetchedAt: string };
  const env = { ROSTER_JSON: ROSTER2_JSON, USAGE_JSON: USAGE2_JSON };
  const a = start(sb, env);
  const b = start(sb, env);
  try {
    await Promise.all([a.initialize(), b.initialize()]);
    // Listing waits for the roster probe: both hosts have the snapshot (same fetchedAt, same rev) and a roster.
    await Promise.all([a.listTools(), b.listTools()]);

    const ra = await a.callTool("codexbar_get_quota", { provider: "codex", refresh: true, waitSeconds: 30 });
    assert.equal(windowUsed(ra.payload, "codex", "secondary"), 42.4);
    const rb = await b.callTool("codexbar_get_quota", { provider: "zai", refresh: true, waitSeconds: 30 });
    assert.equal(windowUsed(rb.payload, "zai", "primary"), 55);

    const log = readArgsLog(sb);
    assert.equal(log.length, 2, "one targeted spawn per host");
    assert.ok(log[0]?.includes("--provider codex"));
    assert.ok(log[1]?.includes("--provider zai"));

    const disk = JSON.parse(readFileSync(diskFile, "utf8")) as {
      rev: number;
      fetchedAt: string;
      snapshot: { providers: Array<Record<string, unknown>> };
    };
    const shared = { providers: disk.snapshot.providers };
    assert.equal(windowUsed(shared, "codex", "secondary"), 42.4, "host A's update survived host B's write");
    assert.equal(windowUsed(shared, "zai", "primary"), 55, "host B's update is there too");
    assert.equal(disk.fetchedAt, initial.fetchedAt, "fetchedAt still means data age (F8 unchanged)");
    assert.equal(disk.rev, initial.rev + 2, "two writes, two rev increments");

    const view = await b.callTool("codexbar_list_quotas", {});
    assert.equal(windowUsed(view.payload, "codex", "secondary"), 42.4);
    assert.equal(windowUsed(view.payload, "zai", "primary"), 55);
    assert.equal(JSON.stringify(view.payload).includes('"rev"'), false, "rev is a disk-format detail, never in a response");
  } finally {
    await a.close();
    await b.close();
  }
});

test("H1: adoption compares the write rev first and fetchedAt second; files without a rev count as rev 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "codexbar-mcp-rev-"));
  try {
    const roster = [{ id: "codex", displayName: "Codex", enabled: true }];
    const raw = (used: number) => [
      { provider: "codex", source: "oauth", usage: { primary: { usedPercent: used, windowMinutes: 300, resetsAt: "2099-01-01T00:00:00Z" } } },
    ];
    const base = normalizeSnapshot(raw(10), roster, new Date("2026-10-13T10:00:00Z"), { source: "cli" });
    const merged = { ...normalizeSnapshot(raw(70), roster, new Date("2026-10-13T10:00:00Z"), { source: "cli" }) };
    const used = (c: QuotaCache) => c.memGet()?.providers[0]?.windows[0]?.usedPercent;
    const diskRev = () => (JSON.parse(readFileSync(join(dir, "usage.json"), "utf8")) as { rev?: number }).rev;

    const a = new QuotaCache({ cacheDir: dir, ttlSeconds: 300 });
    a.memSet(base);
    assert.equal(a.writeDisk(base), true);
    assert.equal(diskRev(), 1);
    const b = new QuotaCache({ cacheDir: dir, ttlSeconds: 300 });
    assert.equal(b.preloadFromDisk(), true);
    assert.equal(b.memRev(), 1);
    assert.equal(b.loadNewerFromDisk(), false, "same copy: nothing to adopt");

    // A writes a merged targeted result: same fetchedAt, higher rev.
    a.memSet(merged);
    assert.equal(a.writeDisk(merged), true);
    assert.equal(diskRev(), 2);
    assert.equal(a.memRev(), 2);
    assert.equal(b.loadNewerFromDisk(), true, "equal fetchedAt but higher rev is newer");
    assert.equal(used(b), 70);
    assert.equal(b.memRev(), 2);
    b.memSet(base);
    assert.equal(b.writeDisk(base), true);
    assert.equal(diskRev(), 3, "the writer's rev = adopted rev + 1");

    // A file from before revs existed: rev 0, ordered by fetchedAt only; it never beats a higher rev.
    const legacyNewer = normalizeSnapshot(raw(33), roster, new Date("2026-10-13T11:00:00Z"), { source: "cli" });
    writeFileSync(join(dir, "usage.json"), JSON.stringify({ v: 1, fetchedAt: legacyNewer.fetchedAt, snapshot: legacyNewer }));
    const c = new QuotaCache({ cacheDir: dir, ttlSeconds: 300 });
    assert.equal(c.preloadFromDisk(), true, "legacy file loads");
    assert.equal(c.memRev(), 0);
    assert.equal(used(c), 33);
    assert.equal(c.writeDisk(legacyNewer), true);
    assert.equal(diskRev(), 1, "first write over a legacy file: rev 1");
    assert.equal(a.loadNewerFromDisk(), false, "rev 1 < A's rev 2: A keeps its copy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H2: codexbar_refresh on a cold start counts the probe wait inside its bound (REVERIFY-2 D3)", async () => {
  const sb = makeSandbox();
  // Probe and usage both hang. Bound = hard timeout 2 s + slack 0 = 2 s for the WHOLE call.
  const rpc = start(sb, {
    PROBE_SLEEP: "1",
    SLEEP_FOREVER: "1",
    CODEXBAR_MCP_TIMEOUT_SECONDS: "2",
    CODEXBAR_MCP_REFRESH_SLACK_SECONDS: "0",
  });
  try {
    await rpc.initialize();
    const t0 = Date.now();
    const res = await rpc.callTool("codexbar_refresh", {});
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2500, `returned after ${elapsed} ms (bound 2 s; probe wait + fetch wait used to add up to about 4 s)`);
    assert.ok(elapsed >= 1500, `${elapsed} ms: it did wait for its budget`);
    assert.equal(res.payload.ok, false);
    assert.equal(res.payload.warming, true);
    assert.equal(typeof res.payload.retryAfterSeconds, "number");
  } finally {
    await rpc.close();
  }
});

test("H3: a provisional enum replaced by the real roster is announced again (REVERIFY-2 D4)", async () => {
  const sb = makeSandbox();
  // The roster probe takes 3.5 s - above the 2 s tools/list cap, below its own 5 s hard timeout -
  // and finally answers [codex, zai]. The usage payload (codex only) is fetched first, so a
  // provisional roster [codex] exists for a while before the real one replaces it. The two
  // notifications may land close together, so the test does NOT depend on their interleaving with
  // tools/list calls: it asserts the FINAL state (exactly two notifications, final enum) and only
  // checks the provisional [codex] if it gets the chance to read it between the two.
  const rpc = start(sb, { PROBE_DELAY: "3.5", ROSTER_JSON: ROSTER2_JSON /* USAGE_JSON: codex only (default) */ });
  const enumOf = (tools: Array<Record<string, any>>) =>
    tools.find((t) => t.name === "codexbar_get_quota")?.inputSchema.properties.provider.enum;
  const LIST_CHANGED = "notifications/tools/list_changed";
  try {
    await rpc.initialize();
    const first = await rpc.listTools();
    assert.equal(enumOf(first), undefined, "degraded: roster not ready within the 2 s cap");

    // waitSeconds 1: the fetch spawns when this call's own budget ends (about 1 s), typically before
    // the probe answers, so the first notification usually announces the provisional roster [codex].
    await rpc.callTool("codexbar_list_quotas", { waitSeconds: 1 });
    await rpc.waitForNotification(LIST_CHANGED, 10_000); // 1st: provisional roster announced

    // Best effort (per FIX-ROUND-3): only assert the provisional schema if it is still the published
    // one. If the second notification has already landed (or the probe won the race entirely), the
    // provisional moment is gone and this step is skipped.
    if (rpc.notificationCount(LIST_CHANGED) < 2) {
      const provisionalEnum = enumOf(await rpc.listTools());
      if (Array.isArray(provisionalEnum) && provisionalEnum.length <= 1) {
        assert.deepEqual(provisionalEnum, ["codex"], "provisional enum from the first payload");
      }
    }

    await rpc.waitForNotification(LIST_CHANGED, 10_000); // 2nd: the real roster replaces it
    const final = await rpc.listTools();
    assert.deepEqual(enumOf(final), ["codex", "zai"], "the real roster replaced the provisional one");
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(rpc.notificationCount(LIST_CHANGED), 2, "exactly two notifications, no third");
  } finally {
    await rpc.close();
  }
});

test("H3: no tools/list_changed when the roster does not change the published schema", async () => {
  const sb = makeSandbox();
  const rpc = start(sb, { ROSTER_JSON: ROSTER2_JSON, USAGE_JSON: USAGE2_JSON });
  try {
    await rpc.initialize();
    // Whatever the timing, this ends with the real roster published (consuming a notification if needed).
    const tools = await rpc.listToolsUntil(
      (list) => Array.isArray(list.find((t) => t.name === "codexbar_get_quota")?.inputSchema.properties.provider.enum),
    );
    assert.deepEqual(tools.find((t) => t.name === "codexbar_get_quota")?.inputSchema.properties.provider.enum, ["codex", "zai"]);
    // Fetching, refreshing and listing again leave the schema as published: no notification.
    await rpc.callTool("codexbar_list_quotas", { waitSeconds: 30 });
    await rpc.callTool("codexbar_refresh", {});
    await rpc.listTools();
    await assert.rejects(rpc.waitForNotification("notifications/tools/list_changed", 700), "schema unchanged: silence");
  } finally {
    await rpc.close();
  }
});

test("H3: nothing is announced before the first tools/list, and a known-empty roster counts as a change", async () => {
  const sb = makeSandbox();
  // Nobody has listed yet when the (delayed) roster arrives: there is no stale schema to correct.
  const quiet = start(sb, { PROBE_DELAY: "1", ROSTER_JSON: ROSTER2_JSON });
  try {
    await quiet.initialize();
    await new Promise((resolve) => setTimeout(resolve, 1800)); // the probe has answered by now
    await assert.rejects(quiet.waitForNotification("notifications/tools/list_changed", 400), "never listed: silence");
  } finally {
    await quiet.close();
  }

  // Listed while unknown, then the roster turns out to be known-and-empty: the description changes.
  const sb2 = makeSandbox();
  const rpc = start(sb2, { PROBE_DELAY: "3", ROSTER_JSON: "[]" });
  try {
    await rpc.initialize();
    const first = await rpc.listTools();
    assert.ok(!String(first.find((t) => t.name === "codexbar_get_quota")?.inputSchema.properties.provider.description).includes("No provider is currently enabled"));
    await rpc.waitForNotification("notifications/tools/list_changed", 8000);
    const second = await rpc.listTools();
    assert.ok(String(second.find((t) => t.name === "codexbar_get_quota")?.inputSchema.properties.provider.description).includes("No provider is currently enabled"));
  } finally {
    await rpc.close();
  }
});

test("H4: when the full fetch has failed, the failed-targeted initiator still reports fetch_failed (DESIGN v1.3.1 5.1, REVERIFY-2 D2)", async () => {
  const sb = makeSandbox();
  const failFile = join(sb.dir, "fail-targeted");
  const rpc = start(sb, {
    ROSTER_JSON: ROSTER2_JSON,
    USAGE_JSON: USAGE2_JSON,
    TARGETED_FAIL_FILE: failFile,
    EXIT_CODE: "64",
    EMPTY_OUTPUT: "1",
  });
  try {
    await rpc.initialize();
    // A good full snapshot first (the disk cache the failing CLI run must not overwrite).
    seedDisk(sb, { ageSeconds: 0 });
    const full = await rpc.callTool("codexbar_list_quotas", {});
    assert.equal(full.payload.status, "ok");
    writeFileSync(failFile, "1");
    // Make the FULL fetch fail while the failing environment is active (F18 keeps the seeded cache).
    const brokenFull = await rpc.callTool("codexbar_refresh", {});
    assert.equal(brokenFull.payload.ok, false);
    // The initiator waits and receives the targeted failure: stale=true (the exception)...
    const initiator = await rpc.callTool("codexbar_get_quota", { provider: "zai", refresh: true, waitSeconds: 30 });
    assert.equal(initiator.payload.providers[0].status, "error");
    assert.equal(initiator.payload.stale, true);
    // ...but the status keeps following the global derivation: the full fetch failed -> fetch_failed.
    assert.equal(initiator.payload.status, "fetch_failed");
    assert.equal(initiator.payload.error.code, "cli_exit_64");
  } finally {
    await rpc.close();
  }
});
