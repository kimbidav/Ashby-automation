/**
 * server.ts -- Express API server for self-serve Ashby pipeline extraction.
 *
 * Endpoints:
 *   POST /api/extract              Synchronous extraction (waits ~2 min, returns result)
 *   POST /api/extract/start        Async: returns jobId immediately, poll for result
 *   GET  /api/extract/status/:id   Poll job status (progress + result)
 *   GET  /api/extract/jobs/:id     Alias for status (Lovable frontend compat)
 *   GET  /api/health               Health check
 *
 * Result cache: successful extractions are cached for 10 minutes.
 * Subsequent requests (even with a different/expired cookie) return the
 * cached result instantly, because the underlying Ashby data doesn't
 * change that fast.
 *
 * Session rotation: Ashby rotates cookies every few minutes. In legacy
 * (non-live-browser) mode, doFetch mirrors every Set-Cookie back into the
 * session and validateCookie attaches a hook that persists the rotated map
 * to .ashby-session.json — so one extraction completes without a mid-sweep
 * 401 and later runs reuse the rotated chain until Ashby's ~7-day login
 * expiry.
 */
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, BrowserContext } from 'playwright';
import { createSessionFromCookie, extractPipeline, ExtractResult, getOrgCacheStats, clearOrgCache } from './api-server-extract.js';
import { fetchArchiveStatuses, fetchCsrfToken, fetchAllAvailableOrgs, enterOrgContext, fetchOpenJobsForOrg, fetchCandidateRestrictedSummaries } from './client.js';
import {
  searchCandidatesInOrg,
  fetchSourceIdByTitle,
  createCandidateWithDetails,
  uploadResumeForCandidate,
  createApplicationForCandidate,
  fetchJobEntryStage,
  addNoteToCandidate,
} from './mutations.js';
import { withGlobalLock } from './write-lock.js';
import { loadSession, persistSessionCookies } from './session.js';
import { AshbySession } from './types.js';
import { getAuthUrl, exchangeCode, addEventsToCalendar, CalendarEventRequest } from './google-calendar.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

app.use(cors());
// The add-candidate route carries a base64 resume PDF (~1.37x file size) —
// its parser must be registered BEFORE the global 1mb parser so the larger
// limit wins for that route (body-parser skips an already-parsed body).
app.use('/api/applications/add-candidate', express.json({ limit: '15mb' }));
app.use(express.json({ limit: '1mb' }));

// ── Shared-secret auth ─────────────────────────────────────────────────────
//
// When EXTRACTOR_SHARED_SECRET is set (the Railway team deployment, which
// holds an org-wide Ashby session), extraction/session endpoints require a
// matching X-Extractor-Secret header — only the Supabase edge functions hold
// the secret, so the org pipeline can't be pulled by anyone with the URL.
// Unset locally → middleware is a no-op and the local flow is unchanged.

const SHARED_SECRET = process.env.EXTRACTOR_SHARED_SECRET || '';

function requireSecret(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!SHARED_SECRET) {
    next();
    return;
  }
  const provided = req.get('x-extractor-secret') || '';
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(SHARED_SECRET).digest();
  if (provided && crypto.timingSafeEqual(a, b)) {
    next();
    return;
  }
  res.status(401).json({ error: 'missing_or_invalid_extractor_secret' });
}

app.use('/api/extract', requireSecret);
app.use('/api/applications', requireSecret);
app.use('/api/session', requireSecret);

// ── Result cache (10-min TTL) ─────────────────────────────────────────────

interface CachedResult {
  timestamp: number;
  data: {
    success: true;
    extracted_at: string;
    stats: { companies: number; jobs: number; candidates: number };
    companies: any[];
    candidates: any[];
    // Authoritative swept-org names (real client orgs, not candidate employers).
    orgs?: string[];
  };
}

let resultCache: CachedResult | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCachedResult(): CachedResult['data'] | null {
  if (!resultCache) return null;
  if (Date.now() - resultCache.timestamp > CACHE_TTL_MS) {
    resultCache = null;
    return null;
  }
  return resultCache.data;
}

function setCachedResult(data: CachedResult['data']) {
  resultCache = { timestamp: Date.now(), data };
}

// ── In-memory job store for async extraction ──────────────────────────────

interface ExtractionJob {
  id: string;
  status: 'running' | 'completed' | 'failed';
  created_at: string;
  completed_at?: string;
  progress?: { completed: number; total: number; current_org: string };
  result?: CachedResult['data'];
  error?: string;
  detail?: string;
}

const jobs = new Map<string, ExtractionJob>();

function cleanupOldJobs() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (new Date(job.created_at).getTime() < cutoff) {
      jobs.delete(id);
    }
  }
}

// ── Health check ──────────────────────────────────────────────────────────

// Bump on behavior changes so a curl to /api/health confirms which build a
// deployment (e.g. Railway) is actually running.
const BUILD_STAMP = '2026-07-11-orgs-and-archived-sweep';

