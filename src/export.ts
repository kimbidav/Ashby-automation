import fs from 'node:fs/promises';
import path from 'node:path';
import { Candidate, Company, Job } from './types.js';

export interface AggregatedData {
  companies: Company[];
  jobs: Job[];
  candidates: Candidate[];
}

export async function exportJSON(data: AggregatedData, filePath = 'ashby-pipeline.json'): Promise<void> {
  const full = path.resolve(process.cwd(), filePath);
  await fs.writeFile(full, JSON.stringify(data, null, 2), 'utf8');
  console.log(`Wrote JSON to ${full}`);
}

export async function exportCSV(data: AggregatedData, filePath = 'ashby-pipeline.csv'): Promise<void> {
  const full = path.resolve(process.cwd(), filePath);

  const companyById = new Map(data.companies.map((c) => [c.id, c]));
  const jobById = new Map(data.jobs.map((j) => [j.id, j]));

  // PRD-specified CSV schema with new fields including feedback data
  const header = [
    'company_name',
    'job_title',
    'job_id',
    'candidate_name',
    'candidate_id',
    'pipeline_stage',
    'decision_status',
    'stage_type',
    'current_stage_index',
    'total_stages',
    'stage_progress',
    'last_activity_at',
    'days_in_stage',
    'needs_scheduling',
    'credited_to',
    'source',
    'feedback_count',
    'latest_recommendation',
    'latest_feedback_author',
    'latest_feedback_date',
    'current_stage_interviews',
    'current_stage_avg_score',
    'current_stage_date',
    'interview_history_summary'
  ];
  const lines = [header.join(',')];

  for (const cand of data.candidates) {
    const company = companyById.get(cand.companyId);
    const job = jobById.get(cand.jobId);

    // Parse interview events to create intuitive summaries
    let currentStageInterviews = '';
    let currentStageAvgScore = '';
    let currentStageDate = '';
    let interviewHistorySummary = '';

    if (cand.interviewEvents && cand.interviewEvents.length > 0) {
      // Sort by date (most recent first)
      const sortedEvents = [...cand.interviewEvents].sort((a, b) =>
        new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
      );

      // Get the most recent date to identify "current stage" interviews
      const mostRecentDate = new Date(sortedEvents[0].startTime);
      const sameDayThreshold = 7 * 24 * 60 * 60 * 1000; // 7 days

      const currentInterviews: any[] = [];
      const previousInterviews: any[] = [];

      for (const event of sortedEvents) {
        const eventDate = new Date(event.startTime);
        const daysDiff = (mostRecentDate.getTime() - eventDate.getTime()) / (24 * 60 * 60 * 1000);

        // Only group same-day or next-day interviews as "current stage"
        // This better matches Ashby's stage grouping
        if (daysDiff <= 1) {
          currentInterviews.push(event);
        } else {
          previousInterviews.push(event);
        }
      }

      // Format current stage interviews with bullet points and feedback
      if (currentInterviews.length > 0) {
        const currentParts = currentInterviews.map(event => {
          // Format date as MM/DD
          const eventDate = new Date(event.startTime);
          const month = String(eventDate.getMonth() + 1).padStart(2, '0');
          const day = String(eventDate.getDate()).padStart(2, '0');
          const dateStr = `${month}/${day}`;

          return event.interviewers.map((interviewer: any) => {
            const score = interviewer.overallRecommendation
              ? `Score: ${interviewer.overallRecommendation}`
              : 'No score yet';

            // Find matching feedback from allFeedback array
            let feedbackText = '';
            if (cand.allFeedback && cand.allFeedback.length > 0) {
              const matchingFeedback = cand.allFeedback.find(
                fb => fb.interviewTitle === event.interviewTitle &&
                      fb.interviewer === interviewer.name
              );
              if (matchingFeedback && matchingFeedback.feedbackText) {
                feedbackText = ` (${matchingFeedback.feedbackText})`;
              }
            }

            return `• ${event.interviewTitle} (${dateStr}) - ${interviewer.name} - ${score}${feedbackText}`;
          }).join('\n');
        });
        currentStageInterviews = currentParts.join('\n');

        // Calculate average score for current stage
        const scores = currentInterviews.flatMap(e =>
          e.interviewers
            .filter((i: any) => i.overallRecommendation)
            .map((i: any) => parseFloat(i.overallRecommendation))
        );
        if (scores.length > 0) {
          const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
          currentStageAvgScore = avg.toFixed(1);
        }

        // Get date of current stage interviews
        const dateStr = new Date(currentInterviews[0].startTime).toISOString().split('T')[0];
        currentStageDate = dateStr;
      }

      // Format previous interviews
      if (previousInterviews.length > 0) {
        const previousParts = previousInterviews.map(event => {
          const dateStr = new Date(event.startTime).toISOString().split('T')[0];
          const scores = event.interviewers
            .filter((i: any) => i.overallRecommendation)
            .map((i: any) => i.overallRecommendation);
          const avgScore = scores.length > 0
            ? (scores.reduce((a: number, b: string) => a + parseFloat(b), 0) / scores.length).toFixed(1)
            : 'N/A';
          return `${dateStr}: ${event.interviewTitle} (${avgScore})`;
        });
        interviewHistorySummary = previousParts.join(' | ');
      }
    }

    const row = [
      cand.orgName || company?.name || '',
      job?.title ?? '',
      cand.jobId,
      cand.name,
      cand.id,
      cand.pipelineStage ?? '',
      cand.decisionStatus ?? '',
      cand.stageType ?? '',
      cand.currentStageIndex !== null ? String(cand.currentStageIndex) : '',
      cand.totalStages !== null ? String(cand.totalStages) : '',
      cand.stageProgress ?? '',
      cand.lastActivityAt,
      String(cand.daysInStage),
      String(cand.needsScheduling),
      cand.creditedTo ?? '',
      cand.source ?? '',
      cand.feedbackCount !== undefined ? String(cand.feedbackCount) : '',
      cand.latestOverallRecommendation ?? '',
      cand.latestFeedbackAuthor ?? '',
      cand.latestFeedbackDate ?? '',
      currentStageInterviews,
      currentStageAvgScore,
      currentStageDate,
      interviewHistorySummary
    ];

    const escaped = row.map((field) => {
      // Convert to string first (handles null, undefined, numbers, etc.)
      const fieldStr = String(field);
      if (fieldStr.includes(',') || fieldStr.includes('"') || fieldStr.includes('\n')) {
        return `"${fieldStr.replace(/"/g, '""')}"`;
      }
      return fieldStr;
    });

    lines.push(escaped.join(','));
  }

  await fs.writeFile(full, lines.join('\n'), 'utf8');
  console.log(`Wrote CSV to ${full}`);
}

