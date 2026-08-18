/**
 * mutations.ts — Ashby write operations for the Add-to-Ashby flow.
 *
 * Every GraphQL document here was mined from Ashby's frontend bundle
 * (cdn.ashbyprd.com/frontend/4086bb136cb57da70d3c2b0a08999f1f744fb6cb,
 * captured 2026-08-18) — introspection is disabled, so these are the exact
 * documents the web UI itself sends. Key shapes:
 *
 *   - addCandidate takes NO arguments: the UI creates a blank candidate and
 *     fills fields with follow-up updateCandidate calls. We do the same.
 *   - Resume upload is a presigned-POST flow: createFileUploadHandle returns
 *     {handle, url, fields}; the file is POSTed to `url` as multipart form
 *     data (Content-Type first, then every fields entry, then `file` last —
 *     mirroring the bundle's own uploader), then uploadCandidateResume
 *     attaches the handle to the candidate.
 *   - addNoteToCandidate's content is a rich-text JSON envelope (version "2",
 *     ProseMirror-style doc/paragraph/text nodes) — the same envelope the
 *     bundle builds for plain text.
 *
 * All mutations run through graphqlMutation (retries=0 — the read path's
 * auto-retry would double-execute a write). Callers are responsible for
 * having entered the correct org context via enterOrgContext first.
 */
import { AshbySession } from './types.js';
import { graphqlMutation, graphqlReadQuery } from './client.js';

// ── Documents (mined; do not edit without re-capturing) ──────────────────

const ADD_CANDIDATE = `
mutation ApiAddCandidate {
  candidate: addCandidate {
    id
  }
}`;

const UPDATE_CANDIDATE_NAME = `
mutation ApiUpdateCandidateName($id: String!, $name: String) {
  candidate: updateCandidate(id: $id, name: $name) {
    id
    name
  }
}`;

const UPDATE_CANDIDATE_EMAILS = `
mutation ApiUpdateCandidateEmailAddresses($id: String!, $emailAddresses: [ContactInfoInput!]) {
  candidate: updateCandidate(id: $id, emailAddresses: $emailAddresses) {
    id
  }
}`;

const UPDATE_CANDIDATE_LINKS = `
mutation ApiUpdateCandidateLinks($id: String!, $socialLinks: [CandidateSocialLinkInput!]) {
  candidate: updateCandidate(id: $id, socialLinks: $socialLinks) {
    id
    socialLinks {
      type
      url
      __typename
    }
  }
}`;

const UPDATE_CANDIDATE_SOURCE = `
mutation ApiUpdateCandidateSource($candidateId: String!, $sourceId: String) {
  candidate: updateCandidate(id: $candidateId, sourceId: $sourceId) {
    id
  }
}`;

const UPDATE_CANDIDATE_CREDITED_TO = `
mutation ApiUpdateCandidateCreditedTo($candidateId: String!, $creditedTo: String) {
  candidate: updateCandidate(id: $candidateId, creditedTo: $creditedTo) {
    id
  }
}`;

const CREATE_FILE_UPLOAD_HANDLE = `
mutation ApiCreateFileUploadHandle($fileUploadContext: FileUploadContext!, $filename: String!, $contentType: String!, $contentLength: Int!) {
  fileUploadHandle: createFileUploadHandle(
    fileUploadContext: $fileUploadContext
    filename: $filename
    contentType: $contentType
    contentLength: $contentLength
  ) {
    handle
    url
    fields
  }
}`;

const UPLOAD_CANDIDATE_RESUME = `
mutation ApiUploadCandidateResume($resumeHandle: String!, $candidateId: String!) {
  candidate: uploadCandidateResume(resumeHandle: $resumeHandle, candidateId: $candidateId) {
    id
    __typename
  }
}`;

const PUBLISH_CANDIDATE = `
mutation ApiPublishCandidate($candidateId: String!) {
  candidate: publishCandidate(id: $candidateId) {
    id
    isDraft
    isPublished
  }
}`;

