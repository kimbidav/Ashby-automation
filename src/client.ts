import fetch from 'cross-fetch';
import { AshbySession, Candidate, Company, Job } from './types.js';

export interface RawPipelineRow {
  // Shape will be filled in once endpoints are known.
  [key: string]: unknown;
}

export interface PipelineFetchResult {
  companies: Company[];
  jobs: Job[];
  candidates: Candidate[];
}

export function createAuthHeaders(session: AshbySession): Record<string, string> {
  const cookieHeader = Object.entries(session.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  const headers: Record<string, string> = {
    cookie: cookieHeader,
    accept: 'application/json'
  };

  if (session.csrfToken) {
    headers['x-csrf-token'] = session.csrfToken;
  }

  return headers;
}

export async function fetchWithSession(
  session: AshbySession,
  url: string,
  init?: RequestInit
): Promise<unknown> {
  const headers = {
    ...createAuthHeaders(session),
    ...(init?.headers as Record<string, string> | undefined)
  };

  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    throw new Error(`Request failed ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

interface GraphQLResponse<T> {
  data: T;
  errors?: Array<{ message: string }>;
}

interface JobsPipelinesResponse {
  jobsPipelines: Array<{
    jobId: string;
    jobTitle: string;
    jobLocationName: string | null;
    customRequisitionId: string | null;
    confidential: boolean;
    userFollowsOrHasRole: boolean;
    applicationCount: number;
    __typename: string;
  }>;
}

interface ApplicationResult {
  id: string;
  job: {
    id: string;
    title: string;
    __typename: string;
  };
  candidate: {
    id: string;
    name: string;
    company: string | null;
    isBlinded: boolean;
    __typename: string;
  };
  source?: {
    id: string;
    title: string;
    __typename: string;
  } | null;
  creditedToUser?: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    __typename: string;
  } | null;
  applicationStatus: {
    description: string;
    priority: number | null;
    dueAt: string | null;
    __typename: string;
  } | null;
  createdAt: string;
  currentInterviewStage: {
    id: string;
    title?: string; // Stage name like "Technical Interviews", "Hard Skills Check"
    interviewPlanId: string;
    stageType: string;
    __typename: string;
  } | null;
  extraFields: Record<string, unknown>;
  __typename: string;
}

interface ApplicationsResponse {
  result: {
    results: ApplicationResult[];
    nextCursor: string | null;
    moreDataAvailable: boolean;
    opaqueFilter: string | null;
    __typename: string;
  };
}

async function fetchCsrfToken(session: AshbySession, retries = 2): Promise<string> {
  const url = 'https://app.ashbyhq.com/api/csrf/token';
  const headers = createAuthHeaders(session);
  
  // Debug: Check if we have the critical auth cookie
  if (!session.cookies['ashby_session_token'] && !session.cookies['authenticated']) {
    throw new Error('Missing authentication cookies. Please run "auth" or "auth-cookie" to refresh your session.');
  }
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      method: 'GET',
      headers
    });

    if (res.ok) {
      const response = await res.json() as { token: string };
      return response.token;
    }

    // If 401, the session might be invalid - don't retry
    if (res.status === 401) {
      const errorText = await res.text();
      // Check if cookies are present
      const hasAuthCookie = session.cookies['ashby_session_token'] || session.cookies['authenticated'];
      const errorMsg = hasAuthCookie 
        ? `Session appears expired. Please refresh your cookies by running 'auth-cookie' again with fresh cookies from your browser.`
        : `Missing authentication cookies. Please run 'auth' or 'auth-cookie' to set up your session.`;
      throw new Error(`Failed to fetch CSRF token: ${res.status} ${res.statusText}. ${errorMsg}`);
    }

    // For other errors, retry
    if (attempt < retries) {
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1))); // Exponential backoff
      continue;
    }

    const errorText = await res.text();
    throw new Error(`Failed to fetch CSRF token after ${retries + 1} attempts: ${res.status} ${res.statusText}. Response: ${errorText.substring(0, 200)}`);
  }

  throw new Error('Unreachable code');
}

async function graphqlQuery<T>(
  session: AshbySession,
  operationName: string,
  query: string,
  variables: Record<string, unknown> = {},
  forceRefreshCsrf = false
): Promise<T> {
  // Ensure we have a CSRF token - refresh if forced or missing
  let csrfToken = session.csrfToken;
  if (!csrfToken || forceRefreshCsrf) {
    if (forceRefreshCsrf) {
      console.log('  Refreshing CSRF token after org switch...');
    } else {
      console.log('Fetching CSRF token...');
    }
    csrfToken = await fetchCsrfToken(session);
    session.csrfToken = csrfToken; // Update session with new token
  }

  const url = `https://app.ashbyhq.com/api/graphql?op=${operationName}`;
  const headers = createAuthHeaders(session);
  headers['content-type'] = 'application/json';
  if (csrfToken) {
    headers['x-csrf-token'] = csrfToken;
  }

  const body = JSON.stringify({
    operationName,
    query,
    variables
  });

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body
  });

  if (!res.ok) {
    throw new Error(`GraphQL request failed ${res.status} ${res.statusText}`);
  }

  const responseText = await res.text();
  let response: GraphQLResponse<T>;
  try {
    response = JSON.parse(responseText) as GraphQLResponse<T>;
  } catch (e) {
    console.error(`Failed to parse GraphQL response for ${operationName}:`, responseText.substring(0, 500));
    throw new Error(`Invalid JSON response: ${responseText.substring(0, 200)}`);
  }

  if (response.errors) {
    const errorMessages = response.errors.map(e => e.message).join(', ');
    console.error(`GraphQL errors for ${operationName}:`, errorMessages);
    throw new Error(`GraphQL errors: ${errorMessages}`);
  }

  return response.data;
}

