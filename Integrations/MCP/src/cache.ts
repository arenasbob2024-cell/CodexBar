/**
 * In-memory + shared on-disk snapshot cache with a mkdir lock (DESIGN.md §3.3).
 * No timers: callers decide when to refresh based on cache age.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { InternalSnapshot } from "./types.js";

const DISK_FILE = "usage.json";
const LOCK_DIR = "usage.lock";
export const LOCK_STALE_MS = 120_000;

/**
 * A lock must outlive the longest fetch it can protect (the hard timeout) plus slack, otherwise a
 * second host would preempt a healthy fetch. Never below the 120 s baseline.
 */
export function lockStaleMsFor(timeoutSeconds: number): number {
  return Math.max(LOCK_STALE_MS, timeoutSeconds * 1000 + 30_000);
}

/**
 * `fetchedAt` is the AGE of the data (a targeted merge keeps the full fetch's `fetchedAt`, DESIGN F8).
 * `rev` is the monotonic WRITE version of this file: every successful write is base rev + 1. Two
 * legitimate updates of one round (host A refreshes codex, then host B refreshes zai) share a
 * `fetchedAt` but never a `rev`, so "which copy is newer" is decided by rev first, fetchedAt second.
 * Files written before `rev` existed have none and count as rev 0. `rev` is never part of a tool response.
 */
interface DiskPayload {
  v: 1;
  fetchedAt: string;
  rev?: number;
  snapshot: InternalSnapshot;
}

function payloadRev(payload: { rev?: unknown }): number {
  return typeof payload.rev === "number" && Number.isInteger(payload.rev) && payload.rev > 0 ? payload.rev : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isNullableNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isValidWindow(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.id === "primary" || value.id === "secondary" || value.id === "tertiary") &&
    typeof value.known === "boolean" &&
    isNullableNumber(value.usedPercent) &&
    isNullableNumber(value.remainingPercent)
  );
}

function isValidProvider(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.provider === "string" &&
    typeof value.displayName === "string" &&
    (value.status === "ok" || value.status === "error" || value.status === "offline") &&
    Array.isArray(value.windows) &&
    value.windows.every(isValidWindow)
  );
}

/** Full structural check of a snapshot read from disk; anything else is treated as no cache. */
export function isValidSnapshot(value: unknown): value is InternalSnapshot {
  if (!isRecord(value)) return false;
  return (
    (value.source === "cli" || value.source === "serve") &&
    typeof value.fetchedAt === "string" &&
    Number.isFinite(Date.parse(value.fetchedAt)) &&
    typeof value.partial === "boolean" &&
    isStringArray(value.enabledProviders) &&
    isStringArray(value.failedProviders) &&
    Array.isArray(value.providers) &&
    value.providers.every(isValidProvider)
  );
}

/** Used when a lock has no readable owner record (dir created but owner.json missing/corrupt). */
export const LOCK_UNKNOWN_OWNER_MIN_MS = 630_000;

/**
 * Decide whether a lock may be preempted. The HOLDER's lease wins: owner.json carries `leaseUntil`
 * (acquire time + the holder's own hard timeout + slack), so a host configured with a short timeout
 * cannot steal a lock from a host that legitimately runs long fetches. Records without a lease use
 * this process's threshold from `at`; a lock with no usable owner record at all falls back to
 * max(this process's threshold, 630 s) measured from the directory's mtime.
 */
function isLockStale(lockPath: string, staleMs: number): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as {
      at?: unknown;
      leaseUntil?: unknown;
    };
    if (typeof owner.leaseUntil === "number" && Number.isFinite(owner.leaseUntil)) {
      return Date.now() > owner.leaseUntil;
    }
    if (typeof owner.at === "number" && Number.isFinite(owner.at)) return Date.now() - owner.at > staleMs;
  } catch {
    // no usable owner record: fall through to the conservative mtime rule
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs > Math.max(staleMs, LOCK_UNKNOWN_OWNER_MIN_MS);
  } catch {
    return false;
  }
}

export class QuotaCache {
  readonly cacheDir: string;
  readonly ttlSeconds: number;
  readonly lockStaleMs: number;
  readonly leaseMs: number;
  private mem: { snapshot: InternalSnapshot; fetchedAtMs: number; rev: number } | null = null;
  private lockHeld = false;
  private lockToken: string | null = null;
  private ownerWritten = false;

  constructor(opts: { cacheDir: string; ttlSeconds: number; lockStaleMs?: number; leaseMs?: number }) {
    this.cacheDir = opts.cacheDir;
    this.ttlSeconds = opts.ttlSeconds;
    this.lockStaleMs = opts.lockStaleMs ?? LOCK_STALE_MS;
    // How long this process may legitimately hold the lock: its hard timeout plus slack.
    this.leaseMs = opts.leaseMs ?? this.lockStaleMs;
  }

  memGet(): InternalSnapshot | null {
    return this.mem?.snapshot ?? null;
  }

  memFetchedAtMs(): number {
    return this.mem?.fetchedAtMs ?? 0;
  }

  /** Age of the in-memory snapshot in ms; Infinity when empty. */
  memAgeMs(): number {
    return this.mem ? Date.now() - this.mem.fetchedAtMs : Number.POSITIVE_INFINITY;
  }