const CREATE_APPLICATION = `
mutation ApiCreateApplication($candidateId: String!, $jobId: String!, $interviewPlanId: String, $initialInterviewStageId: String, $sourceId: String, $sourceSite: SourceSite, $creditedToUserId: String) {
  application: createApplication(
    candidateId: $candidateId
    jobId: $jobId
    interviewPlanId: $interviewPlanId
    initialInterviewStageId: $initialInterviewStageId
    sourceId: $sourceId
    sourceSite: $sourceSite
    creditedToUserId: $creditedToUserId
  ) {
    id
  }
}`;

const ADD_NOTE_TO_CANDIDATE = `
mutation ApiAddNoteToCandidate($candidateId: String!, $content: JSON!, $isPrivate: Boolean) {
  note: addNoteToCandidate(candidateId: $candidateId, content: $content, isPrivate: $isPrivate) {
    id
    __typename
  }
}`;

const SEARCH_CANDIDATES = `
query ApiSearchCandidates($queryString: String!) {
  results: searchCandidates(queryString: $queryString) {
    id
    name
    primaryEmailAddress {
      value
      __typename
    }
    company
    __typename
  }
}`;

const SEARCH_SOURCE_BY_TITLE = `
query ApiSearchSourceByTitle($title: String!, $activeOnly: Boolean) {
  results: searchSourceByTitle(title: $title, activeOnly: $activeOnly) {
    id
    displayTitle
  }
}`;

const CANDIDATE_SOCIAL_LINKS = `
query ApiCandidateSocialLinks($id: String!) {
  candidate(id: $id) {
    id
    name
    socialLinks {
      type
      url
      __typename
    }
    __typename
  }
}`;

// ── Read helpers (dup pre-check, source resolution) ──────────────────────

export interface CandidateSearchHit {
  id: string;
  name: string;
  email: string | null;
  company: string | null;
  linkedinUrl: string | null;
}

/**
 * Search the current org's candidates by name. Search hits don't carry
 * socialLinks, so for LinkedIn-based dup matching each hit's links are
 * fetched individually (hits are few — searchCandidates is a typeahead).
 */
export async function searchCandidatesInOrg(
  session: AshbySession,
  queryString: string,
  options: { resolveLinks?: boolean; maxLinkLookups?: number } = {},
): Promise<CandidateSearchHit[]> {
  const { resolveLinks = true, maxLinkLookups = 8 } = options;
  const resp = await graphqlReadQuery<{
    results: Array<{ id: string; name: string; primaryEmailAddress?: { value?: string } | null; company?: string | null }>;
  }>(session, 'ApiSearchCandidates', SEARCH_CANDIDATES, { queryString });
  const hits: CandidateSearchHit[] = (resp?.results || []).map((r) => ({
    id: r.id,
    name: r.name,
    email: r.primaryEmailAddress?.value ?? null,
    company: r.company ?? null,
    linkedinUrl: null,
  }));
  if (resolveLinks) {
    for (const hit of hits.slice(0, maxLinkLookups)) {
      try {
        const detail = await graphqlReadQuery<{
          candidate: { socialLinks?: Array<{ type?: string; url?: string }> } | null;
        }>(session, 'ApiCandidateSocialLinks', CANDIDATE_SOCIAL_LINKS, { id: hit.id });
        const links = detail?.candidate?.socialLinks || [];
        const li = links.find((l) => /linkedin/i.test(l.type || '') || /linkedin\.com/i.test(l.url || ''));
        hit.linkedinUrl = li?.url ?? null;
      } catch {
        // Non-fatal: dup matching falls back to name-only for this hit.
      }
    }
  }
  return hits;
}