export interface OrgInfo {
  id: string;
  name: string;
}

export async function fetchAvailableOrgs(session: AshbySession): Promise<OrgInfo[]> {
  // First try to get all orgs from available_identities endpoint
  const allOrgs = await fetchAllAvailableOrgs(session);
  if (allOrgs.length > 0) {
    // Return as OrgInfo (without userId, that's internal)
    return allOrgs.map(org => ({ id: org.id, name: org.name }));
  }

  // Fallback: get current org from session user query
  const sessionUserQuery = `
    query ApiGetSessionUser {
      user: sessionUserV2 {
        id
        organizationId
        organizationName
        __typename
      }
    }
  `;

  try {
    const response = await graphqlQuery<{ user: { organizationId: string; organizationName: string } }>(
      session,
      'ApiGetSessionUser',
      sessionUserQuery
    );
    
    if (response.user.organizationId) {
      return [{
        id: response.user.organizationId,
        name: response.user.organizationName || response.user.organizationId
      }];
    }
    return [];
  } catch (error) {
    console.error('Error fetching available orgs:', error);
    return [];
  }
}

async function switchOrgContext(session: AshbySession, userId: string): Promise<void> {
  // Switch org context using the change_user endpoint
  const url = `https://app.ashbyhq.com/api/auth/change_user/${userId}`;
  
  // Always fetch a fresh CSRF token before switching
  const csrfToken = await fetchCsrfToken(session);
  const headers = createAuthHeaders(session);
  headers['x-csrf-token'] = csrfToken;
  headers['content-type'] = 'application/json';

  const res = await fetch(url, {
    method: 'POST',
    headers
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to switch org context: ${res.status} ${res.statusText}. Response: ${errorText.substring(0, 200)}`);
  }

  // Wait a moment for the switch to complete
  await new Promise(resolve => setTimeout(resolve, 500));

  // Update cookies from response headers (if any)
  const setCookieHeaders = res.headers.get('set-cookie');
  if (setCookieHeaders) {
    // Parse and update session cookies
    const cookies = setCookieHeaders.split(',').map(c => c.trim());
    for (const cookie of cookies) {
      const [nameValue] = cookie.split(';');
      const [name, value] = nameValue.split('=');
      if (name && value) {
        session.cookies[name.trim()] = value.trim();
      }
    }
  }

  // Always fetch a fresh CSRF token after switching (critical!)
  // The old token is invalid for the new org context
  try {
    const newCsrfToken = await fetchCsrfToken(session);
    session.csrfToken = newCsrfToken;
    console.log(`  ✓ Switched org context, refreshed CSRF token`);
  } catch (error) {
    console.warn(`  ⚠️  Could not fetch new CSRF token after org switch: ${error}`);
    // Clear the old token so next query will fetch a new one
    session.csrfToken = undefined;
    throw new Error(`Failed to refresh CSRF token after org switch. Session may be invalid.`);
  }

  // Verify the switch worked by checking the session user
  try {
    const sessionUserQuery = `
      query ApiGetSessionUser {
        user: sessionUserV2 {
          organizationId
          organizationName
          __typename
        }
      }
    `;
    const userResponse = await graphqlQuery<{ user: { organizationId: string; organizationName: string } }>(
      session,
      'ApiGetSessionUser',
      sessionUserQuery,
      {},
      false // Don't force refresh, we just got a fresh token
    );
    console.log(`  ✓ Verified switch to org: ${userResponse.user.organizationName || userResponse.user.organizationId}`);
  } catch (error) {
    console.warn(`  ⚠️  Could not verify org switch: ${error}`);
    // Continue anyway - the next query will reveal if it worked
  }
}

interface AvailableIdentityResponse {
  user: {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
  };
  organization: {
    id: string;
    name: string;
    domainName: string;
  };
}

interface OrgInfoWithUserId extends OrgInfo {
  userId: string;
}

export async function fetchAllAvailableOrgs(session: AshbySession): Promise<OrgInfoWithUserId[]> {
  // First, try to get a CSRF token to validate the session
  let csrfToken: string;
  try {
    csrfToken = await fetchCsrfToken(session);
    session.csrfToken = csrfToken; // Update session
  } catch (error) {
    console.error('Cannot fetch CSRF token - session may be invalid');
    throw error;
  }
  
  // Fetch all available identities (orgs) the user can access
  const url = 'https://app.ashbyhq.com/api/auth/available_identities';
  const headers = createAuthHeaders(session);
  headers['x-csrf-token'] = csrfToken;

  const res = await fetch(url, {
    method: 'GET',
    headers
  });

  if (!res.ok) {
    console.warn(`Could not fetch available identities: ${res.status} ${res.statusText}`);
    return [];
  }

  const identities = await res.json() as AvailableIdentityResponse[];
  
  // Map to OrgInfoWithUserId, deduplicating by organizationId (keep first userId for each org)
  const orgMap = new Map<string, OrgInfoWithUserId>();
  for (const identity of identities) {
    if (!orgMap.has(identity.organization.id)) {
      orgMap.set(identity.organization.id, {
        id: identity.organization.id,
        name: identity.organization.name,
        userId: identity.user.id
      });
    }
  }

  return Array.from(orgMap.values());
}

export async function fetchPipelineForOrg(
  session: AshbySession, 
  orgId: string, 
  userId?: string
): Promise<PipelineFetchResult> {
  // If we have a userId, switch to that org context first
  let switchedOrg = false;
  if (userId && orgId !== 'default') {
    try {
      await switchOrgContext(session, userId);
      switchedOrg = true;
    } catch (error) {
      console.error(`  Failed to switch to org ${orgId}:`, error);
      // Return empty result if we can't switch
      return {
        companies: [],
        jobs: [],
        candidates: []
      };
    }
  }
  
  if (orgId !== 'default') {
    console.log(`  Fetching pipeline data for org: ${orgId}`);
  } else {
    console.log(`  Fetching pipeline data for current org context`);
  }
  
  // Step 1: Fetch open jobs
  const openJobsQuery = `
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

  let jobsData: JobsPipelinesResponse;
  try {
    jobsData = await graphqlQuery<JobsPipelinesResponse>(
      session,
      'ApiOpenJobs',
      openJobsQuery,
      {
        onlyIncludeOpenJobs: true,
        onlyIncludeJobsUserFollowsOrHasRole: false
      },
      switchedOrg // Force refresh CSRF token if we just switched orgs
    );
    console.log(`Found ${jobsData.jobsPipelines.length} open jobs`);
  } catch (error) {
    console.error('Error fetching jobs:', error);
    throw error;
  }

  // Step 2: Fetch active applications for all open jobs
  // We'll use applicationsByPrebuiltView with ApplicationActive view
  const applicationsQuery = `
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
          source {
            id
            title
            __typename
          }
          creditedToUser {
            id
            firstName
            lastName
            email
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
            title
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

  const allApplications: ApplicationResult[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  // Fetch all pages of applications
  try {
    while (hasMore) {
      const appsData: ApplicationsResponse = await graphqlQuery<ApplicationsResponse>(
        session,
        'ApiGetActiveApplications',
        applicationsQuery,
        {
          customFilter: null,
          extraFields: [],
          orderByFields: [{ field: 'submitted_at', ascending: false }],
          cursor,
          searchTerm: '',
          queryContext: null,
          limit: 100
        },
        false // Only force refresh on first call after switch
      );

      allApplications.push(...appsData.result.results);
      cursor = appsData.result.nextCursor;
      hasMore = appsData.result.moreDataAvailable;
      console.log(`Fetched ${appsData.result.results.length} applications (total: ${allApplications.length}, more: ${hasMore})`);
    }
    console.log(`Total applications fetched: ${allApplications.length}`);
  } catch (error) {
    console.error('Error fetching applications:', error);
    // Continue with empty applications if this fails
    console.log('Continuing with empty applications list');
  }

  // Step 3: Get org info for this orgId
  let orgName: string | undefined;
  try {
    const sessionUserQuery = `
      query ApiGetSessionUser {
        user: sessionUserV2 {
          organizationId
          organizationName
          __typename
        }
      }
    `;
    const userResponse = await graphqlQuery<{ user: { organizationId: string; organizationName: string } }>(
      session,
      'ApiGetSessionUser',
      sessionUserQuery
    );
    if (userResponse.user.organizationId === orgId) {
      orgName = userResponse.user.organizationName;
    }
  } catch (error) {
    // If we can't get org name, we'll just use the orgId
    console.warn(`Could not fetch org name for ${orgId}, using ID only`);
  }

  // Step 4: Normalize the data
  return normalizePipelineData(jobsData.jobsPipelines, allApplications, orgId, orgName);
}

function normalizePipelineData(
  jobsPipelines: JobsPipelinesResponse['jobsPipelines'],
  applications: ApplicationResult[],
  orgId: string,
  orgName?: string
): PipelineFetchResult {
  const companies = new Map<string, Company>();
  const jobs = new Map<string, Job>();
  const candidates: Candidate[] = [];

  // Process jobs and extract company info
  for (const jobPipeline of jobsPipelines) {
    // Extract company name from job title or use a default
    // In Ashby, jobs might be associated with companies, but we'll infer from job title
    // or use a default company for now
    const companyName = 'Default Company'; // TODO: Extract from job data if available
    const companyId = `company-${companyName}`;

    if (!companies.has(companyId)) {
      companies.set(companyId, {
        id: companyId,
        name: companyName
      });
    }

    if (!jobs.has(jobPipeline.jobId)) {
      jobs.set(jobPipeline.jobId, {
        id: jobPipeline.jobId,
        title: jobPipeline.jobTitle,
        companyId
      });
    }
  }

  // Process applications to create candidates
  for (const app of applications) {
    const jobId = app.job.id;
    const jobTitle = app.job.title;

    // Extract company from candidate's company field or job title
    let companyName = app.candidate.company || 'Default Company';
    if (!companyName || companyName.trim() === '') {
      companyName = 'Default Company';
    }
    const companyId = `company-${companyName}`;

    if (!companies.has(companyId)) {
      companies.set(companyId, {
        id: companyId,
        name: companyName
      });
    }

    // Ensure job exists
    if (!jobs.has(jobId)) {
      jobs.set(jobId, {
        id: jobId,
        title: jobTitle,
        companyId
      });
    }

    // Get current stage and stage type
    const currentStage = app.applicationStatus?.description ||
                        app.currentInterviewStage?.stageType ||
                        'Unknown';

    const stageType = app.currentInterviewStage?.stageType || null;

    // Determine pipeline stage: use currentInterviewStage.title if available,
    // otherwise fall back to applicationStatus for non-interview stages
    const pipelineStage = app.currentInterviewStage?.title || null;

    // Calculate days in stage (using createdAt as lastActivityAt for now)
    const lastActivityAt = app.createdAt;
    const daysInStage = computeDaysInStage(lastActivityAt);

    // Determine if scheduling is needed
    // True if: stage is interview-type AND no activity >= 7 days
    const needsScheduling = computeNeedsScheduling(stageType, daysInStage);

    // Interview stage progression - not available from API yet
    // TODO: These fields would require additional API endpoints or schema changes
    const currentStageIndex: number | null = null;
    const totalStages: number | null = null;
    const stageProgress: string | null = null;

    // Extract attribution (credited to)
    const creditedTo = app.creditedToUser
      ? `${app.creditedToUser.firstName} ${app.creditedToUser.lastName}`.trim() || app.creditedToUser.email
      : null;

    // Extract source
    const source = app.source?.title || null;

    candidates.push({
      id: app.candidate.id,
      applicationId: app.id, // Store application ID for detailed queries
      name: app.candidate.name,
      email: null,
      phone: null,
      currentStage,
      pipelineStage, // Capture from initial query
      stageType,
      currentStageIndex,
      totalStages,
      stageProgress,
      jobId,
      companyId,
      orgId,
      orgName,
      lastActivityAt,
      daysInStage,
      needsScheduling,
      creditedTo,
      source,
      decisionStatus: app.applicationStatus?.description || null,
      statusPriority: app.applicationStatus?.priority || null,
      statusDueAt: app.applicationStatus?.dueAt || null,
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
    jobs: Array.from(jobs.values()),
    candidates
  };
}

function computeDaysInStage(lastActivityAt: string): number {
  const last = new Date(lastActivityAt).getTime();
  const now = Date.now();
  const diffMs = now - last;
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

function computeNeedsScheduling(
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
function extractFeedbackText(submittedFormRender?: any): string | null {
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
export async function fetchApplicationDetails(
  session: AshbySession,
  applicationId: string
): Promise<{
  interviewEvents: any[];
  applicationStatus: any;
  currentInterviewStage: any;
  interviewPlan: any;
  job: any;
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
        job?: {
          id: string;
          title: string;
          interviewPlansWithActivities?: Array<{
            id: string;
            isDefault: boolean;
            interviewPlan?: {
              id: string;
              interviewStages?: Array<{
                id: string;
                title: string;
                stageType: string;
              }>;
            };
          }>;
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

    const response = await graphqlQuery<ApplicationDetailResponse>(
      session,
      'ApiApplication',
      query,
      { applicationId }
    );

    if (!response || !response.application) {
      return null;
    }

    return {
      interviewEvents: response.application.interviewEvents || [],
      applicationStatus: response.application.applicationStatus,
      currentInterviewStage: response.application.currentInterviewStage || null,
      interviewPlan: response.application.interviewPlan || null,
      job: response.application.job || null
    };
  } catch (error) {
    console.error(`  Error fetching application details for ${applicationId}:`, error);
    return null;
  }
}

/**
 * Enrich candidates with detailed interview feedback and ratings
 */
export async function enrichCandidatesWithDetails(
  session: AshbySession,
  candidates: Candidate[],
  orgInfos: Array<{ id: string; name: string; userId: string }>,
  options: { maxConcurrent?: number; fetchAll?: boolean } = {}
): Promise<Candidate[]> {
  const { maxConcurrent = 5, fetchAll = false } = options;

  console.log(`\nEnriching ${candidates.length} candidates with interview details...`);

  // Create a map of orgId -> userId for quick lookup
  const orgIdToUserId = new Map(orgInfos.map(org => [org.id, org.userId]));

  // Group candidates by org to minimize org switching
  const candidatesByOrg = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (!candidatesByOrg.has(candidate.orgId)) {
      candidatesByOrg.set(candidate.orgId, []);
    }
    candidatesByOrg.get(candidate.orgId)!.push(candidate);
  }

  console.log(`  Grouped into ${candidatesByOrg.size} organizations\n`);

  // Process candidates org by org to minimize context switching
  const enrichedCandidates: Candidate[] = [];
  let currentOrgContext: string | null = null;

  for (const [orgId, orgCandidates] of candidatesByOrg.entries()) {
    const userId = orgIdToUserId.get(orgId);

    if (!userId) {
      console.log(`  ⚠️  No userId for org ${orgId}, skipping ${orgCandidates.length} candidates`);
      enrichedCandidates.push(...orgCandidates);
      continue;
    }

    // Switch org context if needed
    if (currentOrgContext !== orgId) {
      const orgInfo = orgInfos.find(o => o.id === orgId);
      console.log(`  Switching to org: ${orgInfo?.name || orgId}`);

      try {
        await switchOrgContext(session, userId);
        currentOrgContext = orgId;
      } catch (error: any) {
        console.error(`  ✗ Failed to switch to org ${orgId}:`, error.message);
        enrichedCandidates.push(...orgCandidates);
        continue;
      }
    }

    // Process candidates in batches within this org
    for (let i = 0; i < orgCandidates.length; i += maxConcurrent) {
      const batch = orgCandidates.slice(i, i + maxConcurrent);

      const enrichedBatch = await Promise.all(
        batch.map(async (candidate) => {
          // Skip if not fetching all and candidate doesn't need enrichment
          if (!fetchAll && !candidate.needsScheduling) {
            return candidate;
          }

          const details = await fetchApplicationDetails(session, candidate.applicationId);

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
              feedbackText: extractFeedbackText(ie.scorecardSubmission?.submittedFormRender),
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

        // Try to get interview plan from application first, then fall back to job's default plan
        let interviewPlan = details.interviewPlan;

        if (!interviewPlan && details.job?.interviewPlansWithActivities) {
          // Find the default interview plan from the job
          const defaultPlanConfig = details.job.interviewPlansWithActivities.find(
            (p: any) => p.isDefault === true
          );
          if (defaultPlanConfig?.interviewPlan?.interviewStages) {
            interviewPlan = defaultPlanConfig.interviewPlan;
          }
        }

        if (interviewPlan && details.currentInterviewStage) {
          const allStages = interviewPlan.interviewStages;

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
    }

    console.log(`  ✓ Enriched ${orgCandidates.length} candidates from ${orgInfos.find(o => o.id === orgId)?.name || orgId}`);
  }

  console.log(`\n✓ Enrichment complete: ${enrichedCandidates.length}/${candidates.length} candidates\n`);
  return enrichedCandidates;
}
