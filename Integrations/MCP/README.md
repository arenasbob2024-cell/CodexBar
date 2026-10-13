# CodexBar quota MCP server

Stdio [MCP](https://modelcontextprotocol.io) server that lets an orchestrating agent (Claude Code, Pi, Codex CLI)
read how much subscription quota each CodexBar provider has left, when it resets, and how fast it is being burned.
It **reports only**: no recommendations, no ranking, no `dispatchable`-style verdicts. Scheduling stays with the caller.

Design contract: [`DESIGN.md`](DESIGN.md) (v1.1). This directory is a thin, independent consumer of
`codexbar usage --format json` / `codexbar serve`; it changes no Swift code.

## Build and test

```bash
cd Integrations/MCP
npm install
npm run build        # tsc -> dist/
npm test             # builds, then node --test on dist/test/*.test.js
npx tsc --noEmit     # type-check src + test
```

Requires Node >= 20 and a CodexBar CLI (0.60.x and 0.74.x payload shapes are both handled).

## Tools

| Tool | Purpose |
|---|---|
| `codexbar_list_quotas` | All enabled providers. Args: `maxAgeSeconds`, `waitSeconds` (default 20, max 60), `includeIdentity`, `includeDetails`. |
| `codexbar_get_quota` | One provider (`provider` is an enum of enabled ids). `refresh=true` does a targeted `--provider` fetch and merges it into the cache. |
| `codexbar_refresh` | Forced full re-fetch (slow, about 45 s). Returns `{ ok, durationMs, snapshot }`. |

Every response is a JSON text block shaped like `QuotaSnapshot` (DESIGN.md section 5). Key semantics:

- `windows` only lists windows that really exist. A missing/`null` window means "unknown", never "unlimited".
- `usedPercent` / `remainingPercent` are clamped to 0-100 (one decimal); the unclamped value is in `rawUsedPercent` when it differs.
- `bindingWindow` / `minRemainingPercent`: the known window with the least remaining quota.
- `resetCredits` (free reset tokens) are never folded into `remainingPercent`; credit ids are never emitted.
- `stale: true` means: TTL expired, the last refresh failed, another host holds the refresh lock, a refresh is still pending after your wait, or a window's reset time already passed.
- `status: "fetch_failed"` with a non-empty `providers` list: the last full refresh failed (`error.code`), the data shown is the previous snapshot and `stale` is true.
- `warming: true` + `retryAfterSeconds`: a refresh is still running; you got the existing data (or an empty list); `stale` is always true then.
- `cliExitCode` (only when non-zero): the exit code of the last full CLI run whose payload was used (1 = some provider failed; 2/3/4 = failure class of a provider, payload still complete).
- A failed targeted refresh (`get_quota refresh=true`) is recorded as a state (DESIGN v1.3 5.1): from then on every response shows that provider exactly like a provider failure inside a full fetch (`status: "error"`, `error.code`, last known windows kept, `partial: true`, listed in `failedProviders`) until a refresh covering it succeeds or a newer shared snapshot is adopted. The snapshot-level `status` / `stale` / `error` are not affected; the one exception is the call that started the refresh and received the failure within its wait: its response is `stale: true`.
- `tools/list` may be answered before the provider roster is known (slow probe, serve mode) and then has no `provider` enum. The server declares `tools.listChanged` and sends `notifications/tools/list_changed` as soon as the roster is known, so hosts that honor it re-list and get the enum. If nothing is enabled in CodexBar the `provider` description says so and every tool answers with empty `providers` / `enabledProviders`.
- Account emails are omitted unless `includeIdentity=true`; emails inside error text are replaced with `<redacted>`.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `CODEXBAR_SERVE_URL` | unset | e.g. `http://127.0.0.1:8080`. Switches to `serve` mode (`GET /usage`); this process then spawns nothing. |
| `CODEXBAR_BIN` | unset | CLI path. When set it is used exclusively. Otherwise `/opt/homebrew/bin/codexbar`, `/usr/local/bin/codexbar`, `/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI`. Not found -> `status: "not_installed"`, never retried. |
| `CODEXBAR_MCP_TTL_SECONDS` | 300 | In-memory / shared-cache TTL. |
| `CODEXBAR_MCP_TIMEOUT_SECONDS` | 90 | Hard timeout per fetch; the child's whole process group gets SIGKILL. |
| `CODEXBAR_MCP_REFRESH_SLACK_SECONDS` | 10 | `codexbar_refresh` waits at most the hard timeout plus this many seconds; beyond that it returns `{ ok: false, warming: true, retryAfterSeconds, snapshot }` and the refresh continues in the background. |
| `CODEXBAR_MCP_CACHE_DIR` | `~/.cache/codexbar-mcp` | Shared cache (`usage.json`) and `usage.lock` directory. |
| `CODEXBAR_MCP_NESTED` | unset | Set to `1` by this server on every child it spawns. If already present at startup the server is inert: tool calls return `{ "status": "nested", "providers": [] }`, nothing is spawned, the cache is not read. |

Hygiene: no polling timers (refresh happens lazily inside a tool call; the per-call wait timer is cleared as soon as the fetch settles),
at most one child process per process at a time: requests are merged only into a fetch whose scope covers them (a full fetch covers everything,
a targeted one covers only its provider), anything else queues behind it,
cross-process mutual exclusion through the `usage.lock` directory (owner pid + token + the holder's own lease `leaseUntil` = acquire time + its hard timeout + 30 s; a competitor honours that lease whatever its own timeout is, and a late holder never deletes the new holder's lock),
child stderr is discarded, a finished CLI's leftover descendants are swept, and SIGTERM / SIGINT / stdin EOF kill every live process group (including the startup probes) before exiting.
Start-up order: handlers first, then the stdio transport, then the roster/version probes (5 s each); `initialize` never waits for them and `tools/list` waits at most 2 s. In a tool call, `waitSeconds` is ONE budget: the probe wait (at most 2 s) and the fetch wait share it, so `waitSeconds: 1` returns in about 1 s even when both the probe and the CLI hang.

## Connect it

```bash
# Claude Code (user scope, otherwise it is only visible in the current directory)
claude mcp add --scope user codexbar -- node /ABS/PATH/Integrations/MCP/dist/src/server.js
```

```json
// Pi: ~/.pi/agent/mcp.json
{ "mcpServers": { "codexbar": { "command": "/opt/homebrew/bin/node", "args": ["/ABS/PATH/Integrations/MCP/dist/src/server.js"] } } }
```

```toml
# Codex CLI: ~/.codex/config.toml
[mcp_servers.codexbar]
command = "node"
args = ["/ABS/PATH/Integrations/MCP/dist/src/server.js"]
```

Several hosts at once: run one resident `codexbar serve --refresh-interval 300` and set
`CODEXBAR_SERVE_URL=http://127.0.0.1:8080` for all of them. (Without it, hosts still share the disk cache and lock.)

> Note: the build output lives at `dist/src/server.js` (tests are compiled next to it in `dist/test/`).
> DESIGN.md writes `dist/server.js`; see Decisions.

## Smoke test

Actually executed on this machine (CodexBar CLI 0.60.3): `initialize`, `notifications/initialized`, `tools/list` fed over stdin.

```bash
{ printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'; sleep 2; } | node dist/src/server.js
```

Output (pretty-printed here; the server emits one JSON object per line). Three tools; `provider` is an enum equal to the
enabled entries of `codexbar config providers`:

```json
[
  {
    "result": {
      "protocolVersion": "2024-11-05",
      "capabilities": {
        "tools": {}
      },
      "serverInfo": {
        "name": "codexbar-mcp",
        "version": "0.1.0"
      }
    },
    "jsonrpc": "2.0",
    "id": 1
  },
  {
    "result": {
      "tools": [
        {
          "name": "codexbar_list_quotas",
          "description": "Report remaining subscription quota for every enabled CodexBar provider. A provider is a paid plan that backs a sub-agent (e.g. codex, claude, zai). Each provider has windows (primary = short session window, secondary = weekly, ...) with usedPercent/remainingPercent, resetsAt and resetsInMinutes; bindingWindow is the tightest known window; null percentages or an empty windows list mean the usage is unknown, NOT unlimited. pace.projectedEmptyAt estimates exhaustion at the current burn rate. resetCredits are free reset tokens and are not included in remainingPercent. Data comes from a local cache that refreshes lazily after the TTL (default 300s); a full refresh takes tens of seconds. stale=true means the data may be outdated (TTL expired, last refresh failed, or a window reset already passed); warming=true means a refresh is still running, retry after retryAfterSeconds. This tool only reports; it never recommends which provider to use.",
          "inputSchema": {
            "type": "object",
            "properties": {
              "maxAgeSeconds": {
                "type": "integer",
                "minimum": 0,
                "maximum": 86400,
                "description": "Accept cached data younger than this many seconds (overrides the server TTL). 0 forces a refresh."
              },
              "waitSeconds": {
                "type": "integer",
                "minimum": 0,
                "maximum": 60,
                "default": 20,
                "description": "Max seconds to block when the cache is expired and a refresh is running. On timeout you get the existing data with warming=true, stale=true and retryAfterSeconds."
              },
              "includeIdentity": {
                "type": "boolean",
                "default": false,
                "description": "Include the account email in identity (omitted by default)."
              },
              "includeDetails": {
                "type": "boolean",
                "default": false,
                "description": "Include provider detail rows (label/value strings passed through verbatim; units are mixed, do not sum)."
              }
            },
            "additionalProperties": false
          }
        },
        {
          "name": "codexbar_get_quota",
          "description": "Report quota for ONE provider (same fields as codexbar_list_quotas, filtered to a single entry in the providers array). With refresh=true it runs a targeted fetch for just that provider (about 10s) and merges it into the cache; otherwise it reads the cache like list_quotas. provider must be one of the enabled ids.",
          "inputSchema": {
            "type": "object",
            "properties": {
              "provider": {
                "type": "string",
                "enum": [
                  "codex",
                  "claude",
                  "cursor",
                  "antigravity",
                  "zai"
                ],
                "description": "CodexBar provider id. Enabled providers: codex (Codex), claude (Claude), cursor (Cursor), antigravity (Antigravity), zai (z.ai / GLM)."
              },
              "refresh": {
                "type": "boolean",
                "default": false,
                "description": "Force a targeted fetch for this provider (slower)."
              },
              "waitSeconds": {
                "type": "integer",
                "minimum": 0,
                "maximum": 60,
                "default": 20,
                "description": "Max seconds to block when the cache is expired and a refresh is running. On timeout you get the existing data with warming=true, stale=true and retryAfterSeconds."
              },
              "includeIdentity": {
                "type": "boolean",
                "default": false,
                "description": "Include the account email in identity (omitted by default)."
              },
              "includeDetails": {
                "type": "boolean",
                "default": false,
                "description": "Include provider detail rows (label/value strings passed through verbatim; units are mixed, do not sum)."
              }
            },
            "required": [
              "provider"
            ],
            "additionalProperties": false
          }
        },
        {
          "name": "codexbar_refresh",
          "description": "Force a full re-fetch of all providers. 慢（约 45 秒）。list_quotas 已自动按 TTL 刷新，仅当 updatedAt 比你需要的更旧时才调用。 (Slow, about 45 seconds: list_quotas already refreshes automatically per TTL; only call this when updatedAt is older than you need.) Returns { ok, durationMs, snapshot }.",
          "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": false
          }
        }
      ]
    },
    "jsonrpc": "2.0",
    "id": 2
  }
]
```

## Sample response

A real `codexbar_list_quotas` call with `waitSeconds: 60` and a cold cache (about 40 s). Default flags, so no identity and no
details. Only the very long Cursor error message is shortened for this README. Values are a point-in-time capture.

```json
{
  "status": "ok",
  "source": "cli",
  "fetchedAt": "2026-10-13T05:31:26.338Z",
  "ageSeconds": 0,
  "stale": false,
  "partial": true,
  "failedProviders": [
    "cursor"
  ],
  "enabledProviders": [
    "codex",
    "claude",
    "cursor",
    "antigravity",
    "zai"
  ],
  "providers": [
    {
      "provider": "codex",
      "displayName": "Codex",
      "status": "ok",
      "source": "oauth",
      "plan": "pro",
      "windows": [
        {
          "id": "secondary",
          "label": "weekly",
          "windowMinutes": 10080,
          "known": true,
          "usedPercent": 1,
          "remainingPercent": 99,
          "resetsAt": "2026-10-20T04:58:49Z",
          "resetPassed": false,
          "resetsInMinutes": 10048
        }
      ],
      "credits": {
        "balance": 33396.422798,
        "unit": "Credits",
        "updatedAt": "2026-10-13T05:30:51Z"
      },
      "resetCredits": {
        "available": 3,
        "nextExpiresAt": "2026-10-22T20:21:35.000Z"
      },
      "updatedAt": "2026-10-13T05:30:51Z",
      "bindingWindow": "secondary",
      "minRemainingPercent": 99
    },
    {
      "provider": "claude",
      "displayName": "Claude",
      "status": "ok",
      "source": "claude",
      "windows": [
        {
          "id": "primary",
          "label": "5h",
          "windowMinutes": 300,
          "known": true,
          "usedPercent": 17,
          "remainingPercent": 83,
          "resetsAt": "2026-10-13T09:29:00Z",
          "resetPassed": false,
          "resetsInMinutes": 238
        },
        {
          "id": "secondary",
          "label": "weekly",
          "windowMinutes": 10080,
          "known": true,
          "usedPercent": 21,
          "remainingPercent": 79,
          "resetsAt": "2026-10-18T17:00:00Z",
          "resetPassed": false,
          "resetsInMinutes": 7889
        }
      ],
      "pace": {
        "summary": "4% in reserve | Expected 21% used | Lasts until reset",
        "stage": "slightlyBehind"
      },
      "updatedAt": "2026-10-13T05:31:04Z",
      "bindingWindow": "secondary",
      "minRemainingPercent": 79
    },
    {
      "provider": "cursor",
      "displayName": "Cursor",
      "status": "error",
      "source": "auto",
      "windows": [],
      "error": {
        "code": "auth",
        "message": "No Cursor session found. If you use Safari, grant CodexBar Full Disk Access in System Settings ▸ Privacy & Sec… [truncated for README]"
      }
    },
    {
      "provider": "antigravity",
      "displayName": "Antigravity",
      "status": "offline",
      "source": "offline",
      "plan": "offline",
      "windows": [],
      "updatedAt": "2026-10-13T05:31:25Z"
    },
    {
      "provider": "zai",
      "displayName": "z.ai / GLM",
      "status": "ok",
      "source": "api",
      "plan": "pro",
      "windows": [
        {
          "id": "primary",
          "label": "5h",
          "windowMinutes": 300,
          "known": true,
          "usedPercent": 100,
          "remainingPercent": 0,
          "resetsAt": "2026-10-13T08:44:41Z",
          "resetPassed": false,
          "resetsInMinutes": 194
        },
        {
          "id": "secondary",
          "label": "weekly",
          "windowMinutes": 10080,
          "known": true,
          "usedPercent": 20.1,
          "remainingPercent": 79.9,
          "resetsAt": "2026-10-20T03:44:36Z",
          "resetPassed": false,
          "resetsInMinutes": 9974
        }
      ],
      "updatedAt": "2026-10-13T05:31:25Z",
      "bindingWindow": "primary",
      "minRemainingPercent": 0
    }
  ],
  "cliVersion": "0.60.3"
}
```

Two further live measurements: a warm shared cache answered in 2 ms; a cold cache with `waitSeconds: 1` returned
`status: "warming"` after 1004 ms; closing stdin left no `codexbar usage` process behind.

## Decisions (things DESIGN.md left open)

1. **Low-level `Server` + hand-written JSON Schema** instead of `McpServer.registerTool`, so `get_quota.provider` can carry a dynamic enum; `zod` validates tool arguments.
2. **Build layout:** `rootDir` is the package root, so output is `dist/src/server.js` (not `dist/server.js`) and tests compile to `dist/test/`. `npm test` builds first and runs `node --test "dist/test/*.test.js"` (Node 24 no longer accepts a directory argument). Tests import `../src/*.js`, which resolves to the type source under `tsc` and to the compiled file at run time.
3. **`package.json` has no `version` field** (it is `private`), so the npm banner has no name-and-version line with an at-sign; the test output then contains no at-sign at all.
4. **Serve mode never spawns:** the roster is derived from the `/usage` payload (display name = id), `cliVersion` is omitted, there is no disk cache or lock. The `provider` enum therefore appears only after the first successful fetch.
5. **Nested (inert) mode** cannot query the roster without spawning, so its `tools/list` shows `provider` as a plain string.
6. **`not_installed` is latched on the first tool call** (lazy lookup) and never re-probed in that process. `CODEXBAR_BIN` is exclusive: a wrong value does not fall back to another binary.
7. **`partial`** = any enabled provider whose status is not `ok` (so `offline` counts, per the literal wording of DESIGN section 5); **`failedProviders`** = providers with `status: "error"` only.
8. **`stale`** compares the age with the server TTL (`CODEXBAR_MCP_TTL_SECONDS`), not with a per-call `maxAgeSeconds`; a caller that accepts older data still sees `stale: true` once the TTL has passed.
9. **Error-code precedence:** `timeout`, then `parse`, then `auth`, then `provider`. `parse` precedes `auth` because Claude's "Could not parse Claude usage: ... without session quota data" would otherwise look like an auth error.
10. **`rawUsedPercent`** is emitted only when the raw value falls outside 0-100. **`label`** is omitted when `windowMinutes` is missing. **`credits`** needs both a numeric balance and a currency code. `resetsInMinutes` is rounded up.
11. **`pace.projectedEmptyAt`** = fetch time + `etaSeconds`, computed from the injected clock (`normalize.ts` never reads the wall clock).
12. **Windows flagged `isSyntheticPlaceholder` are skipped**; the Antigravity `extraRateWindows` array is ignored because its ids do not fit the primary/secondary/tertiary schema.
13. **The disk cache stores the full internal snapshot, including the account email,** so `includeIdentity` works across hosts. The file is mode 0600; responses strip the email by default. `includeIdentity` only controls what a response shows; it does not change what is written to disk, and a memory-only identity mode is not implemented. If you do not want any address on disk, point `CODEXBAR_MCP_CACHE_DIR` at a tmpfs / RAM disk.
14. **Targeted refresh merge (audit round 1, F8/F3):** the merged snapshot keeps the BASE's `fetchedAt`, so `ageSeconds` / `stale` keep describing the oldest data; the refreshed provider carries its own `updatedAt`. A targeted refresh is only issued on top of an existing snapshot and a known roster; otherwise the server does a full fetch (nothing is ever synthesized as `missing` and persisted). Consequence: another host does not see a merged-only change as "newer" in the shared cache.
15. **Our own hard-timeout kill** reports `error.code = "timeout"`; `retryAfterSeconds` is the time left to the hard deadline (clamped to 5-60), or 10 when another host holds the lock. When the lock is busy and no data exists at all, the status is `warming`.
16. **If `config providers` fails but usage works,** the roster falls back to the providers present in the payload.
17. **`get_quota` with an unknown provider** returns an MCP tool error (`isError`), and the `providers` array is filtered to the one requested entry.
18. **stdin EOF is handled explicitly:** the SDK's stdio transport does not report it as a close, and DESIGN section 3.3 requires killing the child group when the host goes away.
19. **`CODEXBAR_SERVE_URL`** must be `http(s)://...`; anything else is ignored.
20. **`package-lock.json` is committed;** `test/helpers.ts` is a non-test helper next to the `*.test.ts` files.
21. **Fixture:** the real full-run output with the `openaiDashboard` block removed, every `id` set to `"redacted"`, and the account address replaced by an example address. The Zai detail rows and the Cursor error text are kept as captured.

22. **Exit codes (F1, DESIGN 3.4 v1.2):** exit 0-4 with a parseable JSON array is a normal result (the CLI prints the full payload even when it exits 2/3/4); only empty/unparseable stdout or other codes (64, ...) are service errors. A parseable array on exit 64 is still a service error.
23. **Scoped single-flight (F14):** `requestFetch(scope)`; scope `null` = all. Covered requests share, others queue; fetches never overlap. `codexbar_refresh` always waits for its own full fetch.
24. **Failure state is global only for full fetches (F5, G5; ruled by the coordinator, DESIGN v1.3 5.1, REVERIFY-1 N6):** targeted failures never set `lastFetchFailed` / `error`. They are recorded per provider (`providerFailures`) as a state: until a refresh covering that provider succeeds (targeted, or any full one) or a newer shared snapshot is adopted, every response shows the provider like a failed provider of a full fetch (`status: "error"`, `code: timeout | parse | provider`, last windows kept, `partial: true`, listed in `failedProviders`). Whether anyone has already seen the failure does not matter (no delivery tracking). Snapshot-level `status` / `stale` / `error` stay driven by data age and full-fetch outcomes; only the call that initiated the failed refresh and got the failure within its wait is `stale: true`.
25. **`status` precedence (F18/F19):** `fetch_failed` if the last full fetch failed (data kept, `stale: true`), else `stale` if any stale condition holds (a pending refresh after the wait counts), else `ok`.
26. **Reset-driven refresh limiter (F7):** a passed `resetsAt` triggers a refresh only if the last good fetch is at least 60 s old and the last full fetch did not fail. The age of the snapshot is the limiter (no extra timer); the response stays `stale: true` meanwhile.
27. **Lock ownership (F4, G4):** `owner.json` holds pid, a random token, `at` and `leaseUntil`; release checks pid and token. A competitor decides staleness from the HOLDER's `leaseUntil`; a record without a lease uses the competitor's own threshold (`max(120 s, hard timeout + 30 s)`) from `at`; a lock with no usable owner record uses `max(own threshold, 630 s)` from the directory's mtime. No lease renewal timer (the lease already covers the longest fetch), which keeps the "no timers" rule simple.
28. **Shared cache is CLI-mode only (F15) and re-read when needed (F16):** serve mode neither reads nor writes it. CLI mode adopts a strictly newer disk snapshot when memory is empty or expired and after a busy lock; adopting clears a stale failure flag. Every adopted/preloaded snapshot is rebuilt against the current enabled roster (F17); an unknown roster leaves it untouched, while a roster that was successfully queried and is empty (G3) clears it. A targeted fetch takes the lock first and then adopts the newest shared snapshot as its merge base (G2); `writeDisk` is monotonic and never replaces a newer snapshot with an older one.
29. **Disk cache validation (F20):** `isValidSnapshot` checks the whole structure (source, fetchedAt, flags, provider/window shapes). Anything else is treated as "no cache".
30. **Redaction (F6, DESIGN 5.3 v1.2):** every passthrough string (plan, source, pace summary/stage, credits unit, details title/label/value/secondaryValue, roster display name, error text) goes through `redactEmails` when it is normalized, and once more at the single projection exit (`projectSnapshot` runs a deep redaction over everything except the explicit identity field), so a cache file written by an older version cannot leak either (G1). Only `identity.accountEmail` with `includeIdentity=true` carries an address.
31. **Legacy reset credits (F22):** a 0.60.x inventory that exists but has nothing usable reports `{ available: 0 }` (no `nextExpiresAt`); an absent/`null` inventory still omits the field.
32. **Start-up (F9/F12/G6/G7):** probes run after the handlers and the transport exist, with a 5 s timeout each; `tools/list` and tool calls wait for them at most 2 s (tool calls: within their own `waitSeconds` budget, via one `Deadline` timer of exactly `waitSeconds` that is cancelled when the call ends) and degrade (plain-string `provider`, roster derived from the first payload). A degraded `tools/list` is followed by `tools/list_changed` once the roster is known.
33. **Roster state (G3):** `rosterKnown` is true once `config providers` answered, even with `[]`. Only then does an empty roster mean "nothing enabled" (empty `providers` / `enabledProviders`, no fetch, `get_quota` answers with an error). A failed or pending probe stays "unknown".
34. **`codexbar_refresh` is bounded (G9):** it waits at most the hard timeout plus `CODEXBAR_MCP_REFRESH_SLACK_SECONDS` (default 10); beyond that it returns `{ ok: false, warming: true, retryAfterSeconds, durationMs, snapshot }` and the fetch continues in the background. The slack is configurable only so the bound can be tested in seconds.
35. **Test-suite note:** the unanswered request in the F21 negative control used to keep the test process alive for 120 s (every full run took about 148 s); its timer is now `unref`'d (about 45 s per run).

## Known limitations

- **Multiple accounts per provider (F10):** CodexBar 0.74 prints several entries for one provider when run with `--all-accounts`. This server never passes that flag, so it sees one entry per provider; multi-account setups are not reported.
- The "lock busy" refresh path re-reads the shared cache through the same `adoptDisk()` helper as the other two paths, but only the expired-memory and empty-memory paths have a timing test.
- A real fetch longer than 120 s guarded by the lock (two real hosts) was not reproduced; the threshold arithmetic and ownership checks are unit-tested.
- After a child exits, its process group is swept with `kill(-pid)`. In theory the group id could already have been reused by an unrelated process in the microseconds between the exit and the sweep (audit R3, accepted as a theoretical risk; the children are detached, so their group id equals their own pid).
- Targeted-refresh merges keep the base `fetchedAt`, so other hosts do not treat them as newer than an existing shared snapshot.

## Known external issues (not caused by this server)

- Cursor needs a signed-in browser session and Full Disk Access for Safari (`status: "error"`, `code: "auth"` otherwise).
- Claude reported a parse error earlier in the day (upstream #4083); on the last live run it returned usable windows.
- Antigravity is `offline` when the app is not running; that is a state, not a failure.

## Self-check (DESIGN.md section 8)

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | `npm test` and `npx tsc --noEmit` | Pass | 92 tests, 0 failures (`npm test`, exit 0, three consecutive runs per round); `npx tsc --noEmit` exit 0. |
| 2 | `tools/list` has exactly 3 tools; `provider` is an enum matching enabled providers | Pass | Smoke output above (codex, claude, cursor, antigravity, zai); also a unit test with a stub CLI. |
| 3 | `list_quotas` covers all enabled providers in roster order | Pass | Live sample; fixture test for the five-provider order. |
| 4 | No at-sign in default responses or test output; email only with `includeIdentity=true` | Pass | counting at-signs in the live response and in `npm test` output gives 0; `includeIdentity` unit test returns the example address. |
| 5 | claude/cursor `error` with a non-`unknown` code; codex/zai `ok`; antigravity `offline` with empty windows | Pass, with a note | Live run: cursor `error/auth`, codex/zai `ok`, antigravity `offline` and no windows. **Claude was `ok` on the live run** (the earlier parse error is gone), so the brief's "claude = error" expectation is not observable now; the fixture test covers claude `error/parse`. |
| 6 | codex windows = secondary only; `resetCredits.available` >= 1 with no id | Pass | Live: `windows: [secondary]`, `resetCredits: { available: 3 }`; fixture test asserts the key set is exactly `available`, `nextExpiresAt`. |
| 7 | Cache hit under 1 s; cold start with `waitSeconds: 1` returns `warming` within 2 s | Pass | Live: 2 ms warm, 1004 ms cold `warming: true`; integration tests with a stub CLI. |
| 8 | `CODEXBAR_MCP_NESTED=1` returns `status: "nested"` with no child process | Pass | Integration test: all three tools return `{status:"nested",providers:[]}`, the spawn counter stays 0 and the cache directory is never created. |
| 9 | Timeout kills the process group (fake `sleep 999` binary) | Pass | Integration test: after a 2 s hard timeout both the script and its `sleep` child are dead; a second test shows stdin close kills them too. |
| 10 | Fixture unit tests: null window, `usageKnown=false`, clamp >100, `resetPassed`, 0.60/0.74 reset credits, missing provider | Pass | `test/normalize.test.ts` (24 tests). Edge shapes that the real capture lacks (`usageKnown=false`, >100, `resetPassed`, 0.74) use small inline variants. |
| 11 | The CodexBar config file is never referenced in code; missing `CODEXBAR_BIN` gives `not_installed`, no retry | Pass | grep over `src/`, `test/`, `fixtures/` finds nothing (the only match anywhere is the TypeScript project file's own name); integration test makes the binary appear later and still gets `not_installed`. |
| 12 | Two concurrent `list_quotas` spawn once | Pass | Integration test with a counting stub: counter == 1 (still true after the scoped queue of audit round 1). |

Additional: TTL expiry is part of `stale` (integration test with an expired shared cache and a held lock); stale locks are preempted only after `max(120 s, hard timeout + 30 s)` (unit tests).

## Audit round 1

> Historical record of round 1 (68 tests at that time). Round 2 changed a few behaviours described here; where it did, Decisions 24, 27, 28, 30 and 32 and the table in "Audit round 2" are current.

Task list FIX-ROUND-1 (three reviews merged: F1-F11 from the coordinator / code review, F12-F22 from the adversarial review). DESIGN.md v1.2 (sections 3.4 and 5.3) was re-read first and no item conflicts with it. Nothing was committed.

**Ladder used for the "Reached" column** (each cell includes the ones before it): (1) source written, (2) inserted into the shipped file, (3) loaded automatically (executed by the real built entry `node dist/src/server.js`, the artifact hosts launch, inside a test), (4) activated (the behavior is observably on: the new assertions go red when the fix is reverted in a scratch copy), (5) verified live (observed through the real stdio server against the real CodexBar CLI 0.60.3).

**Commands** (the test process's own exit code, not `tee`'s):

```bash
npm test 2>&1 | tee LOG; echo "exit=${PIPESTATUS[0]}"      # builds, then node --test "dist/test/*.test.js"
npx tsc --noEmit; echo "exit=$?"
```

Final run: `npm test` exit **0**, 68 tests, 68 pass, 0 fail (it was run after every group: 36, 38, 41, 45, 49, 50, 52, 54, 57, 59, 61, 63, 66, 67, 68 tests, all exit 0); `npx tsc --noEmit` exit **0**; at-sign count in the full `npm test` output **0**; leftover fake-binary / `sleep 999` processes after the full run **0**; test sandbox directories are removed by an `after` hook.

**Revert check** ("M" below): the fix was undone in a scratch copy, rebuilt, and only that item's tests were run with `node --test --test-name-pattern`; every one exited 1. The first F12 revert check passed by accident (it only moved the handlers, not the real defect) and showed the stdin test was weak, so that test was tightened (the child group must be dead within 2.5 s, well under the 5 s probe timeout) and re-checked against the real defect (probes awaited before connect, handlers registered last): both F12 tests now fail on it.

| ID | Fix | Where | Reached | Evidence |
|---|---|---|---|---|
| F1 | Exit 0-4 with a parseable array is a normal result; empty/unparseable stdout or other codes are service errors; `cliExitCode` reported when non-zero | `src/source.ts:155-176` | (4) | Tests `F1: exit 2/3/4 with a valid array ...` (also asserts cache hit, 1 spawn), `F1: exit 4 with empty stdout is fetch_failed; exit 0/1 garbage is invalid_json`, `F1: exit 64 is a service error even if stdout happens to be a JSON array`; group run 36/36, exit 0; M1 (old rule) fails 1, exit 1. Live: real CLI exit 1 with a failed Cursor still gives `status: ok`, `cliExitCode: 1`. Real-CLI exit 2/3/4 cannot be produced on demand: not-verified-by-executor. |
| F2 | Roster is derived from a payload only on a full fetch; a targeted request with no roster goes full | `src/server.ts:170` (derive), `:243` (`scopeFor`) | (4) | Test `F2: serve mode, no cache: a first targeted refresh does the full fetch ...` (HTTP stub, requests == `["/usage"]`, later list has both providers, 0 spawns); group 49/49 exit 0; M13 fails 2, exit 1. A real `codexbar serve` was not started: not-verified-by-executor. |
| F3 | No targeted merge without a base: full fetch instead; nothing synthesized/persisted | `src/server.ts:243`, `src/normalize.ts:377` | (4) | Test `F3: cold start get_quota refresh=true fetches everything ...` (args log has no `--provider`, no `missing` on disk, `enabledProviders` intact); same group run and M13 as F2. |
| F4 | Stale threshold `max(120 s, hard timeout + 30 s)`; release checks owner pid + token | `src/cache.ts:27`, `:228` | (4) | Tests `F4: releaseLock leaves a lock that now belongs to someone else` (foreign pid, and same pid with other token after preemption), `F4: stale threshold follows the hard timeout ...`; group 52/52 exit 0; M4 (unconditional release) fails 1, exit 1. Two real hosts with a fetch over 120 s: not-verified-by-executor. No lease-renewal timer (Decision 27). |
| F5 | Failure state set only by full fetches; targeted failure overlaid on that provider | `src/server.ts:159`, `:327` | (4) | Test `F5: a failed targeted refresh stays on that provider ...` (provider `error.code == timeout`, then `list_quotas` is `ok`, `stale false`, no snapshot error; `codexbar_refresh` ok); group 50/50 exit 0; M14 fails 1, exit 1. |
| F6 | All passthrough free text (plan, source, pace, credits unit, details, display name) goes through `redactEmails` | `src/normalize.ts:67` (`safeText`), `:174` | (4) | Tests `F6: every passthrough free-text field is email-redacted ...` (details with `includeDetails=true`, `includeIdentity=false` has no at-sign; with identity only the explicit field has one), `F6: live path ...` (fake CLI with addresses in details/pace/plan); group 38/38 exit 0; M8 fails 2, exit 1. Live real-CLI response with `includeDetails: true` has 0 at-signs, but real data carries no address to leak, so the leak path itself is synthetic-only. |
| F7 | Reset-driven refresh needs a 60 s old snapshot and no failed refresh | `src/server.ts:122`, `:353` | (4) | Tests `F7: a source that always reports a past resetsAt is not re-fetched on every call` (3 calls, 1 spawn), `F7: a reset-driven refresh happens once the snapshot is older than 60 s, but not after a failed refresh`; group 61/61 exit 0; M5 fails 2, exit 1. |
| F8 | Targeted merge keeps the base `fetchedAt` | `src/normalize.ts:377` | (4) | Tests `F8: a targeted refresh does not make the other providers' old data look fresh` (age >= 3500 s after a codex refresh, zai keeps old value, 1 spawn), unit `F8/F17: merge keeps the base fetchedAt ...`; group 45/45 exit 0; M15 fails 1, exit 1. |
| F9 | Connect first, probes after; probe timeout 5 s; `tools/list` and calls wait at most 2 s and degrade | `src/source.ts:20`, `src/server.ts:529`, `:598` | (4) | Test `F9: a hung roster probe never delays initialize; tools/list degrades within its cap; the probe is killed at 5 s` (initialize < 1.5 s, tools/list < 4 s with no enum, list works, probe dead within 9 s); group 68/68 exit 0. Live: `initialize` 83 ms, `tools/list` 38 ms with the full enum on the real CLI. No revert check was run for F9. Codex's own 10 s MCP start-up budget is host-side: not-verified-by-executor. |
| F10 | README note on `--all-accounts` | README "Known limitations" | (2) | Docs only; stages 3-5 do not apply. |
| F11 | README note on keeping addresses off disk | README Decision 13 | (2) | Docs only; no code change, as instructed. |
| F12 | Handlers (stdin end/close, SIGTERM, SIGINT) before the first spawn; transport connected before probes | `src/server.ts:615-640` | (4) | Tests `F12: closing stdin while the startup probes are still running kills the probe process groups`, `F12: SIGTERM during the startup probes kills the probe process groups` (script and its `sleep 999` dead within 2.5 s; server exits within 3 s); group 41/41 exit 0; revert of the real defect fails 2, exit 1 (after tightening, see above). Live: after the real server exited no `codexbar usage` process remained. |
| F13 | Sweep the CLI's process group when the leader exits / closes | `src/source.ts:125` | (4) | Test `F13: descendants left behind by a CLI that exited normally are swept` (descendant inherits stdout and outlives the CLI; result `ok` in under 10 s, descendant dead); group 41/41 exit 0; M2 fails 1, exit 1. |
| F14 | Scoped single-flight; non-covered requests queue; one child at a time | `src/server.ts:96` (`covers`), `:208` (`requestFetch`) | (4) | Tests `F14: a full refresh queued behind a targeted fetch really runs, one child at a time` (2 spawns, targeted first, no overlap marker, all providers refreshed), `F14: codexbar_refresh waiting behind a targeted fetch ...`, `F14: same-scope and covered requests still share one fetch` (1 spawn); group 45/45 exit 0; M3 fails 2, exit 1. |
| F15 | Serve mode neither reads nor writes the shared disk cache | `src/server.ts:54` | (4) | Tests `F15: serve mode does not adopt a CLI-written disk cache; a dead serve is a fetch failure` (`fetch_failed`, `http_error`, 0 spawns, CLI file untouched), `F15: serve mode never writes the disk cache either`; group 54/54 exit 0; M9 fails 2, exit 1. Real `codexbar serve`: not-verified-by-executor. |
| F16 | Re-read the shared cache when memory is expired, empty, or the lock was busy | `src/server.ts:108` (`adoptDisk`), `src/cache.ts:154` | (4) | Tests `F16: an expired in-memory snapshot is replaced ...`, `F16: an empty in-memory cache adopts ...`, `F16: two resident hosts on one cache directory spawn the CLI once between them` (2 server processes, counter 1); group 57/57 exit 0; M16 fails 3, exit 1. The lock-busy path shares the helper but has no separate timing test (listed under Known limitations). |
| F17 | Rebuild cached/adopted snapshots against the current enabled roster | `src/normalize.ts:397`, `src/server.ts:125` | (4) | Tests `F17: providers no longer enabled disappear from a cached snapshot; newly enabled ones appear as missing`, unit `F8/F17: ...`; group 49/49 exit 0; M17 fails 1, exit 1. |
| F18 | Failed refresh with old cache: `status: fetch_failed`, data kept, `stale: true` | `src/server.ts:304` | (4) | Test `F18: a failed refresh with an old cache keeps the data but reports fetch_failed` (exit 64 and exit 2 with empty output; 2 providers returned; disk file untouched); group 59/59 exit 0; M6 fails 1, exit 1. |
| F19 | A wait that times out (pending refresh) counts as stale | `src/server.ts:297` | (4) | Test `F19: a wait that times out marks even a TTL-fresh snapshot stale (warming implies stale)`; same group run; M18 fails 1, exit 1. |
| F20 | Full structural validation of the disk cache | `src/cache.ts:71` | (4) | Tests `F20: a structurally broken shared cache is ignored ...` (7 broken shapes incl. the reported `{"snapshot":{}}`; each gives `ok` and exactly 1 spawn), `F20: a broken cache written after startup is ignored on the adopt path too`; group 63/63 exit 0; M10 fails 2, exit 1. |
| F21 | Cancelable wait: timer cleared when the fetch settles | `src/wait.ts:5`, `src/server.ts:361` | (4) | Tests `F21: raceWithTimeout leaves no timer behind ...`, `F21: after a fast fetch no long per-call timer is left alive (observed from inside the server process)` (timer observer loaded with `--import`; 0 timers >= 30 s at exit after 3 fast calls with `waitSeconds: 60`; exits within 1 s), `F21: negative control ...` (same observer sees the 60 s and 90 s timers of a pending call); group 66/66 exit 0; M7 fails 2, exit 1. |
| F22 | Legacy reset-credit list with nothing usable gives `available: 0` | `src/normalize.ts:263` | (4) | Test `F22: legacy reset-credit list with nothing usable reports available=0 and no nextExpiresAt` (all expired/used, empty list; absent and `null` stay omitted); group 67/67 exit 0; M11 fails 1, exit 1. |

**Live check** (real CLI 0.60.3, real stdio server, empty cache directory): `initialize` 83 ms; `tools/list` 38 ms with enum `codex, claude, cursor, antigravity, zai`; cold `list_quotas` 15.8 s, `status: ok`, `cliExitCode: 1`, `failedProviders: [cursor]`; warm call 1 ms; targeted `get_quota zai refresh=true` 784 ms, `status: ok`; no at-sign in any response (also with `includeDetails: true`); no `codexbar usage` process left after exit.

**Not verified by the executor:** real-CLI exit 2/3/4 (F1), a resident real `codexbar serve` (F2, F15), two real hosts with a fetch over 120 s (F4), the host-side start-up timeout of Codex (F9), and a revert check for F9. None of these changed the code decision.

## Audit round 2

Task list FIX-ROUND-2 (G1-G9) from the re-verification REVERIFY-1 (N1-N7) and two coordinator findings (R1, R2); R3 is recorded under Known limitations only. Same working tree, nothing committed. The one design conflict found (G5 vs the round-1 F5 test) was ruled by the coordinator: DESIGN v1.3 section 5.1, REVERIFY-1 N6, FIX-ROUND-2-ADDENDUM. Process hygiene: no `pkill` / `killall` was used this round; the only processes touched were the test servers and fake binaries that the tests themselves start and stop.

Ladder as in round 1: (1) source written, (2) inserted into the shipped file, (3) loaded automatically (executed by the real built entry `node dist/src/server.js` inside a test), (4) activated (the new assertions go red when the fix is reverted in a scratch copy), (5) verified live (real stdio server against the real CodexBar CLI 0.60.3).

Commands (exit code of the test process itself): `npm test 2>&1 | tee /tmp/fix2/gN.log; echo "exit=${PIPESTATUS[0]}"` after every group, then `npx tsc --noEmit`. Counts per group: G1 71, G2 73, G3 76, G4 78, G5 80, G6 81, G7 84, G9 85 tests (G8 is docs only), all exit 0 with 0 failures. Final: three consecutive full runs, each `npm test` exit **0**, 85/85 pass, about 46 s, at-sign count in the output **0**; `npx tsc --noEmit` exit **0**.

| ID | Fix | Where | Reached | Evidence |
|---|---|---|---|---|
| G1 | Redaction moved to the single projection exit: deep redaction of everything except the explicit identity field | `src/normalize.ts:71` (`redactDeep`), `:480` | (4) | Tests `G1: a valid disk cache written by the previous normalizer (2939c19de) never leaks addresses after preload` (the OLD normalizer is taken from `git show 2939c19de:...`, transpiled and run to write a real legacy cache; default `list_quotas` and `get_quota includeDetails=true` have no at-sign, `includeIdentity=true` releases exactly one), `G1: projectSnapshot redacts free text that never went through normalizeSnapshot`, `G1: redactDeep ...`; group 71/71 exit 0; revert (no redaction at the exit) fails 2 tests, exit 1. Live: responses with `includeDetails: true` have no at-sign; the leak path itself needs a legacy cache, so it is test-only. |
| G2 | A targeted fetch takes the lock, adopts the newest shared snapshot as its base, and `writeDisk` never replaces a newer snapshot with an older one | `src/server.ts:223`, `src/cache.ts:189` | (4) | Tests `G2: a targeted refresh merges into the newest shared snapshot and never rolls the disk back` (resident host loaded zai=20; "another host" wrote zai=90; after a codex refresh the disk still has zai=90, codex=42.4, `fetchedAt` not earlier), `G2: writeDisk is monotonic ...`; group 73/73 exit 0; reverts: no adopt under the lock fails 1, non-monotonic write fails 1 (both exit 1). Two real hosts: not-verified-by-executor. |
| G3 | Roster state unknown vs known; known and empty clears providers and uses a string `provider` with an explanatory description | `src/normalize.ts:414`, `src/server.ts:71`, `:402` | (4) | Tests `G3: a successful roster query that returns an empty list means nothing is enabled (not 'unknown')` (cache with codex/zai, roster `[]`: `enabledProviders` and `providers` empty, no spawn, no enum, `get_quota` is an error, `codexbar_refresh` ok with empty snapshot), `G3: an unknown roster (probe failed) still leaves the cached snapshot untouched`, unit `G3: rebuildForRoster ...`; group 76/76 exit 0; revert (roster never marked known) fails 1, exit 1. The round-1 assertion `rebuildForRoster(snapshot, [])` returning the snapshot untouched still holds (the known flag is a new option). |
| G4 | Lock owner record carries `leaseUntil`; competitors honour the holder's lease; no usable record falls back to `max(own threshold, 630 s)` from mtime | `src/cache.ts:95`, `:247` | (4) | Tests `G4: a host with a short timeout cannot preempt a lock whose holder leased a longer one` (A TIMEOUT 600, B TIMEOUT 90, A's `at` moved back 121 s, B refused; expired lease is taken), `G4: a lock with no usable owner record falls back to max(local threshold, 630 s)` (missing and corrupt record, 200 s refused, 700 s taken); group 78/78 exit 0; revert (holder lease ignored) fails 1, exit 1. Time is simulated by rewriting `at`; a real 121 s run and two real hosts: not-verified-by-executor. |
| G5 | Per-provider record of targeted failures (a state, not an event); shown on that provider in every response until a covering refresh succeeds or a newer shared snapshot is adopted; snapshot-level state untouched | `src/server.ts:79` (record), the overlay loop in `buildResponse`, `overlayProviderFailure`; initiator exception at the end of `queryUsage` | (4) | Ruling: coordinator, DESIGN v1.3 5.1, REVERIFY-1 N6, FIX-ROUND-2-ADDENDUM (the earlier "delivered = consumed" idea was dropped). Tests: `G5: a targeted failure that completes after the caller got 'warming' is still reported until a refresh succeeds` (N6: later plain `get` shows `provider.status: error`, `partial: true`, `failedProviders` has it, window kept, snapshot `status: ok`, `stale: false`, no snapshot error; a successful refresh clears it; a full refresh clears it too), `G5: the failure stays after the caller that waited for it has seen it, until a covering refresh succeeds` (initiator `stale: true`; three later `list_quotas` calls still show the failure; a full refresh clears it); the delivery-rule test written earlier this round was deleted. The two old assertions the ruling allowed to change are in `F5: a failed targeted refresh is recorded on that provider only; the snapshot-level state stays ok` (renamed from `F5: a failed targeted refresh stays on that provider; list_quotas keeps reporting fresh data as ok`; changed: `failedProviders` is now `["codex"]`, and "every provider is ok" became "codex is `error` with `error.code == timeout`, every other provider is ok"; every other F5 assertion is unchanged); each change is marked `ruling` in the test and cites the three documents. 85/85 exit 0, three consecutive full runs all exit 0; reverting to consume-on-delivery fails 2 tests (that F5 test and the new G5 test), exit 1. |
| G6 | `waitSeconds` is one budget for probe wait and fetch wait (one `Deadline` per call) | `src/wait.ts:26`, `src/server.ts:649` | (4) | Test `G6: waitSeconds is one budget for probes and fetch together (hung probes + hung usage, waitSeconds=1)` (returns in under 1.5 s with `warming: true`; `waitSeconds: 0` returns in under 0.7 s); group 81/81 exit 0, run twice; revert (separate budgets) fails 1, exit 1. Live with the real CLI: cold `waitSeconds: 1` returned `warming` after 1004 ms. |
| G7 | `tools: { listChanged: true }`; a `tools/list` answered without the roster is followed by `notifications/tools/list_changed` once the roster is known | `src/server.ts:721`, `:764` | (4) | Tests `G7: a tools/list answered before the roster was known is followed by tools/list_changed, and the next list has the enum` (probe delayed 3 s: first list has no enum, notification arrives, second list has `["codex"]`), `G7: serve mode - the enum appears after the first fetch, announced by tools/list_changed`, `G7: nested (inert) mode never sends tools/list_changed`; the existing `tools/list: exactly three tools; provider is an enum from the roster` keeps every assertion and now lists via a helper that waits for the notification if the first answer was degraded (no 2 s timing dependence); group 84/84 exit 0; revert (notification never sent) fails 2, exit 1 (the delayed-probe test and the serve-mode test); three consecutive full runs all exit 0. SDK 1.32.1 has `Server.sendToolListChanged()`, so no stop condition applied. Host-side behaviour on receiving the notification: not-verified-by-executor. |
| G8 | README Decision 13 no longer promises single-process identity use avoids persistence | README Decision 13 | (2) | Docs only: it now says `includeIdentity` only controls the response projection, a memory-only identity mode is not implemented, and keeps only the tmpfs / RAM disk advice. |
| G9 | `codexbar_refresh` waits at most hard timeout + slack, then returns `{ ok: false, warming: true, retryAfterSeconds, snapshot }` | `src/server.ts:458`, `:58` | (4) | Test `G9: codexbar_refresh is bounded (hard timeout + slack) even when queued behind a hanging targeted fetch` (every usage run hangs to a 2 s hard timeout, slack 0: returns after about 2 s instead of about 4 s); group 85/85 exit 0; revert (unbounded) fails 1, exit 1. New knob `CODEXBAR_MCP_REFRESH_SLACK_SECONDS` (default 10), documented above. |
| R3 | Recorded as a Known limitation only | README "Known limitations" | (2) | Docs only, as instructed. |

**Other notes**
- Two round-1 tests turned red while G6 was being built and were fixed in the PRODUCT code, with their assertions untouched: `F21: negative control` expects a wait timer of exactly 60000 ms, so the shared budget is a single `Deadline` timer of exactly `waitSeconds` rather than a shrinking "remaining time" timer; `F14: codexbar_refresh waiting behind a targeted fetch` depends on request arrival order, so the `refresh` tool now takes the same wait path (same number of async hops) as the other tools. The only test edits this round are in new tests, and the two helper changes `Rpc.request` `unref` and `listToolsUntil` used by `tools/list: exactly three tools ...` (assertions kept) and by G3.
- The test suite used to take about 148 s per run because of an unanswered request's 120 s timer in `test/helpers.ts`; it now takes about 46 s (Decision 35). That was a test-helper defect, not product code.
- I used `pkill` in round 1 (including a name-based `pkill -x sleep -P 1`); that was wrong and is not repeated here.
- **Not verified by the executor:** two real hosts racing on one cache directory (G2, G4), a real 121 s lock age (G4), a real `codexbar serve` (G7 serve-mode uses an HTTP stub), how a host reacts to `tools/list_changed` (G7), and independent reviewers of the revert checks (each revert is a single-line change made by me; they show the tests detect that line, not that no other regression exists).

## Audit round 3

Task list FIX-ROUND-3 (H1-H4) from the second re-verification REVERIFY-2 (D1-D4). DESIGN.md v1.3.1 (5.1 point 3: `status` is derived, the initiator exception only sets `stale`) was re-read first; H4 needed no product code. Same working tree, nothing committed. No `pkill` / `killall`; no processes outside the tests' own children were touched.

Ladder as in rounds 1-2: (1) source written, (2) inserted into the shipped file, (3) loaded automatically (executed by the real built entry inside a test), (4) activated (the fix's assertions go red when the fix is reverted in a scratch copy), (5) verified live (real stdio server, real CodexBar CLI 0.60.3).

Commands (exit code of the test process itself): after each group `npm test 2>&1 | tee /tmp/fix3/hN.log; echo "exit=${PIPESTATUS[0]}"` and `npx tsc --noEmit`. Counts per group: H1 87, H2 88, H3 91 (then the helper fix kept 91), H4 92 tests, all exit 0 with 0 failures. Final: three consecutive full runs, each `npm test` exit **0**, 92/92 pass, about 59 s, at-sign count in the output **0**; `npx tsc --noEmit` exit **0**.

| ID | Fix | Where | Reached | Evidence |
|---|---|---|---|---|
| H1 | The shared cache file carries a monotonic write `rev` (integer, disk format only, never in a response). Adoption and locked targeted merges pick the newest copy by `rev` first, `fetchedAt` second (the data age, unchanged per F8); a write gets `rev = max(memory rev, disk rev) + 1`. Files without `rev` (pre-existing caches) count as 0. | `src/cache.ts:45` (`payloadRev`), `:159` (`memRev`), `:192`, `:224`, `src/server.ts:219` | (4) | Tests `H1: two hosts that loaded the same snapshot and refresh different providers in turn keep both updates (REVERIFY-2 D1)` (two real server processes on one cache directory: A refreshes codex, then B refreshes zai; the disk keeps codex=42.4 AND zai=55, `fetchedAt` unchanged, `rev` = initial + 2, both hosts see both updates, and no response contains a `rev` field), `H1: adoption compares the write rev first and fetchedAt second; files without a rev count as rev 0` (equal fetchedAt + higher rev is adopted; equal copy is not; first write over a legacy file gets rev 1; a legacy newer-fetchedAt file never beats a higher rev); group 87/87 exit 0; revert (adoption ignores `rev`, fetchedAt only) fails 2, exit 1. Two real hosts over a real 120 s fetch: not-verified-by-executor. |
| H2 | `codexbar_refresh` starts ONE deadline (hard timeout + slack) at call start; the probe wait and the queued fetch wait share it | `src/server.ts:615`, `:441` | (4) | Test `H2: codexbar_refresh on a cold start counts the probe wait inside its bound (REVERIFY-2 D3)` (probe and usage both hang, TIMEOUT=2, SLACK=0: returns ok=false/warming=true in under 2.5 s instead of about 4 s); group 88/88 exit 0; revert (probe wait outside the bound) fails 1, exit 1. |
| H3 | `tools/list_changed` is driven by the last PUBLISHED provider schema: the server remembers what the last `tools/list` actually answered and notifies whenever the roster changes that schema - so a provisional enum replaced by the real roster is announced again, with no notification when nothing changed and none before the first list | `src/server.ts:508` (`providerSchema`), `:701` (`announcedProviderSchema`), `:703` | (4) | Tests `H3: a provisional enum replaced by the real roster is announced again (REVERIFY-2 D4)` (delayed probe + earlier codex-only fetch: first list has no enum, exactly two notifications land, the final list has `["codex","zai"]`; the provisional `["codex"]` is asserted only when it is still the published one - the two notifications can land close together and the test does not depend on their interleaving), `H3: no tools/list_changed when the roster does not change the published schema`, `H3: nothing is announced before the first tools/list, and a known-empty roster counts as a change`; group 91/91 exit 0; revert (never notify) fails 2, exit 1. **A test-helper defect was found and fixed while building this (test infrastructure only, no product change, no old assertion touched): `waitForNotification` missed notifications that arrived before the wait started (a timed-out waiter stayed registered and swallowed them), and the full suite had silently taken about 148 s per run since round 1 because of an unrelated 120 s un-`unref`'d timer in the same helper. The helper now buffers every notification, and a full run takes about 59 s.** How a real host consumes `tools/list_changed`: not-verified-by-executor. |
| H4 | Assertions only (the product code already matched DESIGN v1.3.1 5.1): the failed-targeted initiator's `status` is asserted for both derivations | `test/server.test.ts` (`G5: the failure stays ...`, `H4: when the full fetch has failed ...`) | (4) | Added to `G5: the failure stays after the caller that waited for it has seen it ...`: the initiator is `status: "stale"` (cache fresh, full fetch ok) - line 1401, citing DESIGN v1.3.1 5.1 and REVERIFY-2 D2. New test `H4: when the full fetch has failed, the failed-targeted initiator still reports fetch_failed` (seeded cache, full refresh fails with exit 64, then the targeted initiator: `stale: true`, provider `error`, and `status` stays `fetch_failed` with `error.code: cli_exit_64`); group 92/92 exit 0. No product code changed. |

**R3 (carried over, docs only):** still recorded under Known limitations; nothing new this round.

**Not verified by the executor:** two real hosts contending over one cache directory beyond the two-process D1 scenario (H1), how a real host consumes `tools/list_changed` (H3), and the reverted-fix checks are single-line reverts made by me - they show the tests detect that line, nothing more.