export async function fetchSourceIdByTitle(
  session: AshbySession,
  title: string,
): Promise<{ id: string; displayTitle: string } | null> {
  // Every org names the agency source differently — observed live:
  // "Sourced: Candidate Labs" (Reducto), "Agencies: Candidate Labs"
  // (AfterQuery/Luminai), "Agency - Candidate Labs" (Trajectory). And
  // searchSourceByTitle matches by PREFIX, so "Candidate Labs" misses every
  // variant that puts a category word first. Search several prefixes,
  // collect, and rank: exact preferred title, then any title containing
  // "candidate labs".
  const search = async (q: string) => {
    const resp = await graphqlReadQuery<{
      results: Array<{ id: string; displayTitle: string }>;
    }>(session, 'ApiSearchSourceByTitle', SEARCH_SOURCE_BY_TITLE, { title: q, activeOnly: true });
    return resp?.results || [];
  };
  const byId = new Map<string, { id: string; displayTitle: string }>();
  for (const term of [title, 'Candidate Labs', 'Sourced', 'Agencies', 'Agency']) {
    try {
      for (const r of await search(term)) byId.set(r.id, r);
    } catch { /* try remaining prefixes */ }
    // Stop early once a candidate-labs source is on hand.
    if ([...byId.values()].some((r) => (r.displayTitle || '').toLowerCase().includes('candidate labs'))) break;
  }
  const results = [...byId.values()];
  const wanted = title.trim().toLowerCase();
  return (
    results.find((r) => (r.displayTitle || '').trim().toLowerCase() === wanted) ||
    results.find((r) => (r.displayTitle || '').toLowerCase().includes('candidate labs')) ||
    null
  );
}

// ── Write operations ─────────────────────────────────────────────────────

export interface NewCandidateInput {
  name: string;
  email?: string | null;
  linkedinUrl?: string | null;
  sourceId?: string | null;
  creditedToUserId?: string | null;
}

/**
 * Create a candidate and fill in their fields. Mirrors the UI: a blank
 * addCandidate, then one updateCandidate per field group. Field failures
 * after creation are surfaced in `warnings` rather than thrown — the
 * candidate exists at that point and the caller's partial-failure handling
 * takes over.
 */
export async function createCandidateWithDetails(
  session: AshbySession,
  input: NewCandidateInput,
): Promise<{ candidateId: string; warnings: string[] }> {
  const created = await graphqlMutation<{ candidate: { id: string } }>(
    session,
    'ApiAddCandidate',
    ADD_CANDIDATE,
  );
  const candidateId = created?.candidate?.id;
  if (!candidateId) throw new Error('addCandidate returned no id');
  const warnings: string[] = [];

  const trySet = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err: any) {
      warnings.push(`${label}: ${err?.message?.substring(0, 120)}`);
    }
  };

  await trySet('name', () =>
    graphqlMutation(session, 'ApiUpdateCandidateName', UPDATE_CANDIDATE_NAME, {
      id: candidateId,
      name: input.name,
    }),
  );
  if (input.email) {
    await trySet('email', () =>
      graphqlMutation(session, 'ApiUpdateCandidateEmailAddresses', UPDATE_CANDIDATE_EMAILS, {
        id: candidateId,
        // "personal" lowercase — read off a real record 2026-08-18; the
        // capitalized variant draws an unhandled server error.
        emailAddresses: [{ value: input.email, type: 'personal', isPrimary: true }],
      }),
    );
  }
  if (input.linkedinUrl) {
    await trySet('linkedin', () =>
      graphqlMutation(session, 'ApiUpdateCandidateLinks', UPDATE_CANDIDATE_LINKS, {
        id: candidateId,
        // "LINKEDIN" verified against live candidate data via
        // write-discovery.ts (2026-08-18): socialLinks[].type comes back
        // uppercase, and the input enum matches the read enum.
        socialLinks: [{ type: 'LINKEDIN', url: input.linkedinUrl }],
      }),
    );
  }
  if (input.sourceId) {
    await trySet('source', () =>
      graphqlMutation(session, 'ApiUpdateCandidateSource', UPDATE_CANDIDATE_SOURCE, {
        candidateId,
        sourceId: input.sourceId,
      }),
    );
  }
  if (input.creditedToUserId) {
    await trySet('creditedTo', () =>
      graphqlMutation(session, 'ApiUpdateCandidateCreditedTo', UPDATE_CANDIDATE_CREDITED_TO, {
        candidateId,
        creditedTo: input.creditedToUserId,
      }),
    );
  }
  return { candidateId, warnings };
}

