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
- `stale: true` means: TTL expired, the last refresh failed, another host holds the refresh lock, or a window's reset time already passed.
- `warming: true` + `retryAfterSeconds`: a refresh is still running; you got the existing data (or an empty list).
- Account emails are omitted unless `includeIdentity=true`; emails inside error text are replaced with `<redacted>`.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `CODEXBAR_SERVE_URL` | unset | e.g. `http://127.0.0.1:8080`. Switches to `serve` mode (`GET /usage`); this process then spawns nothing. |
| `CODEXBAR_BIN` | unset | CLI path. When set it is used exclusively. Otherwise `/opt/homebrew/bin/codexbar`, `/usr/local/bin/codexbar`, `/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI`. Not found -> `status: "not_installed"`, never retried. |
| `CODEXBAR_MCP_TTL_SECONDS` | 300 | In-memory / shared-cache TTL. |
| `CODEXBAR_MCP_TIMEOUT_SECONDS` | 90 | Hard timeout per fetch; the child's whole process group gets SIGKILL. |
| `CODEXBAR_MCP_CACHE_DIR` | `~/.cache/codexbar-mcp` | Shared cache (`usage.json`) and `usage.lock` directory. |
| `CODEXBAR_MCP_NESTED` | unset | Set to `1` by this server on every child it spawns. If already present at startup the server is inert: tool calls return `{ "status": "nested", "providers": [] }`, nothing is spawned, the cache is not read. |

Hygiene: no polling timers (refresh happens lazily inside a tool call), one in-flight fetch per process (single-flight),
cross-process mutual exclusion through the `usage.lock` directory (locks older than 120 s are preempted),
child stderr is discarded, and SIGTERM / SIGINT / stdin EOF kill the in-flight process group before exiting.

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
13. **The disk cache stores the full internal snapshot, including the account email,** so `includeIdentity` works across hosts. The file is mode 0600; responses strip the email by default.
14. **Targeted refresh merge:** the merged snapshot's `fetchedAt` is the merge time; each provider's own `updatedAt` stays as reported. With no earlier snapshot, the other providers are synthesized as `missing`.
15. **Our own hard-timeout kill** reports `error.code = "timeout"`; `retryAfterSeconds` is the time left to the hard deadline (clamped to 5-60), or 10 when another host holds the lock. When the lock is busy and no data exists at all, the status is `warming`.
16. **If `config providers` fails but usage works,** the roster falls back to the providers present in the payload.
17. **`get_quota` with an unknown provider** returns an MCP tool error (`isError`), and the `providers` array is filtered to the one requested entry.
18. **stdin EOF is handled explicitly:** the SDK's stdio transport does not report it as a close, and DESIGN section 3.3 requires killing the child group when the host goes away.
19. **`CODEXBAR_SERVE_URL`** must be `http(s)://...`; anything else is ignored.
20. **`package-lock.json` is committed;** `test/helpers.ts` is a non-test helper next to the `*.test.ts` files.
21. **Fixture:** the real full-run output with the `openaiDashboard` block removed, every `id` set to `"redacted"`, and the account address replaced by an example address. The Zai detail rows and the Cursor error text are kept as captured.

## Known external issues (not caused by this server)

- Cursor needs a signed-in browser session and Full Disk Access for Safari (`status: "error"`, `code: "auth"` otherwise).
- Claude reported a parse error earlier in the day (upstream #4083); on the last live run it returned usable windows.
- Antigravity is `offline` when the app is not running; that is a state, not a failure.

## Self-check (DESIGN.md section 8)

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | `npm test` and `npx tsc --noEmit` | Pass | 33 tests, 0 failures; tsc reports no errors. |
| 2 | `tools/list` has exactly 3 tools; `provider` is an enum matching enabled providers | Pass | Smoke output above (codex, claude, cursor, antigravity, zai); also a unit test with a stub CLI. |
| 3 | `list_quotas` covers all enabled providers in roster order | Pass | Live sample; fixture test for the five-provider order. |
| 4 | No at-sign in default responses or test output; email only with `includeIdentity=true` | Pass | counting at-signs in the live response and in `npm test` output gives 0; `includeIdentity` unit test returns the example address. |
| 5 | claude/cursor `error` with a non-`unknown` code; codex/zai `ok`; antigravity `offline` with empty windows | Pass, with a note | Live run: cursor `error/auth`, codex/zai `ok`, antigravity `offline` and no windows. **Claude was `ok` on the live run** (the earlier parse error is gone), so the brief's "claude = error" expectation is not observable now; the fixture test covers claude `error/parse`. |
| 6 | codex windows = secondary only; `resetCredits.available` >= 1 with no id | Pass | Live: `windows: [secondary]`, `resetCredits: { available: 3 }`; fixture test asserts the key set is exactly `available`, `nextExpiresAt`. |
| 7 | Cache hit under 1 s; cold start with `waitSeconds: 1` returns `warming` within 2 s | Pass | Live: 2 ms warm, 1004 ms cold `warming: true`; integration tests with a stub CLI. |
| 8 | `CODEXBAR_MCP_NESTED=1` returns `status: "nested"` with no child process | Pass | Integration test: all three tools return `{status:"nested",providers:[]}`, the spawn counter stays 0 and the cache directory is never created. |
| 9 | Timeout kills the process group (fake `sleep 999` binary) | Pass | Integration test: after a 2 s hard timeout both the script and its `sleep` child are dead; a second test shows stdin close kills them too. |
| 10 | Fixture unit tests: null window, `usageKnown=false`, clamp >100, `resetPassed`, 0.60/0.74 reset credits, missing provider | Pass | `test/normalize.test.ts` (21 tests). Edge shapes that the real capture lacks (`usageKnown=false`, >100, `resetPassed`, 0.74) use small inline variants. |
| 11 | The CodexBar config file is never referenced in code; missing `CODEXBAR_BIN` gives `not_installed`, no retry | Pass | grep over `src/`, `test/`, `fixtures/` finds nothing (the only match anywhere is the TypeScript project file's own name); integration test makes the binary appear later and still gets `not_installed`. |
| 12 | Two concurrent `list_quotas` spawn once | Pass | Integration test with a counting stub: counter == 1. |

Additional: TTL expiry is part of `stale` (integration test with an expired shared cache and a held lock); stale locks older than 120 s are preempted (unit test).