app.get('/api/health', (_req: express.Request, res: express.Response) => {
  res.json({
    status: 'ok',
    build: BUILD_STAMP,
    timestamp: new Date().toISOString(),
    stored_cookie_configured: !!STORED_COOKIE,
    shared_secret_required: !!SHARED_SECRET,
    result_cache_age_seconds: resultCache
      ? Math.round((Date.now() - resultCache.timestamp) / 1000)
      : null,
    org_cache: getOrgCacheStats(),
  });
});

// ── Stored session from env (Playwright-bootstrapped, lasts ~7 days) ──────

const STORED_COOKIE = process.env.ASHBY_SESSION_COOKIE || '';
if (STORED_COOKIE) {
  console.log('ASHBY_SESSION_COOKIE is set — extraction will use the stored session (no cookie paste needed)');
}

// ── Live SSO browser (Phase 2 architecture) ───────────────────────────────
//
// When `liveContext` is set, /api/extract routes every Ashby HTTP call
// through Playwright's APIRequestContext, which sources cookies from the
// live browser jar the user did SSO in. That dodges Ashby's
// "the browser that authenticated quit, who are you?" invalidation —
// the SSO browser stays open as long as the user wants, and refresh
// calls work for as long as the browser stays alive.
//
// Lifecycle:
//   POST /api/auth/start → launches headed Chromium, loads ashbyhq signin,
//                          stores the BrowserContext here.
//   GET  /api/auth/status → probes the context's cookies / identity endpoint.
//   POST /api/auth/stop  → closes the context, clears this handle.
//   On context.on('close') (user Cmd-Q'd Chromium), clear the handle too.

let liveContext: BrowserContext | null = null;
let liveContextStartedAt: string | null = null;

const PROFILE_DIR = path.resolve(
  process.env.PLAYWRIGHT_PROFILE_DIR || '.playwright-browser-data',
);

async function probeLiveAuth(ctx: BrowserContext): Promise<{ ok: boolean; reason?: string; csrfToken?: string }> {
  // Cheap endpoint that requires an authenticated session — the CSRF token
  // endpoint returns 200 + a token when the cookie jar is valid, 401 when not.
  try {
    const res = await ctx.request.fetch('https://app.ashbyhq.com/api/csrf/token', {
      method: 'GET',
      timeout: 8000,
      failOnStatusCode: false,
    });
    if (res.ok()) {
      const body = await res.json().catch(() => ({}));
      return { ok: true, csrfToken: body?.token };
    }
    return { ok: false, reason: `auth probe returned ${res.status()}` };
  } catch (err: any) {
    return { ok: false, reason: err?.message || 'probe error' };
  }
}

function liveSessionFromContext(ctx: BrowserContext, csrfToken?: string): AshbySession {
  // Build an AshbySession whose `requestContext` triggers client.ts's live
  // mode. cookies map is empty — doFetch routes around it in live mode, and
  // the CSRF token hint lets the first call skip a roundtrip.
  return {
    cookies: {},
    csrfToken,
    orgIds: [],
    requestContext: ctx.request,
  };
}

// ── Cookie validation helper ──────────────────────────────────────────────

/**
 * Resolve an Ashby session by trying, in order:
 *   1. Cookie in the request body (legacy paste flow)
 *   2. STORED_COOKIE env var (legacy Railway deploy)
 *   3. The persistent Playwright profile via loadSession() — this is the
 *      no-paste happy path for local runs: log in once with
 *      `npm run start -- auth`, the session lives in .playwright-browser-data/
 *      and `.ashby-session.json` for ~7 days, and every extract call here
 *      transparently picks it up without any cookie wrangling on the caller.
 */