/**
 * Presigned-POST resume upload, mirroring the bundle's own uploader:
 * createFileUploadHandle → multipart POST to the storage URL (Content-Type
 * first, then every `fields` entry, then the file itself LAST) →
 * uploadCandidateResume to attach the handle. The storage POST needs no
 * Ashby auth — the signed policy in `fields` is the authorization.
 */
export async function uploadResumeForCandidate(
  session: AshbySession,
  candidateId: string,
  file: { filename: string; contentBase64: string; contentType?: string },
): Promise<void> {
  const bytes = Buffer.from(file.contentBase64, 'base64');
  const contentType = file.contentType || 'application/pdf';

  const handleResp = await graphqlMutation<{
    fileUploadHandle: { handle: string; url: string; fields: Record<string, string> };
  }>(session, 'ApiCreateFileUploadHandle', CREATE_FILE_UPLOAD_HANDLE, {
    fileUploadContext: 'CandidateResume',
    filename: file.filename,
    contentType,
    contentLength: bytes.length,
  });
  const handle = handleResp?.fileUploadHandle;
  if (!handle?.url || !handle?.handle) throw new Error('createFileUploadHandle returned no url/handle');

  const form = new FormData();
  form.append('Content-Type', contentType);
  for (const [k, v] of Object.entries(handle.fields || {})) form.append(k, v);
  form.append('file', new Blob([bytes], { type: contentType }), file.filename);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(handle.url, { method: 'POST', body: form, signal: controller.signal });
    if (!res.ok && res.status !== 204) {
      const text = await res.text().catch(() => '');
      throw new Error(`storage upload failed ${res.status}: ${text.substring(0, 150)}`);
    }
  } finally {
    clearTimeout(timer);
  }

  await graphqlMutation(session, 'ApiUploadCandidateResume', UPLOAD_CANDIDATE_RESUME, {
    resumeHandle: handle.handle,
    candidateId,
  });
}

const JOB_INTERVIEW_PLAN = `
query ApiJobInterviewPlan($id: String!) {
  job(id: $id) {
    id
    interviewPlansWithActivities {
      id
      isDefault
      interviewPlan {
        ... on CustomInterviewPlan { id interviewStages { id title stageType __typename } __typename }
        ... on InterviewPlanTemplate { id interviewStages { id title stageType __typename } __typename }
        __typename
      }
      __typename
    }
    __typename
  }
}`;

/**
 * The job's default interview plan and its entry stage. The manual Add
 * Candidate flow lands new applications at the Application Review stage, so
 * prefer the first stage of that type; fall back to the plan's first stage.
 */
export async function fetchJobEntryStage(
  session: AshbySession,
  jobId: string,
): Promise<{ interviewPlanId: string; initialInterviewStageId: string; stageTitle: string } | null> {
  const resp = await graphqlReadQuery<{
    job: {
      interviewPlansWithActivities?: Array<{
        id: string;
        isDefault: boolean;
        interviewPlan?: { id: string; interviewStages?: Array<{ id: string; title: string; stageType: string }> };
      }>;
    } | null;
  }>(session, 'ApiJobInterviewPlan', JOB_INTERVIEW_PLAN, { id: jobId });
  const plans = resp?.job?.interviewPlansWithActivities || [];
  const plan = plans.find((p) => p.isDefault) || plans[0];
  const stages = plan?.interviewPlan?.interviewStages || [];
  if (!plan || stages.length === 0) return null;
  const entry = stages.find((s) => (s.stageType || '') === 'ApplicationReview')
    || stages.find((s) => /application review/i.test(s.title || ''))
    || stages[0];
  return {
    interviewPlanId: plan.interviewPlan?.id || plan.id,
    initialInterviewStageId: entry.id,
    stageTitle: entry.title,
  };
}

