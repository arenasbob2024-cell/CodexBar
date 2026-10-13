/**
 * Pure normalization of raw `codexbar usage --format json` / `GET /usage`
 * payloads into the QuotaSnapshot schema (DESIGN.md §5).
 *
 * `normalizeSnapshot` builds the full internal form (identity + details kept so
 * they can be projected later). `projectSnapshot` strips identity/details per
 * call options and recomputes everything that depends on the current instant
 * (resetPassed, resetsInMinutes, binding window, age).
 *
 * No clocks, no I/O: the current time is always an explicit `Date` argument.
 */

import type {
  DetailRow,
  DetailSection,
  InternalProvider,
  InternalSnapshot,
  NormalizeOptions,
  ProjectOptions,
  ProviderErrorCode,
  ProviderPace,
  ProviderQuota,
  ProviderResetCredits,
  ProviderStatus,
  QuotaSnapshot,
  QuotaWindow,
  RawEntry,
  RawUsage,
  RawWindow,
  RosterEntry,
  WindowId,
} from "./types.js";

const ISO_8601_ZONED =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export const WINDOW_IDS: WindowId[] = ["primary", "secondary", "tertiary"];

export function isIsoZoned(value: unknown): value is string {
  return typeof value === "string" && ISO_8601_ZONED.test(value);
}

/** Replace anything that looks like an email address with `<redacted>`. */
export function redactEmails(text: string): string {
  return text.replace(EMAIL_RE, "<redacted>");
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clampPercent(value: number): number {
  return round1(Math.min(100, Math.max(0, value)));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Window label from windowMinutes; resetDescription is localized text and never parsed. */
export function windowLabel(windowMinutes: number | undefined): string | undefined {
  if (windowMinutes === undefined) return undefined;
  if (windowMinutes === 300) return "5h";
  if (windowMinutes === 10080) return "weekly";
  if (windowMinutes === 43200) return "monthly";
  return `${windowMinutes}m`;
}

/**
 * Map a provider error message to a stable code. Order matters:
 * "parse" is checked before "auth" so Claude's
 * "Could not parse Claude usage: ... without session quota data" maps to
 * `parse`, not `auth` ("No ... session" also matches Cursor's message only).
 */
export function mapErrorCode(message: string, kind?: string): ProviderErrorCode {
  const m = message.toLowerCase();
  if (kind === "timeout" || m.includes("timed out") || m.includes("timeout")) return "timeout";
  if (m.includes("parse")) return "parse";
  if (/no .{0,60}session/.test(m)) return "auth";
  if (m.includes("sign in") || m.includes("log in") || m.includes("unauthorized")) return "auth";
  if (m.includes("not signed in") || m.includes("401") || m.includes("403")) return "auth";
  return "provider";
}

function resetTimeFields(
  resetsAt: string | undefined,
  now: Date,
): Pick<QuotaWindow, "resetsInMinutes" | "resetPassed"> {
  if (!resetsAt) return {};
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return {};
  const passed = now.getTime() >= resetMs;
  return {
    resetPassed: passed,
    resetsInMinutes: passed
      ? 0
      : Math.max(0, Math.ceil((resetMs - now.getTime()) / 60_000)),
  };
}

function buildWindow(id: WindowId, slot: RawWindow | null | undefined, now: Date): QuotaWindow | null {
  if (!slot || typeof slot !== "object") return null;
  if (slot.isSyntheticPlaceholder === true) return null;
  const known = slot.usageKnown !== false;
  const windowMinutes = finiteNumber(slot.windowMinutes);
  const resetsAt = isIsoZoned(slot.resetsAt) ? slot.resetsAt : undefined;
  const timeFields = resetTimeFields(resetsAt, now);
  const label = windowLabel(windowMinutes);

  if (!known) {
    return {
      id,
      ...(label !== undefined ? { label } : {}),
      ...(windowMinutes !== undefined ? { windowMinutes } : {}),
      known: false,
      usedPercent: null,
      remainingPercent: null,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...timeFields,
    };
  }

  const rawUsed = finiteNumber(slot.usedPercent);
  if (rawUsed === undefined) {
    return {
      id,
      ...(label !== undefined ? { label } : {}),
      ...(windowMinutes !== undefined ? { windowMinutes } : {}),
      known: true,
      usedPercent: null,
      remainingPercent: null,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...timeFields,
    };
  }

  const used = clampPercent(rawUsed);
  return {
    id,
    ...(label !== undefined ? { label } : {}),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    known: true,
    usedPercent: used,
    ...(rawUsed > 100 || rawUsed < 0 ? { rawUsedPercent: rawUsed } : {}),
    remainingPercent: round1(100 - used),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...timeFields,
  };
}

function buildWindows(usage: RawUsage | null | undefined, now: Date): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  for (const id of WINDOW_IDS) {
    if (!usage) break;
    const slot = usage[id];
    const built = buildWindow(id, slot, now);
    if (built !== null) windows.push(built);
  }
  return windows;
}

function parseDetails(value: unknown): DetailSection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sections: DetailSection[] = [];
  for (const section of value) {
    if (!section || typeof section !== "object") continue;
    const record = section as Record<string, unknown>;
    const rawRows = Array.isArray(record.rows) ? record.rows : [];
    const rows: DetailRow[] = [];
    for (const row of rawRows) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const label = typeof r.label === "string" ? r.label : "";
      const cell = typeof r.value === "string" ? r.value : "";
      if (label === "" && cell === "") continue;
      const secondary =
        typeof r.secondaryValue === "string" && r.secondaryValue.length > 0
          ? r.secondaryValue
          : undefined;
      rows.push(
        secondary !== undefined ? { label, value: cell, secondaryValue: secondary } : { label, value: cell },
      );
    }
    if (rows.length === 0) continue;
    const title = nonEmptyString(record.title);
    sections.push({ ...(title !== undefined ? { title } : {}), rows });
  }
  return sections.length > 0 ? sections : undefined;
}