async function validateCookie(cookie: unknown): Promise<{ session: AshbySession } | { error: string; status: number }> {
  const bodyCookie = (typeof cookie === 'string' && cookie.trim()) ? cookie.trim() : '';

  // Every legacy-transport session gets this hook: doFetch fires it whenever
  // Ashby rotates a cookie via Set-Cookie, and persistSessionCookies writes
  // the rotated map to .ashby-session.json. That keeps the on-disk session
  // current across runs (Ashby rotates every few minutes — the login-day
  // token alone goes stale almost immediately), so one extraction completes
  // without a mid-sweep 401 and the next run reuses the rotated chain.
  const attachPersistence = (session: AshbySession, seedHash?: string): AshbySession => {
    if (seedHash) session.seedHash = seedHash;
    session.onCookiesRotated = (s) => { void persistSessionCookies(s); };
    return session;
  };

  // 1. Explicit body cookie — back-compat for legacy clients that still
  // paste a token (the Lovable dashboard re-sends its stored paste on EVERY
  // sync). Ashby rotates the token within minutes of the paste, so the raw
  // value is usually dead by the second sync — but the persisted session
  // file holds the live chain that descends from it. Same seedHash logic as
  // the STORED_COOKIE branch below: a persisted chain descended from this
  // exact seed wins (it's fresher); a different seed means the caller
  // deliberately pasted a NEW token, and that wins instead.
  if (bodyCookie) {
    const seedHash = crypto.createHash('sha256').update(bodyCookie).digest('hex');
    try {
      const persisted = await loadSession();
      if (
        persisted?.seedHash === seedHash &&
        (persisted.cookies?.['ashby_session_token'] || persisted.cookies?.['authenticated'])
      ) {
        return { session: attachPersistence(persisted, seedHash) };
      }
    } catch {
      // No persisted descendant — fall through to the raw pasted cookie.
    }
    const session = createSessionFromCookie(bodyCookie);
    if (!session.cookies['ashby_session_token'] && !session.cookies['authenticated']) {
      return {
        error: 'Cookie string is missing the ashby_session_token. Make sure you copy the full cookie from DevTools.',
        status: 400,
      };
    }
    // Tag the chain with this seed so the next sync's identical paste
    // matches it instead of resending the rotated-away raw token.
    return { session: attachPersistence(session, seedHash) };
  }

  // 2. Live SSO browser. The user kept Chromium open from /api/auth/start;
  // we route through its APIRequestContext so cookies stay fresh. No
  // persistence hook — the live cookie map is empty by design and the
  // Playwright profile owns those cookies.
  if (liveContext) {
    const probe = await probeLiveAuth(liveContext);
    if (probe.ok) {
      return { session: liveSessionFromContext(liveContext, probe.csrfToken) };
    }
    console.warn(`[live-auth] liveContext present but probe failed: ${probe.reason}`);
    // Don't bail with 401 yet — STORED_COOKIE / persistent-file paths
    // may still authenticate via the legacy transport.
  }

  // 3. Persisted session file / Playwright profile. This is the shared-team
  // happy path: on Railway the file lives on a durable volume, seeded via
  // POST /api/session/seed and kept fresh by rotation persistence; locally
  // it's .ashby-session.json / .playwright-browser-data from `auth`. It
  // outranks STORED_COOKIE because the env value is frozen at deploy time
  // while the file holds the live rotation chain.
  try {
    const session = await loadSession();
    if (session?.cookies?.['ashby_session_token'] || session?.cookies?.['authenticated']) {
      return { session: attachPersistence(session, session.seedHash) };
    }
  } catch {
    // Persistent session unavailable — fall through to the env cookie.
  }

  // 4. STORED_COOKIE env var — panic fallback only, reached when no
  // persisted session exists at all (e.g. fresh volume). Recovery from a
  // dead persisted chain is POST /api/session/seed, not a redeploy.
  if (STORED_COOKIE) {
    const seedHash = crypto.createHash('sha256').update(STORED_COOKIE).digest('hex');
    const stored = createSessionFromCookie(STORED_COOKIE);
    if (stored.cookies['ashby_session_token'] || stored.cookies['authenticated']) {
      return { session: attachPersistence(stored, seedHash) };
    }
  }

  return {
    // 401 (not 400): from the caller's perspective this is "no auth," which
    // is what the dashboard's session_dead branch keys off of to surface
    // the "Log into Ashby" recovery instructions.
    error: "No Ashby session available. Open Log into Ashby in the dashboard, or pass a cookie in the request body.",
    status: 401,
  };
}

// ── Live-auth endpoints ─────────────────────────────────────────────────

async function clearStaleSingletonLocks(profileDir: string): Promise<void> {
  // Chromium leaves SingletonLock / SingletonCookie / SingletonSocket files
  // when it shuts down ungracefully (crash, kill -9, Cmd-Q during navigation).
  // Subsequent launches see these and abort with "Failed to create a
  // ProcessSingleton." Since this server is the sole owner of the profile,
  // any of those files we find when liveContext is null is by definition
  // stale, so we delete them. If a real Chromium process is still holding
  // the profile, launchPersistentContext will fail anyway and we surface
  // the error to the user.
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      await fs.unlink(path.join(profileDir, name));
      console.log(`[live-auth] cleared stale ${name}`);
    } catch {
      // Doesn't exist — that's the happy path; nothing to do.
    }
  }
}

