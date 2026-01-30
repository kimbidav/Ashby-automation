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
}

