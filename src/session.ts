/**
 * session.ts — Authentication and session management.
 *
 * Sessions are saved to / loaded from `.ashby-session.json` (a cookie map + optional CSRF token).
 *
 * Two ways to create a session:
 *   bootstrapSession()              Opens a real Chrome window for SSO login; saves cookies on close
 *   createSessionFromCookieHeader() Parses a cookie string pasted from browser DevTools
 *
 * loadSession() tries sources in order:
 *   1. .ashby-session.json (works even while the browser window is still open)
 *   2. Playwright persistent browser context at .playwright-browser-data/ (if browser is closed)
 *
 * Ashby ROTATES ashby_session_token via Set-Cookie every few minutes.
 * doFetch (client.ts) mirrors each rotation into the in-memory session and
 * fires session.onCookiesRotated, which server.ts wires to
 * persistSessionCookies() below — so `.ashby-session.json` always holds the
 * newest token in the rotation chain, not the one from login day.
 * Sessions only die at Ashby's hard login expiry (~7 days) or logout.
 * Re-auth: npm run start -- auth-cookie --cookie "<new cookie string>"
 */
import { chromium, BrowserContext } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AshbySession } from './types.js';

const SESSION_FILE = path.join(process.cwd(), '.ashby-session.json');

// Serializes session-file writes so concurrent rotations can't interleave.
let persistChain: Promise<void> = Promise.resolve();

/**
 * Persist the session's current cookie map to .ashby-session.json.
 *
 * Called (via session.onCookiesRotated) every time doFetch observes a
 * Set-Cookie rotation, so the file on disk always holds the newest token in
 * the rotation chain — the next run (or a run resumed after a crash) starts
 * from a valid session instead of the login-day token Ashby already rotated
 * out.
 *
 * Guards:
 *  - Live mode (requestContext set) never persists — its cookie map is empty
 *    by design; the Playwright profile owns those cookies.
 *  - A map without auth cookies never persists — don't clobber a good file
 *    with junk.
 *
 * Writes are atomic (tmp + rename) and serialized through `persistChain`.
 * Failures are logged, never thrown — persistence must not fail extraction.
 */
export function persistSessionCookies(session: AshbySession): Promise<void> {
  if (session.requestContext) return Promise.resolve();
  if (!session.cookies?.['ashby_session_token'] && !session.cookies?.['authenticated']) {
    return Promise.resolve();
  }

  // Snapshot now — the map may mutate again before the queued write runs.
  const payload = JSON.stringify(
    {
      cookies: { ...session.cookies },
      csrfToken: session.csrfToken,
      orgIds: session.orgIds,
      persistedAt: new Date().toISOString(),
      ...(session.seedHash ? { seedHash: session.seedHash } : {}),
    },
    null,
    2
  );

  persistChain = persistChain.then(async () => {
    const tmpFile = `${SESSION_FILE}.tmp`;
    try {
      await fs.writeFile(tmpFile, payload, 'utf8');
      await fs.rename(tmpFile, SESSION_FILE);
      console.log('✓ Persisted rotated session cookies to .ashby-session.json');
    } catch (err: any) {
      console.warn(`⚠ Failed to persist rotated session cookies: ${err?.message || err}`);
    }
  });
  return persistChain;
}

export async function saveSessionFromContext(context: BrowserContext): Promise<AshbySession> {
  const cookies = await context.cookies();
  const cookieMap: Record<string, string> = {};
  for (const c of cookies) {
    if (c.name && c.value) {
      cookieMap[c.name] = c.value;
    }
  }

  // CSRF token is often stored in cookies or localStorage; stubbed here.
  const ashbySession: AshbySession = {
    cookies: cookieMap,
    csrfToken: cookieMap['csrf'],
    orgIds: []
  };

  await fs.writeFile(SESSION_FILE, JSON.stringify(ashbySession, null, 2), 'utf8');
  console.log(`Saved Ashby session to ${SESSION_FILE}`);
  return ashbySession;
}

export async function loadSession(): Promise<AshbySession> {
  // First try to load from session file (created when browser was closed)
  try {
    const content = await fs.readFile(SESSION_FILE, 'utf8');
    const session = JSON.parse(content) as AshbySession;
    // Check if it has valid auth cookies
    if (session.cookies && (session.cookies['ashby_session_token'] || session.cookies['authenticated'])) {
      console.log('✓ Loaded session from .ashby-session.json');
      return session;
    }
  } catch (error) {
    // Session file doesn't exist or is invalid, continue to try browser context
  }

  // Fallback to browser context (if browser is closed)
  try {
    const session = await loadSessionFromBrowserContext();
    if (session && Object.keys(session.cookies).length > 0) {
      console.log('✓ Loaded session from browser context');
      return session;
    }
  } catch (error: any) {
    // Browser context might be locked (browser still open) or not exist
    if (error.message && error.message.includes('ProcessSingleton')) {
      console.log('⚠ Browser window is still open from "auth" command.');
      console.log('   Using saved session file instead. Close the browser window if you want to refresh the session.');
    }
  }

  // Final fallback: try session file one more time
  try {
    const content = await fs.readFile(SESSION_FILE, 'utf8');
    const session = JSON.parse(content) as AshbySession;
    console.log('✓ Loaded session from .ashby-session.json (fallback)');
    return session;
  } catch (error) {
    throw new Error(
      'No session found. Please run "npm run start -- auth" to log in first.\n' +
      'This will open a browser where you can log in with dkimball@candidatelabs.com'
    );
  }
}

