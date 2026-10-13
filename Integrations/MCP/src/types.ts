/** Shared types for the CodexBar MCP server. */

export type WindowId = "primary" | "secondary" | "tertiary";

export type ProviderErrorCode =
  | "timeout"
  | "auth"
  | "parse"
  | "missing"
  | "provider"
  | "unknown";

export type ProviderStatus = "ok" | "error" | "offline";

export type SnapshotStatus =
  | "ok"
  | "warming"
  | "stale"
  | "nested"
  | "not_installed"
  | "fetch_failed";

export interface RosterEntry {
  id: string;
  displayName: string;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Raw CLI / serve payload shapes (loose on purpose — the CLI evolves).
// ---------------------------------------------------------------------------

export interface RawWindow {
  usedPercent?: number;
  resetsAt?: string;
  windowMinutes?: number;
  resetDescription?: string;
  usageKnown?: boolean;
  [key: string]: unknown;
}

export interface RawUsage {
  primary?: RawWindow | null;
  secondary?: RawWindow | null;
  tertiary?: RawWindow | null;
  updatedAt?: string;
  loginMethod?: string;
  identity?: { accountEmail?: string; providerID?: string; [key: string]: unknown } | null;
  providerCost?: {
    balance?: number;
    currencyCode?: string;
    updatedAt?: string;
    [key: string]: unknown;
  } | null;
  codexResetCredits?: {
    credits?: Array<{
      status?: string;
      expires_at?: string;
      id?: string;
      [key: string]: unknown;
    }> | null;
    [key: string]: unknown;
  } | null;
  details?: unknown;
  [key: string]: unknown;
}

export interface RawEntry {
  provider?: string;
  source?: string;
  error?: { code?: unknown; kind?: string; message?: string } | null;
  usage?: RawUsage | null;
  pace?: {
    primary?: {
      summary?: string;
      stage?: string;
      etaSeconds?: number;
      [key: string]: unknown;
    } | null;
    [key: string]: unknown;
  } | null;
  /** 0.74.x shape: compact reset-credit summary at the entry level. */
  resetCredits?: { available?: number; nextExpiresAt?: string; [key: string]: unknown };
  /** Ignored entirely; never propagated. */
  credits?: unknown;
  /** Ignored entirely; never propagated. */
  openaiDashboard?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Normalized output schema (DESIGN.md §5).
// ---------------------------------------------------------------------------

export interface DetailRow {
  label: string;
  value: string;
  secondaryValue?: string;
}

export interface DetailSection {
  title?: string;
  rows: DetailRow[];
}

export interface QuotaWindow {
  id: WindowId;
  label?: string;
  windowMinutes?: number;
  known: boolean;
  usedPercent: number | null;
  rawUsedPercent?: number;
  remainingPercent: number | null;
  resetsAt?: string;
  resetsInMinutes?: number;
  resetPassed?: boolean;
}

export interface ProviderPace {
  summary: string;
  projectedEmptyAt?: string;
  etaSeconds?: number;
  stage?: string;
}

export interface ProviderCredits {
  balance: number;
  unit: string;
  updatedAt?: string;
}

export interface ProviderResetCredits {
  available: number;
  nextExpiresAt?: string;
}

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
}

export interface ProviderIdentity {
  accountEmail?: string;
}

export interface ProviderQuota {
  provider: string;
  displayName: string;
  status: ProviderStatus;
  source?: string;
  plan?: string;
  windows: QuotaWindow[];
  bindingWindow?: WindowId;
  minRemainingPercent?: number;
  pace?: ProviderPace;
  credits?: ProviderCredits;
  resetCredits?: ProviderResetCredits;
  updatedAt?: string;
  error?: ProviderError;
  identity?: ProviderIdentity;
  details?: DetailSection[];
}

export interface SnapshotError {
  code: string;
  message: string;
}

export interface QuotaSnapshot {
  status: SnapshotStatus;
  source: "cli" | "serve";
  cliVersion?: string;
  fetchedAt?: string;
  ageSeconds?: number;
  stale: boolean;
  warming?: boolean;
  retryAfterSeconds?: number;
  partial: boolean;
  failedProviders: string[];
  enabledProviders: string[];
  providers: ProviderQuota[];
  error?: SnapshotError;
}

/**
 * Full snapshot kept in memory / on disk: identity and details are retained so
 * `includeIdentity` / `includeDetails` can project them later. Response-level
 * fields that depend on the call instant (binding window, age, status, stale)
 * are (re)computed by `projectSnapshot`.
 */
export interface InternalProvider extends Omit<ProviderQuota, "bindingWindow" | "minRemainingPercent"> {}

export interface InternalSnapshot {
  source: "cli" | "serve";
  fetchedAt: string;
  providers: InternalProvider[];
  enabledProviders: string[];
  partial: boolean;
  failedProviders: string[];
}

export interface ProjectOptions {
  includeIdentity: boolean;
  includeDetails: boolean;
}

export interface NormalizeOptions {
  source?: "cli" | "serve";
  includeIdentity?: boolean;
  includeDetails?: boolean;
}

export interface ServiceError {
  code: string;
  message: string;
}

export type FetchOutcome =
  | { kind: "ok" }
  | { kind: "lock_busy" }
  | { kind: "failed"; error: ServiceError };
