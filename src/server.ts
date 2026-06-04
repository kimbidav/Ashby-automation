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
 * change that fast and cookies rotate every few minutes.
 */
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'node:path';
import { chromium, BrowserContext } from 'playwright';
import { createSessionFromCookie, extractPipeline, ExtractResult, getOrgCacheStats } from './api-server-extract.js';
import { loadSession } from './session.js';
import { AshbySession } from './types.js';
import { getAuthUrl, exchangeCode, addEventsToCalendar, CalendarEventRequest } from './google-calendar.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ── Result cache (10-min TTL) ─────────────────────────────────────────────

interface CachedResult {
  timestamp: number;
  data: {
    success: true;
    extracted_at: string;
    stats: { companies: number; jobs: number; candidates: number };
    companies: any[];
    candidates: any[];
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

app.get('/api/health', (_req: express.Request, res: express.Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    stored_cookie_configured: !!STORED_COOKIE,
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

  // 1. Explicit body cookie — back-compat for legacy clients that still
  // paste a token. Wins over all other sources; the caller knew what
  // they wanted.
  if (bodyCookie) {
    const session = createSessionFromCookie(bodyCookie);
    if (!session.cookies['ashby_session_token'] && !session.cookies['authenticated']) {
      return {
        error: 'Cookie string is missing the ashby_session_token. Make sure you copy the full cookie from DevTools.',
        status: 400,
      };
    }
    return { session };
  }

  // 2. Live SSO browser. The user kept Chromium open from /api/auth/start;
  // we route through its APIRequestContext so cookies stay fresh.
  if (liveContext) {
    const probe = await probeLiveAuth(liveContext);
    if (probe.ok) {
      return { session: liveSessionFromContext(liveContext, probe.csrfToken) };
    }
    console.warn(`[live-auth] liveContext present but probe failed: ${probe.reason}`);
    // Don't bail with 401 yet — STORED_COOKIE / persistent-file paths
    // may still authenticate via the legacy transport.
  }

  // 3. STORED_COOKIE env var (legacy Railway deploy).
  if (STORED_COOKIE) {
    const stored = createSessionFromCookie(STORED_COOKIE);
    if (stored.cookies['ashby_session_token'] || stored.cookies['authenticated']) {
      return { session: stored };
    }
  }

  // 4. .ashby-session.json / .playwright-browser-data (the cookie-paste
  // and persistent-profile fallbacks). loadSession knows the right order.
  try {
    const session = await loadSession();
    if (session?.cookies?.['ashby_session_token'] || session?.cookies?.['authenticated']) {
      return { session };
    }
  } catch {
    // Persistent session unavailable — fall through to the 401 below.
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
    // Launch the persistent context HEADED so the user can do SSO. The
    // context stays attached to this Node process; on close we clear the
    // module-level handle so the next call sees a clean state.
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
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
    const data = await extractPipeline(validation.session);
    const result = formatResult(data);
    setCachedResult(result);
    res.json(result);
  } catch (err: any) {
    handleExtractionError(err, res);
  }
});

// ── Async extraction (start + poll) ──────────────────────────────────────

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

  // Fire and forget — extraction runs in the background
  extractPipeline(validation.session, (completed, total, currentOrg) => {
    job.progress = { completed, total, current_org: currentOrg };
  })
    .then((data) => {
      const result = formatResult(data);
      setCachedResult(result);
      job.status = 'completed';
      job.completed_at = new Date().toISOString();
      job.result = result;
    })
    .catch((err: any) => {
      const message = err?.message || String(err);
      job.status = 'failed';
      job.completed_at = new Date().toISOString();
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
    jobs.delete(job.id);
    return;
  }

  // completed
  res.json({
    jobId: job.id,
    job_id: job.id,
    status: 'completed',
    ...job.result,
  });
  jobs.delete(job.id);
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
