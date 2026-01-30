import { Candidate, Company, Job } from './types.js';

export interface NormalizedData {
  companies: Company[];
  jobs: Job[];
  candidates: Candidate[];
}

export function computeDaysInStage(lastActivityAt: string): number {
  const last = new Date(lastActivityAt).getTime();
  const now = Date.now();
  const diffMs = now - last;
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

// Placeholder for when we know the raw response shape.
export function normalizePipeline(rawRows: any[]): NormalizedData {
  const companies: Company[] = [];
  const jobs: Job[] = [];
  const candidates: Candidate[] = [];

  // TODO: map rawRows into the normalized structures once recon is done.

  return { companies, jobs, candidates };
}

