/**
 * api-server-extract.ts -- Extraction logic adapted for the API server.
 *
 * Unlike the CLI version, this:
 *   - Accepts session objects directly (no file I/O)
 *   - Returns data in-memory instead of writing CSV/JSON files
 *   - Returns candidates in the same snake_case format the Lovable frontend expects
 */
import { AshbySession, Candidate, Company, InterviewEvent, Job } from './types.js';
import { fetchAllAvailableOrgs, fetchPipelineForOrg, fetchAvailableOrgs, enrichCandidatesWithDetails } from './client.js';

export interface ExtractedInterviewEvent {
  id: string;
  interview_title: string;
  start_time: string;
  end_time: string;
  interview_stage_id?: string | null;
  interview_stage_title?: string | null;
  interviewers: Array<{
    name: string;
    email: string;
    score: string | null;
    feedback_submitted: boolean;
    feedback_text: string | null;
  }>;
}

export interface ExtractedCandidate {
  company_name: string;
  job_title: string;
  job_id: string;
  candidate_name: string;
  candidate_id: string;
  application_id: string;
  org_id: string;
  pipeline_stage: string;
  decision_status: string;
  stage_type: string;
  current_stage_index: number | null;
  total_stages: number | null;
  stage_progress: string;
  last_activity_at: string;
  days_in_stage: number;
  needs_scheduling: boolean;
  credited_to: string;
  source: string;
  feedback_count: number;
  latest_recommendation: string;
  latest_feedback_author: string;
  latest_feedback_date: string;
  interview_events: ExtractedInterviewEvent[];
  current_stage_interviews: string;
  current_stage_avg_score: number | null;
  current_stage_date: string;
  interview_history_summary: string;
}

export interface ExtractResult {
  companies: Company[];
  jobs: Job[];
  candidates: ExtractedCandidate[];
  // Names of the Ashby orgs that were actually swept this run (the real client
  // orgs — NOT candidate employers). This is the authoritative "which companies
  // run Ashby" list for the dashboard and the trusted set for archival
  // inference. `companies` above is derived from each candidate's employer
  // (app.candidate.company) and must NOT be used for org-level detection.
  orgs: string[];
}

function eventKey(event: InterviewEvent): string {
  return `${event.id}|${event.startTime}|${event.interviewTitle}`;
}

function getCurrentStageEvents(candidate: Candidate, sortedEvents: InterviewEvent[]): InterviewEvent[] {
  const currentStageId = candidate.currentStageId || null;
  const currentStageTitle = (candidate.pipelineStage || '').trim().toLowerCase();

  const byStageId = currentStageId
    ? sortedEvents.filter((event) => event.interviewStageId === currentStageId)
    : [];
  if (byStageId.length > 0) return byStageId;

  const byStageTitle = currentStageTitle
    ? sortedEvents.filter((event) => (event.interviewStageTitle || '').trim().toLowerCase() === currentStageTitle)
    : [];
  if (byStageTitle.length > 0) return byStageTitle;

  const now = Date.now();
  const futureEvents = sortedEvents.filter((event) => new Date(event.startTime).getTime() >= now);
  const status = (candidate.decisionStatus || '').toLowerCase();
  if (futureEvents.length > 0 && /scheduled|availability|booking/.test(status)) {
    return futureEvents;
  }

  const mostRecent = sortedEvents[0];
  if (!mostRecent) return [];
  const mostRecentDate = new Date(mostRecent.startTime);
  return sortedEvents.filter((event) => {
    const daysDiff = (mostRecentDate.getTime() - new Date(event.startTime).getTime()) / (24 * 60 * 60 * 1000);
    return daysDiff <= 1;
  });
}

function splitCurrentAndPreviousInterviews(candidate: Candidate): {
  currentInterviews: InterviewEvent[];
  previousInterviews: InterviewEvent[];
} {
  const sortedEvents = [...(candidate.interviewEvents || [])].sort((a, b) =>
    new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
  );
  const currentInterviews = getCurrentStageEvents(candidate, sortedEvents);
  const currentKeys = new Set(currentInterviews.map(eventKey));
  return {
    currentInterviews: [...currentInterviews].sort((a, b) =>
      new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    ),
    previousInterviews: sortedEvents.filter((event) => !currentKeys.has(eventKey(event))),
  };
}

