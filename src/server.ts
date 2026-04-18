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
import { createSessionFromCookie, extractPipeline, ExtractResult, getOrgCacheStats } from './api-server-extract.js';
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
    result_cache_age_seconds: resultCache
      ? Math.round((Date.now() - resultCache.timestamp) / 1000)
      : null,
    org_cache: getOrgCacheStats(),
  });
});

// ── Cookie validation helper ──────────────────────────────────────────────

function validateCookie(cookie: unknown): { session: ReturnType<typeof createSessionFromCookie> } | { error: string; status: number } {
  if (!cookie || typeof cookie !== 'string' || !cookie.trim()) {
    return { error: 'Missing or empty "cookie" field in request body.', status: 400 };
  }

  const session = createSessionFromCookie(cookie.trim());

  if (!session.cookies['ashby_session_token'] && !session.cookies['authenticated']) {
    return {
      error: 'Cookie string is missing the ashby_session_token. Make sure you copy the full cookie from DevTools.',
      status: 400,
    };
  }

  return { session };
}

function formatResult(data: ExtractResult & { extraction_stats?: Record<string, number> }): CachedResult['data'] & { extraction_stats?: Record<string, number> } {
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

  const validation = validateCookie(req.body.cookie);
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

app.post('/api/extract/start', (req: express.Request, res: express.Response) => {
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

  const validation = validateCookie(req.body.cookie);
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
});