export async function loadSessionFromBrowserContext(): Promise<AshbySession | null> {
  // First, try to load from the saved session file (created when browser was closed)
  try {
    const content = await fs.readFile(SESSION_FILE, 'utf8');
    const session = JSON.parse(content) as AshbySession;
    // Check if it has valid auth cookies
    if (session.cookies && (session.cookies['ashby_session_token'] || session.cookies['authenticated'])) {
      return session;
    }
  } catch {
    // Session file doesn't exist or is invalid, continue to try browser context
  }

  const userDataDir = path.join(process.cwd(), '.playwright-browser-data');
  
  // Check if browser context exists
  try {
    await fs.access(userDataDir);
  } catch {
    return null; // Browser context doesn't exist
  }

  // Try to load the persistent browser context (headless cookie reader)
  // If it's locked (browser still open), we'll catch the error and use session file.
  // Match the browser used by bootstrapSession() — Playwright's bundled
  // Chromium — so the cookie jar Playwright reads is the one it wrote.
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      args: ['--disable-blink-features=AutomationControlled']
    });
  } catch (error: any) {
    // Browser profile is locked (browser still open from auth command)
    // Fall back to session file if it exists
    console.log('Browser profile is in use (browser window still open). Using saved session file...');
    try {
      const content = await fs.readFile(SESSION_FILE, 'utf8');
      const session = JSON.parse(content) as AshbySession;
      if (session.cookies && (session.cookies['ashby_session_token'] || session.cookies['authenticated'])) {
        return session;
      }
    } catch {
      // No session file either
    }
    // If we can't get cookies, return null - user needs to close browser and re-run auth
    return null;
  }

  try {
    const cookies = await context.cookies();
    const cookieMap: Record<string, string> = {};
    for (const c of cookies) {
      if (c.name && c.value) {
        cookieMap[c.name] = c.value;
      }
    }

    // Check if we have auth cookies
    if (!cookieMap['ashby_session_token'] && !cookieMap['authenticated']) {
      await context.close();
      return null;
    }

    const session: AshbySession = {
      cookies: cookieMap,
      csrfToken: cookieMap['csrf'], // Will be fetched fresh when needed
      orgIds: []
    };

    await context.close();
    return session;
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function createSessionFromCookieHeader(cookieHeader: string): Promise<AshbySession> {
  const cookieMap: Record<string, string> = {};

  cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const eqIndex = pair.indexOf('=');
      if (eqIndex === -1) return;
      const name = pair.slice(0, eqIndex).trim();
      const value = pair.slice(eqIndex + 1).trim();
      if (name && value) {
        cookieMap[name] = value;
      }
    });

  const ashbySession: AshbySession = {
    cookies: cookieMap,
    csrfToken: cookieMap['csrf'],
    orgIds: []
  };

  await fs.writeFile(SESSION_FILE, JSON.stringify(ashbySession, null, 2), 'utf8');
  console.log(`Saved Ashby session to ${SESSION_FILE} from pasted cookies`);
  return ashbySession;
}

export async function bootstrapSession(): Promise<AshbySession> {
  // Use a persistent context with realistic settings to avoid Google's "not secure" detection
  const userDataDir = path.join(process.cwd(), '.playwright-browser-data');
  
  // Check if profile is locked (another instance running)
  const lockFile = path.join(userDataDir, 'SingletonLock');
  try {
    await fs.access(lockFile);
    console.error('\n❌ Browser profile is already in use.');
    console.error('Please close any Chrome windows that might be using this profile, then try again.');
    console.error('Or wait a few seconds and try again.\n');
    throw new Error('Browser profile locked - another Chrome instance is running');
  } catch (error: any) {
    // If file doesn't exist, that's fine - proceed
    if (error.code !== 'ENOENT' && !error.message.includes('locked')) {
      throw error;
    }
  }
  
  // Use Playwright's bundled Chromium (NOT the system Chrome channel). On
  // macOS, launching /Applications/Google Chrome.app via channel:'chrome'
  // collides with any Chrome window the user already has open — the second
  // launch gets swallowed by the existing Chrome.app process and no SSO
  // window appears. Chromium has its own app bundle / dock entry, so it
  // can't collide; the window is unambiguously visible.
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox'
    ],
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  
  const page = await context.pages()[0] || await context.newPage();

  console.log('Opening Ashby login. Complete SSO/MFA in the browser window...');
  await page.goto('https://app.ashbyhq.com', { waitUntil: 'networkidle' });

  console.log(
    '\n📋 Instructions:\n' +
    '  1. Log in with dkimball@candidatelabs.com\n' +
    '  2. Navigate to the Ashby dashboard (make sure you\'re fully logged in)\n' +
    '  3. IMPORTANT: Close the browser window when done\n' +
    '     (This saves your session so you can run "extract")\n'
  );

  const session = await new Promise<AshbySession>((resolve, reject) => {
    let resolved = false;

    const cleanup = async () => {
      if (resolved) return;
      resolved = true;
      try {
        const saved = await saveSessionFromContext(context);
        console.log('\n✅ Session saved successfully!');
        console.log('   You can now run: npm run start -- extract --json output.json --csv output.csv');
        console.log('   (Token rotations are persisted automatically — the session lasts until Ashby\'s ~7-day login expiry)\n');
        resolve(saved);
      } catch (err) {
        reject(err);
      }
    };

    context.on('close', cleanup);

    // Handle Ctrl+C
    const sigintHandler = async () => {
      await cleanup();
      await context.close();
      process.exit(0);
    };
    process.on('SIGINT', sigintHandler);
  });

  return session;
}
