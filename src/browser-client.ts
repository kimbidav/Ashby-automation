import { BrowserContext, Page } from 'playwright';
import { Candidate, Company, Job } from './types.js';
import { findPipelineQueries, ParsedGraphQLQuery } from './recon-parser.js';

export interface PipelineFetchResult {
  companies: Company[];
  jobs: Job[];
  candidates: Candidate[];
}

interface GraphQLResponse<T> {
  data: T;
  errors?: Array<{ message: string }>;
}

/**
 * Client that uses Playwright browser context directly - no cookie extraction needed!
 * The browser manages authentication automatically.
 */
export class BrowserClient {
  private context: BrowserContext;
  private page: Page;
  private csrfToken: string | null = null;

  constructor(context: BrowserContext, page: Page) {
    this.context = context;
    this.page = page;
  }

  /**
   * Get CSRF token from the page (either from cookies or by fetching it)
   */
  private async getCsrfToken(): Promise<string> {
    if (this.csrfToken) {
      return this.csrfToken;
    }

    // Try to get CSRF token from page cookies or localStorage
    this.csrfToken = await this.page.evaluate(() => {
      // Check cookies
      const cookies = document.cookie.split(';').reduce((acc, cookie) => {
        const [key, value] = cookie.trim().split('=');
        acc[key] = value;
        return acc;
      }, {} as Record<string, string>);
      
      if (cookies['csrf']) {
        return cookies['csrf'];
      }

      // Check localStorage
      try {
        const csrf = localStorage.getItem('csrf');
        if (csrf) return csrf;
      } catch {}

      return null;
    });

    // If not found in page, fetch it via API
    if (!this.csrfToken) {
      const response = await this.page.request.get('https://app.ashbyhq.com/api/csrf/token');
      if (response.ok()) {
        const data = await response.json() as { token: string };
        this.csrfToken = data.token;
      } else {
        throw new Error(`Failed to fetch CSRF token: ${response.status()}`);
      }
    }

    return this.csrfToken;
  }

  /**
   * Make a GraphQL query using the browser context
   */
  async graphqlQuery<T>(
    operationName: string,
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<T> {
    const csrfToken = await this.getCsrfToken();
    const url = `https://app.ashbyhq.com/api/graphql?op=${operationName}`;

    const response = await this.page.request.post(url, {
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
        'accept': 'application/json'
      },
      data: JSON.stringify({
        operationName,
        query,
        variables
      })
    });

    if (!response.ok()) {
      const errorText = await response.text();
      throw new Error(`GraphQL request failed ${response.status()}: ${errorText.substring(0, 200)}`);
    }

    const responseData = await response.json() as GraphQLResponse<T>;

    if (responseData.errors) {
      const errorMessages = responseData.errors.map(e => e.message).join(', ');
      throw new Error(`GraphQL errors: ${errorMessages}`);
    }

    return responseData.data;
  }

  /**
   * Switch organization context
   */
  async switchOrgContext(userId: string): Promise<void> {
    // First, get a fresh CSRF token for the switch request
    await this.getCsrfToken();
    
    const response = await this.page.request.post(`https://app.ashbyhq.com/api/auth/change_user/${userId}`, {
      headers: {
        'accept': 'application/json',
        'x-csrf-token': this.csrfToken || ''
      }
    });

    if (!response.ok()) {
      throw new Error(`Failed to switch org context: ${response.status()}`);
    }

    // Clear CSRF token and navigate to page to refresh session
    this.csrfToken = null;
    
    // Navigate to ensure cookies are refreshed for new org
    await this.page.goto('https://app.ashbyhq.com', { waitUntil: 'networkidle', timeout: 30000 });
    await this.page.waitForTimeout(1000);
    
    // Refresh CSRF token for the new org context
    await this.getCsrfToken();
  }

  /**
   * Fetch all available organizations
   */
  async fetchAllAvailableOrgs(): Promise<Array<{ id: string; name?: string; userId?: string }>> {
    const response = await this.page.request.get('https://app.ashbyhq.com/api/auth/available_identities', {
      headers: {
        'accept': 'application/json'
      }
    });

    if (!response.ok()) {
      throw new Error(`Failed to fetch available orgs: ${response.status()}`);
    }

    const data = await response.json() as Array<{
      organizationId: string;
      organizationName?: string;
      userId: string;
    }>;

    return data.map(item => ({
      id: item.organizationId,
      name: item.organizationName,
      userId: item.userId
    }));
  }

