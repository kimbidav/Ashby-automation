/**
 * api-extract.ts — Orchestration for the `extract` CLI command.
 *
 * extractCommand() runs the full pipeline:
 *   1. Load session from .ashby-session.json
 *   2. Discover all accessible organizations (fetchAllAvailableOrgs)
 *   3. For each org: switch context and fetch jobs + candidates with inline enrichment
 *   4. Export to timestamped CSV and JSON in output/
 *
 * Interview events, scorecard feedback, and stage progress are fetched inline
 * during the initial query — no separate enrichment phase.
 *
 * ExtractOptions:
 *   maxOrgs   — Limit orgs processed (useful for testing, e.g. --max-orgs 2)
 *   retries   — Retry count per org on failure
 *   orgFilter — Case-insensitive name filter to run on a single org
 */
import { loadSession } from './session.js';
import { fetchAllAvailableOrgs, fetchPipelineForOrg } from './client.js';
import { exportJSON, exportCSV } from './export.js';
import { Company, Job, Candidate } from './types.js';

export interface ExtractOptions {
  csv?: string;
  json?: string;
  maxOrgs?: number;
  retries?: number;
  detailed?: boolean;
  detailedConcurrent?: number;
  orgFilter?: string;
}

/**
 * Extract using direct API calls (faster than browser automation)
 * Uses cookies from session file
 */
export async function extractCommand(options: ExtractOptions): Promise<void> {
  console.log('Loading session...');
  const session = await loadSession();
  
  if (!session) {
    console.error('\n❌ No session found. Please run "npm run start -- auth" first.');
    console.error('   This will save your authentication cookies.\n');
    process.exitCode = 1;
    return;
  }

  // Check if we have auth cookies
  if (!session.cookies['ashby_session_token'] && !session.cookies['authenticated']) {
    console.error('\n❌ Session missing authentication cookies.');
    console.error('   Please run "npm run start -- auth" to refresh your session.\n');
    process.exitCode = 1;
    return;
  }

  console.log('✓ Session loaded\n');

  // Discover all available organizations
  console.log('Discovering accessible organizations...');
  let orgInfos;
  try {
    orgInfos = await fetchAllAvailableOrgs(session);
    console.log(`Found ${orgInfos.length} accessible organization(s)\n`);
  } catch (error: any) {
    console.error(`Failed to discover orgs: ${error?.message || error}`);
    process.exitCode = 1;
    return;
  }

  if (orgInfos.length === 0) {
    console.error('No organizations found. Check your session.\n');
    process.exitCode = 1;
    return;
  }

  let orgsToProcess = orgInfos;

  // Filter by org name if specified
  if (options.orgFilter) {
    const filterLower = options.orgFilter.toLowerCase();
    orgsToProcess = orgsToProcess.filter(org =>
      org.name.toLowerCase().includes(filterLower)
    );
    console.log(`🔍 Filtered to orgs matching "${options.orgFilter}": ${orgsToProcess.length} found\n`);

    if (orgsToProcess.length === 0) {
      console.error(`❌ No organizations found matching "${options.orgFilter}"`);
      console.error('Available organizations:');
      orgInfos.forEach(org => console.error(`  - ${org.name}`));
      process.exitCode = 1;
      return;
    }
  }

  // Apply max orgs limit if specified
  if (options.maxOrgs) {
    orgsToProcess = orgsToProcess.slice(0, options.maxOrgs);
    console.log(`⚠️  Testing mode: Processing only ${orgsToProcess.length} orgs\n`);
  }

  const allCompanies: Company[] = [];
  const allJobs: Job[] = [];
  let allCandidates: Candidate[] = [];
  const failedOrgs: string[] = [];

  console.log(`Processing ${orgsToProcess.length} organization(s)...\n`);

  for (let i = 0; i < orgsToProcess.length; i++) {
    const orgInfo = orgsToProcess[i];
    const orgId = orgInfo.id;
    const orgDisplayName = orgInfo.name || orgId;
    console.log(`[${i + 1}/${orgsToProcess.length}] Processing org: ${orgDisplayName} (${orgId})`);
    
    if (!orgInfo.userId) {
      console.log('  ⚠️  Skipping - no userId for org switching');
      failedOrgs.push(`${orgDisplayName} - no userId`);
      continue;
    }

    let success = false;
    const maxRetries = options.retries || 1;
    
    for (let attempt = 1; attempt <= maxRetries && !success; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`  Retry attempt ${attempt}/${maxRetries}...`);
        }

        const { companies, jobs, candidates } = await fetchPipelineForOrg(
          session,
          orgId,
          orgInfo.userId
        );
        
        allCompanies.push(...companies);
        allJobs.push(...jobs);
        allCandidates.push(...candidates);
        
        console.log(`  ✓ Found ${companies.length} companies, ${jobs.length} jobs, ${candidates.length} candidates\n`);
        success = true;
        
      } catch (error: any) {
        const errorMsg = error?.message || String(error);
        if (attempt === maxRetries) {
          console.error(`  ✗ Failed after ${maxRetries} attempt(s):`, errorMsg.substring(0, 150));
          failedOrgs.push(orgDisplayName);
        } else {
          console.warn(`  ⚠️  Attempt ${attempt} failed:`, errorMsg.substring(0, 100));
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(`Total candidates extracted: ${allCandidates.length}`);
  console.log(`Successful orgs: ${orgsToProcess.length - failedOrgs.length}/${orgsToProcess.length}`);
  
  if (failedOrgs.length > 0) {
    console.log(`\nFailed orgs (${failedOrgs.length}):`);
    failedOrgs.forEach(org => console.log(`  - ${org}`));
  }

  if (allCandidates.length === 0) {
    console.error('\n⚠️  No candidates were extracted from any organization.');
    console.error('\nPossible reasons:');
    console.error('  1. All orgs failed to process (check errors above)');
    console.error('  2. No active candidates in any of your organizations');
    console.error('  3. Session expired - try running "npm run start -- auth" again\n');
    process.exitCode = 1;
    return;
  }

  console.log(`\n✅ Successfully extracted data:`);
  console.log(`   - ${allCompanies.length} companies`);
  console.log(`   - ${allJobs.length} jobs`);
  console.log(`   - ${allCandidates.length} candidates\n`);

  // Export
  if (options.json) {
    await exportJSON(
      { companies: allCompanies, jobs: allJobs, candidates: allCandidates },
      options.json
    );
    console.log(`✓ Exported to JSON: ${options.json}`);
  }
  
  if (options.csv) {
    await exportCSV(
      { companies: allCompanies, jobs: allJobs, candidates: allCandidates },
      options.csv
    );
    console.log(`✓ Exported to CSV: ${options.csv}`);
  }
  
  console.log('');
}
