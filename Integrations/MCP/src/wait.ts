/**
 * Cancelable wait helper. The timer is always cleared once the promise settles, so a
 * fast fetch never leaves a long per-call timer behind (DESIGN 3.3: no stray timers).
 */
export function raceWithTimeout(promise: Promise<unknown>, ms: number): Promise<"settled" | "timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve("settled");
      },
      () => {
        clearTimeout(timer);
        resolve("settled");
      },
    );
  });
}

/**
 * One wait budget per tool call. A single timer of exactly `ms` is created when the call starts and
 * must be cancelled when the call ends; every wait inside the call (start-up probes, the fetch) races
 * against this same deadline, so `waitSeconds` bounds them together instead of adding up.
 */
export class Deadline {
  readonly expired: Promise<"timeout">;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly ms: number) {
    this.expired = new Promise((resolve) => {
      this.timer = setTimeout(() => resolve("timeout"), ms);
    });
  }

  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}

/** Wait for `promise`, but not past `deadline` and, if given, not longer than `capMs`. */
export function raceDeadline(
  promise: Promise<unknown>,
  deadline: Deadline,
  capMs?: number,
): Promise<"settled" | "timeout"> {
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  const racers: Array<Promise<"settled" | "timeout">> = [
    promise.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    deadline.expired,
  ];
  if (capMs !== undefined) {
    racers.push(
      new Promise((resolve) => {
        capTimer = setTimeout(() => resolve("timeout"), capMs);
      }),
    );
  }
  return Promise.race(racers).finally(() => {
    if (capTimer !== undefined) clearTimeout(capTimer);
  });
}
