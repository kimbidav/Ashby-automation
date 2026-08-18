# CLAUDE.md — Ashby Automation

## What This Project Does

Read-only aggregator that extracts active candidate pipeline data across **all Ashby organizations** a user has access to. It uses Ashby's internal (non-public) GraphQL API — the same one their web UI uses — authenticated via browser session cookies. No official API keys exist; everything runs through replayed browser requests.

**Two interfaces:**
- **CLI** (`npm run start -- extract`) — writes timestamped CSV + JSON to `output/`
- **API server** (`npm run server`) — Express server at `:3001` with `POST /api/extract` returning JSON

## Architecture Overview

```
cli.ts (Commander.js entry point)
  ├── auth / auth-cookie → session.ts (saves .ashby-session.json)
  └── extract → api-extract.ts (orchestration)
                  └── client.ts (core: org switching, GraphQL queries, normalization)
                        └── export.ts (CSV/JSON output)

server.ts (Express API)
  └── POST /api/extract → api-server-extract.ts (same client.ts, returns JSON)
  └── Google Calendar endpoints (OAuth + batch event creation)
```

## Key Data Flow (extract command)

1. **Load session** from `.ashby-session.json` (cookie map with `ashby_session_token`)
2. **Discover orgs** via `GET /api/auth/available_identities` → list of `{orgId, userId}`
3. **For each org** (sequential — server-side session constraint):
   a. `POST /api/auth/change_user/{userId}` to switch org context
   b. `GET /api/csrf/token` to refresh CSRF token (required after every switch)
   c. **Single combined GraphQL request** (`InitialFetch`) fetches:
      - All open jobs (`jobsPipelines`)
      - First page of active applications with full enrichment data
      - Session user info (org name)
   d. If the full query fails with a transient server error, **retry up to 2 times** with backoff, then **fall back to a simplified query** without scorecard data
   e. Paginate remaining applications (cursor-based, 100 per page)
   f. **Normalization** extracts enrichment data inline: interview events, scorecard feedback, stage progress
4. **Export** to CSV + JSON

### Why Orgs Must Be Sequential

Ashby uses a **server-side session**. The `ashby_session_token` cookie maps to server state. Calling `change_user` switches the org context globally for that session — you cannot process multiple orgs in parallel with one session.

### How Enrichment Works (Inline Bulk + Targeted Pass)

Most enrichment arrives inline: the `applicationsByPrebuiltView` query includes the enrichment fields in bulk:

- `interviewEvents` with full interviewer + scorecard data
- `interviewPlan` with stage definitions
- `job.interviewPlansWithActivities` for fallback stage ordering

This data is extracted during `normalizePipelineData()` in `client.ts`.

On top of that, `extractPipeline()` runs a **targeted enrichment pass** (`enrichCandidatesWithDetails()` in `client.ts`) for suspect candidates — status "Scheduled"/"Waiting on…", or active candidates whose bulk row has zero interview events (the bulk view lags newly-moved stages). It re-fetches full application details per candidate, time-boxed by `ASHBY_ENRICH_MIN_BUDGET_SEC` (default 180s; raise for a one-off catch-up). In legacy cookie mode it runs sequentially (one token in flight — see Session Management); in live-browser mode it runs 5-wide. Candidates left unenriched when the deadline hits keep their bulk data and are picked up by future runs (the dashboard backend merges per candidate, so enrichment accumulates).

### Error Recovery: Retry + Fallback

Ashby's internal GraphQL API returns transient `"Unidentified server error"` for some orgs when the full enrichment query (with scorecard/feedback fields) is too heavy. This is a server-side issue on Ashby's end, not a session/auth problem. Orgs with lots of data (e.g., Decagon, January) are most likely to trigger it.

**Two-layer defense in `client.ts`:**

1. **`graphqlQuery()` retries** — transient server errors are retried up to 2 times with exponential backoff (1s, 2s). CSRF token is refreshed between retries. This catches intermittent failures.

