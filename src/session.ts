import { chromium, BrowserContext } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AshbySession } from './types.js';

const SESSION_FILE = path.join(process.cwd(), '.ashby-session.json');

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

  // Try to load the persistent browser context
  // If it's locked (browser still open), we'll catch the error and use session file
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true, // Headless is fine, we just need cookies
      channel: 'chrome',
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
  
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome', // Use system Chrome if available, otherwise Chromium
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
        console.log('   (Run it soon - cookies expire after ~30-60 minutes)\n');
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