  /**
   * Fetch pipeline data for a specific organization
   */
  async fetchPipelineForOrg(
    orgId: string,
    userId?: string
  ): Promise<PipelineFetchResult> {
    // Switch org context if needed
    if (userId && orgId !== 'default') {
      console.log(`  Switching to org context (userId: ${userId.substring(0, 8)}...)`);
      await this.switchOrgContext(userId);
      console.log(`  Switched org context, ready to fetch data`);
    }

    // Try to load queries from recon log, fallback to hardcoded
    let openJobsQuery: string;
    let applicationsQuery: string;
    
    try {
      const pipelineQueries = await findPipelineQueries();
      
      if (pipelineQueries.openJobs) {
        openJobsQuery = pipelineQueries.openJobs.query;
        console.log('  Using ApiOpenJobs query from recon log');
      } else {
        // Fallback to hardcoded
        openJobsQuery = `
          query ApiOpenJobs($onlyIncludeOpenJobs: Boolean = true, $onlyIncludeJobsUserFollowsOrHasRole: Boolean = false) {
            jobsPipelines(
              onlyIncludeOpenJobs: $onlyIncludeOpenJobs
              onlyIncludeJobsUserFollowsOrHasRole: $onlyIncludeJobsUserFollowsOrHasRole
            ) {
              jobId
              jobTitle
              jobLocationName
              customRequisitionId
              confidential
              userFollowsOrHasRole
              applicationCount
              __typename
            }
          }
        `;
        console.log('  Using hardcoded ApiOpenJobs query (recon log not found)');
      }
      
      if (pipelineQueries.activeApplications) {
        applicationsQuery = pipelineQueries.activeApplications.query;
        console.log('  Using active applications query from recon log');
      } else {
        // Fallback to hardcoded
        applicationsQuery = `
          query ApiGetActiveApplications($customFilter: JSON, $extraFields: [String], $orderByFields: [OrderByFieldInput], $cursor: String, $searchTerm: String, $queryContext: JSON, $limit: Int) {
            result: applicationsByPrebuiltView(
              prebuiltView: Active
              customFilter: $customFilter
              extraFields: $extraFields
              orderByFields: $orderByFields
              cursor: $cursor
              searchTerm: $searchTerm
              queryContext: $queryContext
              limit: $limit
            ) {
              results {
                id
                job {
                  id
                  title
                  __typename
                }
                candidate {
                  id
                  name
                  company
                  socialLinks {
                    type
                    url
                    __typename
                  }
                  pseudonym {
                    pseudonym
                    __typename
                  }
                  isBlinded
                  __typename
                }
                applicationStatus {
                  description
                  priority
                  dueAt
                  __typename
                }
                createdAt
                currentInterviewStage {
                  id
                  interviewPlanId
                  stageType
                  __typename
                }
                extraFields
                __typename
              }
              nextCursor
              moreDataAvailable
              opaqueFilter
              __typename
            }
          }
        `;
        console.log('  Using hardcoded active applications query (recon log not found)');
      }
    } catch (error) {
      console.warn('  Could not load queries from recon log, using hardcoded fallback:', error);
      // Use hardcoded queries as fallback
      openJobsQuery = `
        query ApiOpenJobs($onlyIncludeOpenJobs: Boolean = true, $onlyIncludeJobsUserFollowsOrHasRole: Boolean = false) {
          jobsPipelines(
            onlyIncludeOpenJobs: $onlyIncludeOpenJobs
            onlyIncludeJobsUserFollowsOrHasRole: $onlyIncludeJobsUserFollowsOrHasRole
          ) {
            jobId
            jobTitle
            jobLocationName
            customRequisitionId
            confidential
            userFollowsOrHasRole
            applicationCount
            __typename
          }
        }
      `;
      applicationsQuery = `
        query ApiGetActiveApplications($customFilter: JSON, $extraFields: [String], $orderByFields: [OrderByFieldInput], $cursor: String, $searchTerm: String, $queryContext: JSON, $limit: Int) {
          result: applicationsByPrebuiltView(
            prebuiltView: Active
            customFilter: $customFilter
            extraFields: $extraFields
            orderByFields: $orderByFields
            cursor: $cursor
            searchTerm: $searchTerm
            queryContext: $queryContext
            limit: $limit
          ) {
            results {
              id
              job {
                id
                title
                __typename
              }
              candidate {
                id
                name
                company
                socialLinks {
                  type
                  url
                  __typename
                }
                pseudonym {
                  pseudonym
                  __typename
                }
                isBlinded
                __typename
              }
              applicationStatus {
                description
                priority
                dueAt
                __typename
              }
              createdAt
              currentInterviewStage {
                id
                interviewPlanId
                stageType
                __typename
              }
              extraFields
              __typename
            }
            nextCursor
            moreDataAvailable
            opaqueFilter
            __typename
          }
        }
      `;
    }

    interface JobsPipelinesResponse {
      jobsPipelines: Array<{
        jobId: string;
        jobTitle: string;
        jobLocationName?: string;
        customRequisitionId?: string;
        confidential: boolean;
        userFollowsOrHasRole: boolean;
        applicationCount: number;
      }>;
    }

    // Extract operation name from query
    const openJobsOpMatch = openJobsQuery.match(/query\s+(\w+)/);
    const openJobsOpName = openJobsOpMatch ? openJobsOpMatch[1] : 'ApiOpenJobs';
    
    let jobsData: JobsPipelinesResponse;
    try {
      jobsData = await this.graphqlQuery<JobsPipelinesResponse>(
        openJobsOpName,
        openJobsQuery,
        {
          onlyIncludeOpenJobs: true,
          onlyIncludeJobsUserFollowsOrHasRole: false
        }
      );
      console.log(`  Found ${jobsData.jobsPipelines.length} open jobs`);
    } catch (error) {
      console.error('  Error fetching jobs:', error);
      throw error;
    }

    // Step 2: Fetch active applications (query loaded above)

    interface ApplicationResult {
      id: string;
      job: {
        id: string;
        title: string;
      };
      candidate: {
        id: string;
        name: string;
        company?: string;
        isBlinded?: boolean;
        pseudonym?: { pseudonym: string };
      };
      applicationStatus: {
        description: string;
        priority?: number;
        dueAt?: string;
      };
      createdAt: string;
      currentInterviewStage?: {
        id: string;
        interviewPlanId?: string;
        stageType?: string;
      };
    }

    interface ApplicationsResponse {
      result: {
        results: ApplicationResult[];
        nextCursor: string | null;
        moreDataAvailable: boolean;
      };
    }

    const allApplications: ApplicationResult[] = [];
    let cursor: string | null = null;
    let hasMore = true;

    // Extract operation name from query
    const appsOpMatch = applicationsQuery.match(/query\s+(\w+)/);
    const appsOpName = appsOpMatch ? appsOpMatch[1] : 'ApiGetActiveApplications';
    
    try {
      while (hasMore) {
        const appsData: ApplicationsResponse = await this.graphqlQuery<ApplicationsResponse>(
          appsOpName,
          applicationsQuery,
          {
            customFilter: null,
            extraFields: [],
            orderByFields: [{ field: 'submitted_at', ascending: false }],
            cursor,
            searchTerm: '',
            queryContext: null,
            limit: 100
          }
        );

        allApplications.push(...appsData.result.results);
        cursor = appsData.result.nextCursor;
        hasMore = appsData.result.moreDataAvailable;
        console.log(`  Fetched ${appsData.result.results.length} applications (total: ${allApplications.length}, more: ${hasMore})`);
      }
      console.log(`  Total applications fetched: ${allApplications.length}`);
    } catch (error) {
      console.error('  Error fetching applications:', error);
      // Continue with empty applications if this fails
    }

    // Step 3: Normalize the data
    return this.normalizePipelineData(jobsData.jobsPipelines, allApplications, orgId);
  }