2. **`fetchPipelineForOrg()` fallback query** — if the full query fails even after retries, it re-tries with a simplified query that omits `scorecardSubmission` data (the heaviest nested field). The `useFallbackQuery` flag is also applied to pagination queries for that org. Candidates from fallback orgs will have interview events and interviewer names but no feedback text or scores.

The fallback query still includes: candidate info, job/stage data, interview events with interviewer names/emails, credited-to, source, interview plan stages, and application status.

## Source Files

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI entry point. Commander.js commands: `auth`, `auth-cookie`, `recon`, `extract` |
| `src/types.ts` | All shared interfaces: `Candidate`, `AshbySession`, `InterviewEvent`, `InterviewFeedback`, `Company`, `Job` |
| `src/session.ts` | Session management. `loadSession()` tries `.ashby-session.json` first, falls back to Playwright browser context |
| `src/client.ts` | **Core file (~1400 lines).** Org discovery, org switching, GraphQL queries with retry/fallback, data normalization with inline enrichment |
| `src/api-extract.ts` | CLI orchestration. Loops through orgs, calls `fetchPipelineForOrg()`, exports results |
| `src/api-server-extract.ts` | Server orchestration. Same logic but returns in-memory data in snake_case format for frontend |
| `src/export.ts` | CSV and JSON file writers. CSV includes computed interview summaries and score averages |
| `src/server.ts` | Express server. `POST /api/extract`, `GET /api/health`, Google Calendar OAuth + batch add |
| `src/google-calendar.ts` | Google Calendar integration. OAuth flow + batch event creation from interview data |
| `src/recon.ts` | Dev tool: opens browser, captures all Ashby API traffic to `ashby-recon-log.json` |
| `src/recon-parser.ts` | Dev tool: parses recon log to extract GraphQL operation names and queries |
| `query_ApiApplication.graphql` | Full GraphQL query for single-application detail. Legacy — used by the old `fetchApplicationDetails()` |

## Key Functions in client.ts

- `fetchAllAvailableOrgs(session)` — discovers all orgs via `/api/auth/available_identities`
- `switchOrgContext(session, userId)` — switches server-side org context, refreshes CSRF token, verifies switch
- `fetchPipelineForOrg(session, orgId, userId)` — the main function: combined initial query + pagination + normalization
- `normalizePipelineData(jobs, applications, orgId, orgName)` — converts raw GraphQL data to `Candidate[]` with inline enrichment
- `graphqlQuery<T>(session, operationName, query, variables, forceRefreshCsrf, retries)` — low-level GraphQL executor with automatic retry for transient server errors
- `extractFeedbackText(submittedFormRender)` — parses scorecard form data to extract feedback text
- `enrichCandidatesWithDetails(session, candidates, orgInfos, options)` — targeted per-application enrichment pass, called by `extractPipeline()` after the sweep for suspect candidates (time-boxed; sequential in legacy cookie mode)
- `fetchArchivedForOrg(session, orgId, userId, orgName, options)` — bounded done-sweep of an org's Archived + Hired prebuilt views (recency window + page cap); lean field set, terminal rows only
- `fetchCandidateRestrictedSummaries(session, candidateId)` — candidate-level "Considered For Jobs" list via `candidate(id).applicationRestrictedSummaries`. **The only query here that can see applications on jobs the seat has no access to** — every prebuilt-view sweep (Active/Archived/Hired) is permission-scoped and silently omits them, and even `candidate(id).applications` filters them out. Returns per-application `{job title, current stage + stageType, archiveReason, enteredStageAt, userHasPermissionToAccess}`. Requires the org's context to already be active. (Field discovered by mining Ashby's frontend JS bundle for the query AST — introspection is disabled and error suggestions are hidden.)

## The Done-Sweep and Pair Semantics (`sweepDoneRowsForOrg` in api-server-extract.ts)

The dashboard downstream treats "archived row, no active row" for a (candidate, org)
pair as the whole relationship being over. A candidate with a parallel application
that is still live must therefore never be emitted as done. Two guards in
`sweepDoneRowsForOrg` enforce that:

