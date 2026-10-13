/**
 * In-memory + shared on-disk snapshot cache with a mkdir lock (DESIGN.md §3.3).
 * No timers: callers decide when to refresh based on cache age.
 */

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

interface DiskPayload {
  v: 1;
  fetchedAt: string;
  snapshot: InternalSnapshot;
}

function isLockStale(lockPath: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { at?: number };
    if (typeof owner.at === "number") return Date.now() - owner.at > LOCK_STALE_MS;
  } catch {
    // fall through to mtime
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

export class QuotaCache {
  readonly cacheDir: string;
  readonly ttlSeconds: number;
  private mem: { snapshot: InternalSnapshot; fetchedAtMs: number } | null = null;
  private lockHeld = false;

  constructor(opts: { cacheDir: string; ttlSeconds: number }) {
    this.cacheDir = opts.cacheDir;
    this.ttlSeconds = opts.ttlSeconds;
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

  memSet(snapshot: InternalSnapshot): void {
    const ms = Date.parse(snapshot.fetchedAt);
    this.mem = { snapshot, fetchedAtMs: Number.isFinite(ms) ? ms : Date.now() };
  }

  readDisk(): DiskPayload | null {
    try {
      const parsed = JSON.parse(readFileSync(join(this.cacheDir, DISK_FILE), "utf8")) as DiskPayload;
      if (parsed?.v === 1 && parsed.snapshot && typeof parsed.fetchedAt === "string") return parsed;
    } catch {
      // missing or corrupt: ignore
    }
    return null;
  }

  /** Load disk cache into memory when memory is empty or older. */
  preloadFromDisk(): void {
    const disk = this.readDisk();
    if (!disk) return;
    const ms = Date.parse(disk.fetchedAt);
    if (!Number.isFinite(ms)) return;
    if (!this.mem || ms > this.mem.fetchedAtMs) {
      this.mem = { snapshot: disk.snapshot, fetchedAtMs: ms };
    }
  }

  /** Atomic write: temp file + rename. Best-effort; never throws. */
  writeDisk(snapshot: InternalSnapshot): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      const final = join(this.cacheDir, DISK_FILE);
      const tmp = join(this.cacheDir, `.usage.${process.pid}.${Date.now()}.tmp`);
      const payload: DiskPayload = { v: 1, fetchedAt: snapshot.fetchedAt, snapshot };
      writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      renameSync(tmp, final);
      try {
        chmodSync(final, 0o600);
      } catch {
        // ignore
      }
    } catch {
      // cache is an optimization only
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
        if (!isLockStale(lockPath)) return false;
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          return false;
        }
        continue;
      }
      try {
        writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
      } catch {
        // lock dir exists; staleness falls back to mtime
      }
      this.lockHeld = true;
      return true;
    }
    return false;
  }

  releaseLock(): void {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    try {
      rmSync(join(this.cacheDir, LOCK_DIR), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
