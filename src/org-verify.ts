/**
 * org-verify.ts — proof that the session is in the intended client's org
 * before anything is written there.
 *
 * Ashby's org context is server-side state that belongs to the USER, not the
 * session: DK browsing Ashby in his own browser moves the same context this
 * automation writes under. A write that lands after a mis-switch puts a
 * candidate in the WRONG CLIENT'S ATS, so every write path verifies first and
 * fails closed.
 *
 * The check used to read `sessionUserV2.organizationName`. Ashby removed that
 * field on 2026-08-26, and the internal API is feature-frozen (Ashby asked
 * Candidate Labs off it on 2026-08-25), so the replacement uses only a query
 * this repo already makes: the target job must appear in the current org's
 * open-jobs list. Job ids are org-unique, so membership proves the session is
 * in the org that owns the job being applied to.
 *
 * No imports from client.ts — keeps this file cycle-free and unit-testable.
 */

export type WrongOrgReason =
  /** `change_user` answered with a different user/org than the one requested. */
  | 'identity_mismatch'
  /** The job isn't in the current org's open jobs: wrong org, or the job closed. */
  | 'job_not_in_org'
  /** The check itself could not run (timeout, error). Treated as a failure. */
  | 'verification_unavailable'
  /** Context was wrong right after the blank draft was created. */
  | 'post_create_mismatch';

export interface WrongOrgDetails {
  /** False once a draft candidate exists. */
  nothingWritten: boolean;
  /** The blank draft left behind when the post-create check fails. */
  draftCandidateId?: string;
  /** Reason to report when the job is missing. Defaults to `job_not_in_org`. */
  mismatchReason?: WrongOrgReason;
  cause?: unknown;
}

const REASON_TEXT: Record<WrongOrgReason, string> = {
  identity_mismatch: 'Ashby switched the session into a different org than the one requested',
  job_not_in_org:
    "the selected job is not in this org's open jobs. Either the Ashby session is in a different org, or the job closed since it was picked",
  verification_unavailable: 'could not confirm which org the Ashby session is in',
  post_create_mismatch:
    'the org context was wrong right after the blank draft was created, so the upload stopped before any details were added',
};

export class WrongOrgContextError extends Error {
  readonly reason: WrongOrgReason;
  readonly expectedOrgName: string;
  readonly nothingWritten: boolean;
  readonly draftCandidateId?: string;

  constructor(reason: WrongOrgReason, expectedOrgName: string, details: WrongOrgDetails) {
    // No ids in the message: handleExtractionError classifies errors by
    // substring, and a UUID can contain "401".
    super(`wrong_org_context: expected "${expectedOrgName}" but ${REASON_TEXT[reason]}`);
    this.name = 'WrongOrgContextError';
    this.reason = reason;
    this.expectedOrgName = expectedOrgName;
    this.nothingWritten = details.nothingWritten;
    this.draftCandidateId = details.draftCandidateId;
    if (details.cause !== undefined) (this as any).cause = details.cause;
  }
}

/** `instanceof` plus a name check, so a second copy of this module still matches. */
export function isWrongOrgContextError(err: unknown): err is WrongOrgContextError {
  return err instanceof WrongOrgContextError || (err as any)?.name === 'WrongOrgContextError';
}

export type IdentityVerdict = 'match' | 'mismatch' | 'unknown';

/**
 * Verdict from the body of `POST /api/auth/change_user/{userId}`, a request
 * this repo already makes. Observed live 2026-09-18: `{user: {id,
 * organizationId, ...}}`. It proves which identity the switch LANDED in, at no
 * extra cost and for reads as well as writes. It cannot see DK's browser moving
 * the context a moment later, so writes still require job membership too.
 * An unrecognised shape is `unknown`, never a pass or a fail by itself.
 */
export function verdictFromSwitchBody(
  body: unknown,
  expected: { userId: string; orgId?: string },
): IdentityVerdict {
  const user = (body as any)?.user;
  if (!user || typeof user !== 'object') return 'unknown';
  const checks: boolean[] = [];
  if (typeof user.id === 'string' && expected.userId) checks.push(user.id === expected.userId);
  if (typeof user.organizationId === 'string' && expected.orgId) checks.push(user.organizationId === expected.orgId);
  if (checks.length === 0) return 'unknown';
  return checks.every(Boolean) ? 'match' : 'mismatch';
}

