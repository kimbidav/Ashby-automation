/**
 * write-lock.ts — process-wide serialization of Ashby session use.
 *
 * Ashby's org context is SERVER-side state keyed to the session: change_user
 * switches it globally for every request that follows. Two concurrent flows
 * (a sweep iterating orgs and a write targeting one org) would interleave
 * their switches and the write could land in whatever org the sweep switched
 * to last — candidate data in the wrong client's ATS. Reads racing reads
 * merely produce wrong data; writes racing anything is unacceptable, so
 * every session-using route runs under this single lock.
 *
 * Simple promise-chain mutex: FIFO, no timeout (an extract can legitimately
 * hold it for many minutes — callers surface progress separately). The
 * `label` is logged on acquisition when someone had to wait, so lock
 * contention is visible in the server log.
 */
let chain: Promise<unknown> = Promise.resolve();
let currentHolder: string | null = null;

export function lockHolder(): string | null {
  return currentHolder;
}

export async function withGlobalLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const waitingOn = currentHolder;
  const run = chain.then(async () => {
    if (waitingOn) {
      console.log(`[lock] ${label} acquired (waited on ${waitingOn})`);
    }
    currentHolder = label;
    try {
      return await fn();
    } finally {
      currentHolder = null;
    }
  });
  // The chain must not reject for the next waiter — swallow errors on the
  // chain link only; the caller still gets the rejection from `run`.
  chain = run.catch(() => undefined);
  return run;
}