function buildPace(entry: RawEntry, now: Date): ProviderPace | undefined {
  const primary = entry.pace?.primary;
  if (!primary || typeof primary !== "object") return undefined;
  const summary = nonEmptyString(primary.summary);
  if (summary === undefined) return undefined;
  const etaSeconds = finiteNumber(primary.etaSeconds);
  const stage = nonEmptyString(primary.stage);
  let projectedEmptyAt: string | undefined;
  if (etaSeconds !== undefined && etaSeconds > 0) {
    projectedEmptyAt = new Date(now.getTime() + etaSeconds * 1000).toISOString();
  }
  return {
    summary,
    ...(projectedEmptyAt !== undefined ? { projectedEmptyAt } : {}),
    ...(etaSeconds !== undefined ? { etaSeconds } : {}),
    ...(stage !== undefined ? { stage } : {}),
  };
}

function buildCredits(usage: RawUsage | null | undefined): ProviderQuota["credits"] {
  const cost = usage?.providerCost;
  if (!cost || typeof cost !== "object") return undefined;
  const balance = finiteNumber(cost.balance);
  const unit = nonEmptyString(cost.currencyCode);
  if (balance === undefined || unit === undefined) return undefined;
  const updatedAt = nonEmptyString(cost.updatedAt);
  return { balance, unit, ...(updatedAt !== undefined ? { updatedAt } : {}) };
}

/** 0.60.x / 0.74.x reset-credit shapes (DESIGN.md §5.2). Never emits ids. */
function buildResetCredits(
  entry: RawEntry,
  usage: RawUsage | null | undefined,
  now: Date,
): ProviderResetCredits | undefined {
  const compact = (entry.resetCredits ?? usage?.resetCredits) as
    | { available?: unknown; nextExpiresAt?: unknown }
    | null
    | undefined;
  if (compact && typeof compact === "object") {
    const available = finiteNumber(compact.available);
    if (available !== undefined) {
      const nextExpiresAt = isIsoZoned(compact.nextExpiresAt) ? compact.nextExpiresAt : undefined;
      return { available, ...(nextExpiresAt !== undefined ? { nextExpiresAt } : {}) };
    }
  }
  const legacy = usage?.codexResetCredits;
  const credits = Array.isArray(legacy?.credits) ? legacy?.credits : undefined;
  if (!credits) return undefined;
  const nowMs = now.getTime();
  const expires: number[] = [];
  for (const credit of credits) {
    if (!credit || typeof credit !== "object") continue;
    if (credit.status !== "available") continue;
    const at = credit.expires_at;
    if (!isIsoZoned(at)) continue;
    const ms = Date.parse(at);
    if (Number.isFinite(ms) && ms > nowMs) expires.push(ms);
  }
  if (expires.length === 0) return undefined;
  return { available: expires.length, nextExpiresAt: new Date(Math.min(...expires)).toISOString() };
}

