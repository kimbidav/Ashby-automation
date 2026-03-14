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
   d. Paginate remaining applications (cursor-based, 100 per page)
   e. **Normalization** extracts enrichment data inline: interview events, scorecard feedback, stage progress
4. **Export** to CSV + JSON

### Why Orgs Must Be Sequential

Ashby uses a **server-side session**. The `ashby_session_token` cookie maps to server state. Calling `change_user` switches the org context globally for that session — you cannot process multiple orgs in parallel with one session.

### How Enrichment Works (Inline, No Separate Phase)

Previously, enrichment required a separate `ApiApplication` GraphQL call per candidate. Now, the `applicationsByPrebuiltView` query includes all enrichment fields inline:

- `interviewEvents` with full interviewer + scorecard data
- `interviewPlan` with stage definitions
- `job.interviewPlansWithActivities` for fallback stage ordering

This data is extracted during `normalizePipelineData()` in `client.ts`. There is **no separate enrichment phase**.

The old `enrichCandidatesWithDetails()` function still exists in `client.ts` but is no longer called from either orchestration path.

## Source Files

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI entry point. Commander.js commands: `auth`, `auth-cookie`, `recon`, `extract` |
| `src/types.ts` | All shared interfaces: `Candidate`, `AshbySession`, `InterviewEvent`, `InterviewFeedback`, `Company`, `Job` |
| `src/session.ts` | Session management. `loadSession()` tries `.ashby-session.json` first, falls back to Playwright browser context |
| `src/client.ts` | **Core file (~1100 lines).** Org discovery, org switching, GraphQL queries, data normalization with inline enrichment |
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
- `graphqlQuery<T>(session, operationName, query, variables, forceRefreshCsrf)` — low-level GraphQL executor
- `extractFeedbackText(submittedFormRender)` — parses scorecard form data to extract feedback text
- `enrichCandidatesWithDetails(session, candidates, orgInfos, options)` — **legacy**, no longer called

## GraphQL Queries Used

| Operation Name | Endpoint | Purpose |
|---------------|----------|---------|
| `InitialFetch` | `/api/graphql?op=InitialFetch` | Combined: jobs + first app page + session user |
| `ApiGetActiveApplications` | `/api/graphql?op=ApiGetActiveApplications` | Subsequent application pages (pagination) |
| `ApiGetSessionUser` | `/api/graphql?op=ApiGetSessionUser` | Verify org switch (used inside `switchOrgContext`) |

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
  "orgIds": []
}
```

Sessions expire after ~7 days. To refresh:
```bash
npm run start -- auth-cookie --cookie "paste_token_here"
```

The cookie value is the `ashby_session_token` from Chrome DevTools > Application > Cookies > `app.ashbyhq.com`.

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

- **Session invalidation**: The `switchOrgContext` function modifies `session.cookies` in-place (from `set-cookie` response headers). If the process crashes mid-extraction, the saved session file may have stale cookies.
- **CSRF tokens**: Must be refreshed after every org switch. The token from before the switch is invalid for the new org context.
- **`applicationsByPrebuiltView` fields**: This is an internal Ashby API. If Ashby changes the schema, the expanded query may fail. The fields we request (interviewEvents, interviewPlan, scorecardSubmission) are stable since they're used by the Ashby web UI itself.
- **ESM modules**: Project uses `"type": "module"` with `ts-node/esm` loader. All imports use `.js` extensions even for `.ts` files.
- **The `--detailed` / `--no-detailed` CLI flags**: These still exist in `cli.ts` but are currently no-ops since enrichment is always inline. They could be removed or repurposed.
