/**
 * google-calendar.ts -- Google OAuth2 and Calendar API integration (multi-user).
 *
 * Tokens are NOT stored server-side. Instead:
 *   1. Server generates the OAuth URL and exchanges the auth code for tokens
 *   2. Tokens are returned to the frontend, which stores them in localStorage
 *   3. Frontend sends tokens with each /api/calendar/add request
 *   4. Server creates a per-request OAuth client using those tokens
 */
import { google } from 'googleapis';

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

// --- OAuth flow ---

export function getAuthUrl(): string {
  return makeOAuth2Client().generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    prompt: 'consent',
  });
}

export async function exchangeCode(code: string): Promise<any> {
  const client = makeOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
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

export async function addEventsToCalendar(
  tokens: any,
  events: CalendarEventRequest[],
): Promise<AddEventsResult> {
  const client = makeOAuth2Client();
  client.setCredentials(tokens);
  const calendar = google.calendar({ version: 'v3', auth: client });

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