app.post('/api/auth/start', async (_req: express.Request, res: express.Response) => {
  if (liveContext) {
    // Already up. Return current status instead of double-launching.
    const probe = await probeLiveAuth(liveContext);
    res.json({
      already_running: true,
      authenticated: probe.ok,
      reason: probe.reason,
      started_at: liveContextStartedAt,
    });
    return;
  }

  try {
    // Clear stale singleton files from a previous ungraceful shutdown.
    // Safe because the only owner of this profile is this server process,
    // and we just confirmed liveContext === null above.
    await clearStaleSingletonLocks(PROFILE_DIR);

    // Launch the persistent context HEADED so the user can do SSO. The
    // context stays attached to this Node process; on close we clear the
    // module-level handle so the next call sees a clean state.
    //
    // Anti-automation-detection setup. Google's sign-in flow checks for
    // several Playwright telltales and refuses auth if it sees them. We:
    //   1) Drop Playwright's default --enable-automation flag (otherwise
    //      Chrome shows "Chrome is being controlled by automated test
    //      software" and exposes the `chrome.app` / automation markers).
    //   2) Drop --use-mock-keychain so the OS keychain works for password
    //      autofill (Google checks).
    //   3) Add an init script that overrides navigator.webdriver and a few
    //      other common detection points BEFORE any page script runs.
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      ignoreDefaultArgs: [
        '--enable-automation',
        '--use-mock-keychain',
      ],
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--no-default-browser-check',
        '--no-first-run',
        '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
        '--password-store=basic',
      ],
    });

    // Run BEFORE every page's scripts. Suppresses the most common
    // navigator.webdriver detection used by Google sign-in.
    await ctx.addInitScript(() => {
      // navigator.webdriver === true is the canonical automation signal.
      try {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
          configurable: true,
        });
      } catch {/* already overridden */}
      // navigator.languages is empty in headless; Google flags that.
      try {
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
          configurable: true,
        });
      } catch {/* ignore */}
      // navigator.plugins is empty in automation; real Chrome has at
      // least the PDF viewer. Spoof a non-zero length.
      try {
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
          configurable: true,
        });
      } catch {/* ignore */}
      // chrome.runtime is missing under automation; Google checks for it.
      try {
        if (!(window as any).chrome) (window as any).chrome = {};
        if (!(window as any).chrome.runtime) (window as any).chrome.runtime = {};
      } catch {/* ignore */}
    });

    ctx.on('close', () => {
      console.log('[live-auth] BrowserContext closed; clearing liveContext.');
      liveContext = null;
      liveContextStartedAt = null;
    });

    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://app.ashbyhq.com/signin', { waitUntil: 'domcontentloaded' }).catch((err) => {
      console.warn('[live-auth] initial navigation warning:', err?.message);
    });

    liveContext = ctx;
    liveContextStartedAt = new Date().toISOString();
    console.log(`[live-auth] Chromium opened with profile ${PROFILE_DIR}. Awaiting SSO.`);

    res.status(202).json({
      started: true,
      already_running: false,
      profile_dir: PROFILE_DIR,
      started_at: liveContextStartedAt,
      message: 'Chromium is open at app.ashbyhq.com. Sign in, then leave the window open — refresh will work as long as Chromium is alive.',
    });
  } catch (err: any) {
    console.error('[live-auth] failed to start:', err?.message);
    res.status(500).json({ error: 'live_auth_start_failed', detail: err?.message });
  }
});

app.get('/api/auth/status', async (_req: express.Request, res: express.Response) => {
  if (!liveContext) {
    res.json({
      live_active: false,
      authenticated: false,
      reason: 'No live browser context. Call POST /api/auth/start to open one.',
    });
    return;
  }
  const probe = await probeLiveAuth(liveContext);
  res.json({
    live_active: true,
    authenticated: probe.ok,
    reason: probe.reason,
    started_at: liveContextStartedAt,
  });
});

app.post('/api/auth/stop', async (_req: express.Request, res: express.Response) => {
  if (!liveContext) {
    res.json({ live_active: false, closed: false });
    return;
  }
  try {
    const ctx = liveContext;
    liveContext = null;
    liveContextStartedAt = null;
    await ctx.close().catch(() => {});
    res.json({ live_active: false, closed: true });
  } catch (err: any) {
    res.status(500).json({ error: 'live_auth_stop_failed', detail: err?.message });
  }
});

function formatResult(data: ExtractResult & { extraction_stats?: Record<string, unknown> }): CachedResult['data'] & { extraction_stats?: Record<string, unknown> } {
  return {
    success: true as const,
    extracted_at: new Date().toISOString(),
    stats: {
      companies: data.companies.length,
      jobs: data.jobs.length,
      candidates: data.candidates.length,
    },
    companies: data.companies,
    candidates: data.candidates,
    orgs: data.orgs,
    extraction_stats: data.extraction_stats,
  };
}

function handleExtractionError(err: any, res: express.Response) {
  const message = err?.message || String(err);

  if (message.includes('401') || message.includes('expired') || message.includes('CSRF')) {
    res.status(401).json({
      error: 'Session expired or invalid. Please paste a fresh cookie from Ashby.',
      detail: message,
    });
    return;
  }

  console.error('Extraction error:', message);
  res.status(500).json({ error: 'Extraction failed.', detail: message });
}

// ── Archive-status verification ──────────────────────────────────────────
//
// When a previously-active candidate stops appearing in the sweep, the
// dashboard backend asks here WHY: Hired is a placement, Did Not Respond is
// a dead process. Body: { applications: [{application_id, org_id}], cookie? }
// Sequential per-application lookups in the owning org's context.