/** Pure membership check on an already-fetched job list. */
export function assertJobInOrg(
  jobs: ReadonlyArray<{ id: string }> | null | undefined,
  jobId: string,
  expectedOrgName: string,
  details: WrongOrgDetails,
): void {
  const wanted = (jobId || '').trim();
  const found = !!wanted && (jobs || []).some((j) => j?.id === wanted);
  if (!found) {
    throw new WrongOrgContextError(details.mismatchReason ?? 'job_not_in_org', expectedOrgName, details);
  }
}

/**
 * Fetch the CURRENT org's open jobs via `listJobs` and require `jobId` to be
 * among them. Any failure to fetch is a verification failure, never a pass.
 */
export async function verifyJobMembership(
  listJobs: () => Promise<ReadonlyArray<{ id: string }>>,
  jobId: string,
  expectedOrgName: string,
  details: WrongOrgDetails,
): Promise<void> {
  let jobs: ReadonlyArray<{ id: string }>;
  try {
    jobs = await listJobs();
  } catch (cause) {
    throw new WrongOrgContextError('verification_unavailable', expectedOrgName, { ...details, cause });
  }
  assertJobInOrg(jobs, jobId, expectedOrgName, details);
}

/** HTTP body for a wrong-org abort. Served as 409 so callers see it verbatim. */
export function wrongOrgResponseBody(err: WrongOrgContextError): Record<string, unknown> {
  const body: Record<string, unknown> = {
    error: 'wrong_org_context',
    reason: err.reason,
    org_name: err.expectedOrgName,
    nothing_written: err.nothingWritten,
    detail: err.message,
    instructions: err.nothingWritten
      ? 'Nothing was written. Make sure you are not switching orgs in Ashby in your browser, then try again. If the job closed, reopen the form to pick a current one.'
      : 'A blank, unpublished draft candidate may exist in whichever org the session was in. It is invisible in Ashby search. Do not retry until you have checked which org you are in.',
  };
  if (err.draftCandidateId) body.draft_candidate_id = err.draftCandidateId;
  return body;
}

/**
 * Make an error message safe to log or return to a caller. Playwright's
 * request errors append a "Call log" with every request header, which includes
 * the Ashby session cookie and CSRF token; nothing past that marker is needed
 * to diagnose a failure. Cookie/CSRF-looking fragments are masked as well.
 */
export function redactSecrets(message: string): string {
  let m = message || '';
  const cut = m.indexOf('Call log:');
  if (cut !== -1) {
    // Keep the one line that says WHICH request failed; drop the headers.
    // The GraphQL operation name is the only query parameter worth keeping.
    const target = m.slice(cut).match(/→\s+([A-Z]+\s+https?:\/\/[^\s?]+)(?:\?(?:[^\s]*&)?(op=[A-Za-z0-9_]+))?/);
    m = m.slice(0, cut).trimEnd() + (target ? ` (${target[1]}${target[2] ? '?' + target[2] : ''})` : '');
  }
  return m
    .replace(/(ashby_session_token|x-csrf-token|cookie|authorization)\s*[:=]\s*[^\s;,]+/gi, '$1=[redacted]')
    .replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * True when an error message means the Ashby login is dead. `\b401\b` rather
 * than a bare substring: ids and counts in unrelated messages contain "401".
 */
export function isSessionAuthFailure(message: string): boolean {
  const m = message || '';
  return /\b401\b/.test(m) || m.includes('expired') || m.includes('CSRF');
}

/**
 * Key NAMES of a JSON value, to `depth` levels — never values. Used to learn
 * the shape of responses this repo already receives (e.g. `change_user`)
 * without logging anything a client or candidate would recognise.
 */
export function describeKeys(value: unknown, depth = 2): string {
  if (Array.isArray(value)) {
    return value.length ? `[${describeKeys(value[0], depth)}]` : '[]';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    if (depth <= 0) return `{${keys.length} keys}`;
    return `{${keys
      .map((k) => {
        const v = (value as Record<string, unknown>)[k];
        return v && typeof v === 'object' ? `${k}:${describeKeys(v, depth - 1)}` : k;
      })
      .join(',')}}`;
  }
  return value === null ? 'null' : typeof value;
}

const shapesLogged = new Set<string>();

/** Log a response's key names once per process per label. */
export function logShapeOnce(label: string, value: unknown): void {
  if (shapesLogged.has(label)) return;
  shapesLogged.add(label);
  console.log(`[org-verify] ${label} shape: ${describeKeys(value)}`);
}