1. **Candidate also in the org's active sweep** → their done rows are dropped
   (the archived application is history; the live one carries the pair's status).
   Without this, the downstream same-candidate merge lets the done row overwrite
   the live row's decision status.
2. **Candidate absent from the active sweep** → probe
   `fetchCandidateRestrictedSummaries`. A live application there (stageType
   Active/Offer) replaces the done rows with a synthesized live row:
   `decision_status="In Process"`, stage/title from the summary, `days_in_stage`
   from `enteredStageAt`, and `access_restricted=true` when the seat can't open
   the application (no interview events / feedback / scheduling visibility —
   the enrichment pass skips these rows). The canonical case: Charles Lin @
   Reducto — Product Engineer app archived ("Lacks Skills/Qualifications") while
   his Backend/AI Engineer app sat at Onsite on a job DK's seat can't access;
   the pair wrongly demoted to Archived on the dashboard.
   **Probe errors emit nothing for that candidate this fetch** — "couldn't
   check" must not flip a pair to Archived (confirm-or-skip, same rule the
   dashboard backend applies to archive-status verification).

Probe cost control (env, set when launching the server):
```
ASHBY_RESTRICTED_PROBE_CREDITED_TO   # comma-separated credited-to allowlist for probing;
                                     # default "david kimball,david,dk"; "*" = probe all
                                     # done rows; "0"/"off"/"" = disable probing
ASHBY_RESTRICTED_PROBE_MAX_PER_ORG   # per-org probe cap (default 25); rows past the cap
                                     # are emitted unprobed (logged)
```

## Write Support (Add-to-Ashby)

`src/mutations.ts` holds the write operations for the dashboard's Add-to-Ashby flow —
every document mined from the frontend bundle (hash 4086bb13, 2026-08-18). Shapes worth
remembering: `addCandidate` takes NO arguments (blank create, then `updateCandidate`
per-field setters — name, emailAddresses, socialLinks type `"LINKEDIN"`, sourceId,
creditedTo); resume upload is presigned-POST (`createFileUploadHandle` →
multipart to the storage URL: Content-Type first, `fields` entries, `file` last →
`uploadCandidateResume(resumeHandle, candidateId)`); `createApplication` takes
sourceId/creditedToUserId at create time; `addNoteToCandidate` content is the
version-"2" rich-text envelope (`{version:"2", content:{type:"doc", content:[paragraph
nodes]}, features:[]}`).

Safety rails: all mutations run via `graphqlMutation` (retries=0 — the read path's
auto-retry would double-execute a write); every write path enters the org through
`enterOrgContext` (switch + eager CSRF refresh + verify-or-throw `wrong_org_context`);
and `src/write-lock.ts` serializes ALL session use (extract, archive-status, writes) —
org context is server-side per session, so a write racing a sweep's `change_user` calls
would land data in the wrong client's ATS.

Endpoints (`/api/applications/*`, behind `requireSecret` on Railway):
- `POST /api/applications/open-jobs` `{org_name}` → open jobs + "Sourced: Candidate
  Labs" source id + per-org credited-to user id (the org's own `userId` from
  available_identities).
- `POST /api/applications/add-candidate` → duplicate pre-check (LinkedIn slug, then
  exact name) 409s BEFORE any write; candidate create is the point of no return;
  resume/application/note failures return 200 + a per-step status map and the caller
  retries with `existing_candidate_id`; caches invalidated after any write. Route has
  its own 15mb JSON limit for the base64 resume.

`src/write-discovery.ts` is the read-only validation harness (org guard, open jobs,
source resolution, candidate search, social-link enum) — run it after Ashby ships
frontend changes if writes start failing.

## GraphQL Queries Used