/**
 * Create an AshbySession from a raw cookie string (no file I/O).
 */
export function createSessionFromCookie(cookieHeader: string): AshbySession {
  const cookieMap: Record<string, string> = {};

  // If the user pasted just the raw token value (no "=" sign), treat it as the session token
  if (!cookieHeader.includes('=')) {
    cookieMap['ashby_session_token'] = cookieHeader;
  } else {
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
  }

  return {
    cookies: cookieMap,
    csrfToken: cookieMap['csrf'],
    orgIds: [],
  };
}

/**
 * Run the full extraction pipeline and return structured data.
 */
export type ProgressCallback = (completed: number, total: number, currentOrg: string) => void;

// ── Per-org result cache (persists across requests in Railway's process) ──

interface OrgCacheEntry {
  orgId: string;
  timestamp: number;
  companies: Company[];
  jobs: Job[];
  candidates: Candidate[];
}

const orgCache = new Map<string, OrgCacheEntry>();
const ORG_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes per org

// Total wall-clock budget for one extraction run. Callers waiting on the
// extract (the dashboard backend's ASHBY_REFRESH_TIMEOUT_SEC, default 300s)
// must allow at least this much plus ~60s of flatten/restore/network slack.
const EXTRACT_BUDGET_MS = parseInt(process.env.ASHBY_EXTRACT_BUDGET_SEC || '240', 10) * 1000;

// Guaranteed floor for the targeted enrichment pass. The org sweep itself is
// unbounded (it takes as long as Ashby takes), so on a slow day it can eat
// the whole EXTRACT_BUDGET_MS and enrichment would never run no matter how
// often the user re-fetches. The floor ensures enrichment always gets at
// least this much time. Set to 0 to restore the old leftovers-only behavior.
const ENRICH_MIN_BUDGET_MS = parseInt(process.env.ASHBY_ENRICH_MIN_BUDGET_SEC || '180', 10) * 1000;

export function getOrgCacheStats() {
  let cachedOrgs = 0;
  let cachedCandidates = 0;
  const cutoff = Date.now() - ORG_CACHE_TTL_MS;
  for (const [, entry] of orgCache) {
    if (entry.timestamp > cutoff) {
      cachedOrgs++;
      cachedCandidates += entry.candidates.length;
    }
  }
  return { cachedOrgs, cachedCandidates, totalCached: orgCache.size };
}

export function clearOrgCache() {
  orgCache.clear();
}

