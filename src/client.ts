/**
 * client.ts — Ashby GraphQL API client. The core data-fetching layer.
 *
 * Talks to Ashby's internal (non-public) GraphQL API at:
 *   https://app.ashbyhq.com/api/graphql?op=<OperationName>
 *
 * Key exports:
 *   fetchAllAvailableOrgs()        List every org the session user can access (via /api/auth/available_identities)
 *   fetchPipelineForOrg()          Fetch open jobs + all active applications for one org (with inline enrichment)
 *   createAuthHeaders()            Build cookie/CSRF headers for raw fetch calls
 *
 * Multi-org flow (runs once per org during extraction):
 *   1. GET /api/auth/available_identities  → list of { orgId, userId }
 *   2. POST /api/auth/change_user/{userId} → switches the session to that org's context
 *   3. GET /api/csrf/token                 → fresh CSRF token required after every org switch
 *   4. Combined InitialFetch query: jobs + first app page + session user in one request
 *   5. Paginate remaining applications (cursor-based, 100/page)
 *
 * Enrichment is inline — the applicationsByPrebuiltView query includes interviewEvents,
 * scorecardSubmissions, feedback text, and interview plan stages. No separate per-candidate
 * API calls are needed. Data is extracted during normalizePipelineData().
 */
import fetch from 'cross-fetch';
import type { APIResponse } from 'playwright';
import { AshbySession, Candidate, Company, InterviewEvent, Job } from './types.js';

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

const REQUEST_TIMEOUT_MS = 15_000; // 15s per API call — fail fast, don't hang

function withTimeout(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * Lowest-common-denominator response surface used by client.ts. Lets
 * doFetch() return one shape regardless of transport (cross-fetch
 * Response vs Playwright APIResponse).
 */
export interface UnifiedResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
  text(): Promise<string>;
}

function adaptPlaywrightResponse(res: APIResponse): UnifiedResponse {
  // Playwright returns headers as a Record<string,string>, lowercased.
  const headersMap = res.headers();
  return {
    ok: res.ok(),
    status: res.status(),
    statusText: res.statusText() || '',
    headers: {
      get(name: string): string | null {
        return headersMap[name.toLowerCase()] ?? null;
      },
    },
    json: () => res.json(),
    text: () => res.text(),
  };
}

function adaptNodeResponse(res: Response): UnifiedResponse {
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText || '',
    headers: { get: (name: string) => res.headers.get(name) },
    json: () => res.json(),
    text: () => res.text(),
  };
}

/**
 * Pull individual Set-Cookie header values out of a fetch Response.
 * cross-fetch resolves to node-fetch v2 here, whose Headers exposes the
 * non-standard raw() returning string arrays; undici (and future runtimes)
 * expose getSetCookie(). headers.get() is the last resort — it joins
 * multiple Set-Cookie values with ", ", so split only on commas that start
 * a new `name=` pair (an `Expires=Thu, 01 Jan...` comma doesn't match).
 */
