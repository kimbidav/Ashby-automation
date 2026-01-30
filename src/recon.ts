import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadSession } from './session.js';
import { AshbySession } from './types.js';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  responseStatus?: number;
  responseBodySnippet?: string;
}

const RECON_FILE = path.join(process.cwd(), 'ashby-recon-log.json');

async function applySessionToContext(session: AshbySession, context: import('playwright').BrowserContext) {
  const cookies = Object.entries(session.cookies).map(([name, value]) => ({
    name,
    value,
    domain: '.ashbyhq.com',
    path: '/',
    httpOnly: true,
    secure: true
  }));
  if (cookies.length) {
    await context.addCookies(cookies);
  }
}

export async function runRecon(): Promise<void> {
  const session = await loadSession();

  // Use a persistent context with realistic settings to avoid detection
  const userDataDir = path.join(process.cwd(), '.playwright-browser-data');
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
  
  await applySessionToContext(session, context);
  const page = await context.pages()[0] || await context.newPage();

  const captured: CapturedRequest[] = [];

  // Capture requests from all pages in the context
  context.on('page', (newPage) => {
    setupPageListeners(newPage);
  });

  function setupPageListeners(p: import('playwright').Page) {
    p.on('request', (req) => {
      const url = req.url();
      // Capture all requests, but prioritize API-like URLs
      const isApiLike = url.includes('/api/') || url.includes('graphql') || url.includes('query') || 
                        req.method() === 'POST' || url.includes('candidate') || url.includes('pipeline');
      
      if (isApiLike || url.includes('ashby')) {
        const entry: CapturedRequest = {
          url,
          method: req.method(),
          headers: req.headers(),
          postData: req.postData() ?? undefined
        };
        captured.push(entry);
        console.log(`[CAPTURED] ${req.method()} ${url}`);
      }
    });

    p.on('response', async (res) => {
      const url = res.url();
      const isApiLike = url.includes('/api/') || url.includes('graphql') || url.includes('query') || 
                        res.request().method() === 'POST' || url.includes('candidate') || url.includes('pipeline');
      
      if (isApiLike || url.includes('ashby')) {
        const match = captured.find((r) => r.url === url && r.responseStatus === undefined);
        if (match) {
          match.responseStatus = res.status();
          try {
            const text = await res.text();
            match.responseBodySnippet = text.slice(0, 2000); // Increased snippet size
            console.log(`[RESPONSE] ${res.status()} ${url} (${text.length} bytes)`);
          } catch {
            // ignore non-text responses
          }
        }
      }
    });
  }

  // Setup listeners for the initial page
  setupPageListeners(page);

  console.log('Opening Ashby with your saved session.');
  console.log('IMPORTANT: Navigate to Candidates → Pipeline → Active and expand roles to capture API traffic.');
  console.log('Watch the terminal for [CAPTURED] and [RESPONSE] messages as you interact.');
  await page.goto('https://app.ashbyhq.com', { waitUntil: 'networkidle' });

  console.log('\n✅ Browser ready. Now:');
  console.log('   1. Click "Candidates" in the left sidebar');
  console.log('   2. Click "Pipeline"');
  console.log('   3. Click "Active"');
  console.log('   4. Expand some roles to see candidates');
  console.log('   5. When done, close the browser window to finish recon.\n');

  await new Promise<void>((resolve, reject) => {
    context.on('close', async () => {
      try {
        await fs.writeFile(RECON_FILE, JSON.stringify(captured, null, 2), 'utf8');
        console.log(`Saved recon log to ${RECON_FILE}`);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

