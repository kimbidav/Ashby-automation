export interface Candidate {
  id: string;
  name: string;
  currentStage: string;
  stageType: string | null;
  currentStageIndex: number | null;
  totalStages: number | null;
  stageProgress: string | null;
  jobId: string;
  companyId: string;
  orgId: string;
  orgName?: string;
  lastActivityAt: string;
  daysInStage: number;
  needsScheduling: boolean;
  creditedTo: string | null;
  source: string | null;
}

export interface Job {
  id: string;
  title: string;
  companyId: string;
}

export interface Company {
  id: string;
  name: string;
}

export interface PipelineData {
  candidates: Candidate[];
  jobs: Job[];
  companies: Company[];
}

export interface Stats {
  totalCandidates: number;
  totalJobs: number;
  totalCompanies: number;
  candidatesByOrg: Record<string, number>;
  candidatesByStage: Record<string, number>;
  candidatesByCreditedTo: Record<string, number>;
  avgDaysInStage: number;
  needsScheduling: number;
}