function extractSetCookies(res: Response): string[] {
  const h = res.headers as any;
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  if (typeof h.raw === 'function') return h.raw()['set-cookie'] ?? [];
  const joined = res.headers.get('set-cookie');
  if (!joined) return [];
  return joined.split(/,(?=\s*[a-zA-Z0-9!#$%&'*+\-.^_`|~]+=)/).map((c) => c.trim());
}

/**
 * Mirror Set-Cookie values into the in-memory session cookie map. Ashby
 * rotates ashby_session_token every few minutes; without this, the next
 * request goes out with the pre-rotation token and 401s mid-extraction.
 * Honors deletions (empty value / Max-Age=0 / past Expires). Returns true
 * if any cookie actually changed, so the caller can persist the new map.
 */
function mirrorSetCookies(session: AshbySession, setCookies: string[]): boolean {
  let changed = false;
  for (const raw of setCookies) {
    const segments = raw.split(';');
    const nameValue = segments[0] ?? '';
    const eqIndex = nameValue.indexOf('=');
    if (eqIndex <= 0) continue;
    const name = nameValue.slice(0, eqIndex).trim();
    const value = nameValue.slice(eqIndex + 1).trim();
    if (!name) continue;

    let expired = value === '';
    for (const seg of segments.slice(1)) {
      const [attr, attrValue] = seg.split('=').map((s) => s?.trim());
      const attrLower = (attr || '').toLowerCase();
      if (attrLower === 'max-age' && Number(attrValue) <= 0) expired = true;
      if (attrLower === 'expires' && attrValue) {
        const ts = Date.parse(seg.slice(seg.indexOf('=') + 1).trim());
        if (!Number.isNaN(ts) && ts < Date.now()) expired = true;
      }
    }

    if (expired) {
      if (name in session.cookies) {
        delete session.cookies[name];
        changed = true;
      }
    } else if (session.cookies[name] !== value) {
      session.cookies[name] = value;
      changed = true;
    }
  }
  return changed;
}

/**
 * Single transport-aware HTTP entry point for the Ashby client.
 *
 * Two modes, picked by `session.requestContext`:
 *
 *   - **Live mode** (`requestContext` set, by server.ts liveContext): route
 *     through Playwright's APIRequestContext, which inherits cookies from
 *     the live BrowserContext the user did SSO in. Ashby keeps the session
 *     fresh because every call comes "from" the browser it knows.
 *
 *   - **Legacy mode** (no `requestContext`): cookie header from the
 *     in-memory `session.cookies` map + cross-fetch. Same behavior the
 *     CLI / cookie-paste path has always had.
 *
 * Caller passes only resource-specific headers (content-type, etc.).
 * doFetch handles auth (cookie OR live context) + csrf + timeout.
 */
async function doFetch(
  session: AshbySession,
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<UnifiedResponse> {
  const callerHeaders: Record<string, string> = { ...(init?.headers || {}) };
  if (!callerHeaders.accept) callerHeaders.accept = 'application/json';
  if (session.csrfToken && !callerHeaders['x-csrf-token']) {
    callerHeaders['x-csrf-token'] = session.csrfToken;
  }

  if (session.requestContext) {
    const res = await session.requestContext.fetch(url, {
      method: init?.method || 'GET',
      headers: callerHeaders,
      data: init?.body,
      timeout: REQUEST_TIMEOUT_MS,
      failOnStatusCode: false,
    });
    return adaptPlaywrightResponse(res);
  }

  // Legacy: cookies from session.cookies map.
  const cookieHeader = Object.entries(session.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  const headers: Record<string, string> = { cookie: cookieHeader, ...callerHeaders };
  const res = await fetch(url, {
    method: init?.method || 'GET',
    headers,
    body: init?.body,
    signal: withTimeout(REQUEST_TIMEOUT_MS),
  });

  // Ashby rotates session cookies on arbitrary responses, not just org
  // switches — mirror every rotation so the next request stays authenticated,
  // and let the owner persist the new map (server.ts writes it to
  // .ashby-session.json so the rotation chain survives across runs).
  // Only successful responses advance the chain: a 401's Set-Cookie clears
  // the token, and mirroring that would wipe a jar that a concurrent
  // response may have just validly rotated.
  // Note: node-fetch follows redirects and drops intermediate Set-Cookie
  // headers; fine here, the GraphQL/JSON endpoints never redirect.
  if (res.ok && mirrorSetCookies(session, extractSetCookies(res))) {
    session.onCookiesRotated?.(session);
  }

  return adaptNodeResponse(res);
}

export async function fetchWithSession(
  session: AshbySession,
  url: string,
  init?: RequestInit
): Promise<unknown> {
  const res = await doFetch(session, url, {
    method: (init?.method as string | undefined),
    headers: init?.headers as Record<string, string> | undefined,
    body: typeof init?.body === 'string' ? init.body : undefined,
  });
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
    title?: string;
    interviewPlanId: string;
    stageType: string;
    __typename: string;
  } | null;
  interviewPlan?: {
    id: string;
    interviewStages: Array<{
      id: string;
      title: string;
      stageType: string;
    }>;
  } | null;
  interviewEvents?: Array<{
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
            fieldValue?: { value?: any };
          }>;
          sections?: Array<{
            fieldEntries?: Array<{
              field: string;
              fieldValue?: { value?: any };
            }>;
          }>;
        };
      } | null;
      isFeedbackSubmitted: boolean;
    }>;
  }>;
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

export async function fetchCsrfToken(session: AshbySession, retries = 2): Promise<string> {
  const url = 'https://app.ashbyhq.com/api/csrf/token';

  // Auth check only applies to the cookie-header path. The live
  // BrowserContext path carries cookies in the browser jar — they may not
  // be mirrored into session.cookies and we shouldn't refuse a live call
  // just because session.cookies happens to be empty.
  if (!session.requestContext &&
      !session.cookies['ashby_session_token'] &&
      !session.cookies['authenticated']) {
    throw new Error('Missing authentication cookies. Please run "auth" or "auth-cookie" to refresh your session.');
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await doFetch(session, url, { method: 'GET' });

    if (res.ok) {
      const response = await res.json() as { token: string };
      return response.token;
    }

    // If 401, the session might be invalid - don't retry
    if (res.status === 401) {
      const errorText = await res.text();
      // Adapt the message to whichever transport we're using.
      const hasAuthCookie = session.cookies['ashby_session_token'] || session.cookies['authenticated'];
      let errorMsg: string;
      if (session.requestContext) {
        errorMsg = 'Live browser session no longer authenticated. Re-run Log into Ashby.';
      } else if (hasAuthCookie) {
        errorMsg = "Session appears expired. Please refresh your cookies by running 'auth-cookie' again with fresh cookies from your browser.";
      } else {
        errorMsg = "Missing authentication cookies. Please run 'auth' or 'auth-cookie' to set up your session.";
      }
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
  forceRefreshCsrf = false,
  retries = 2
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

  for (let attempt = 0; attempt <= retries; attempt++) {
    const body = JSON.stringify({
      operationName,
      query,
      variables
    });

    const res = await doFetch(session, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    if (!res.ok) {
      // 403 usually means stale CSRF — refresh and retry once
      if (res.status === 403 && attempt < retries) {
        console.log(`  CSRF likely stale (403), refreshing and retrying...`);
        try {
          session.csrfToken = await fetchCsrfToken(session);
        } catch { /* will fail on next attempt */ }
        continue;
      }
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
      const isTransient = response.errors.some(e =>
        e.message.includes('Unidentified server error') ||
        e.message.includes('looking into it')
      );

      if (isTransient && attempt < retries) {
        const delay = 1000 * (attempt + 1);
        console.warn(`  ⚠️  Transient error for ${operationName}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        // Refresh CSRF token before retry in case it went stale
        try {
          session.csrfToken = await fetchCsrfToken(session);
        } catch { /* ignore, will try with existing token */ }
        continue;
      }

      console.error(`GraphQL errors for ${operationName}:`, errorMessages);
      throw new Error(`GraphQL errors: ${errorMessages}`);
    }

    return response.data;
  }

  throw new Error('Unreachable code in graphqlQuery');
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
  const url = `https://app.ashbyhq.com/api/auth/change_user/${userId}`;

  const res = await doFetch(session, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to switch org context: ${res.status} ${res.statusText}. Response: ${errorText.substring(0, 200)}`);
  }

  // Set-Cookie mirroring happens centrally in doFetch — the org switch's
  // session updates are already in session.cookies by the time we get here.

  // The CSRF token is IDENTITY-scoped and change_user switches identity, so
  // the old token is invalid from this point on. Refresh it eagerly: Ashby
  // answers a stale-CSRF GraphQL call with 401 (not the 403 graphqlQuery's
  // self-heal listens for) and revokes the whole session chain — observed
  // live when the enrichment pass queried right after a switch without
  // refreshing, killing every subsequent request in the run.
  session.csrfToken = await fetchCsrfToken(session);
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
  const res = await doFetch(session, url, { method: 'GET' });

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
  
  // Application fields fragment (shared between initial combined query and pagination queries)
  const applicationFieldsFragment = `
          id
          job {
            id
            title
            interviewPlansWithActivities {
              id
              isDefault
              interviewPlan {
                ... on CustomInterviewPlan {
                  id
                  interviewStages { id title stageType __typename }
                  __typename
                }
                ... on InterviewPlanTemplate {
                  id
                  interviewStages { id title stageType __typename }
                  __typename
                }
                __typename
              }
              __typename
            }
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
          interviewPlan {
            id
            interviewStages {
              id
              title
              stageType
              __typename
            }
            __typename
          }
          interviewEvents {
            id
            startTime
            endTime
            interview {
              id
              title
              __typename
            }
            interviewerEvents {
              id
              interviewer {
                id
                firstName
                lastName
                email
                __typename
              }
              scorecardSubmission {
                ... on Scorecard {
                  id
                  overallRecommendation
                  submittedAt
                  submittedFormRender {
                    id
                    fieldEntries {
                      id
                      field
                      fieldValue {
                        ... on JSONBox { value __typename }
                        __typename
                      }
                      __typename
                    }
                    sections {
                      fieldEntries {
                        id
                        field
                        fieldValue {
                          ... on JSONBox { value __typename }
                          __typename
                        }
                        __typename
                      }
                      __typename
                    }
                    __typename
                  }
                  __typename
                }
                ... on ScorecardPermissionDenied { reason __typename }
                __typename
              }
              isFeedbackSubmitted
              __typename
            }
            __typename
          }
          extraFields
          __typename`;

  // Step 1: Combined initial query — jobs + first page of applications + session user in one request
  const initialQuery = `
    query InitialFetch(
      $onlyIncludeOpenJobs: Boolean = true,
      $onlyIncludeJobsUserFollowsOrHasRole: Boolean = false,
      $customFilter: JSON,
      $extraFields: [String],
      $orderByFields: [OrderByFieldInput],
      $cursor: String,
      $searchTerm: String,
      $queryContext: JSON,
      $limit: Int
    ) {
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
${applicationFieldsFragment}
        }
        nextCursor
        moreDataAvailable
        opaqueFilter
        __typename
      }
      user: sessionUserV2 {
        organizationId
        organizationName
        __typename
      }
    }
  `;

  interface InitialFetchResponse extends JobsPipelinesResponse, ApplicationsResponse {
    user: { organizationId: string; organizationName: string };
  }

  let jobsData: JobsPipelinesResponse;
  const allApplications: ApplicationResult[] = [];
  let cursor: string | null = null;
  let hasMore = true;
  let orgName: string | undefined;

  // Fallback query with minimal fields (no scorecard/interview enrichment)
  // Used when the full query triggers server errors for certain orgs
  const fallbackApplicationFields = `
          id
          job {
            id
            title
            interviewPlansWithActivities {
              id
              isDefault
              interviewPlan {
                ... on CustomInterviewPlan {
                  id
                  interviewStages { id title stageType __typename }
                  __typename
                }
                ... on InterviewPlanTemplate {
                  id
                  interviewStages { id title stageType __typename }
                  __typename
                }
                __typename
              }
              __typename
            }
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
          interviewPlan {
            id
            interviewStages {
              id
              title
              stageType
              __typename
            }
            __typename
          }
          interviewEvents {
            id
            startTime
            endTime
            interview {
              id
              title
              __typename
            }
            interviewerEvents {
              id
              interviewer {
                id
                firstName
                lastName
                email
                __typename
              }
              isFeedbackSubmitted
              __typename
            }
            __typename
          }
          extraFields
          __typename`;

  let useFallbackQuery = false;

  // Fetch initial combined data (jobs + first app page + session user)
  const initialVars = {
    onlyIncludeOpenJobs: true,
    onlyIncludeJobsUserFollowsOrHasRole: false,
    customFilter: null,
    extraFields: [],
    orderByFields: [{ field: 'submitted_at', ascending: false }],
    cursor: null,
    searchTerm: '',
    queryContext: null,
    limit: 100
  };

  try {
    const initialData = await graphqlQuery<InitialFetchResponse>(
      session,
      'InitialFetch',
      initialQuery,
      initialVars,
      switchedOrg
    );

    jobsData = { jobsPipelines: initialData.jobsPipelines };
    console.log(`Found ${jobsData.jobsPipelines.length} open jobs`);

    allApplications.push(...initialData.result.results);
    cursor = initialData.result.nextCursor;
    hasMore = initialData.result.moreDataAvailable;
    console.log(`Fetched ${initialData.result.results.length} applications (total: ${allApplications.length}, more: ${hasMore})`);

    if (initialData.user.organizationId === orgId) {
      orgName = initialData.user.organizationName;
    }
  } catch (error: any) {
    // If the full query fails (even after retries in graphqlQuery), try a fallback
    // with stripped-down fields (no scorecard data which can cause server errors)
    const isServerError = error?.message?.includes('Unidentified server error') ||
                          error?.message?.includes('looking into it');
    if (isServerError) {
      console.warn(`  ⚠️  Full query failed for org ${orgId}, retrying with simplified query (no scorecard data)...`);
      useFallbackQuery = true;

      const fallbackInitialQuery = `
        query InitialFetch(
          $onlyIncludeOpenJobs: Boolean = true,
          $onlyIncludeJobsUserFollowsOrHasRole: Boolean = false,
          $customFilter: JSON,
          $extraFields: [String],
          $orderByFields: [OrderByFieldInput],
          $cursor: String,
          $searchTerm: String,
          $queryContext: JSON,
          $limit: Int
        ) {
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
      ${fallbackApplicationFields}
            }
            nextCursor
            moreDataAvailable
            opaqueFilter
            __typename
          }
          user: sessionUserV2 {
            organizationId
            organizationName
            __typename
          }
        }
      `;

      try {
        const fallbackData = await graphqlQuery<InitialFetchResponse>(
          session,
          'InitialFetch',
          fallbackInitialQuery,
          initialVars,
          true // force CSRF refresh
        );

        jobsData = { jobsPipelines: fallbackData.jobsPipelines };
        console.log(`  Found ${jobsData.jobsPipelines.length} open jobs (fallback)`);

        allApplications.push(...fallbackData.result.results);
        cursor = fallbackData.result.nextCursor;
        hasMore = fallbackData.result.moreDataAvailable;
        console.log(`  Fetched ${fallbackData.result.results.length} applications (fallback, total: ${allApplications.length}, more: ${hasMore})`);

        if (fallbackData.user.organizationId === orgId) {
          orgName = fallbackData.user.organizationName;
        }
      } catch (fallbackError) {
        console.error('  Error in fallback fetch:', fallbackError);
        throw fallbackError;
      }
    } else {
      console.error('Error in initial combined fetch:', error);
      throw error;
    }
  }

  // Fetch remaining pages of applications (cursor-dependent, must be sequential)
  if (hasMore) {
    const activeFields = useFallbackQuery ? fallbackApplicationFields : applicationFieldsFragment;
    const paginationQuery = `
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
${activeFields}
          }
          nextCursor
          moreDataAvailable
          opaqueFilter
          __typename
        }
      }
    `;

    const MAX_PAGES = 50; // 50 × 100 = 5000 candidates per org — safety valve
    let pageCount = 0;
    try {
      while (hasMore && pageCount < MAX_PAGES) {
        pageCount++;
        const appsData: ApplicationsResponse = await graphqlQuery<ApplicationsResponse>(
          session,
          'ApiGetActiveApplications',
          paginationQuery,
          {
            customFilter: null,
            extraFields: [],
            orderByFields: [{ field: 'submitted_at', ascending: false }],
            cursor,
            searchTerm: '',
            queryContext: null,
            limit: 100
          },
          false
        );

        allApplications.push(...appsData.result.results);
        cursor = appsData.result.nextCursor;
        hasMore = appsData.result.moreDataAvailable;
        console.log(`Fetched ${appsData.result.results.length} applications (total: ${allApplications.length}, more: ${hasMore})`);
      }
    } catch (error) {
      console.error('Error fetching application pages:', error);
      console.log(`Continuing with ${allApplications.length} applications fetched so far`);
    }
  }

  console.log(`Total applications fetched: ${allApplications.length}`);

  // Normalize the data (including enrichment data from expanded query)
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

    // Extract attribution (credited to)
    const creditedTo = app.creditedToUser
      ? `${app.creditedToUser.firstName} ${app.creditedToUser.lastName}`.trim() || app.creditedToUser.email
      : null;

    // Extract source
    const source = app.source?.title || null;

    // --- Enrichment: extract interview events, feedback, and stage progress inline ---
    const interviewEvents = (app.interviewEvents || []).map((event) => ({
      id: event.id,
      interviewTitle: event.interview.title,
      startTime: event.startTime,
      endTime: event.endTime,
      interviewers: event.interviewerEvents.map((ie) => ({
        name: `${ie.interviewer.firstName} ${ie.interviewer.lastName}`,
        email: ie.interviewer.email,
        overallRecommendation: ie.scorecardSubmission?.overallRecommendation || null,
        isFeedbackSubmitted: ie.isFeedbackSubmitted
      }))
    }));

    const allFeedback = (app.interviewEvents || []).flatMap((event) =>
      event.interviewerEvents
        .filter((ie) => ie.isFeedbackSubmitted)
        .map((ie) => ({
          interviewTitle: event.interview.title,
          interviewer: `${ie.interviewer.firstName} ${ie.interviewer.lastName}`,
          interviewerEmail: ie.interviewer.email,
          submittedAt: ie.scorecardSubmission?.submittedAt || event.endTime,
          overallRecommendation: ie.scorecardSubmission?.overallRecommendation || null,
          feedbackText: extractFeedbackText(ie.scorecardSubmission?.submittedFormRender),
          isFeedbackSubmitted: ie.isFeedbackSubmitted
        }))
    );

    const sortedFeedback = allFeedback
      .filter(f => f.submittedAt)
      .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
    const latestFeedback = sortedFeedback[0];

    // Calculate stage position in the pipeline
    let currentStageIndex: number | null = null;
    let totalStages: number | null = null;
    let stageProgress: string | null = null;

    let interviewPlan = app.interviewPlan;
    if (!interviewPlan && app.job?.interviewPlansWithActivities) {
      const defaultPlanConfig = app.job.interviewPlansWithActivities.find(
        (p) => p.isDefault === true
      );
      if (defaultPlanConfig?.interviewPlan?.interviewStages) {
        interviewPlan = defaultPlanConfig.interviewPlan as NonNullable<typeof interviewPlan>;
      }
    }

    if (interviewPlan && app.currentInterviewStage) {
      const allStages = interviewPlan.interviewStages;
      const filteredStages = allStages.filter((s) => {
        const st = s.stageType || '';
        return st === 'Active' || st === 'Offer';
      });
      totalStages = filteredStages.length;
      const stageIdx = filteredStages.findIndex((s) => s.id === app.currentInterviewStage!.id);
      if (stageIdx !== -1) {
        currentStageIndex = stageIdx + 1;
        stageProgress = `${currentStageIndex}/${totalStages}`;
      }
    }

    candidates.push({
      id: app.candidate.id,
      applicationId: app.id,
      name: app.candidate.name,
      email: null,
      phone: null,
      currentStage,
      currentStageId: app.currentInterviewStage?.id || null,
      currentStageEnteredAt: null,
      pipelineStage,
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
      websiteUrl: null,
      interviewEvents,
      allFeedback,
      latestOverallRecommendation: latestFeedback?.overallRecommendation || null,
      latestFeedbackAuthor: latestFeedback?.interviewer || undefined,
      latestFeedbackDate: latestFeedback?.submittedAt || undefined,
      feedbackCount: allFeedback.length
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
function extractTextFromRichText(richText: any): string | null {
  if (!richText || typeof richText !== 'object') return null;

  // ProseMirror structure: { content: { type: "doc", content: [...nodes] } }
  // or sometimes directly: { type: "doc", content: [...nodes] }
  const texts: string[] = [];
  function walk(node: any) {
    if (!node || typeof node !== 'object') return;
    if (node.text && typeof node.text === 'string') {
      texts.push(node.text);
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) walk(child);
    }
    // Handle the outer wrapper: { content: { type: "doc", content: [...] } }
    if (node.content && typeof node.content === 'object' && !Array.isArray(node.content)) {
      walk(node.content);
    }
  }
  walk(richText);
  return texts.length > 0 ? texts.join(' ').trim() : null;
}

function extractFeedbackText(submittedFormRender?: any): string | null {
  if (!submittedFormRender) return null;

  const parts: string[] = [];

  function extractFromEntries(entries: any[]) {
    for (const entry of entries) {
      const value = entry.fieldValue?.value;
      if (!value) continue;

      // Skip numeric-only values (likely the overall recommendation score)
      if (typeof value === 'number') continue;
      if (typeof value === 'string' && /^\d+$/.test(value.trim())) continue;

      if (typeof value === 'string' && value.trim()) {
        parts.push(value.trim());
      } else if (typeof value === 'object') {
        // ProseMirror rich text JSON
        const text = extractTextFromRichText(value);
        if (text) parts.push(text);
      }
    }
  }

  if (submittedFormRender.fieldEntries) {
    extractFromEntries(submittedFormRender.fieldEntries);
  }

  if (submittedFormRender.sections) {
    for (const section of submittedFormRender.sections) {
      if (section.fieldEntries) {
        extractFromEntries(section.fieldEntries);
      }
    }
  }

  return parts.length > 0 ? parts.join(' | ') : null;
}

function displayUserName(user: any): string {
  if (!user || typeof user !== 'object') return '';
  if (typeof user.name === 'string' && user.name.trim()) return user.name.trim();
  const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  return name || user.email || '';
}

function normalizeInterviewEvent(event: any, stage?: any): InterviewEvent | null {
  if (!event?.id || !event?.startTime || !event?.endTime) return null;
  return {
    id: event.id,
    interviewTitle: event.interview?.title || event.title || '',
    startTime: event.startTime,
    endTime: event.endTime,
    interviewStageId: stage?.id || event.interviewStage?.id || null,
    interviewStageTitle: stage?.title || event.interviewStage?.title || null,
    interviewers: (event.interviewerEvents || []).map((ie: any) => ({
      name: displayUserName(ie.interviewer),
      email: ie.interviewer?.email || '',
      overallRecommendation: ie.scorecardSubmission?.overallRecommendation || null,
      isFeedbackSubmitted: !!ie.isFeedbackSubmitted
    }))
  };
}

function upsertInterviewEvent(eventsById: Map<string, InterviewEvent>, event: InterviewEvent | null) {
  if (!event) return;
  const existing = eventsById.get(event.id);
  if (!existing) {
    eventsById.set(event.id, event);
    return;
  }
  eventsById.set(event.id, {
    ...existing,
    ...event,
    interviewStageId: event.interviewStageId || existing.interviewStageId || null,
    interviewStageTitle: event.interviewStageTitle || existing.interviewStageTitle || null,
    interviewers: event.interviewers.length >= existing.interviewers.length
      ? event.interviewers
      : existing.interviewers
  });
}

function collectInterviewEventsFromDetails(details: {
  interviewEvents?: any[];
  historyEvents?: any[];
  activeSubprocesses?: any[];
}): InterviewEvent[] {
  const eventsById = new Map<string, InterviewEvent>();

  for (const event of details.interviewEvents || []) {
    upsertInterviewEvent(eventsById, normalizeInterviewEvent(event));
  }

  for (const historyEvent of details.historyEvents || []) {
    const stage = historyEvent.newInterviewStage || null;
    for (const event of historyEvent.interviewEvents || []) {
      upsertInterviewEvent(eventsById, normalizeInterviewEvent(event, stage));
    }
  }

  for (const subprocess of details.activeSubprocesses || []) {
    if (subprocess?.__typename !== 'InterviewSchedule') continue;
    const stage = subprocess.interviewStage || null;
    for (const event of subprocess.scheduledInterviewEvents || []) {
      upsertInterviewEvent(eventsById, normalizeInterviewEvent(event, stage));
    }
    for (const event of subprocess.unscheduledInterviewEvents || []) {
      upsertInterviewEvent(eventsById, normalizeInterviewEvent(event, stage));
    }
  }

  return Array.from(eventsById.values()).sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
  );
}

function collectRawInterviewEventsFromDetails(details: {
  interviewEvents?: any[];
  historyEvents?: any[];
  activeSubprocesses?: any[];
}): any[] {
  const byId = new Map<string, any>();
  for (const event of details.interviewEvents || []) {
    if (event?.id) byId.set(event.id, event);
  }
  for (const historyEvent of details.historyEvents || []) {
    for (const event of historyEvent.interviewEvents || []) {
      if (event?.id) byId.set(event.id, event);
    }
  }
  for (const subprocess of details.activeSubprocesses || []) {
    if (subprocess?.__typename !== 'InterviewSchedule') continue;
    for (const event of [
      ...(subprocess.scheduledInterviewEvents || []),
      ...(subprocess.unscheduledInterviewEvents || []),
    ]) {
      if (event?.id) byId.set(event.id, event);
    }
  }
  return Array.from(byId.values());
}

function getCurrentStageEnteredAt(details: {
  currentInterviewStage?: any;
  historyEvents?: any[];
}): string | null {
  const currentStageId = details.currentInterviewStage?.id;
  if (!currentStageId) return null;
  const candidates = (details.historyEvents || [])
    .filter((event: any) => event?.newInterviewStage?.id === currentStageId && event.enteredStageAt)
    .sort((a: any, b: any) => new Date(b.enteredStageAt).getTime() - new Date(a.enteredStageAt).getTime());
  return candidates[0]?.enteredStageAt || null;
}

/**
 * Fetch detailed application data including interview feedback and ratings
 */
export async function fetchApplicationDetails(
  session: AshbySession,
  applicationId: string
): Promise<{
  interviewEvents: any[];
  historyEvents: any[];
  activeSubprocesses: any[];
  applicationStatus: any;
  currentInterviewStage: any;
  interviewPlan: any;
  job: any;
  archiveReason: any;
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
        historyEvents?: any[];
        activeSubprocesses?: any[];
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
      historyEvents: response.application.historyEvents || [],
      activeSubprocesses: response.application.activeSubprocesses || [],
      applicationStatus: response.application.applicationStatus,
      currentInterviewStage: response.application.currentInterviewStage || null,
      interviewPlan: response.application.interviewPlan || null,
      job: response.application.job || null,
      // The query requests archiveReason (ArchiveReasonAdminParts) — surface
      // it so callers can distinguish Hired from other archive outcomes.
      archiveReason: (response.application as any).archiveReason || null,
    };
  } catch (error) {
    console.error(`  Error fetching application details for ${applicationId}:`, error);
    return null;
  }
}

export interface ArchiveStatusResult {
  application_id: string;
  found: boolean;
  is_archived: boolean;
  archive_reason_text: string | null;
  archive_reason_type: string | null;
  status_description: string | null;
}

/**
 * Resolve the archive status of specific applications — used when a
 * candidate disappears from the active-pipeline sweep and the caller needs
 * to know WHY (Hired is a very different outcome from Did Not Respond).
 * Groups by org (each lookup must run in the owning org's context) and
 * fetches sequentially — safe for legacy cookie sessions under rotation.
 */
export async function fetchArchiveStatuses(
  session: AshbySession,
  applications: Array<{ application_id: string; org_id: string }>,
): Promise<ArchiveStatusResult[]> {
  const orgs = await fetchAllAvailableOrgs(session);
  const userIdByOrg = new Map(orgs.map((o) => [o.id, o.userId]));

  const byOrg = new Map<string, string[]>();
  for (const app of applications) {
    if (!app?.application_id || !app?.org_id) continue;
    if (!byOrg.has(app.org_id)) byOrg.set(app.org_id, []);
    byOrg.get(app.org_id)!.push(app.application_id);
  }

  const results: ArchiveStatusResult[] = [];
  for (const [orgId, appIds] of byOrg.entries()) {
    const userId = userIdByOrg.get(orgId);
    if (!userId) {
      for (const id of appIds) {
        results.push({ application_id: id, found: false, is_archived: false, archive_reason_text: null, archive_reason_type: null, status_description: null });
      }
      continue;
    }
    try {
      await switchOrgContext(session, userId);
    } catch (err: any) {
      console.warn(`  archive-status: failed to switch to org ${orgId}: ${err?.message}`);
      for (const id of appIds) {
        results.push({ application_id: id, found: false, is_archived: false, archive_reason_text: null, archive_reason_type: null, status_description: null });
      }
      continue;
    }
    for (const id of appIds) {
      const details = await fetchApplicationDetails(session, id);
      const reason = details?.archiveReason;
      results.push({
        application_id: id,
        found: !!details,
        is_archived: !!reason,
        archive_reason_text: reason?.text ?? null,
        archive_reason_type: reason?.builtInId ?? reason?.reasonType ?? null,
        status_description: details?.applicationStatus?.description ?? null,
      });
    }
  }
  return results;
}

/**
 * Enrich candidates with detailed interview feedback and ratings
 */
export async function enrichCandidatesWithDetails(
  session: AshbySession,
  candidates: Candidate[],
  orgInfos: Array<{ id: string; name: string; userId: string }>,
  options: {
    maxConcurrent?: number;
    fetchAll?: boolean;
    shouldEnrich?: (c: Candidate) => boolean;
    deadlineMs?: number;
  } = {}
): Promise<Candidate[]> {
  const {
    maxConcurrent = 5,
    fetchAll = false,
    shouldEnrich,
    deadlineMs,
  } = options;

  const startedAt = Date.now();
  const deadlineAt = deadlineMs ? startedAt + deadlineMs : Number.POSITIVE_INFINITY;
  const overBudget = () => Date.now() > deadlineAt;

  // A candidate gets the detail-query treatment when the caller's predicate
  // says so (most flexible), else when `fetchAll`, else when the bulk
  // `needsScheduling` heuristic flagged it. Predicate wins because callers
  // know best which records' bulk data is suspicious.
  const wantEnrich = (c: Candidate): boolean => {
    if (shouldEnrich) return shouldEnrich(c);
    if (fetchAll) return true;
    return !!c.needsScheduling;
  };

  const enrichTargets = candidates.filter(wantEnrich);
  console.log(
    `\nEnriching ${enrichTargets.length}/${candidates.length} candidates with interview details` +
      (deadlineMs ? ` (deadline ${Math.round(deadlineMs / 1000)}s)` : '') +
      `...`,
  );

  // Create a map of orgId -> userId for quick lookup
  const orgIdToUserId = new Map(orgInfos.map(org => [org.id, org.userId]));

  // Group ONLY the enrichment targets by org. Candidates that won't be
  // enriched are passed through unchanged at the end so we don't waste org
  // switches on them.
  const candidatesByOrg = new Map<string, Candidate[]>();
  for (const candidate of enrichTargets) {
    if (!candidatesByOrg.has(candidate.orgId)) {
      candidatesByOrg.set(candidate.orgId, []);
    }
    candidatesByOrg.get(candidate.orgId)!.push(candidate);
  }

  console.log(`  Grouped into ${candidatesByOrg.size} organizations\n`);

  // Process candidates org by org to minimize context switching
  // Keyed by applicationId so the final merge preserves order and lets us
  // overwrite originals with the enriched copies.
  const enrichedById = new Map<string, Candidate>();
  let currentOrgContext: string | null = null;
  let processed = 0;
  let aborted = false;

  for (const [orgId, orgCandidates] of candidatesByOrg.entries()) {
    if (overBudget()) {
      aborted = true;
      console.warn(`  ⏱  Deadline reached; skipping remaining orgs`);
      break;
    }
    const userId = orgIdToUserId.get(orgId);

    if (!userId) {
      console.log(`  ⚠️  No userId for org ${orgId}, skipping ${orgCandidates.length} candidates`);
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
        continue;
      }
    }

    // Process candidates in batches within this org
    for (let i = 0; i < orgCandidates.length; i += maxConcurrent) {
      if (overBudget()) {
        aborted = true;
        console.warn(`  ⏱  Deadline reached mid-batch; ${enrichTargets.length - processed} candidate(s) left unenriched`);
        break;
      }
      const batch = orgCandidates.slice(i, i + maxConcurrent);

      const enrichedBatch = await Promise.all(
        batch.map(async (candidate) => {
          const details = await fetchApplicationDetails(session, candidate.applicationId);

        if (!details) {
          return candidate; // Return original if fetch failed
        }

        // Extract interview events from the application, stage history, and
        // active scheduling subprocesses. The bulk application list can lag
        // behind the candidate's current stage; active subprocesses are what
        // the Ashby UI uses for newly scheduled onsite/final-loop blocks.
        const interviewEvents = collectInterviewEventsFromDetails(details);
        const rawInterviewEvents = collectRawInterviewEventsFromDetails(details);

        // Extract all feedback
        const allFeedback = rawInterviewEvents.flatMap((event: any) =>
          (event.interviewerEvents || [])
            .filter((ie: any) => ie.isFeedbackSubmitted)
            .map((ie: any) => ({
              interviewTitle: event.interview?.title || event.title || '',
              interviewer: displayUserName(ie.interviewer),
              interviewerEmail: ie.interviewer?.email || '',
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
        const currentStageEnteredAt = getCurrentStageEnteredAt(details);

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
          currentStageId: details.currentInterviewStage?.id || candidate.currentStageId || null,
          currentStageEnteredAt,
          stageType: details.currentInterviewStage?.stageType || candidate.stageType,
          currentStage: details.applicationStatus?.description || candidate.currentStage,
          decisionStatus: details.applicationStatus?.description || candidate.decisionStatus,
          statusPriority: details.applicationStatus?.priority ?? candidate.statusPriority,
          statusDueAt: details.applicationStatus?.dueAt ?? candidate.statusDueAt,
          lastActivityAt: currentStageEnteredAt || candidate.lastActivityAt,
          daysInStage: currentStageEnteredAt ? computeDaysInStage(currentStageEnteredAt) : candidate.daysInStage,
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

      for (const c of enrichedBatch) enrichedById.set(c.applicationId, c);
      processed += enrichedBatch.length;
    }

    if (aborted) break;

    console.log(`  ✓ Enriched ${orgCandidates.length} candidates from ${orgInfos.find(o => o.id === orgId)?.name || orgId}`);
  }

  // Merge: keep original order; substitute enriched copy when present.
  const merged = candidates.map((c) => enrichedById.get(c.applicationId) ?? c);
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `\n✓ Enrichment ${aborted ? 'partial (timed out)' : 'complete'}: ` +
      `${enrichedById.size}/${enrichTargets.length} target(s) enriched in ${elapsed}s ` +
      `(${candidates.length - enrichedById.size} pass-through)\n`,
  );
  return merged;
}