/**
 * THE step everything else hinged on: addCandidate creates an UNPUBLISHED
 * DRAFT. Draft candidates are invisible to search, duplicate detection, and
 * candidate pages, and createApplication dies on them with an unhandled
 * server error. The UI publishes on the Add panel's "Next" click
 * (`candidate.isPublished ? navigate : publish()`); we publish after the
 * field setters. Idempotent-safe to call on an already-published candidate.
 */
export async function publishCandidate(
  session: AshbySession,
  candidateId: string,
): Promise<{ isPublished: boolean }> {
  const resp = await graphqlMutation<{ candidate: { id: string; isDraft: boolean; isPublished: boolean } }>(
    session,
    'ApiPublishCandidate',
    PUBLISH_CANDIDATE,
    { candidateId },
  );
  return { isPublished: resp?.candidate?.isPublished === true };
}

/**
 * Variables mirror the UI's exact payload, mined from the bundle's
 * "Consider Candidate for Job?" panel (2026-08-18):
 *   { candidateId, jobId, interviewPlanId: <plan id>,
 *     initialInterviewStageId: null, sourceId, sourceSite: null,
 *     creditedToUserId }
 * Two hard requirements the server enforces with an unhandled error:
 * interviewPlanId must be PRESENT (the panel always supplies the default
 * plan), and initialInterviewStageId must be NULL for external-recruiter
 * seats — the panel hides the stage selector for that role
 * (showInterviewStageSelect: globalRole !== ExternalRecruiter), so a
 * caller-chosen stage id is rejected server-side.
 */
export async function createApplicationForCandidate(
  session: AshbySession,
  input: {
    candidateId: string;
    jobId: string;
    interviewPlanId: string;
    sourceId?: string | null;
    creditedToUserId?: string | null;
  },
): Promise<{ applicationId: string }> {
  const resp = await graphqlMutation<{ application: { id: string } }>(
    session,
    'ApiCreateApplication',
    CREATE_APPLICATION,
    {
      candidateId: input.candidateId,
      jobId: input.jobId,
      interviewPlanId: input.interviewPlanId,
      initialInterviewStageId: null,
      sourceId: input.sourceId ?? null,
      sourceSite: null,
      creditedToUserId: input.creditedToUserId ?? null,
    },
  );
  const applicationId = resp?.application?.id;
  if (!applicationId) throw new Error('createApplication returned no id');
  return { applicationId };
}

/**
 * Plain text → Ashby's rich-text note envelope, captured 2026-08-18 from a
 * live ApiAddNoteToCandidate request the web UI sent (fetch-intercepted):
 * text nodes are BASE64-encoded with attrs.encoding="base64" — plain text
 * nodes draw an unhandled server error — and the envelope carries the
 * editor's feature list plus attachments/metadata blocks. Paragraph per
 * line; blank lines become empty paragraphs so Slack spacing survives.
 */
const NOTE_FEATURES = [
  'AiContentAssistant', 'Unimplemented', 'Placeholder', 'Italic', 'Bold',
  'Underline', 'Code', 'CodeBlocks', 'Headings', 'NumberedLists',
  'BulletedLists', 'Links', 'Blockquote', 'Mentions', 'Table',
  'InternalImages', 'EmptyDivAsParagraph',
];

export function noteContentFromPlainText(text: string): Record<string, unknown> {
  const paragraphs = text.split('\n').map((line) => ({
    type: 'paragraph',
    content: line.length > 0
      ? [{
          type: 'text',
          text: Buffer.from(line, 'utf8').toString('base64'),
          attrs: { encoding: 'base64' },
        }]
      : [],
  }));
  return {
    version: '2',
    content: { type: 'doc', content: paragraphs },
    features: NOTE_FEATURES,
    attachments: [],
    metadata: { mentions: { users: [] }, tasks: [] },
  };
}

export async function addNoteToCandidate(
  session: AshbySession,
  candidateId: string,
  text: string,
): Promise<void> {
  await graphqlMutation(session, 'ApiAddNoteToCandidate', ADD_NOTE_TO_CANDIDATE, {
    candidateId,
    content: noteContentFromPlainText(text),
    isPrivate: false,
  });
}