function buildError(entry: RawEntry): { code: ProviderErrorCode; message: string } | undefined {
  const err = entry.error;
  if (!err || typeof err !== "object") return undefined;
  const message = typeof err.message === "string" ? err.message : "Provider error";
  return { code: mapErrorCode(message, nonEmptyString(err.kind)), message: redactEmails(message) };
}

function buildProvider(
  rosterEntry: RosterEntry,
  entry: RawEntry | undefined,
  now: Date,
): InternalProvider {
  if (entry === undefined) {
    return {
      provider: rosterEntry.id,
      displayName: rosterEntry.displayName,
      status: "error",
      windows: [],
      error: {
        code: "missing",
        message: `Provider ${rosterEntry.id} is enabled but missing from the usage output.`,
      },
    };
  }

  const usage = entry.usage && typeof entry.usage === "object" ? entry.usage : null;
  const error = buildError(entry);
  const providerSource = nonEmptyString(entry.source);
  let status: ProviderStatus;
  if (error !== undefined) {
    status = "error";
  } else if (providerSource === "offline") {
    status = "offline";
  } else {
    status = "ok";
  }

  const plan = nonEmptyString(usage?.loginMethod);
  const updatedAt = nonEmptyString(usage?.updatedAt);
  const accountEmail = nonEmptyString(usage?.identity?.accountEmail);
  const details = parseDetails(usage?.details);
  const pace = buildPace(entry, now);
  const credits = buildCredits(usage);
  const resetCredits = buildResetCredits(entry, usage, now);

  return {
    provider: rosterEntry.id,
    displayName: rosterEntry.displayName,
    status,
    ...(providerSource !== undefined ? { source: providerSource } : {}),
    ...(plan !== undefined ? { plan } : {}),
    windows: buildWindows(usage, now),
    ...(pace !== undefined ? { pace } : {}),
    ...(credits !== undefined ? { credits } : {}),
    ...(resetCredits !== undefined ? { resetCredits } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(accountEmail !== undefined ? { identity: { accountEmail } } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

function buildMissingProvider(rosterEntry: RosterEntry): InternalProvider {
  return buildProvider(rosterEntry, undefined, new Date(0));
}

function recomputeSnapshotLevels(
  snapshot: Omit<InternalSnapshot, "partial" | "failedProviders">,
): InternalSnapshot {
  const failedProviders = snapshot.providers
    .filter((p) => p.status === "error")
    .map((p) => p.provider);
  const partial = snapshot.providers.some((p) => p.status !== "ok");
  return { ...snapshot, failedProviders, partial };
}

/**
 * Normalize a raw usage array against the enabled roster. Providers in the
 * roster but absent from the payload are synthesized with `error.code=missing`.
 * Raw entries for providers outside the roster are dropped.
 */
export function normalizeSnapshot(
  raw: unknown,
  roster: RosterEntry[],
  now: Date,
  opts: { source?: "cli" | "serve" } = {},
): InternalSnapshot {
  const byId = new Map<string, RawEntry>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const id = nonEmptyString((item as Record<string, unknown>).provider);
      if (id !== undefined && !byId.has(id)) byId.set(id, item as RawEntry);
    }
  }
  const enabled = roster.filter((r) => r.enabled !== false && typeof r.id === "string" && r.id.length > 0);
  const providers = enabled.map((r) => buildProvider(r, byId.get(r.id), now));
  return recomputeSnapshotLevels({
    source: opts.source ?? "cli",
    fetchedAt: now.toISOString(),
    providers,
    enabledProviders: enabled.map((r) => r.id),
  });
}

/** Merge a single-provider snapshot (targeted `--provider` fetch) into a base. */
export function mergeProviderSnapshot(
  base: InternalSnapshot | null,
  freshSingle: InternalSnapshot,
  provider: string,
  roster: RosterEntry[],
  now: Date,
): InternalSnapshot {
  const fresh = freshSingle.providers.find((p) => p.provider === provider);
  const skeleton = base?.providers ?? roster
    .filter((r) => r.enabled !== false)
    .map((r) => buildMissingProvider(r));
  const providers = skeleton.map((p) => (p.provider === provider && fresh ? fresh : p));
  return recomputeSnapshotLevels({
    source: base?.source ?? freshSingle.source,
    // fetchedAt = time of the last successful fetch; per-provider updatedAt stays as reported.
    fetchedAt: now.toISOString(),
    providers,
    enabledProviders: base?.enabledProviders ?? freshSingle.enabledProviders,
  });
}

function projectWindow(window: QuotaWindow, now: Date): QuotaWindow {
  const resetsAt = isIsoZoned(window.resetsAt) ? window.resetsAt : undefined;
  const timeFields = resetTimeFields(resetsAt, now);
  const passed = timeFields.resetPassed === true;
  const usedPercent = passed ? null : window.usedPercent;
  const remainingPercent = passed ? null : window.remainingPercent;
  return {
    ...window,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...timeFields,
    usedPercent,
    remainingPercent,
    ...(passed || window.rawUsedPercent === undefined ? {} : { rawUsedPercent: window.rawUsedPercent }),
  };
}

/**
 * Project an internal snapshot for a tool response: strips identity/details
 * per options, recomputes resetPassed/resetsInMinutes at call time, derives
 * the binding window, and flags `stale` when any window's reset has passed.
 * `status` starts as "ok"; the server layer overrides it.
 */
export function projectSnapshot(
  snapshot: InternalSnapshot,
  now: Date,
  opts: ProjectOptions,
): QuotaSnapshot {
  const providers: ProviderQuota[] = snapshot.providers.map((p) => {
    const windows = p.windows.map((w) => projectWindow(w, now));
    const knownRemaining = windows.filter((w) => w.known && w.remainingPercent !== null);
    let bindingWindow: WindowId | undefined;
    let minRemainingPercent: number | undefined;
    for (const w of knownRemaining) {
      const remaining = w.remainingPercent as number;
      if (minRemainingPercent === undefined || remaining < minRemainingPercent) {
        minRemainingPercent = remaining;
        bindingWindow = w.id;
      }
    }
    const {
      identity,
      details,
      ...rest
    } = p;
    return {
      ...rest,
      windows,
      ...(bindingWindow !== undefined ? { bindingWindow } : {}),
      ...(minRemainingPercent !== undefined ? { minRemainingPercent } : {}),
      ...(opts.includeIdentity && identity !== undefined ? { identity } : {}),
      ...(opts.includeDetails && details !== undefined ? { details } : {}),
    };
  });
  const anyResetPassed = providers.some((p) => p.windows.some((w) => w.resetPassed === true));
  const ageSeconds = Math.max(0, Math.round((now.getTime() - Date.parse(snapshot.fetchedAt)) / 1000));
  return {
    status: "ok",
    source: snapshot.source,
    fetchedAt: snapshot.fetchedAt,
    ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : 0,
    stale: anyResetPassed,
    partial: snapshot.partial,
    failedProviders: snapshot.failedProviders,
    enabledProviders: snapshot.enabledProviders,
    providers,
  };
}

/**
 * Design-mandated pure entry point: `(rawArray, roster, now, opts) => QuotaSnapshot`.
 */
export function normalize(
  raw: unknown,
  roster: RosterEntry[],
  now: Date,
  opts: NormalizeOptions = {},
): QuotaSnapshot {
  const internal = normalizeSnapshot(raw, roster, now, { source: opts.source });
  return projectSnapshot(internal, now, {
    includeIdentity: opts.includeIdentity ?? false,
    includeDetails: opts.includeDetails ?? false,
  });
}
