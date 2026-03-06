/**
 * server.ts -- Express API server for self-serve Ashby pipeline extraction.
 *
 * Endpoints:
 *   POST /api/extract   Accept a cookie string, run extraction, return candidate data as JSON
 *   GET  /api/health    Health check
 *
 * The extraction logic reuses the same code as the CLI `extract` command,
 * but returns JSON directly instead of writing files.
 */
import express from 'express';
import cors from 'cors';
import { createSessionFromCookie, extractPipeline } from './api-server-extract.js';
import { getAuthUrl, exchangeCode, addEventsToCalendar, CalendarEventRequest } from './google-calendar.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/extract', async (req, res) => {
  const { cookie } = req.body;

  if (!cookie || typeof cookie !== 'string' || !cookie.trim()) {
    res.status(400).json({ error: 'Missing or empty "cookie" field in request body.' });
    return;
  }

  try {
    const session = createSessionFromCookie(cookie.trim());

    // Validate that the cookie has the required auth token
    if (!session.cookies['ashby_session_token'] && !session.cookies['authenticated']) {
      res.status(400).json({
        error: 'Cookie string is missing the ashby_session_token. Make sure you copy the full cookie from DevTools.'
      });
      return;
    }

    const data = await extractPipeline(session);

    res.json({
      success: true,
      extracted_at: new Date().toISOString(),
      stats: {
        companies: data.companies.length,
        jobs: data.jobs.length,
        candidates: data.candidates.length,
      },
      candidates: data.candidates,
    });
  } catch (err: any) {
    const message = err?.message || String(err);

    // Detect auth failures
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
});

// --- Google Calendar OAuth (multi-user) ---
// Tokens are returned to the frontend and stored in localStorage.
// The frontend sends tokens with each calendar request.

app.get('/api/google/auth', (_req, res) => {
  res.json({ url: getAuthUrl() });
});

app.get('/api/google/callback', async (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).json({ error: 'Missing code parameter.' });
    return;
  }
  try {
    const tokens = await exchangeCode(code);
    // Redirect to frontend with tokens encoded in the hash (not query params, for security)
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
// Frontend sends google_tokens alongside events.

app.post('/api/calendar/add', async (req, res) => {
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