| Operation Name | Endpoint | Purpose |
|---------------|----------|---------|
| `InitialFetch` | `/api/graphql?op=InitialFetch` | Combined: jobs + first app page + session user |
| `ApiGetActiveApplications` | `/api/graphql?op=ApiGetActiveApplications` | Subsequent application pages (pagination) |
| `ApiGetSessionUser` | `/api/graphql?op=ApiGetSessionUser` | Verify org switch (used inside `switchOrgContext`) |
| `ArchivedSweep` | `/api/graphql?op=ArchivedSweep` | Bounded done-sweep pages (Archived/Hired prebuilt views) |
| `ApiCandidateRestrictedSummaries` | `/api/graphql?op=ApiCandidateRestrictedSummaries` | Candidate-level application list incl. no-access jobs |

## Build & Run

```bash
npm install              # Install deps
npm run build            # TypeScript → dist/
npm run start -- extract # Run CLI extraction
npm run server           # Start API server on :3001
```

**Testing with limited orgs:**
```bash
npm run start -- extract --max-orgs 3
npm run start -- extract --org "CompanyName"
```

## Session Management

Sessions are stored in `.ashby-session.json` (gitignored). Format:
```json
{
  "cookies": { "ashby_session_token": "s%3A..." },
  "csrfToken": "...",
  "orgIds": [],
  "persistedAt": "2026-06-10T17:03:12.345Z",
  "seedHash": "sha256-of-the-seed-cookie (only when seeded from STORED_COOKIE)"
}
```

**Rotation persistence**: Ashby rotates `ashby_session_token` via `Set-Cookie` every few minutes. `doFetch` (client.ts) mirrors every rotation into the in-memory session and fires `session.onCookiesRotated`; the server (`validateCookie`) and the CLI `extract` command wire that hook to `persistSessionCookies()` (session.ts), which atomically rewrites `.ashby-session.json` with the rotated map. So the file always holds the newest token in the chain, a single extraction run never 401s mid-sweep from rotation, and later runs reuse the persisted chain — no re-auth until Ashby's hard login expiry (~7 days) or an explicit logout. Live-SSO-browser sessions never persist (the Playwright profile owns those cookies).

When `ASHBY_SESSION_COOKIE` (env) is set, `validateCookie` prefers the persisted file if its `seedHash` matches the env cookie's sha256 (the file is a rotation descendant of that deploy's cookie); a different hash means a fresh cookie was deployed and it wins.

Sessions expire after ~7 days (hard login expiry). To refresh:
```bash
npm run start -- auth-cookie --cookie "paste_token_here"
```

The cookie value is the `ashby_session_token` from Chrome DevTools > Application > Cookies > `app.ashbyhq.com`.

