/**
 * api-server-extract.ts -- Extraction logic adapted for the API server.
 *
 * Unlike the CLI version, this:
 *   - Accepts session objects directly (no file I/O)
 *   - Returns data in-memory instead of writing CSV/JSON files
 *   - Returns candidates in the same snake_case format the Lovable frontend expects
 */
import { AshbySession, Candidate, Company, Job } from './types.js';
import { fetchAllAvailableOrgs, fetchPipelineForOrg, quickCheckOrgHasCandidates } from './client.js';

export interface ExtractedInterviewEvent {
  id: string;
  interview_title: string;
  start_time: string;
  end_time: string;
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
): Promise<ExtractResult & { extraction_stats: Record<string, number> }> {
  const startTime = Date.now();

  // Discover orgs
  const orgInfos = await fetchAllAvailableOrgs(session);
  if (orgInfos.length === 0) {
    throw new Error('No organizations found. Check your session cookie.');
  }

  const orgsWithUserId = orgInfos.filter(o => o.userId);
  console.log(`Found ${orgInfos.length} org(s) (${orgsWithUserId.length} with userId)`);

  // ── Pass 1: Fast scan to find which orgs have active candidates ────────
  // ~200ms/org (no CSRF refresh, minimal query). Identifies the ~30 orgs
  // that actually have candidates out of ~333 total.

  onProgress?.(0, orgsWithUserId.length, 'Scanning orgs for active candidates...');
  const orgsWithCandidates: typeof orgsWithUserId = [];
  let scanErrors = 0;

  for (let i = 0; i < orgsWithUserId.length; i++) {
    const orgInfo = orgsWithUserId[i];

    if (i % 20 === 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`  Scan progress: ${i}/${orgsWithUserId.length} (${orgsWithCandidates.length} with candidates, ${elapsed}s)`);
      onProgress?.(i, orgsWithUserId.length, `Scanning: ${orgInfo.name} (${orgsWithCandidates.length} found)`);
    }

    try {
      const hasCandidates = await quickCheckOrgHasCandidates(session, orgInfo.userId);
      if (hasCandidates) {
        orgsWithCandidates.push(orgInfo);
      }
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('401') || msg.includes('expired')) {
        console.error(`  Cookie expired during scan at org ${i}/${orgsWithUserId.length}`);
        // If we already found some orgs, continue to pass 2 with what we have
        if (orgsWithCandidates.length > 0) break;
        throw err;
      }
      scanErrors++;
    }
  }

  const scanElapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`Scan complete in ${scanElapsed}s: ${orgsWithCandidates.length} orgs have active candidates (of ${orgsWithUserId.length} scanned, ${scanErrors} errors)`);

  if (orgsWithCandidates.length === 0) {
    throw new Error('No organizations with active candidates found. Session may be expired.');
  }

  // ── Pass 2: Full fetch only for orgs with candidates ───────────────────
  // ~1.5s/org but only ~30 orgs instead of ~333.

  onProgress?.(0, orgsWithCandidates.length, 'Fetching candidate data...');

  const allCompanies: Company[] = [];
  const allJobs: Job[] = [];
  let allCandidates: Candidate[] = [];
  let orgsFetched = 0;

  for (let i = 0; i < orgsWithCandidates.length; i++) {
    const orgInfo = orgsWithCandidates[i];

    console.log(`[${i + 1}/${orgsWithCandidates.length}] Fetching: ${orgInfo.name}`);
    onProgress?.(i, orgsWithCandidates.length, `Fetching: ${orgInfo.name}`);

    try {
      const { companies, jobs, candidates } = await fetchPipelineForOrg(
        session,
        orgInfo.id,
        orgInfo.userId
      );
      allCompanies.push(...companies);
      allJobs.push(...jobs);
      allCandidates.push(...candidates);
      orgsFetched++;
      if (candidates.length > 0) {
        console.log(`  Found ${candidates.length} candidates (total: ${allCandidates.length})`);
      }
    } catch (err: any) {
      const msg = err?.message?.substring(0, 150) || '';
      console.error(`  Failed: ${msg}`);
      if (msg.includes('401') || msg.includes('expired') || msg.includes('CSRF')) {
        if (allCandidates.length > 0) {
          console.log(`⚠️  Cookie expired after ${orgsFetched} orgs — returning ${allCandidates.length} candidates collected`);
          break;
        }
        throw err;
      }
    }
  }

  const totalElapsed = Math.round((Date.now() - startTime) / 1000);
  onProgress?.(orgsWithCandidates.length, orgsWithCandidates.length, 'Finalizing...');
  console.log(`Extraction complete in ${totalElapsed}s: ${allCandidates.length} candidates from ${orgsFetched}/${orgsWithCandidates.length} orgs (scanned ${orgsWithUserId.length} total)`);

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
      const sortedEvents = [...cand.interviewEvents].sort((a, b) =>
        new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
      );

      const mostRecentDate = new Date(sortedEvents[0].startTime);
      const currentInterviews: typeof sortedEvents = [];
      const previousInterviews: typeof sortedEvents = [];

      for (const event of sortedEvents) {
        const daysDiff = (mostRecentDate.getTime() - new Date(event.startTime).getTime()) / (24 * 60 * 60 * 1000);
        if (daysDiff <= 1) {
          currentInterviews.push(event);
        } else {
          previousInterviews.push(event);
        }
      }

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
        currentStageDate = new Date(currentInterviews[0].startTime).toISOString().split('T')[0];
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
    extraction_stats: {
      orgs_total: orgsWithUserId.length,
      orgs_scanned: orgsWithUserId.length,
      orgs_with_candidates: orgsWithCandidates.length,
      orgs_fetched: orgsFetched,
      scan_seconds: scanElapsed,
      total_seconds: totalElapsed,
    },
  };
}
