/**
 * write-lock.ts — serialization of Ashby session use, per Ashby IDENTITY.
 *
 * Ashby's org context is SERVER-side state keyed to the logged-in USER:
 * change_user switches it for every request that follows under that login.
 * Two concurrent flows on the same identity (a sweep iterating orgs and a
 * write targeting one org) would interleave their switches and the write
 * could land in whatever org the sweep switched to last — candidate data in
 * the wrong client's ATS. So every session-using route runs under a lock,
 * and the lock key is the identity: the team sweep session and one
 * recruiter's own session are different Ashby users, so they never contend;
 * two uploads by the same recruiter do.
 *
 * Simple promise-chain mutex per key: FIFO. Sweeps may hold the team key for
 * many minutes (callers surface progress separately). Write labels get a
 * maximum hold: a hung upload must not brick a recruiter for the day, so the
 * lock is released for the next waiter after `maxHoldMs` even though the
 * stuck call keeps running.
 */
export const TEAM_LOCK_KEY = 'team';

const chains = new Map<string, Promise<unknown>>();
const holders = new Map<string, string>();

/** Lock key for a recruiter's own Ashby login. */
export function identityLockKey(email: string): string {
  return `user:${email.trim().toLowerCase()}`;
}

export function lockHolder(key: string = TEAM_LOCK_KEY): string | null {
  return holders.get(key) ?? null;
}

export function withLock<T>(
  key: string,
  label: string,
  fn: () => Promise<T>,
  opts: { maxHoldMs?: number } = {},
): Promise<T> {
  const waitingOn = holders.get(key) ?? null;
  // Claim the key synchronously when it is idle, so a fast-fail check right
  // after this call (`lockHolder`) already sees the holder. A queued caller
  // claims it when its turn comes.
  if (!waitingOn) holders.set(key, label);

  // The NEXT waiter waits for our *release*, not for our work to finish:
  // that is what lets the hold limit hand the key on while a stuck call
  // keeps running.
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const prev = chains.get(key) ?? Promise.resolve();
  chains.set(key, released);

  const result = prev.then(async () => {
    if (waitingOn) {
      console.log(`[lock ${key}] ${label} acquired (waited on ${waitingOn})`);
      holders.set(key, label);
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (holders.get(key) === label) holders.delete(key);
      release();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.maxHoldMs) {
      timer = setTimeout(() => {
        if (!done) console.warn(`[lock ${key}] ${label} exceeded ${opts.maxHoldMs}ms hold — releasing for the next waiter`);
        finish();
      }, opts.maxHoldMs);
    }
    try {
      return await fn();
    } finally {
      if (timer) clearTimeout(timer);
      finish();
    }
  });
  // A rejection reaches the caller through `result`; the chain link
  // (`released`) never rejects, so the next waiter always proceeds.
  return result;
}

/** Team-session lock (sweeps, archive-status). Kept for existing call sites. */
export function withGlobalLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return withLock(TEAM_LOCK_KEY, label, fn);
}