**Extraction time budget**: one run is time-boxed by `ASHBY_EXTRACT_BUDGET_SEC` (code default 240; `npm run server` / `npm run server:prod` pin 720 unless the env var is already set). The org sweep itself is unbounded — it takes as long as Ashby takes (~120s normally, ~850s observed on a slow day) — so the targeted enrichment pass additionally has a guaranteed floor: `ASHBY_ENRICH_MIN_BUDGET_SEC` (default 180) of time it always gets, even when the sweep already blew the budget. Set the floor to 0 to restore leftovers-only behavior. Callers waiting synchronously (the dashboard backend's `ASHBY_REFRESH_TIMEOUT_SEC`) should allow sweep + floor + ~60s slack; if they time out anyway, the run still completes and is served from the 10-minute result cache on the next call.

## Feedback Text Extraction

Scorecard feedback in Ashby has two formats:
- **Plain text** (e.g., TLDR field): stored as a string value
- **Rich text** (e.g., Positives, Negatives): stored as ProseMirror JSON `{"content":{"type":"doc","content":[...]}}`

The `extractFeedbackText()` function in `client.ts` handles both:
1. Iterates all `fieldEntries` in the `submittedFormRender` (top-level and inside sections)
2. Skips numeric values (likely the recommendation score)
3. Extracts plain strings directly
4. Walks ProseMirror JSON trees to extract text nodes
5. Joins all parts with ` | ` separator

Note: the `field` property in `fieldEntries` is an **object** (not a string) in Ashby's GraphQL schema. Any code that filters by field name must handle this.

## Per-Candidate Data Available

For each candidate, the following is extracted in a single bulk query (no per-candidate API calls):

| Field | Source | Example |
|-------|--------|---------|
| `pipelineStage` | `currentInterviewStage.title` | "Follow-up Interview" |
| `stageProgress` | Computed from `interviewPlan` stages | "4/6" |
| `interviewEvents[]` | `interviewEvents` with interviewer details | Title, date, interviewer name/email, score |
| `allFeedback[]` | `scorecardSubmission.submittedFormRender` | TLDR + rich text positives/negatives |
| `latestOverallRecommendation` | Most recent scorecard | "3" |
| `feedbackCount` | Count of submitted scorecards | 2 |
| `creditedTo` / `source` | `creditedToUser` / `source.title` | "David Kimball" / "Candidate Labs" |

## API Server Response (`POST /api/extract`)

The API server returns candidates in snake_case with computed interview summary fields for the Lovable frontend:

```typescript
{
  // ... basic fields (company_name, job_title, pipeline_stage, etc.)

  // Interview events with full interviewer/feedback detail
  interview_events: [{
    id, interview_title, start_time, end_time,
    interviewers: [{ name, email, score, feedback_submitted, feedback_text }]
  }],

  // Pre-formatted strings for the expanded row view
  current_stage_interviews: "• Coding Interview (03/11) - Zi Gao - Score: 3 (Good communicator...)",
  current_stage_avg_score: 3.0,
  current_stage_date: "2026-03-11",
  interview_history_summary: "2026-02-23: Initial Team Screen (3.0) | 2026-01-15: Phone Screen (N/A)",
}
```

The Lovable frontend repo is at https://github.com/kimbidav/ashbypipeline. Its `CandidateTable.tsx` renders `current_stage_interviews` and `interview_history_summary` in expandable row details.

## Common Pitfalls

- **Session rotation**: `doFetch` mirrors every `Set-Cookie` into `session.cookies` in-place and (when the persistence hook is attached) immediately rewrites `.ashby-session.json`. A crash mid-extraction leaves the file holding the newest rotated token, so the next run resumes off a valid session.
- **CSRF tokens**: Must be refreshed after every org switch. The token from before the switch is invalid for the new org context.
- **`applicationsByPrebuiltView` fields**: This is an internal Ashby API. If Ashby changes the schema, the expanded query may fail. The fields we request (interviewEvents, interviewPlan, scorecardSubmission) are stable since they're used by the Ashby web UI itself.
- **Transient server errors**: Ashby's API returns `"Unidentified server error"` for some orgs when the full enrichment query is too heavy. This is NOT a session/auth issue — it's server-side. The retry + fallback mechanism in `graphqlQuery()` and `fetchPipelineForOrg()` handles this automatically. Orgs with large datasets (many candidates/interviews) are most likely to trigger it.
- **ESM modules**: Project uses `"type": "module"` with `ts-node/esm` loader. All imports use `.js` extensions even for `.ts` files.
- **The `--detailed` / `--no-detailed` CLI flags**: These still exist in `cli.ts` but are currently no-ops since enrichment is always inline. They could be removed or repurposed.

## Future Performance Optimizations

Currently the extraction processes all ~70 orgs sequentially (~2 min on a good day; ~10–15 min observed when Ashby is slow and per-request 15s timeouts trigger retries). Parallelization is blocked by Ashby's server-side session (one org context at a time per token). Planned improvements:

- **Lazy enrichment**: Serve simple query results immediately, fetch scorecard/feedback on-demand per candidate via the existing `ApiApplication` query in `fetchApplicationDetails()`
- **Skip empty orgs**: Check `jobsPipelines.applicationCount` first, skip orgs with 0 candidates (~20 orgs currently)
- **Cache + incremental refresh**: Store last extraction, serve cached data instantly, only re-fetch orgs whose `applicationCount` changed
- **Streaming responses**: Use SSE or chunked JSON to stream results per-org as they complete