export async function extractPipeline(
  session: AshbySession,
  onProgress?: ProgressCallback,
): Promise<ExtractResult & { extraction_stats: Record<string, unknown> }> {
  const startTime = Date.now();

  // Discover orgs
  const orgInfos = await fetchAllAvailableOrgs(session);
  if (orgInfos.length === 0) {
    throw new Error('No organizations found. Check your session cookie.');
  }

  const orgsWithUserId = orgInfos.filter(o => o.userId);
  // Remember the first org so we can restore context after extraction.
  // change_user modifies USER-LEVEL state (not per-session), so without
  // restoration the user's browser ends up in the last org we visited.
  const firstOrg = orgsWithUserId[0];
  console.log(`Found ${orgInfos.length} org(s) (${orgsWithUserId.length} with userId). Will restore to ${firstOrg?.name || '?'} after extraction.`);
  onProgress?.(0, orgsWithUserId.length, 'Starting extraction...');

  const allCompanies: Company[] = [];
  const allJobs: Job[] = [];
  let allCandidates: Candidate[] = [];
  let orgsFetched = 0;
  // Real client-org names that were successfully swept (includes orgs with zero
  // candidates this run — the "Rilla case"). This, not `allCompanies` (employer
  // names), is the authoritative Ashby-client list returned as `orgs`.
  const sweptOrgNames = new Set<string>();
  const failedOrgs: typeof orgsWithUserId = [];
  let authDead = false;

  // ── Pass 1: fetch all orgs ─────────────────────────────────────────────
  for (let i = 0; i < orgsWithUserId.length; i++) {
    const orgInfo = orgsWithUserId[i];

    if (i % 20 === 0 || i === orgsWithUserId.length - 1) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`  Progress: ${i}/${orgsWithUserId.length} orgs, ${allCandidates.length} candidates, ${elapsed}s`);
    }
    onProgress?.(i, orgsWithUserId.length, orgInfo.name);

    try {
      const { companies, jobs, candidates } = await fetchPipelineForOrg(
        session,
        orgInfo.id,
        orgInfo.userId
      );
      allCompanies.push(...companies);
      allJobs.push(...jobs);
      allCandidates.push(...candidates);
      if (orgInfo.name?.trim()) sweptOrgNames.add(orgInfo.name.trim());
      orgsFetched++;
    } catch (err: any) {
      const msg = err?.message?.substring(0, 150) || '';
      console.error(`  [${orgInfo.name}] Failed: ${msg}`);
      if (msg.includes('401') || msg.includes('expired')) {
        authDead = true;
        if (allCandidates.length > 0) {
          console.log(`⚠️  Cookie expired after ${orgsFetched} orgs — returning ${allCandidates.length} candidates collected`);
          break;
        }
        throw err;
      }
      failedOrgs.push(orgInfo);
    }
  }

  // ── Pass 2 & 3: retry failed orgs up to 2 more times ────────────────
  let stillFailed = [...failedOrgs];
  const MAX_RETRIES = 2;
  for (let retry = 1; retry <= MAX_RETRIES && stillFailed.length > 0 && !authDead; retry++) {
    console.log(`\nRetry pass ${retry}/${MAX_RETRIES}: ${stillFailed.length} org(s)...`);
    const nextFailed: typeof orgsWithUserId = [];
    for (const orgInfo of stillFailed) {
      onProgress?.(orgsWithUserId.length, orgsWithUserId.length, `Retry ${retry}: ${orgInfo.name}`);
      try {
        const { companies, jobs, candidates } = await fetchPipelineForOrg(
          session,
          orgInfo.id,
          orgInfo.userId
        );
        allCompanies.push(...companies);
        allJobs.push(...jobs);
        allCandidates.push(...candidates);
        if (orgInfo.name?.trim()) sweptOrgNames.add(orgInfo.name.trim());
        orgsFetched++;
        console.log(`  ✓ Retry ${retry} succeeded for ${orgInfo.name}: ${candidates.length} candidates`);
      } catch (err: any) {
        console.error(`  ✗ Retry ${retry} failed for ${orgInfo.name}: ${err?.message?.substring(0, 100)}`);
        nextFailed.push(orgInfo);
      }
    }
    stillFailed = nextFailed;
  }

  // ── Pass 4: targeted per-application enrichment ───────────────────────
  // The bulk applicationsByPrebuiltView query returns interview_events
  // inline, but the field is sometimes incomplete for newly-moved-stage
  // candidates: decision_status updates to "Scheduled" before the new
  // stage's InterviewEvent records materialize in the bulk view. Re-fetch
  // detailed application data for those candidates so the snapshot reflects
  // what's actually on Ashby's calendar (interviewer, time, scorecard).
  //
  // Bounded by a deadline so a slow/rate-limited Ashby session can't blow
  // the frontend's 4-minute extract timeout. On deadline we return whatever
  // got enriched; the remaining candidates keep their bulk data.
  if (!authDead && allCandidates.length > 0) {
    const elapsedSoFar = Date.now() - startTime;
    // Leave at least 90s for the rest of the pipeline (restore + flatten +
    // network return) out of the overall budget — but never give enrichment
    // less than its guaranteed floor, even when a slow sweep already blew
    // the budget. Below 60s (only possible when the floor is configured
    // down) we skip rather than risk timing out.
    const budgetForEnrich = Math.max(
      EXTRACT_BUDGET_MS - elapsedSoFar - 90_000,
      ENRICH_MIN_BUDGET_MS,
    );
    if (budgetForEnrich >= 60_000) {
      const SUSPECT_STATUS = new Set([
        'scheduled',
        'waiting on feedback',
        'waiting on availability',
        'waiting on submission',
        'booking link sent',
        'needs scheduling',
      ]);
      const shouldEnrich = (c: Candidate): boolean => {
        const status = (c.decisionStatus || '').trim().toLowerCase();
        if (SUSPECT_STATUS.has(status)) return true;
        // Catch records where bulk fetch returned zero events but the
        // candidate looks active — likely missing data.
        if (c.stageType && !(c.interviewEvents && c.interviewEvents.length)) {
          return true;
        }
        return c.needsScheduling === true;
      };
      try {
        onProgress?.(orgsWithUserId.length, orgsWithUserId.length, 'Enriching scheduled candidates...');
        // Concurrency is only safe in live mode, where the browser context's
        // cookie jar absorbs token rotation server-side. In legacy cookie
        // mode, N in-flight requests share one rotating token: the first
        // response invalidates it, the rest 401, and Ashby revokes the whole
        // session chain. Sequential keeps exactly one token in flight.
        const enrichConcurrency = session.requestContext ? 5 : 1;
        allCandidates = await enrichCandidatesWithDetails(
          session,
          allCandidates,
          orgsWithUserId,
          { maxConcurrent: enrichConcurrency, shouldEnrich, deadlineMs: budgetForEnrich },
        );
      } catch (err: any) {
        console.warn(`⚠️  Enrichment pass failed (non-fatal): ${err?.message?.substring(0, 150)}`);
      }
    } else {
      console.log(`Skipping enrichment pass (only ${Math.round(budgetForEnrich / 1000)}s of budget left)`);
    }
  }

  // Restore the user's org context to the first org so their browser
  // session isn't left stranded in some random client's org.
  if (firstOrg?.userId) {
    try {
      onProgress?.(orgsWithUserId.length, orgsWithUserId.length, `Restoring context to ${firstOrg.name}...`);
      await fetchPipelineForOrg(session, firstOrg.id, firstOrg.userId);
      console.log(`✓ Restored org context to ${firstOrg.name}`);
    } catch (err: any) {
      console.warn(`⚠️  Could not restore org context: ${err?.message?.substring(0, 100)}`);
    }
  }

  const totalElapsed = Math.round((Date.now() - startTime) / 1000);
  onProgress?.(orgsWithUserId.length, orgsWithUserId.length, 'Finalizing...');
  console.log(`Extraction complete in ${totalElapsed}s: ${allCandidates.length} candidates from ${orgsFetched}/${orgsWithUserId.length} orgs`);

  if (allCandidates.length === 0) {
    throw new Error('No candidates extracted. Session may be expired.');
  }

  // Convert to the flat snake_case format the frontend expects
  const companyById = new Map(allCompanies.map((c) => [c.id, c]));
  const jobById = new Map(allJobs.map((j) => [j.id, j]));

  const flatCandidates: ExtractedCandidate[] = allCandidates.map((cand) => {
    const company = companyById.get(cand.companyId);
    const job = jobById.get(cand.jobId);

    // Compute interview summary strings (same logic as export.ts CSV)
    let currentStageInterviews = '';
    let currentStageAvgScore: number | null = null;
    let currentStageDate = '';
    let interviewHistorySummary = '';

    if (cand.interviewEvents && cand.interviewEvents.length > 0) {
      const { currentInterviews, previousInterviews } = splitCurrentAndPreviousInterviews(cand);

      if (currentInterviews.length > 0) {
        const parts = currentInterviews.map(event => {
          const d = new Date(event.startTime);
          const dateStr = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
          return event.interviewers.map(interviewer => {
            const score = interviewer.overallRecommendation
              ? `Score: ${interviewer.overallRecommendation}`
              : 'No score yet';
            let feedbackSnippet = '';
            if (cand.allFeedback && cand.allFeedback.length > 0) {
              const match = cand.allFeedback.find(
                fb => fb.interviewTitle === event.interviewTitle && fb.interviewer === interviewer.name
              );
              if (match?.feedbackText) {
                feedbackSnippet = ` (${match.feedbackText})`;
              }
            }
            return `• ${event.interviewTitle} (${dateStr}) - ${interviewer.name} - ${score}${feedbackSnippet}`;
          }).join('\n');
        });
        currentStageInterviews = parts.join('\n');

        const scores = currentInterviews.flatMap(e =>
          e.interviewers
            .filter(i => i.overallRecommendation)
            .map(i => parseFloat(String(i.overallRecommendation)))
        );
        if (scores.length > 0) {
          currentStageAvgScore = parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1));
        }
        const firstCurrentEvent = [...currentInterviews].sort((a, b) =>
          new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
        )[0];
        currentStageDate = new Date(firstCurrentEvent.startTime).toISOString().split('T')[0];
      }

      if (previousInterviews.length > 0) {
        interviewHistorySummary = previousInterviews.flatMap(event => {
          const d = new Date(event.startTime);
          const dateStr = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
          return event.interviewers.map(interviewer => {
            const score = interviewer.overallRecommendation
              ? `Score: ${interviewer.overallRecommendation}`
              : 'No score';
            let feedbackSnippet = '';
            if (cand.allFeedback && cand.allFeedback.length > 0) {
              const match = cand.allFeedback.find(
                fb => fb.interviewTitle === event.interviewTitle && fb.interviewer === interviewer.name
              );
              if (match?.feedbackText) {
                feedbackSnippet = `: ${match.feedbackText}`;
              }
            }
            return `${event.interviewTitle} (${dateStr}) - ${interviewer.name} - ${score}${feedbackSnippet}`;
          });
        }).join(' | ');
      }
    }

    return {
      company_name: cand.orgName || company?.name || '',
      job_title: job?.title ?? '',
      job_id: cand.jobId,
      candidate_name: cand.name,
      candidate_id: cand.id,
      // Identity for targeted lookups after the candidate leaves the active
      // pipeline (archived/hired verification needs the application + org).
      application_id: cand.applicationId ?? '',
      org_id: cand.orgId ?? '',
      pipeline_stage: cand.pipelineStage ?? '',
      decision_status: cand.decisionStatus ?? '',
      stage_type: cand.stageType ?? '',
      current_stage_index: cand.currentStageIndex,
      total_stages: cand.totalStages,
      stage_progress: cand.stageProgress ?? '',
      last_activity_at: cand.lastActivityAt,
      days_in_stage: cand.daysInStage,
      needs_scheduling: cand.needsScheduling,
      credited_to: cand.creditedTo ?? '',
      source: cand.source ?? '',
      feedback_count: cand.feedbackCount ?? 0,
      latest_recommendation: cand.latestOverallRecommendation ?? '',
      latest_feedback_author: cand.latestFeedbackAuthor ?? '',
      latest_feedback_date: cand.latestFeedbackDate ?? '',
      interview_events: (cand.interviewEvents || []).map((ev) => {
        // Find matching feedback for each interviewer
        const feedbackByInterviewer = new Map(
          (cand.allFeedback || []).map(fb => [`${fb.interviewTitle}:${fb.interviewer}`, fb])
        );
        return {
          id: ev.id,
          interview_title: ev.interviewTitle,
          start_time: ev.startTime,
          end_time: ev.endTime,
          interview_stage_id: ev.interviewStageId || null,
          interview_stage_title: ev.interviewStageTitle || null,
          interviewers: ev.interviewers.map(i => ({
            name: i.name,
            email: i.email,
            score: i.overallRecommendation ? String(i.overallRecommendation) : null,
            feedback_submitted: i.isFeedbackSubmitted,
            feedback_text: feedbackByInterviewer.get(`${ev.interviewTitle}:${i.name}`)?.feedbackText || null,
          })),
        };
      }),
      current_stage_interviews: currentStageInterviews,
      current_stage_avg_score: currentStageAvgScore,
      current_stage_date: currentStageDate,
      interview_history_summary: interviewHistorySummary,
    };
  });

  return {
    companies: allCompanies,
    jobs: allJobs,
    candidates: flatCandidates,
    orgs: Array.from(sweptOrgNames),
    extraction_stats: {
      orgs_total: orgsWithUserId.length,
      orgs_fetched: orgsFetched,
      orgs_failed: stillFailed.length,
      orgs_retried: failedOrgs.length,
      failed_org_names: stillFailed.map(o => o.name),
      total_seconds: totalElapsed,
      complete: stillFailed.length === 0,
    },
  };
}
