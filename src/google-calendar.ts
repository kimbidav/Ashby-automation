/**
 * google-calendar.ts -- Google OAuth2 and Calendar API integration.
 *
 * Handles:
 *   - OAuth2 auth URL generation and token exchange
 *   - In-memory token storage with file-based persistence
 *   - Batch calendar event creation with duplicate detection
 */
import { google } from 'googleapis';
import fs from 'node:fs';

const TOKEN_FILE = '/tmp/google-tokens.json';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);

// --- Token management ---

let storedTokens: any = null;

function loadTokensFromDisk(): void {
  try {
    const data = fs.readFileSync(TOKEN_FILE, 'utf8');
    storedTokens = JSON.parse(data);
    oauth2Client.setCredentials(storedTokens);
    console.log('Loaded Google tokens from disk');
  } catch {
    // No saved tokens — user needs to authenticate
  }
}

// Load on startup
loadTokensFromDisk();

function saveTokensToDisk(tokens: any): void {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens), 'utf8');
  } catch (err) {
    console.error('Failed to persist Google tokens:', err);
  }
}

export function setTokens(tokens: any): void {
  storedTokens = tokens;
  oauth2Client.setCredentials(tokens);
  saveTokensToDisk(tokens);
}

export function isAuthenticated(): boolean {
  return !!storedTokens;
}

// --- OAuth flow ---

export function getAuthUrl(): string {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    prompt: 'consent',
  });
}

export async function exchangeCode(code: string): Promise<void> {
  const { tokens } = await oauth2Client.getToken(code);
  setTokens(tokens);
}

// --- Calendar operations ---

export interface CalendarEventRequest {
  candidate_name: string;
  company_name: string;
  interview_title: string;
  start_time: string;
  end_time: string;
}

interface AddEventsResult {
  created: number;
  skipped_past: number;
  skipped_duplicate: number;
  errors: number;
  details: string[];
}

export async function addEventsToCalendar(events: CalendarEventRequest[]): Promise<AddEventsResult> {
  oauth2Client.setCredentials(storedTokens);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const now = new Date();
  const result: AddEventsResult = { created: 0, skipped_past: 0, skipped_duplicate: 0, errors: 0, details: [] };

  // Filter to future events
  const futureEvents = events.filter((ev) => {
    if (new Date(ev.start_time) <= now) {
      result.skipped_past++;
      return false;
    }
    return true;
  });

  if (futureEvents.length === 0) {
    return result;
  }

  // Fetch existing events in the relevant time range for dedup
  const timestamps = futureEvents.map((e) => new Date(e.start_time).getTime());
  const minTime = new Date(Math.min(...timestamps));
  const maxTime = new Date(Math.max(...timestamps) + 86_400_000); // +1 day buffer

  let existingEvents: any[] = [];
  try {
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: minTime.toISOString(),
      timeMax: maxTime.toISOString(),
      singleEvents: true,
      maxResults: 500,
    });
    existingEvents = res.data.items || [];
  } catch (err: any) {
    console.error('Failed to list existing calendar events (continuing without dedup):', err?.message);
  }

  for (const ev of futureEvents) {
    const title = `${ev.candidate_name} x ${ev.company_name} (${ev.interview_title})`;

    // Check for duplicate: same title and same date
    const evDate = ev.start_time.substring(0, 10); // YYYY-MM-DD
    const isDuplicate = existingEvents.some(
      (existing) =>
        existing.summary === title &&
        (existing.start?.dateTime?.startsWith(evDate) || existing.start?.date === evDate),
    );

    if (isDuplicate) {
      result.skipped_duplicate++;
      result.details.push(`Skipped (duplicate): ${title}`);
      continue;
    }

    try {
      await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: title,
          start: { dateTime: ev.start_time },
          end: { dateTime: ev.end_time },
        },
      });
      result.created++;
      result.details.push(`Created: ${title}`);
    } catch (err: any) {
      result.errors++;
      result.details.push(`Error: ${title} — ${err?.message}`);
      console.error(`Failed to create event "${title}":`, err?.message);
    }
  }

  return result;
}
