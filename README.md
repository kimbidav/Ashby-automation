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

Authenticate with Ashby using your browser:

```bash
npm run start -- auth
```

- A Chromium window will open at `app.ashbyhq.com/signin`
- Complete your normal SSO/MFA login
- The session will be saved to `.ashby-session.json`
- Close the browser when done

**Alternative**: Use existing browser cookies:

```bash
npm run start -- auth-cookie --cookie "your_cookie_string"
```

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

The CSV output follows this schema:

```csv
company_name,job_title,job_id,candidate_name,candidate_id,stage_name,stage_type,last_activity_at,days_in_stage,needs_scheduling
```

**Field Descriptions:**

- `company_name`: Organization name
- `job_title`: Job/role title
- `job_id`: Unique job identifier
- `candidate_name`: Candidate name
- `candidate_id`: Unique candidate identifier
- `stage_name`: Current pipeline stage
- `stage_type`: Type of stage (e.g., "interview", "technical_screen")
- `last_activity_at`: ISO timestamp of last activity
- `days_in_stage`: Number of days since last activity
- `needs_scheduling`: `true` if candidate is in an interview stage and inactive >= 7 days

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

If your session expires, simply run:

```bash
npm run start -- auth
```

## Project Structure

```
Ashby Automation/
├── src/
│   ├── cli.ts              # Command-line interface
│   ├── session.ts          # Authentication & session management
│   ├── client.ts           # API client with org switching
│   ├── browser-client.ts   # Browser-based API client
│   ├── api-extract.ts      # Main extraction orchestration
│   ├── export.ts           # CSV/JSON export functions
│   ├── normalize.ts        # Data normalization
│   ├── recon.ts            # Network reconnaissance
│   └── types.ts            # TypeScript type definitions
├── output/                 # Generated reports (timestamped)
├── dist/                   # Compiled JavaScript
├── .ashby-session.json     # Saved authentication session
├── package.json            # Node.js dependencies
└── README.md              # This file
```

## Output Schema

### CSV Format

Flat, human-readable table with one row per candidate:

```csv
company_name,job_title,job_id,candidate_name,candidate_id,stage_name,stage_type,last_activity_at,days_in_stage,needs_scheduling
Canals,Senior Software Engineer,job_123,John Doe,cand_456,First Call,interview,2026-01-15T10:30:00Z,7,true
```

### JSON Format

Structured data with normalized companies, jobs, and candidates:

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
      "currentStage": "First Call",
      "stageType": "interview",
      "jobId": "job_123",
      "companyId": "org_123-company",
      "orgId": "org_123",
      "orgName": "Canals",
      "lastActivityAt": "2026-01-15T10:30:00Z",
      "daysInStage": 7,
      "needsScheduling": true
    }
  ]
}
```

## Troubleshooting

### Session Expired

**Error**: `Failed to fetch CSRF token` or `401 Unauthorized`

**Solution**: Re-authenticate:
```bash
npm run start -- auth
```

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

Uses two main GraphQL queries:
1. `ApiOpenJobs` - Fetches all open job postings
2. `ApiGetActiveApplications` - Fetches active candidate applications with pagination

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
- Google Sheets sync
- Candidate redeployment suggestions
- Velocity analytics

## Support

For issues or questions, check:
1. Console output for error messages
2. `.ashby-session.json` for session data
3. `ashby-recon-log.json` for API details (if using recon mode)

## License

Internal use only.