  /**
   * Normalize raw API data into our standard format
   */
  private normalizePipelineData(
    jobs: Array<{
      jobId: string;
      jobTitle: string;
      jobLocationName?: string;
      customRequisitionId?: string;
    }>,
    applications: Array<{
      id: string;
      job: { id: string; title: string };
      candidate: {
        id: string;
        name: string;
        company?: string;
        isBlinded?: boolean;
        pseudonym?: { pseudonym: string };
      };
      applicationStatus: { description: string; dueAt?: string };
      createdAt: string;
      currentInterviewStage?: { id: string; title?: string; stageType?: string };
    }>,
    orgId: string
  ): PipelineFetchResult {
    // Get org name from page if possible
    let orgName = orgId;
    try {
      // Try to get org name from page title or URL
      const url = this.page.url();
      // This is a fallback - we'll try to get it from the API response if available
    } catch {}

    // Create companies map (using job titles as company names for now, or candidate.company)
    const companies = new Map<string, Company>();
    const jobsMap = new Map<string, Job>();

    // Process jobs
    for (const job of jobs) {
      // Use a default company ID based on org
      const companyId = `${orgId}-company`;
      if (!companies.has(companyId)) {
        companies.set(companyId, {
          id: companyId,
          name: orgName || 'Unknown Company'
        });
      }

      jobsMap.set(job.jobId, {
        id: job.jobId,
        title: job.jobTitle,
        companyId
      });
    }

    // Process applications/candidates
    const candidates: Candidate[] = [];
    for (const app of applications) {
      const job = jobsMap.get(app.job.id);
      if (!job) continue;

      const companyId = job.companyId;
      const candidateName = app.candidate.isBlinded && app.candidate.pseudonym
        ? app.candidate.pseudonym.pseudonym
        : app.candidate.name;

      const dueAt = app.applicationStatus.dueAt
        ? new Date(app.applicationStatus.dueAt)
        : null;
      const createdAt = new Date(app.createdAt);
      const daysInStage = dueAt
        ? Math.floor((Date.now() - dueAt.getTime()) / (1000 * 60 * 60 * 24))
        : Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

      const stageType = app.currentInterviewStage?.stageType || null;
      const finalDaysInStage = Math.max(0, daysInStage);
      const needsScheduling = this.computeNeedsScheduling(stageType, finalDaysInStage);

      candidates.push({
        id: app.candidate.id,
        applicationId: app.id, // Store application ID for detailed queries
        name: candidateName,
        email: null,
        phone: null,
        currentStage: app.applicationStatus.description || 'Unknown',
        pipelineStage: app.currentInterviewStage?.title || null, // Capture from initial query
        stageType,
        currentStageIndex: null,
        totalStages: null,
        stageProgress: null,
        jobId: app.job.id,
        companyId,
        orgId,
        orgName: orgName || orgId,
        lastActivityAt: app.applicationStatus.dueAt || app.createdAt,
        daysInStage: finalDaysInStage,
        needsScheduling,
        creditedTo: null,
        source: null,
        decisionStatus: app.applicationStatus.description,
        statusPriority: null,
        statusDueAt: app.applicationStatus.dueAt || null,
        primaryEmailAddress: null,
        phoneNumber: null,
        location: null,
        resumeUrl: null,
        linkedInUrl: null,
        githubUrl: null,
        websiteUrl: null
      });
    }

    return {
      companies: Array.from(companies.values()),
      jobs: Array.from(jobsMap.values()),
      candidates
    };
  }