app.post('/api/applications/archive-status', async (req: express.Request, res: express.Response) => {
  const validation = await validateCookie(req.body?.cookie);
  if ('error' in validation) {
    res.status(validation.status).json({ error: validation.error });
    return;
  }
  const applications = Array.isArray(req.body?.applications) ? req.body.applications : [];
  if (applications.length === 0) {
    res.json({ results: [] });
    return;
  }
  try {
    // Under the global lock: fetchArchiveStatuses switches org contexts and
    // must not interleave with a sweep or a write.
    const results = await withGlobalLock('archive-status', () =>
      fetchArchiveStatuses(validation.session, applications.slice(0, 50)),
    );
    res.json({ results });
  } catch (err: any) {
    handleExtractionError(err, res);
  }
});

// ── Add-to-Ashby write endpoints ──────────────────────────────────────────
//
// The dashboard's Add-to-Ashby flow. Both routes are under /api/applications
// (covered by requireSecret on the Railway deploy) and run inside the global
// lock — org context is server-side session state, so a write must never
// interleave with a sweep's org switches.

function resolveOrgByName(
  orgs: Array<{ id: string; name: string; userId: string }>,
  orgName: string,
): { id: string; name: string; userId: string } | null {
  const wanted = (orgName || '').trim().toLowerCase();
  if (!wanted) return null;
  const compact = wanted.replace(/\s+/g, '');
  return (
    orgs.find((o) => o.name.trim().toLowerCase() === wanted) ||
    orgs.find((o) => o.name.trim().toLowerCase().replace(/\s+/g, '') === compact) ||
    null
  );
}

const CANDIDATE_LABS_SOURCE_TITLE = process.env.ASHBY_SOURCE_TITLE || 'Sourced: Candidate Labs';

app.post('/api/applications/open-jobs', async (req: express.Request, res: express.Response) => {
  const validation = await validateCookie(req.body?.cookie);
  if ('error' in validation) {
    res.status(validation.status).json({ error: validation.error });
    return;
  }
  const orgName = typeof req.body?.org_name === 'string' ? req.body.org_name : '';
  try {
    const payload = await withGlobalLock('open-jobs', async () => {
      const orgs = (await fetchAllAvailableOrgs(validation.session)).filter((o) => o.userId);
      const org = resolveOrgByName(orgs, orgName);
      if (!org) {
        return { __status: 404, error: 'unknown_org', org_name: orgName, available: orgs.map((o) => o.name) };
      }
      await enterOrgContext(validation.session, org.userId, org.name);
      const jobs = await fetchOpenJobsForOrg(validation.session);
      let sourceId: string | null = null;
      let sourceTitle: string | null = null;
      try {
        const source = await fetchSourceIdByTitle(validation.session, CANDIDATE_LABS_SOURCE_TITLE);
        sourceId = source?.id ?? null;
        sourceTitle = source?.displayTitle ?? null;
      } catch (err: any) {
        console.warn(`  open-jobs: source lookup failed (non-fatal): ${err?.message?.substring(0, 120)}`);
      }
      return {
        org_name: org.name,
        jobs: jobs.map((j) => ({ id: j.id, title: j.title, location: j.locationName, application_count: j.applicationCount })),
        source_id: sourceId,
        source_title: sourceTitle,
        // available_identities returns the session user's identity per org,
        // so this userId IS the credited-to user id for that org.
        credited_to_user_id: org.userId,
      };
    });
    if ((payload as any).__status) {
      const { __status, ...body } = payload as any;
      res.status(__status).json(body);
      return;
    }
    res.json(payload);
  } catch (err: any) {
    handleExtractionError(err, res);
  }
});

