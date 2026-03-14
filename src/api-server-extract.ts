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
export async function extractPipeline(session: AshbySession): Promise<ExtractResult> {
  // Discover orgs
  const orgInfos = await fetchAllAvailableOrgs(session);
  if (orgInfos.length === 0) {
    throw new Error('No organizations found. Check your session cookie.');
  }

  console.log(`Found ${orgInfos.length} org(s)`);

  const allCompanies: Company[] = [];
  const allJobs: Job[] = [];
  let allCandidates: Candidate[] = [];

  for (let i = 0; i < orgInfos.length; i++) {
    const orgInfo = orgInfos[i];
    console.log(`[${i + 1}/${orgInfos.length}] Processing: ${orgInfo.name}`);

    if (!orgInfo.userId) continue;

    try {
      const { companies, jobs, candidates } = await fetchPipelineForOrg(
        session,
        orgInfo.id,
        orgInfo.userId
      );
      allCompanies.push(...companies);
      allJobs.push(...jobs);
      allCandidates.push(...candidates);
      console.log(`  Found ${candidates.length} candidates`);
    } catch (err: any) {
      console.error(`  Failed: ${err?.message?.substring(0, 150)}`);
    }

  }

  if (allCandidates.length === 0) {
    throw new Error('No candidates extracted from any organization. Session may be expired.');
  }

  // Convert to the flat snake_case format the frontend expects
  const companyById = new Map(allCompanies.map((c) => [c.id, c]));
  const jobById = new Map(allJobs.map((j) => [j.id, j]));

  const flatCandidates: ExtractedCandidate[] = allCandidates.map((cand) => {
    const company = companyById.get(cand.companyId);
    const job = jobById.get(cand.jobId);

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
      interview_events: (cand.interviewEvents || []).map((ev) => ({
        id: ev.id,
        interview_title: ev.interviewTitle,
        start_time: ev.startTime,
        end_time: ev.endTime,
      })),
    };
  });

  return {
    companies: allCompanies,
    jobs: allJobs,
    candidates: flatCandidates,
  };
}
