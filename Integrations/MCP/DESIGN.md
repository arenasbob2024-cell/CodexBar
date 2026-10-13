# CodexBar MCP Server 设计方案（v1.1，含红队补丁）

状态：定稿，交 Pi 执行
作者：Claude（方案 / 审计）  执行：Pi  日期：2026-10-13

## 1. 目标

让多 agent 调度场景中的主 agent（Claude Code / Pi / Codex CLI）通过 MCP 随时读取本机 CodexBar
已知的各订阅 provider 剩余额度、重置时间和消耗节奏，用于给子 agent 分工。

MCP 只负责**报告**额度，外加少量机械推导（最紧窗口、预计耗尽时间）。调度决策（谁干什么）留给主 agent，
MCP 不做推荐、不做排序、不输出 "dispatchable" 之类的结论字段。

## 2. 为什么是薄封装而不是 `codexbar mcp` Swift 子命令

- 上游 issue [#3295](https://github.com/steipete/CodexBar/issues/3295) 请求 `codexbar mcp`，维护者
  steipete 以 not planned 关闭：任何 MCP wrapper 都能直接调 `codexbar usage --json` 或 dashboard HTTP，
  并表示愿意在文档链接社区 wrapper。
- 薄封装不改 Swift、不触发 1370 文件的全量构建、不依赖仓库版本（本机 CLI 0.60.3，仓库 v0.74.1 均可用）、
  未来与上游同步零冲突。
- 位置 `Integrations/MCP/`，与 `Integrations/Linux`、`Integrations/Omarchy` 同级，符合 VISION.md
  "桌面集成作为独立消费方消费 `codexbar serve` 或 `codexbar usage --json`" 的原则。

## 3. 数据源、缓存与进程卫生（红队重点）

### 3.1 两个数据源，环境变量切换

| 模式 | 触发 | 延迟 | 说明 |
|---|---|---|---|
| `serve`（推荐多 host 共用） | 设了 `CODEXBAR_SERVE_URL`（如 `http://127.0.0.1:8080`） | <100ms | 走 `GET /usage`，由一个常驻 `codexbar serve --refresh-interval 300` 统一刷新；MCP 本身不 spawn 任何进程 |
| `cli`（默认） | 未设 `CODEXBAR_SERVE_URL` | 全量实测 43s，单 provider 约 10s | 子进程 `codexbar usage --format json --json-only --log-level error [--provider <id>]` |

二进制定位：`CODEXBAR_BIN` 环境变量 → `/opt/homebrew/bin/codexbar` → `/usr/local/bin/codexbar` →
`/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI`。GUI 启动的 harness 常常没有 Homebrew PATH，不能只靠 PATH。
找不到 → 服务进入 `not_installed` 状态：工具返回 `{ status: "not_installed", hint }`，**不再重试**。

### 3.2 防递归（必须）

CodexBar 的 Claude provider 在 `auto` 源下会回落到 `claude` CLI 的 PTY 探测（docs/claude.md），而 `claude` 启动时会
初始化用户配置的 MCP server，包括本服务（上游 #3521、#4077 就是这个问题的后果）。不防护就是无限扇出。

- spawn 子进程时注入环境变量 `CODEXBAR_MCP_NESTED=1`。
- 服务启动时若自身环境已有 `CODEXBAR_MCP_NESTED=1`：进入**惰性模式**，正常应答 `initialize` / `tools/list`，
  但任何工具调用只返回 `{ status: "nested", providers: [] }`，绝不 spawn、绝不读缓存文件。
- 单元测试覆盖：带 sentinel 启动 → 工具调用零 spawn。

### 3.3 无后台定时器，惰性刷新 + 单飞 + stale-while-revalidate

- **不设 setInterval。** 只在工具调用时判断缓存年龄，超过 TTL 才触发抓取。
- 内存缓存 TTL 默认 **300s**（`CODEXBAR_MCP_TTL_SECONDS`），额度窗口本来就是分钟级变化，60s 没必要。
- 同一进程任何时刻最多一个在途抓取（单飞 Promise）；并发工具调用共享它。
- 磁盘共享缓存 `~/.cache/codexbar-mcp/usage.json`（`CODEXBAR_MCP_CACHE_DIR` 可改）：每次抓取成功后原子写入
  （临时文件 + rename），启动或缓存过期时先读它；三个 host 同时跑时，谁先刷新谁写盘，其他 host 直接受益。
  写入前用 `mkdir` 锁目录做互斥（`usage.lock`，超过 120s 视为陈旧锁可抢占）。拿不到锁的 host 不抓取，返回盘上数据并标 stale。
- 工具入参 `waitSeconds`（默认 20，上限 60）：缓存过期且抓取在途时最多阻塞这么久；超时则返回现有数据（或空）并带
  `warming: true, stale: true, retryAfterSeconds`。`initialize` / `tools/list` 永远不等待抓取。
- 子进程：`detached: true` 自成进程组，硬超时 `CODEXBAR_MCP_TIMEOUT_SECONDS`（默认 90）到点 `kill(-pgid, SIGKILL)`；
  服务收到 SIGTERM / SIGINT / stdin 关闭时同样杀整个进程组后退出。
- 子进程 stderr 一律丢弃（`stdio: ['ignore','pipe','ignore']`），不转发、不记日志。

### 3.4 退出码语义

CLI 文档：任一 provider 失败即非零退出。因此：
- exit 0 / 1 且 stdout 可解析为 JSON 数组 → 正常结果（1 只表示有 provider 失败）。
- exit 2（binary not found）、3（parse error）、4（timeout）、64（usage）或 stdout 不可解析 → 服务级错误，
  工具返回 `{ status: "fetch_failed", code: "cli_exit_<n>" | "invalid_json" }`，并保留上一份缓存标 stale。

## 4. MCP 工具

工具 description 要写给 LLM 看：provider 就是"背后供养某个子 agent 的订阅"，数值含义、stale 含义、refresh 很慢。

### 4.1 `codexbar_list_quotas`
入参：`{ maxAgeSeconds?: number, waitSeconds?: number = 20, includeIdentity?: boolean = false, includeDetails?: boolean = false }`
`maxAgeSeconds` 覆盖 TTL（如传 0 等价于强制刷新）。返回 `QuotaSnapshot`。

### 4.2 `codexbar_get_quota`
入参：`{ provider: <enum>, refresh?: boolean = false, waitSeconds?, includeIdentity?, includeDetails? }`
`provider` 的 JSON Schema 用 **enum**，取值来自启动时 `codexbar config providers --format json`（70ms）里
`enabled === true` 的 id；description 列出 `id (displayName)` 对照，如 `claude (Claude)`、`zai (z.ai)`。
`refresh=true` 用 `--provider <id>` 定向抓取后合并进缓存。

### 4.3 `codexbar_refresh`
入参：`{}`。强制全量重抓，返回 `{ ok, durationMs, snapshot }`。
description 必须写：**"慢（约 45 秒）。list_quotas 已自动按 TTL 刷新，仅当 updatedAt 比你需要的更旧时才调用。"**

## 5. 归一化输出 schema

```ts
interface QuotaSnapshot {
  status: "ok" | "warming" | "stale" | "nested" | "not_installed" | "fetch_failed";
  source: "cli" | "serve";
  cliVersion?: string;         // codexbar --version，启动时取一次
  fetchedAt?: string;          // ISO，最近一次成功抓取
  ageSeconds?: number;
  stale: boolean;              // ageSeconds > TTL，或最近一次刷新失败，或任一窗口 resetPassed
  warming?: boolean;
  retryAfterSeconds?: number;
  partial: boolean;            // 任一启用 provider 不是 ok
  failedProviders: string[];
  enabledProviders: string[];  // 来自 config providers 清单，不是来自 usage 输出
  providers: ProviderQuota[];  // 顺序 = enabledProviders；清单里有而 usage 输出没有的 → 合成 status=error code=missing
  error?: { code: string; message: string };   // 服务级错误，message 为固定文案，不含 CLI 原文
}

interface ProviderQuota {
  provider: string;            // codexbar id
  displayName: string;         // 来自 config providers
  status: "ok" | "error" | "offline";
  source?: string;             // oauth / api / cli / web / offline
  plan?: string;               // loginMethod
  windows: QuotaWindow[];      // 只含真实存在的窗口；null 槽位不输出；isSyntheticPlaceholder=true 的跳过
  bindingWindow?: "primary" | "secondary" | "tertiary";  // known 窗口里 remainingPercent 最小者
  minRemainingPercent?: number;
  pace?: { summary: string; projectedEmptyAt?: string; etaSeconds?: number; stage?: string };  // 来自 pace.primary
  credits?: { balance: number; unit: string; updatedAt?: string };   // 只取 providerCost.balance + currencyCode；limit/used 忽略
  resetCredits?: { available: number; nextExpiresAt?: string };      // 见 §5.2，绝不输出 id
  updatedAt?: string;          // usage.updatedAt
  error?: { code: "timeout" | "auth" | "parse" | "missing" | "provider" | "unknown"; message: string };  // message 为 CLI 的 error.message 去掉邮箱后的文本
  identity?: { accountEmail?: string };   // 仅 includeIdentity=true
  details?: Array<{ title?: string; rows: Array<{ label: string; value: string; secondaryValue?: string }> }>;  // 仅 includeDetails=true，原样透传字符串，不解析数字
}

interface QuotaWindow {
  id: "primary" | "secondary" | "tertiary";
  label: string;               // windowMinutes 推导：300→"5h", 10080→"weekly", 43200→"monthly"，否则 "<n>m"；不用 resetDescription（是本地化文本）
  windowMinutes?: number;
  known: boolean;              // usageKnown === false 时为 false，此时三个百分比都为 null
  usedPercent: number | null;  // clamp 0–100，保留一位小数
  rawUsedPercent?: number;     // 未 clamp 原值（CLI 故意不 clamp，可 >100）
  remainingPercent: number | null;  // 100 - clamp(used)
  resetsAt?: string;           // 只接受带 Z 或显式时区的 ISO-8601；否则省略
  resetsInMinutes?: number;    // 调用时刻计算，>= 0
  resetPassed?: boolean;       // now >= resetsAt：置 true，resetsInMinutes=0，used/remaining 置 null，snapshot.stale=true，并触发一次刷新
}
```

### 5.1 status 规则
- 有 `error` 对象 → `error`，code 由 message 关键字映射（timed out→timeout，No ... session/sign in→auth，parse→parse），映射不到→provider。
- `source === "offline"` → `offline`，无论 usage 里有什么。
- 否则 `ok`。
- 单个 provider 失败只影响它自己。

### 5.2 Codex 免费重置额度（两种 CLI 形状）
- 0.74.x：顶层 `resetCredits { available, nextExpiresAt }` → 直接用。
- 0.60.x：`usage.codexResetCredits.credits[]` → 过滤 `status === "available" && expires_at > now`，
  `available` = 数量，`nextExpiresAt` = 最早 expires_at。
- 两者都没有 → 省略字段。**不**把它折进 remainingPercent。

### 5.3 身份剥离
默认删除：`accountEmail`、`identity.accountEmail`、`credits.events`、任何 `id` / `accountId` 字段、
`openaiDashboard` 整块。错误文本里形如邮箱的子串替换为 `<redacted>`。

## 6. 工程约定

- 目录 `Integrations/MCP/`：
  `package.json`、`tsconfig.json`、`README.md`、
  `src/server.ts`（MCP 装配 + 工具定义）、`src/source.ts`（cli / serve 两个数据源 + 进程组管理）、
  `src/cache.ts`（内存 + 磁盘缓存 + 锁）、`src/normalize.ts`（纯函数）、`src/roster.ts`（config providers）、
  `test/*.test.ts`、`fixtures/usage.v0.60.sample.json`（脱敏：邮箱改 `user@example.com`，id 改 `redacted`）。
- 依赖只有 `@modelcontextprotocol/sdk`（^1.32）与 `zod`；`tsc` 构建到 `dist/`；测试 `node --test`。
- `normalize.ts` 必须是纯函数 `(rawArray, roster, now: Date, opts) => QuotaSnapshot`，方便 fixture 测试。
- 不改任何 Swift 文件，不改根 README、Package.swift、Makefile。
- 分支 `feat/mcp-server`；不 push、不提 PR。提交信息 `feat(mcp): ...`。

## 7. 接入示例（写进 README）

```bash
# Claude Code（user 作用域，否则只在当前目录可见）
claude mcp add --scope user codexbar -- node /ABS/PATH/Integrations/MCP/dist/server.js
```

```json
// Pi: ~/.pi/agent/mcp.json
{ "mcpServers": { "codexbar": { "command": "/opt/homebrew/bin/node", "args": ["/ABS/PATH/Integrations/MCP/dist/server.js"] } } }
```

```toml
# Codex CLI: ~/.codex/config.toml
[mcp_servers.codexbar]
command = "node"
args = ["/ABS/PATH/Integrations/MCP/dist/server.js"]
```

多 host 推荐：常驻 `codexbar serve --refresh-interval 300`，三个 host 都设 `CODEXBAR_SERVE_URL=http://127.0.0.1:8080`。

## 8. 验收清单（审计方逐条核）

1. `npm test` 通过；`npx tsc --noEmit` 零错误。
2. stdio 下 `initialize` → `tools/list` 恰好 3 个工具；`get_quota.provider` 是 enum 且与 `config providers` 启用项一致。
3. `list_quotas` 的 `providers` 覆盖全部启用 provider（本机：codex、claude、cursor、antigravity、zai），顺序一致。
4. 默认返回体与所有测试输出 grep 不到 `@`；`includeIdentity=true` 时才有邮箱。
5. claude / cursor `status: "error"` 且 code 非 unknown；codex / zai `ok`；antigravity `offline` 且 windows 为空或 known=false。
6. codex 的 `windows` 只有 secondary（primary 为 null 不输出）；`resetCredits.available` ≥ 1 且无 id。
7. 缓存命中时工具响应 < 1s；冷启动 `waitSeconds: 1` 时 2s 内返回 `warming: true`。
8. 带 `CODEXBAR_MCP_NESTED=1` 启动，调用工具返回 `status: "nested"` 且无子进程。
9. 子进程超时后进程组被杀（测试用假的 `CODEXBAR_BIN` 指向一个 `sleep 999` 脚本验证）。
10. fixture 单测：null 窗口、usageKnown=false、usedPercent>100 clamp、resetPassed、0.60/0.74 两种 resetCredits、缺失 provider 合成 error=missing。
11. 代码中无 `config.json` 字样；`CODEXBAR_BIN` 不存在时返回 `not_installed` 且不重试。
12. 单飞：并发两次 `list_quotas` 只 spawn 一次（测试用计数器脚本当假二进制）。

## 9. 已知外部问题（不在本任务范围）

- Claude provider 当前报错：Claude Code 2.1.x 的 `/usage` 只返回订阅通知（上游 #4083）。修法二选一：
  升级 CodexBar.app 到 ≥0.74（含修复），或 Settings → Providers → Claude → Usage source 改为 Web/OAuth。
- Cursor 需要 Safari/Chrome 已登录 cursor.com 且授予 Full Disk Access。
- config.json 的 moonshot 条目 apiKey 字段里是一段误粘贴的中文提示词，建议清理。

## 10. 红队记录（2026-10-13，三视角并行）

| 视角 | 采纳的攻击 | 落在哪 |
|---|---|---|
| 运维/隐私 | 递归 spawn 循环；多 host 进程风暴与僵尸 PTY；provider 限流；stderr 泄露邮箱；二进制缺失死循环 | §3.2 §3.3 §3.1 §5.3 |
| 消费者 | null 窗口被当成无限；exit 1 时缺失 provider 消失；冷启动阻塞 43s 撞 Codex MCP 启动超时；refresh 被当免费；provider 名猜错 | §5 QuotaWindow、enabledProviders/partial、waitSeconds、§4.3 description、enum |
| 数据正确性 | 合成占位窗口；usedPercent 未 clamp；details 单位混杂；resetPassed 矛盾；0.60/0.74 resetCredits 形状漂移；exit 2/3/4 无 JSON | §5 QuotaWindow、§5.2、§3.4 |

未采纳：`dispatchable` 结论字段（属于调度判断，归主 agent）；解析 `resetDescription`（本地化文本，不解析）。