// Body: { org_name, job_id, candidate: {name, email?, linkedin_url?},
//         resume: {filename, content_base64}|null, note_text?,
//         source_id?, credited_to_user_id?,
//         existing_candidate_id?, skip_duplicate_check? }
// Partial-failure contract: once the candidate exists, downstream failures
// come back as HTTP 200 with a per-step status map; the caller retries by
// resending with existing_candidate_id.
app.post('/api/applications/add-candidate', async (req: express.Request, res: express.Response) => {
  const validation = await validateCookie(req.body?.cookie);
  if ('error' in validation) {
    res.status(validation.status).json({ error: validation.error });
    return;
  }
  const body = req.body || {};
  const orgName = typeof body.org_name === 'string' ? body.org_name : '';
  const jobId = typeof body.job_id === 'string' ? body.job_id : '';
  const cand = body.candidate || {};
  const candName = typeof cand.name === 'string' ? cand.name.trim() : '';
  if (!orgName || !jobId || !candName) {
    res.status(400).json({ error: 'missing_fields', detail: 'org_name, job_id, and candidate.name are required' });
    return;
  }

  try {
    const payload = await withGlobalLock('add-candidate', async () => {
      const session = validation.session;
      const orgs = (await fetchAllAvailableOrgs(session)).filter((o) => o.userId);
      const org = resolveOrgByName(orgs, orgName);
      if (!org) {
        return { __status: 404, error: 'unknown_org', org_name: orgName, available: orgs.map((o) => o.name) };
      }
      await enterOrgContext(session, org.userId, org.name);
      // Ashby's org context is PER-USER server state, not per-session: the
      // operator's own browsing in the Ashby web UI moves the same context
      // this session writes under. Re-entering (change_user + verify) before
      // each write step forces the context back and shrinks the race window
      // from the whole request to milliseconds per mutation group.
      const reassertOrg = () => enterOrgContext(session, org.userId, org.name);

      const warnings: string[] = [];
      const steps: Record<string, string> = { candidate: 'pending', resume: 'pending', application: 'pending', note: 'pending' };
      const normLi = (u: string) =>
        (u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('?')[0].replace(/\/+$/, '');

      let candidateId: string = typeof body.existing_candidate_id === 'string' ? body.existing_candidate_id : '';

      // Duplicate pre-check — BEFORE any write. LinkedIn slug match first,
      // exact normalized name second.
      if (!candidateId && body.skip_duplicate_check !== true) {
        const hits = await searchCandidatesInOrg(session, candName);
        const liWanted = cand.linkedin_url ? normLi(cand.linkedin_url) : '';
        const matches = hits.filter((h) => {
          if (liWanted && h.linkedinUrl && normLi(h.linkedinUrl) === liWanted) return true;
          return h.name.trim().toLowerCase() === candName.toLowerCase();
        });
        if (matches.length > 0) {
          return {
            __status: 409,
            error: 'candidate_exists',
            matches: matches.map((m) => ({ id: m.id, name: m.name, email: m.email, linkedin_url: m.linkedinUrl })),
          };
        }
      }

      // Attribution ids — either passed through from the open-jobs prefill
      // or resolved here. Soft-fail: an upload without attribution beats no
      // upload; the warning is surfaced in the modal.
      let sourceId: string | null = typeof body.source_id === 'string' ? body.source_id : null;
      if (!sourceId) {
        try {
          sourceId = (await fetchSourceIdByTitle(session, CANDIDATE_LABS_SOURCE_TITLE))?.id ?? null;
        } catch { /* soft-fail below */ }
        if (!sourceId) warnings.push(`source "${CANDIDATE_LABS_SOURCE_TITLE}" not found in this org — attribution skipped`);
      }
      const creditedToUserId: string | null =
        typeof body.credited_to_user_id === 'string' ? body.credited_to_user_id : org.userId;

      // Create (point of no return) — or reuse the retry path's id.
      if (candidateId) {
        steps.candidate = 'existing';
      } else {
        const created = await createCandidateWithDetails(session, {
          name: candName,
          email: typeof cand.email === 'string' && cand.email.trim() ? cand.email.trim() : null,
          linkedinUrl: typeof cand.linkedin_url === 'string' && cand.linkedin_url.trim() ? cand.linkedin_url.trim() : null,
          sourceId,
          creditedToUserId,
        });
        candidateId = created.candidateId;
        warnings.push(...created.warnings);
        steps.candidate = 'created';
      }

      // Resume — non-fatal.
      if (body.resume?.content_base64 && body.resume?.filename) {
        try {
          await reassertOrg();
          await uploadResumeForCandidate(session, candidateId, {
            filename: body.resume.filename,
            contentBase64: body.resume.content_base64,
          });
          steps.resume = 'uploaded';
        } catch (err: any) {
          steps.resume = 'failed';
          warnings.push(`resume upload failed: ${err?.message?.substring(0, 150)}`);
        }
      } else {
        steps.resume = 'skipped';
      }

      // Application — on the retry path, re-check for one on this job first
      // (the restricted-summaries lookup returns every application with its
      // job id, including ones this seat can't open).
      let applicationId: string | null = null;
      try {
        await reassertOrg();
        if (steps.candidate === 'existing') {
          try {
            const summaries = await fetchCandidateRestrictedSummaries(session, candidateId);
            const existing = summaries.find((s) => s.jobId === jobId);
            if (existing) {
              applicationId = existing.applicationId;
              steps.application = 'existing';
            }
          } catch { /* fall through to create */ }
        }
        if (!applicationId) {
          // interviewPlanId is REQUIRED (the UI panel always supplies the
          // job's default plan); the stage must stay null for this seat —
          // see createApplicationForCandidate.
          const plan = await fetchJobEntryStage(session, jobId);
          if (!plan?.interviewPlanId) {
            throw new Error(`no interview plan found for job ${jobId} — cannot create application`);
          }
          const created = await createApplicationForCandidate(session, {
            candidateId,
            jobId,
            interviewPlanId: plan.interviewPlanId,
            sourceId,
            creditedToUserId,
          });
          applicationId = created.applicationId;
          steps.application = 'created';
        }
      } catch (err: any) {
        steps.application = 'failed';
        warnings.push(`application create failed: ${err?.message?.substring(0, 150)}`);
      }

      // Note — non-fatal.
      if (typeof body.note_text === 'string' && body.note_text.trim()) {
        try {
          await reassertOrg();
          await addNoteToCandidate(session, candidateId, body.note_text);
          steps.note = 'created';
        } catch (err: any) {
          steps.note = 'failed';
          warnings.push(`note create failed: ${err?.message?.substring(0, 150)}`);
        }
      } else {
        steps.note = 'skipped';
      }

      // A write changes org state — cached sweep results are now stale.
      resultCache = null;
      clearOrgCache();

      return {
        success: steps.application === 'created' || steps.application === 'existing',
        candidate_id: candidateId,
        application_id: applicationId,
        candidate_url: `https://app.ashbyhq.com/candidates/${candidateId}`,
        org_name: org.name,
        steps,
        warnings,
      };
    });
    if ((payload as any).__status) {
      const { __status, ...bodyOut } = payload as any;
      res.status(__status).json(bodyOut);
      return;
    }
    res.json(payload);
  } catch (err: any) {
    handleExtractionError(err, res);
  }
});

// ── Shared-session seed + status ──────────────────────────────────────────
//
// The team deployment's session lifecycle: anyone in the Ashby org pastes a
// cookie once (~weekly) via POST /api/session/seed; the chain then rotates
// itself on every sweep and persists to ASHBY_SESSION_FILE (a Railway
// volume), so the seed survives deploys and restarts. GET /api/session/status
// probes whether the persisted chain still authenticates.

app.post('/api/session/seed', async (req: express.Request, res: express.Response) => {
  const cookie = typeof req.body?.cookie === 'string' ? req.body.cookie.trim() : '';
  if (!cookie) {
    res.status(400).json({ error: 'Missing cookie in request body.' });
    return;
  }
  const session = createSessionFromCookie(cookie);
  if (!session.cookies['ashby_session_token'] && !session.cookies['authenticated']) {
    res.status(400).json({
      error: 'Cookie string is missing the ashby_session_token. Copy the full Cookie header value from DevTools.',
    });
    return;
  }
  session.seedHash = crypto.createHash('sha256').update(cookie).digest('hex');
  // Persist rotations observed during the probe too — Ashby may rotate on
  // the very first request, and dropping that rotation kills the chain.
  session.onCookiesRotated = (s) => { void persistSessionCookies(s); };
  try {
    session.csrfToken = await fetchCsrfToken(session);
  } catch (err: any) {
    // Don't clobber a (possibly still healthy) persisted chain with a paste
    // that doesn't authenticate.
    res.status(401).json({
      error: 'Cookie did not authenticate against Ashby. Make sure you are logged in and copied the full cookie.',
      detail: err?.message || String(err),
    });
    return;
  }
  await persistSessionCookies(session);
  console.log('[session-seed] New shared session seeded and verified.');
  res.json({ authenticated: true, persisted_at: new Date().toISOString() });
});

app.get('/api/session/status', async (_req: express.Request, res: express.Response) => {
  let session: AshbySession;
  try {
    session = await loadSession();
  } catch {
    res.json({ authenticated: false, reason: 'no_session' });
    return;
  }
  if (!session.cookies?.['ashby_session_token'] && !session.cookies?.['authenticated']) {
    res.json({ authenticated: false, reason: 'no_session' });
    return;
  }
  // Probe with rotation persistence attached — the probe itself may rotate
  // the token, and that rotation must land back in the persisted file.
  session.onCookiesRotated = (s) => { void persistSessionCookies(s); };
  try {
    await fetchCsrfToken(session);
    res.json({ authenticated: true, persisted_at: (session as any).persistedAt ?? null });
  } catch {
    res.json({ authenticated: false, reason: 'expired', persisted_at: (session as any).persistedAt ?? null });
  }
});

// ── Synchronous extraction ───────────────────────────────────────────────

app.post('/api/extract', async (req: express.Request, res: express.Response) => {
  const force = req.body.force === true;
  // Return cache if fresh (unless force=true)
  const cached = !force ? getCachedResult() : null;
  if (cached) {
    console.log('Returning cached extraction result');
    res.json({ ...cached, cached: true });
    return;
  }

  const validation = await validateCookie(req.body.cookie);
  if ('error' in validation) {
    res.status(validation.status).json({ error: validation.error });
    return;
  }

  try {
    const data = await withGlobalLock('extract', () => extractPipeline(validation.session));
    const result = formatResult(data);
    setCachedResult(result);
    res.json(result);
  } catch (err: any) {
    handleExtractionError(err, res);
  }
});

// ── Async extraction (start + poll) ──────────────────────────────────────

// Single-flight: the shared session can't run two sweeps at once — both
// would fight over Ashby's server-side org context (change_user races). A
// second start while one runs ATTACHES to the running job instead.
let runningJobId: string | null = null;

app.post('/api/extract/start', async (req: express.Request, res: express.Response) => {
  const force = req.body.force === true;
  // Return cache if fresh — no need to even validate the cookie
  const cached = !force ? getCachedResult() : null;
  if (cached) {
    console.log('Returning cached extraction result (async fast path)');
    const jobId = crypto.randomUUID();
    // Create a pre-completed job so the status endpoint returns the result
    jobs.set(jobId, {
      id: jobId,
      status: 'completed',
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      result: { ...cached, cached: true } as any,
    });
    res.json({ jobId, job_id: jobId, id: jobId, status: 'completed', cached: true });
    return;
  }

  if (runningJobId) {
    const running = jobs.get(runningJobId);
    if (running && running.status === 'running') {
      console.log(`Attaching caller to in-flight extraction job ${running.id}`);
      res.json({ jobId: running.id, job_id: running.id, id: running.id, status: 'running', attached: true });
      return;
    }
    runningJobId = null;
  }

  const validation = await validateCookie(req.body.cookie);
  if ('error' in validation) {
    res.status(validation.status).json({ error: validation.error });
    return;
  }

  cleanupOldJobs();

  const jobId = crypto.randomUUID();
  const job: ExtractionJob = {
    id: jobId,
    status: 'running',
    created_at: new Date().toISOString(),
    progress: { completed: 0, total: 0, current_org: 'Starting...' },
  };
  jobs.set(jobId, job);
  runningJobId = jobId;

  // Fire and forget — extraction runs in the background (under the global
  // lock so it can't interleave org switches with a write).
  withGlobalLock('extract-async', () =>
    extractPipeline(validation.session, (completed, total, currentOrg) => {
      job.progress = { completed, total, current_org: currentOrg };
    }),
  )
    .then((data) => {
      const result = formatResult(data);
      setCachedResult(result);
      job.status = 'completed';
      job.completed_at = new Date().toISOString();
      job.result = result;
      if (runningJobId === jobId) runningJobId = null;
    })
    .catch((err: any) => {
      const message = err?.message || String(err);
      job.status = 'failed';
      job.completed_at = new Date().toISOString();
      if (runningJobId === jobId) runningJobId = null;
      if (message.includes('401') || message.includes('expired') || message.includes('CSRF')) {
        job.error = 'Session expired or invalid. Please paste a fresh cookie from Ashby.';
      } else {
        job.error = 'Extraction failed.';
      }
      job.detail = message;
      console.error(`Job ${jobId} failed:`, message);
    });

  res.json({ jobId, job_id: jobId, id: jobId, status: 'running' });
});

const handleJobStatus = (req: express.Request, res: express.Response) => {
  cleanupOldJobs();
  const jobId = req.params.jobId as string;
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: 'Job not found. It may have expired (30-min TTL).' });
    return;
  }

  if (job.status === 'running') {
    res.json({
      jobId: job.id,
      job_id: job.id,
      status: 'running',
      created_at: job.created_at,
      progress: job.progress,
    });
    return;
  }

  if (job.status === 'failed') {
    res.status(job.error?.includes('expired') ? 401 : 500).json({
      jobId: job.id,
      job_id: job.id,
      status: 'failed',
      error: job.error,
      detail: job.detail,
    });
    return;
  }

  // completed — keep the job until the 30-min TTL (cleanupOldJobs) instead
  // of deleting on first read, so multiple teammates' pollers attached to
  // the same shared-session job can each read the result.
  res.json({
    jobId: job.id,
    job_id: job.id,
    status: 'completed',
    ...job.result,
  });
};