  /** Write version of the in-memory snapshot (the rev of the disk copy it came from or was written as). */
  memRev(): number {
    return this.mem?.rev ?? 0;
  }

  /** Replace the in-memory snapshot. The write version is kept: it describes the disk lineage, not the content. */
  memSet(snapshot: InternalSnapshot): void {
    const ms = Date.parse(snapshot.fetchedAt);
    this.mem = { snapshot, fetchedAtMs: Number.isFinite(ms) ? ms : Date.now(), rev: this.mem?.rev ?? 0 };
  }

  readDisk(): DiskPayload | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(this.cacheDir, DISK_FILE), "utf8"));
      if (
        isRecord(parsed) &&
        parsed.v === 1 &&
        typeof parsed.fetchedAt === "string" &&
        isValidSnapshot(parsed.snapshot)
      ) {
        return parsed as unknown as DiskPayload;
      }
    } catch {
      // missing or corrupt: ignore
    }
    return null;
  }

  /**
   * Adopt the shared disk snapshot when it is newer than memory (or memory is empty): a higher write
   * `rev` wins; with equal revs the later `fetchedAt` wins. Equal rev and equal fetchedAt is the same copy.
   * `transform` lets the caller adapt it (e.g. rebuild against the current roster) first.
   * Returns true when memory was replaced.
   */
  loadNewerFromDisk(transform?: (snapshot: InternalSnapshot) => InternalSnapshot): boolean {
    const disk = this.readDisk();
    if (!disk) return false;
    const ms = Date.parse(disk.fetchedAt);
    if (!Number.isFinite(ms)) return false;
    const rev = payloadRev(disk);
    if (this.mem) {
      if (rev < this.mem.rev) return false;
      if (rev === this.mem.rev && ms <= this.mem.fetchedAtMs) return false;
    }
    this.mem = { snapshot: transform ? transform(disk.snapshot) : disk.snapshot, fetchedAtMs: ms, rev };
    return true;
  }

  preloadFromDisk(transform?: (snapshot: InternalSnapshot) => InternalSnapshot): boolean {
    return this.loadNewerFromDisk(transform);
  }

  /**
   * Atomic write: temp file + rename. Best-effort; never throws.
   * Monotonic: a snapshot older than the one already on disk is not written (it would roll another
   * host's newer data back). The written file gets rev = max(memory rev, disk rev) + 1, i.e. the
   * adopted base's rev + 1, and the in-memory snapshot takes that rev. Returns whether it was written.
   */
  writeDisk(snapshot: InternalSnapshot): boolean {
    try {
      const existing = this.readDisk();
      if (existing) {
        const onDisk = Date.parse(existing.fetchedAt);
        const incoming = Date.parse(snapshot.fetchedAt);
        if (Number.isFinite(onDisk) && Number.isFinite(incoming) && onDisk > incoming) return false;
      }
      const rev = Math.max(this.mem?.rev ?? 0, existing ? payloadRev(existing) : 0) + 1;
      mkdirSync(this.cacheDir, { recursive: true });
      const final = join(this.cacheDir, DISK_FILE);
      const tmp = join(this.cacheDir, `.usage.${process.pid}.${Date.now()}.tmp`);
      const payload: DiskPayload = { v: 1, fetchedAt: snapshot.fetchedAt, rev, snapshot };
      writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      renameSync(tmp, final);
      try {
        chmodSync(final, 0o600);
      } catch {
        // ignore
      }
      if (this.mem) this.mem.rev = rev;
      return true;
    } catch {
      // cache is an optimization only
      return false;
    }
  }

  /** mkdir-based mutex; locks older than 120s are considered stale and preempted. */
  acquireLock(): boolean {
    if (this.lockHeld) return true;
    try {
      mkdirSync(this.cacheDir, { recursive: true });
    } catch {
      return false;
    }
    const lockPath = join(this.cacheDir, LOCK_DIR);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        mkdirSync(lockPath);
      } catch {
        if (!isLockStale(lockPath, this.lockStaleMs)) return false;
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          return false;
        }
        continue;
      }
      this.lockToken = randomBytes(8).toString("hex");
      try {
        writeFileSync(
          join(lockPath, "owner.json"),
          JSON.stringify({
            pid: process.pid,
            token: this.lockToken,
            at: Date.now(),
            leaseUntil: Date.now() + this.leaseMs,
          }),
        );
        this.ownerWritten = true;
      } catch {
        this.ownerWritten = false; // lock dir exists; staleness falls back to mtime
      }
      this.lockHeld = true;
      return true;
    }
    return false;
  }

  /**
   * Remove the lock directory only if it is still ours. If the lock went stale and another host
   * preempted it, its owner.json carries a different pid/token and must be left alone.
   */
  releaseLock(): void {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    const token = this.lockToken;
    const wrote = this.ownerWritten;
    this.lockToken = null;
    this.ownerWritten = false;
    const lockPath = join(this.cacheDir, LOCK_DIR);
    try {
      const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as {
        pid?: number;
        token?: string;
      };
      if (owner.pid !== process.pid || owner.token !== token) return; // someone else's lock now
    } catch {
      // No readable owner file. If we wrote one and it is gone, the directory was replaced: leave it.
      if (wrote) return;
    }
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
