#!/usr/bin/env node
import { Command } from 'commander';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { bootstrapSession, createSessionFromCookieHeader } from './session.js';
import { runRecon } from './recon.js';
import { exportCSV, exportJSON } from './export.js';
import { Company, Job, Candidate } from './types.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const program = new Command();

program
  .name('ashby-automation')
  .description('Read-only Ashby candidate pipeline aggregator')
  .version('0.1.0');

program
  .command('auth')
  .description('Bootstrap an authenticated Ashby browser session (manual SSO/MFA)')
  .action(async () => {
    try {
      await bootstrapSession();
      console.log('Auth bootstrap complete. Session saved to .ashby-session.json');
    } catch (error: any) {
      console.error('Error during auth:', error?.message || error);
      if (error?.stack) {
        console.error(error.stack);
      }
      process.exitCode = 1;
    }
  });

program
  .command('auth-cookie')
  .description('Create an Ashby session from an existing browser cookie header (no Playwright login)')
  .option('--cookie <cookie>', 'Cookie string (if not provided, will prompt)')
  .action(async (opts) => {
    try {
      let cookieHeader: string;
      
      if (opts.cookie) {
        cookieHeader = opts.cookie;
      } else {
        // Try to use readline, but fall back to a simpler method if it fails
        try {
          const rl = readline.createInterface({ input, output });
          cookieHeader = await rl.question(
            'Paste the cookie header or document.cookie string from an authenticated app.ashbyhq.com tab:\n> '
          );
          await rl.close();
        } catch (readlineError) {
          // Fallback: read from stdin
          console.log('Paste the cookie header and press Enter (or Ctrl+D to finish):');
          const chunks: string[] = [];
          for await (const chunk of input) {
            chunks.push(chunk);
          }
          cookieHeader = chunks.join('');
        }
      }

      if (!cookieHeader || !cookieHeader.trim()) {
        console.error('No cookie string provided. Aborting.');
        console.error('Usage: npm run start -- auth-cookie --cookie "cookie_string_here"');
        process.exitCode = 1;
        return;
      }

      await createSessionFromCookieHeader(cookieHeader.trim());
      console.log('Auth via pasted cookies complete. You can now run "recon" and "extract".');
    } catch (error: any) {
      console.error('Error in auth-cookie command:', error?.message || error);
      if (error?.stack) {
        console.error(error.stack);
      }
      process.exitCode = 1;
    }
  });

program
  .command('recon')
  .description('Open Ashby and capture internal API traffic while you navigate the pipeline UI')
  .action(async () => {
    await runRecon();
  });

program
  .command('extract')
  .description('Replay known Ashby pipeline endpoints and output normalized data as JSON/CSV')
  .option('--json <file>', 'JSON output file (default: timestamped)')
  .option('--csv <file>', 'CSV output file (default: timestamped)')
  .option('--max-orgs <number>', 'Limit number of orgs to process (for testing)', parseInt)
  .option('--retries <number>', 'Number of retries per org on failure', parseInt)
  .option('--detailed', 'Fetch detailed interview feedback and ratings for each candidate (slower)', true)
  .option('--no-detailed', 'Skip fetching detailed interview data (faster but missing stage progression)')
  .option('--detailed-concurrent <number>', 'Number of concurrent detail fetches', parseInt)
  .option('--org <name>', 'Filter to organizations matching this name (case-insensitive)')
  .action(async (opts) => {
    // Generate timestamped filenames if not specified
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD

    const jsonFile = opts.json || `output/ashby_pipeline_${dateStr}.json`;
    const csvFile = opts.csv || `output/ashby_pipeline_${dateStr}.csv`;

    // Use direct API approach (faster, uses cookies from session file)
    const { extractCommand } = await import('./api-extract.js');
    await extractCommand({
      json: jsonFile,
      csv: csvFile,
      maxOrgs: opts.maxOrgs,
      retries: opts.retries,
      detailed: opts.detailed !== false, // Default to true, unless --no-detailed is used
      detailedConcurrent: opts.detailedConcurrent || 5,
      orgFilter: opts.org
    });
  });

program.parseAsync(process.argv);