app.get('/api/extract/status/:jobId', handleJobStatus);
app.get('/api/extract/jobs/:jobId', handleJobStatus);

// --- Google Calendar OAuth (multi-user) ---

app.get('/api/google/auth', (_req: express.Request, res: express.Response) => {
  res.json({ url: getAuthUrl() });
});

app.get('/api/google/callback', async (req: express.Request, res: express.Response) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).json({ error: 'Missing code parameter.' });
    return;
  }
  try {
    const tokens = await exchangeCode(code);
    const frontendUrl = process.env.FRONTEND_URL || '';
    const tokenParam = encodeURIComponent(JSON.stringify(tokens));
    if (frontendUrl) {
      res.redirect(`${frontendUrl}?google_tokens=${tokenParam}`);
    } else {
      res.json({ success: true, tokens });
    }
  } catch (err: any) {
    console.error('Google OAuth error:', err?.message);
    res.status(500).json({ error: 'Failed to complete Google OAuth.', detail: err?.message });
  }
});

// --- Calendar batch add (multi-user) ---

app.post('/api/calendar/add', async (req: express.Request, res: express.Response) => {
  const { events, google_tokens } = req.body as {
    events?: CalendarEventRequest[];
    google_tokens?: any;
  };

  if (!google_tokens) {
    res.status(401).json({ error: 'Missing google_tokens. Please connect Google Calendar first.' });
    return;
  }

  if (!events || !Array.isArray(events) || events.length === 0) {
    res.status(400).json({ error: 'Missing or empty "events" array in request body.' });
    return;
  }

  try {
    const result = await addEventsToCalendar(google_tokens, events);
    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error('Calendar add error:', err?.message);
    res.status(500).json({ error: 'Failed to add calendar events.', detail: err?.message });
  }
});

app.listen(PORT, () => {
  console.log(`Ashby extraction API listening on port ${PORT}`);
  // Periodic cleanup of stale jobs (every 5 minutes)
  setInterval(cleanupOldJobs, 5 * 60 * 1000);
});
