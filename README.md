# Ashby Automation — Shadow API Aggregator (Read-Only)

A read-only automation system that provides a consolidated view of all in-process candidates across every Ashby organization you have access to.

## Overview

This project is a **read-only control plane** for Ashby that aggregates **in-process candidates across all Ashby orgs you can access** by:

- Reusing a real browser auth session (no credential storage)
- Discovering and switching between all accessible organizations
- Using Ashby's internal GraphQL APIs via authenticated requests
- Normalizing and exporting the data to **CSV** and **JSON**

### Key Features

- **Read-Only**: No data modification, only extraction
- **Multi-Org Support**: Automatically discovers and aggregates data across all accessible organizations
- **Single Session**: Authenticate once, access all orgs
- **Structured Output**: CSV and JSON exports with timestamped filenames
- **Inline Enrichment**: Interview events, scorecard feedback, and stage progress fetched in bulk — no per-candidate API calls
- **Resilient Extraction**: Automatic retry with exponential backoff for transient Ashby server errors, plus fallback to simplified queries for orgs where the full enrichment query is too heavy
- **API Server**: Express server with `POST /api/extract` for the [Lovable dashboard frontend](https://github.com/kimbidav/ashbypipeline)
- **Google Calendar Sync**: Batch-add interview events to Google Calendar via OAuth
- **Smart Detection**: Identifies candidates needing scheduling based on stage and inactivity

### Safety & Non-Goals

- **Read-only only**: no candidate mutation, messaging, or scheduling
- **No official Ashby API dependency**: works by replaying internal API calls the web UI makes
- **Permissions-respecting**: only sees data you can see in the UI
- **No credential storage**: uses browser-based authentication

## Installation

### Prerequisites

- Node.js 18+ and npm
- Access to one or more Ashby organizations

### Setup

1. Install dependencies:
```bash
cd "/Users/david/Desktop/Ashby Automation"
npm install
```

2. Build the project:
```bash
npm run build
```

3. Install Playwright browsers:
```bash
npx playwright install chromium
```

## Usage

### Step 1: Authentication (One-Time Setup)

The recommended way to authenticate is to use your existing Ashby session from Google Chrome:

1. Log in to Ashby normally in Google Chrome at `app.ashbyhq.com`
2. Open Chrome DevTools (F12 or Cmd+Option+I)
3. Go to **Application** → **Cookies** → `https://app.ashbyhq.com`
4. Find the session cookie (typically named `__session` or similar) and copy its value
5. Run the auth command with your cookie:

```bash
npm run start -- auth-cookie --cookie "your_cookie_value_here"
```

This saves the session to `.ashby-session.json` for subsequent extractions.

**Alternative**: Browser-based authentication (may have issues with SSO):

```bash
npm run start -- auth
```

This opens a Chromium window for login, but using your existing Chrome session is more reliable.

### Step 2: Extract Pipeline Data

Extract active candidate data from all organizations:

```bash
npm run start -- extract
```

This will:
1. Load your saved session
2. Discover all accessible organizations
3. Switch to each org and fetch active candidates
4. Export timestamped files to the `output/` directory:
   - `output/ashby_pipeline_YYYY-MM-DD.csv`
   - `output/ashby_pipeline_YYYY-MM-DD.json`

**Options:**

```bash
# Specify custom output files
npm run start -- extract --csv my-report.csv --json my-report.json

# Limit to first N orgs (for testing)
npm run start -- extract --max-orgs 3

# Retry failed orgs
npm run start -- extract --retries 3
```

### Step 3: Review the Data

The CSV output includes pipeline progress, feedback scores, and interview history:

```csv
company_name,job_title,job_id,candidate_name,candidate_id,pipeline_stage,decision_status,stage_type,current_stage_index,total_stages,stage_progress,last_activity_at,days_in_stage,needs_scheduling,credited_to,source,feedback_count,latest_recommendation,latest_feedback_author,latest_feedback_date,current_stage_interviews,current_stage_avg_score,current_stage_date,interview_history_summary
```

**Field Descriptions:**

- `company_name`: Organization name
- `job_title`: Job/role title
- `job_id`: Unique job identifier
- `candidate_name`: Candidate name
- `candidate_id`: Unique candidate identifier
- `pipeline_stage`: Current pipeline stage (e.g., "Technical Interviews", "Onsite")
- `decision_status`: Action needed (e.g., "Needs Decision", "Scheduled", "Waiting on Availability")
- `stage_type`: Type of stage (e.g., "interview", "technical_screen")
- `current_stage_index`: Which stage number the candidate is on (1-based)
- `total_stages`: Total number of stages in the pipeline
- `stage_progress`: Combined progress string (e.g., "3/5" or "Technical Interview (3/5)")
- `last_activity_at`: ISO timestamp of last activity
- `days_in_stage`: Number of days since last activity
- `needs_scheduling`: `true` if candidate is in an interview stage and inactive >= 7 days
- `credited_to`: Recruiter or person credited for the candidate
- `source`: How the candidate was sourced
- `feedback_count`: Total number of feedback submissions received
- `latest_recommendation`: Most recent interviewer score (e.g., "2", "3", "4")
- `latest_feedback_author`: Who gave the most recent feedback
- `latest_feedback_date`: When the latest feedback was submitted
- `current_stage_interviews`: Detailed breakdown of recent interviews with scores and feedback
- `current_stage_avg_score`: Average score across current stage interviews
- `current_stage_date`: Date of current stage interviews
- `interview_history_summary`: Summary of previous interview stages with dates and scores

## API Server (for Lovable Frontend)

The project includes an Express API server that powers the [Lovable dashboard](https://github.com/kimbidav/ashbypipeline).

```bash
npm run server           # Start on port 3001
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/extract` | Accept `{ cookie: "..." }`, run extraction, return candidates as JSON |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/google/auth` | Get Google OAuth URL |
| `GET` | `/api/google/callback` | OAuth callback (exchanges code for tokens) |
| `POST` | `/api/calendar/add` | Batch-add interview events to Google Calendar |

### API Response Format

`POST /api/extract` returns candidates with full interview detail:

```json
{
  "success": true,
  "candidates": [{
    "candidate_name": "Sunny Rekhi",
    "company_name": "Netic",
    "pipeline_stage": "Follow-up Interview",
    "stage_progress": "4/6",
    "feedback_count": 2,
    "latest_recommendation": "3",
    "current_stage_interviews": "• Follow Up (03/18) - Melisa Tokmak - No score yet",
    "current_stage_avg_score": null,
    "interview_history_summary": "2026-03-11: Coding Interview (3.0) | 2026-02-23: Initial Team Screen (3.0)",
    "interview_events": [{
      "interview_title": "Coding Interview",
      "start_time": "2026-03-11T20:00:00.000Z",
      "interviewers": [{
        "name": "Zi Gao",
        "score": "3",
        "feedback_text": "Good communicator, pretty fast | Clear thought process..."
      }]
    }]
  }]
}
```

## Advanced Usage

### Reconnaissance Mode (Optional)

If you need to discover or verify API endpoints:

```bash
npm run start -- recon
```

- A browser window opens
- Navigate to `Candidates → Pipeline → Active`
- The tool captures all network requests to `ashby-recon-log.json`
- Use this to analyze API structure or debug issues

### Re-authentication

If your session expires, grab a fresh cookie from Chrome and run:

```bash
npm run start -- auth-cookie --cookie "your_new_cookie"
```

## Project Structure

```
Ashby Automation/
├── src/
│   ├── cli.ts                # Entry point — CLI commands (auth, auth-cookie, recon, extract)
│   ├── types.ts              # Shared TypeScript interfaces (Candidate, AshbySession, etc.)
│   ├── session.ts            # Auth & session management (.ashby-session.json)
│   ├── client.ts             # Core: Ashby GraphQL client — org switching, pipeline fetch, inline enrichment
│   ├── api-extract.ts        # CLI orchestration: loops orgs → fetchPipelineForOrg → export
│   ├── api-server-extract.ts # Server orchestration: same logic, returns snake_case JSON for frontend
│   ├── server.ts             # Express API server (:3001) — /api/extract, /api/health, Google Calendar
│   ├── export.ts             # CSV and JSON file export with computed interview summaries
│   ├── google-calendar.ts    # Google Calendar OAuth + batch event creation
│   ├── recon.ts              # Dev tool: captures live API traffic to ashby-recon-log.json
│   └── recon-parser.ts       # Dev tool: reads the recon log to extract GraphQL queries
├── query_ApiApplication.graphql  # Legacy: full single-application GraphQL query (no longer called)
├── output/                   # Generated reports (timestamped, gitignored)
├── dist/                     # Compiled JavaScript (gitignored)
├── run_ashby_extract.sh      # Convenience wrapper with session expiry detection
├── .ashby-session.json       # Saved auth session (gitignored)
├── CLAUDE.md                 # AI assistant documentation (architecture, data flow, pitfalls)
├── package.json              # Node.js dependencies
└── README.md                 # This file
```

## Output Schema

### CSV Format

Flat, human-readable table with one row per candidate, including pipeline progress and feedback:

```csv
company_name,job_title,job_id,candidate_name,candidate_id,pipeline_stage,decision_status,stage_type,current_stage_index,total_stages,stage_progress,last_activity_at,days_in_stage,needs_scheduling,credited_to,source,feedback_count,latest_recommendation,latest_feedback_author,latest_feedback_date,current_stage_interviews,current_stage_avg_score,current_stage_date,interview_history_summary
Canals,Senior Software Engineer,job_123,John Doe,cand_456,Technical Interviews,Needs Decision,interview,3,5,3/5,2026-01-15T10:30:00Z,7,true,Jane Smith,LinkedIn,3,4,Bob Jones,2026-01-14,"• Technical Interview - Bob Jones - Score: 4",4.0,2026-01-14,2026-01-10: Phone Screen (3.5)
```

### JSON Format

Structured data with normalized companies, jobs, and candidates including interview feedback:

```json
{
  "companies": [
    { "id": "org_123-company", "name": "Canals" }
  ],
  "jobs": [
    { "id": "job_123", "title": "Senior Software Engineer", "companyId": "org_123-company" }
  ],
  "candidates": [
    {
      "id": "cand_456",
      "name": "John Doe",
      "pipelineStage": "Technical Interviews",
      "decisionStatus": "Needs Decision",
      "stageType": "interview",
      "currentStageIndex": 3,
      "totalStages": 5,
      "stageProgress": "3/5",
      "jobId": "job_123",
      "companyId": "org_123-company",
      "orgId": "org_123",
      "orgName": "Canals",
      "lastActivityAt": "2026-01-15T10:30:00Z",
      "daysInStage": 7,
      "needsScheduling": true,
      "creditedTo": "Jane Smith",
      "source": "LinkedIn",
      "feedbackCount": 3,
      "latestOverallRecommendation": "4",
      "latestFeedbackAuthor": "Bob Jones",
      "latestFeedbackDate": "2026-01-14",
      "interviewEvents": [...],
      "allFeedback": [...]
    }
  ]
}
```

## Troubleshooting

### Session Expired

**Error**: `Failed to fetch CSRF token` or `401 Unauthorized`

**Solution**: Re-authenticate by grabbing a fresh session cookie from Chrome:
1. Log in to Ashby in Chrome
2. Copy the session cookie from DevTools
3. Run: `npm run start -- auth-cookie --cookie "your_new_cookie"`

### No Organizations Found

**Error**: `No organizations found`

**Solution**:
1. Verify you can access organizations in the Ashby web UI
2. Re-run authentication
3. Check that `.ashby-session.json` exists and has cookies

### No Candidates Extracted

**Possible Causes**:
1. All orgs failed to process (check error messages)
2. No active candidates in any organization
3. Session expired during extraction

**Solution**: Check the console output for specific error messages

### Some Organizations Missing Candidates

**Cause**: Ashby's internal API returns `"Unidentified server error"` for orgs where the full enrichment query (with scorecard data) is too heavy. This is a server-side issue on Ashby's end, not an auth problem.

**Behavior**: The extraction automatically retries failed queries up to 2 times, then falls back to a simplified query without scorecard data. Candidates from these orgs will appear but without feedback text/scores. Check console output for `⚠️  Full query failed ... retrying with simplified query` messages.

### TypeScript Build Errors

```bash
npm run build
```

If build fails, ensure you're on Node.js 18+ and all dependencies are installed.

## Implementation Details

### Organization Discovery

The tool uses Ashby's `/api/auth/available_identities` endpoint to discover all organizations you have access to.

### Organization Switching

Uses `/api/auth/change_user/{userId}` to switch between organization contexts, allowing data extraction from multiple orgs in a single session.

### Data Extraction

Uses a combined initial GraphQL query (`InitialFetch`) that fetches jobs, the first page of applications, and session user info in a single HTTP request. The applications query includes full interview events, scorecard feedback, and interview plan data inline — eliminating the need for a separate per-candidate enrichment phase.

Subsequent application pages are fetched sequentially (cursor-based pagination) with the same expanded field set.

### Error Recovery

Ashby's internal API can return transient server errors for orgs with large datasets. The extraction handles this with:
1. **Automatic retry** (up to 2 attempts with exponential backoff) for transient `"Unidentified server error"` responses
2. **Fallback query** that strips scorecard/feedback fields if the full query keeps failing — candidates still appear with basic data, just without feedback text/scores

### Needs Scheduling Logic

A candidate is flagged as needing scheduling (`needs_scheduling: true`) if:
- Stage type contains interview-related keywords (`interview`, `onsite`, `technical`, `screening`, `call`)
- AND days since last activity >= 7 days (configurable threshold)

## Security & Ethics

- **Read-only**: No write operations to Ashby
- **Session-based**: No password storage
- **Scope-limited**: Only accesses data visible in your UI
- **Audit trail**: All extractions are timestamped

## Future Enhancements (Out of Scope)

- Slack digest notifications
- Automated staleness alerts
- Candidate redeployment suggestions
- Velocity analytics

## Support

For issues or questions, check:
1. Console output for error messages
2. `.ashby-session.json` for session data
3. `ashby-recon-log.json` for API details (if using recon mode)

## License

Internal use only.

