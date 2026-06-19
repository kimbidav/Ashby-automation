/**
 * types.ts — Shared TypeScript interfaces used across the project.
 *
 * Key types:
 *   AshbySession      — Auth cookies + optional CSRF token, saved to .ashby-session.json.
 *                       When `requestContext` is set, the session is being driven by
 *                       a live Playwright BrowserContext (server.ts's `liveContext`)
 *                       and HTTP calls go through that context — cookies come from
 *                       the live browser, not from the in-memory `cookies` map.
 *   Candidate         — One active application: pipeline stage, interview data, feedback
 *   InterviewEvent    — A scheduled interview with interviewers and scorecard submissions
 *   InterviewFeedback — One interviewer's feedback and rating for an interview
 *   Company / Job     — Lightweight containers used for CSV/JSON lookup
 */
import type { APIRequestContext } from 'playwright';

export interface Company {
  id: string;
  name: string;
}

export interface Job {
  id: string;
  title: string;
  companyId: string;
}

export interface InterviewFeedback {
  interviewTitle: string; // Name of the interview
  interviewer: string; // Person who gave feedback
  interviewerEmail: string; // Interviewer email
  submittedAt: string; // When feedback was submitted
  overallRecommendation: string | null; // e.g., "2", "3", "4" or null
  feedbackText: string | null; // Extracted feedback content
  isFeedbackSubmitted: boolean;
}

export interface InterviewEvent {
  id: string;
  interviewTitle: string;
  startTime: string;
  endTime: string;
  interviewStageId?: string | null;
  interviewStageTitle?: string | null;
  interviewers: Array<{
    name: string;
    email: string;
    overallRecommendation: string | null;
    isFeedbackSubmitted: boolean;
  }>;
}

export interface InterviewStageHistory {
  stageName: string;
  stageType: string | null;
  enteredAt: string;
  daysInStage: number;
  interviews: InterviewEvent[];
}

export interface Candidate {
  id: string;
  applicationId: string; // Add application ID for detailed queries
  name: string;
  email: string | null;
  phone: string | null;
  currentStage: string; // Decision status like "Needs Decision", "Scheduled"
  currentStageId?: string | null;
  currentStageEnteredAt?: string | null;
  pipelineStage: string | null; // Actual pipeline stage like "Technical Interviews", "Hard Skills Check"
  stageType: string | null;
  currentStageIndex: number | null;
  totalStages: number | null;
  stageProgress: string | null; // e.g., "3/5" or "First call (3/5)"
  jobId: string;
  companyId: string;
  orgId: string;
  orgName?: string;
  lastActivityAt: string;
  daysInStage: number;
  needsScheduling: boolean;
  creditedTo: string | null;
  source: string | null;

  // Application status
  decisionStatus: string | null; // e.g., "NEEDS DECISION", "SCHEDULED", "WAITING ON AVAILABILITY"
  statusPriority: number | null;
  statusDueAt: string | null;

  // Archive/hire reason — populated by the bounded done-sweep (fetchArchivedForOrg)
  // for candidates pulled from the Archived/Hired prebuilt views.
  archivedReason?: string | null;     // e.g., "Lacks Skills/Qualifications"
  archivedReasonType?: string | null; // e.g., "REJECTED_BY_ORG"

  // Enhanced fields
  primaryEmailAddress: string | null;
  phoneNumber: string | null;
  location: string | null;
  resumeUrl: string | null;
  linkedInUrl: string | null;
  githubUrl: string | null;
  websiteUrl: string | null;

  // Interview data
  interviewEvents?: InterviewEvent[]; // All interview events
  allFeedback?: InterviewFeedback[]; // All feedback from all interviews

  // Latest feedback summary (for quick reference in CSV)
  latestOverallRecommendation?: string | null; // Most recent rating (e.g., "2", "3", "4")
  latestFeedbackAuthor?: string; // Who gave the latest feedback
  latestFeedbackDate?: string; // When latest feedback was submitted
  feedbackCount?: number; // Total number of feedback submissions
}

export interface AshbySession {
  cookies: Record<string, string>;
  csrfToken?: string;
  orgIds: string[];
  /**
   * Playwright APIRequestContext sourced from a live BrowserContext. When
   * present, client.ts routes every HTTP call through it — cookies are read
   * from the live browser jar (always fresh), which dodges Ashby's
   * "the browser that authenticated quit, who are you?" invalidation.
   * Not serialized to disk; only set on the in-memory session held by
   * server.ts when login mode is "live."
   */
  requestContext?: APIRequestContext;
  /**
   * Invoked by doFetch whenever a Set-Cookie response rotated a cookie value
   * in `cookies`. server.ts attaches a hook that persists the rotated map to
   * .ashby-session.json so the session survives across runs. Never serialized.
   */
  onCookiesRotated?: (session: AshbySession) => void;
  /**
   * sha256 of the cookie string this session's rotation chain descends from
   * (e.g. the STORED_COOKIE env var). Lets validateCookie tell whether a
   * persisted session file is a rotation descendant of the configured seed
   * cookie or predates it. Persisted alongside the cookie map.
   */
  seedHash?: string;
}