  /**
   * Determine if a candidate needs scheduling based on stage type and days in stage
   */
  private computeNeedsScheduling(
    stageType: string | null,
    daysInStage: number,
    threshold: number = 7
  ): boolean {
    // If no stage type, can't determine if it's interview-related
    if (!stageType) return false;

    // Check if stage is interview-related
    // Common interview stage types in Ashby include variations of "interview", "onsite", "technical", etc.
    const interviewKeywords = ['interview', 'onsite', 'technical', 'screening', 'call'];
    const isInterviewStage = interviewKeywords.some(keyword =>
      stageType.toLowerCase().includes(keyword)
    );

    // Needs scheduling if it's an interview stage AND days >= threshold
    return isInterviewStage && daysInStage >= threshold;
  }

  /**
   * Extract feedback text from submittedFormRender
   * Looks for common feedback field names like "overallFeedback", "feedback", "comments", etc.
   */
  private extractFeedbackText(submittedFormRender?: any): string | null {
    if (!submittedFormRender) return null;

    const feedbackFieldNames = [
      'overallFeedback',
      'overall_feedback',
      'feedback',
      'comments',
      'notes',
      'assessment',
      'evaluation'
    ];

    // Check top-level fieldEntries
    if (submittedFormRender.fieldEntries) {
      for (const entry of submittedFormRender.fieldEntries) {
        if (!entry.field || typeof entry.field !== 'string') continue;
        const fieldLower = entry.field.toLowerCase();
        if (feedbackFieldNames.some(name => fieldLower.includes(name))) {
          const value = entry.fieldValue?.value;
          if (value && typeof value === 'string' && value.trim()) {
            return value.trim();
          }
        }
      }
    }

    // Check sections
    if (submittedFormRender.sections) {
      for (const section of submittedFormRender.sections) {
        if (section.fieldEntries) {
          for (const entry of section.fieldEntries) {
            if (!entry.field || typeof entry.field !== 'string') continue;
            const fieldLower = entry.field.toLowerCase();
            if (feedbackFieldNames.some(name => fieldLower.includes(name))) {
              const value = entry.fieldValue?.value;
              if (value && typeof value === 'string' && value.trim()) {
                return value.trim();
              }
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Fetch detailed application data including interview feedback and ratings
   */
  async fetchApplicationDetails(applicationId: string): Promise<{
    interviewEvents: any[];
    applicationStatus: any;
    currentInterviewStage: any;
    interviewPlan: any;
  } | null> {
    try {
      // Load the ApiApplication query from file
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const queryPath = path.join(process.cwd(), 'query_ApiApplication.graphql');
      const query = await fs.readFile(queryPath, 'utf8');

      interface ApplicationDetailResponse {
        application: {
          id: string;
          applicationStatus: {
            description: string;
            priority?: number;
            dueAt?: string;
          };
          currentInterviewStage?: {
            id: string;
            title: string;
            stageType?: string;
          };
          interviewPlan?: {
            id: string;
            interviewStages: Array<{
              id: string;
              title: string;
              stageType: string;
            }>;
          };
          interviewEvents: Array<{
            id: string;
            startTime: string;
            endTime: string;
            interview: {
              id: string;
              title: string;
            };
            interviewerEvents: Array<{
              id: string;
              interviewer: {
                id: string;
                firstName: string;
                lastName: string;
                email: string;
              };
              scorecardSubmission?: {
                id?: string;
                overallRecommendation?: string;
                submittedAt?: string;
                submittedFormRender?: {
                  fieldEntries?: Array<{
                    field: string;
                    fieldValue?: {
                      value?: any;
                    };
                  }>;
                  sections?: Array<{
                    fieldEntries?: Array<{
                      field: string;
                      fieldValue?: {
                        value?: any;
                      };
                    }>;
                  }>;
                };
              } | null;
              isFeedbackSubmitted: boolean;
            }>;
          }>;
        };
      }

      const response = await this.graphqlQuery<ApplicationDetailResponse>(
        'ApiApplication',
        query,
        { applicationId }
      );

      return {
        interviewEvents: response.application.interviewEvents || [],
        applicationStatus: response.application.applicationStatus,
        currentInterviewStage: response.application.currentInterviewStage || null,
        interviewPlan: response.application.interviewPlan || null
      };
    } catch (error) {
      console.error(`  Error fetching application details for ${applicationId}:`, error);
      return null;
    }
  }

  /**
   * Enrich candidates with detailed interview data
   * This is called after initial extraction to add feedback, ratings, etc.
   */
  async enrichCandidatesWithDetails(
    candidates: Candidate[],
    options: { maxConcurrent?: number; fetchAll?: boolean } = {}
  ): Promise<Candidate[]> {
    const { maxConcurrent = 5, fetchAll = false } = options;

    console.log(`  Enriching ${candidates.length} candidates with interview details...`);

    // Process candidates in batches to avoid overwhelming the API
    const enrichedCandidates: Candidate[] = [];

    for (let i = 0; i < candidates.length; i += maxConcurrent) {
      const batch = candidates.slice(i, i + maxConcurrent);

      const enrichedBatch = await Promise.all(
        batch.map(async (candidate) => {
          // Skip if not fetching all and candidate doesn't need enrichment
          if (!fetchAll && !candidate.needsScheduling) {
            return candidate;
          }

          const details = await this.fetchApplicationDetails(candidate.applicationId);

          if (!details) {
            return candidate; // Return original if fetch failed
          }

          // Extract interview events
          const interviewEvents = details.interviewEvents.map((event: any) => ({
            id: event.id,
            interviewTitle: event.interview.title,
            startTime: event.startTime,
            endTime: event.endTime,
            interviewers: event.interviewerEvents.map((ie: any) => ({
              name: `${ie.interviewer.firstName} ${ie.interviewer.lastName}`,
              email: ie.interviewer.email,
              overallRecommendation: ie.scorecardSubmission?.overallRecommendation || null,
              isFeedbackSubmitted: ie.isFeedbackSubmitted
            }))
          }));

          // Extract all feedback
          const allFeedback = details.interviewEvents.flatMap((event: any) =>
            event.interviewerEvents
              .filter((ie: any) => ie.isFeedbackSubmitted)
              .map((ie: any) => ({
                interviewTitle: event.interview.title,
                interviewer: `${ie.interviewer.firstName} ${ie.interviewer.lastName}`,
                interviewerEmail: ie.interviewer.email,
                submittedAt: ie.scorecardSubmission?.submittedAt || event.endTime,
                overallRecommendation: ie.scorecardSubmission?.overallRecommendation || null,
                feedbackText: this.extractFeedbackText(ie.scorecardSubmission?.submittedFormRender),
                isFeedbackSubmitted: ie.isFeedbackSubmitted
              }))
          );

          // Find latest feedback
          const sortedFeedback = allFeedback
            .filter(f => f.submittedAt)
            .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());

          const latestFeedback = sortedFeedback[0];

          // Calculate stage position in the pipeline
          let currentStageIndex: number | null = null;
          let totalStages: number | null = null;
          let stageProgress: string | null = null;

          if (details.interviewPlan && details.currentInterviewStage) {
            const allStages = details.interviewPlan.interviewStages;

            // Filter to only "Active" and "Offer" stages shown in the main pipeline view
            // This excludes sourcing stages (Lead, PreInterviewScreen) and terminal stages (Hired, Archived)
            const interviewStages = allStages.filter((s: any) => {
              const stageType = s.stageType || '';
              // Only include stages with stageType "Active" or "Offer"
              // This matches what's shown in the Ashby pipeline UI
              return stageType === 'Active' || stageType === 'Offer';
            });

            totalStages = interviewStages.length;

            // Find the index of the current stage (1-indexed for display)
            const stageIdx = interviewStages.findIndex((s: any) => s.id === details.currentInterviewStage!.id);
            if (stageIdx !== -1) {
              currentStageIndex = stageIdx + 1; // Convert to 1-indexed
              stageProgress = `${currentStageIndex}/${totalStages}`;
            }
          }

          return {
            ...candidate,
            pipelineStage: details.currentInterviewStage?.title || candidate.pipelineStage,
            currentStageIndex,
            totalStages,
            stageProgress,
            interviewEvents,
            allFeedback,
            latestOverallRecommendation: latestFeedback?.overallRecommendation || null,
            latestFeedbackAuthor: latestFeedback?.interviewer || null,
            latestFeedbackDate: latestFeedback?.submittedAt || null,
            feedbackCount: allFeedback.length
          };
        })
      );

      enrichedCandidates.push(...enrichedBatch);
      console.log(`    Enriched ${enrichedCandidates.length}/${candidates.length} candidates`);
    }

    console.log(`  ✓ Enrichment complete`);
    return enrichedCandidates;
  }
}
