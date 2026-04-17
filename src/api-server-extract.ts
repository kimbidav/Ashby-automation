/**
 * api-server-extract.ts -- Extraction logic adapted for the API server.
 *
 * Unlike the CLI version, this:
 *   - Accepts session objects directly (no file I/O)
 *   - Returns data in-memory instead of writing CSV/JSON files
 *   - Returns candidates in the same snake_case format the Lovable frontend expects
 */
import { AshbySession, Candidate, Company, Job } from './types.js';
import { fetchAllAvailableOrgs, fetchPipelineForOrg } from './client.js';

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

export async function extractPipeline(
  session: AshbySession,
  onProgress?: ProgressCallback,
): Promise<ExtractResult> {
  const startTime = Date.now();
  const TIME_LIMIT_MS = 100_000; // 100 seconds — well within cookie lifespan

  function timeRemaining(): number {
    return TIME_LIMIT_MS - (Date.now() - startTime);
  }

  // Discover orgs
  const orgInfos = await fetchAllAvailableOrgs(session);
  if (orgInfos.length === 0) {
    throw new Error('No organizations found. Check your session cookie.');
  }

  console.log(`Found ${orgInfos.length} org(s). Time limit: ${TIME_LIMIT_MS / 1000}s`);
  onProgress?.(0, orgInfos.length, 'Discovering organizations...');

  const allCompanies: Company[] = [];
  const allJobs: Job[] = [];
  let allCandidates: Candidate[] = [];
  let orgsProcessed = 0;
  let orgsSkippedTimeout = 0;

  for (let i = 0; i < orgInfos.length; i++) {
    const orgInfo = orgInfos[i];

    if (!orgInfo.userId) continue;

    // Check time limit — return partial results if we're running out
    if (timeRemaining() < 5000 && allCandidates.length > 0) {
      orgsSkippedTimeout = orgInfos.length - i;
      console.log(`⏱️  Time limit reached after ${orgsProcessed} orgs (${allCandidates.length} candidates). Skipping ${orgsSkippedTimeout} remaining orgs.`);
      break;
    }

    console.log(`[${i + 1}/${orgInfos.length}] Processing: ${orgInfo.name} (${Math.round(timeRemaining() / 1000)}s remaining)`);
    onProgress?.(i, orgInfos.length, orgInfo.name);

    try {
      const { companies, jobs, candidates } = await fetchPipelineForOrg(
        session,
        orgInfo.id,
        orgInfo.userId
      );
      allCompanies.push(...companies);
      allJobs.push(...jobs);
      allCandidates.push(...candidates);
      orgsProcessed++;
      if (candidates.length > 0) {
        console.log(`  Found ${candidates.length} candidates (total: ${allCandidates.length})`);
      }
    } catch (err: any) {
      const msg = err?.message?.substring(0, 150) || '';
      console.error(`  Failed: ${msg}`);
      // If we hit auth errors, stop immediately — cookie is dead
      if (msg.includes('401') || msg.includes('expired') || msg.includes('CSRF')) {
        if (allCandidates.length > 0) {
          console.log(`⚠️  Auth error after ${orgsProcessed} orgs — returning ${allCandidates.length} candidates collected so far`);
          break;
        }
        throw err; // No data collected yet — propagate the error
      }
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  onProgress?.(orgInfos.length, orgInfos.length, 'Finalizing...');
  console.log(`Extraction complete: ${allCandidates.length} candidates from ${orgsProcessed} orgs in ${elapsed}s${orgsSkippedTimeout > 0 ? ` (${orgsSkippedTimeout} orgs skipped — time limit)` : ''}`);

  if (allCandidates.length === 0) {
    throw new Error('No candidates extracted from any organization. Session may be expired.');
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
  };
}
