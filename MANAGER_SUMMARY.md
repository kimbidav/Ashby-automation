# Ashby Automation Project - Manager Summary

## Executive Summary

**Goal**: Create a read-only tool that aggregates in-process candidates across all Ashby organizations accessible by a single user account, eliminating the need to manually log into each client's Ashby instance.

**Status**: Core functionality complete, ready for testing and refinement.

---

## The Problem (Big Picture)

As a consultant/recruiter working with multiple clients, you need to:
- Track active candidates across multiple Ashby instances
- See pipeline status, stages, and activity across all clients
- Do this without manually logging into each client's Ashby account

**Current Pain Point**: You have to log into each client's Ashby instance separately, navigate to their pipeline, and manually track candidates. This is time-consuming and doesn't give you a unified view.

---

## The Solution (Big Picture)

A command-line tool that:
1. **Authenticates once** using your browser session
2. **Discovers all organizations** you have access to
3. **Aggregates candidate data** from all orgs automatically
4. **Exports to CSV/JSON** for easy analysis

**Key Principle**: Read-only, no data mutation. This tool only reads data you can already see in the UI.

---

## Technical Approach

### Architecture Overview

We're using a **reverse-engineering approach** because Ashby doesn't have a public API:

1. **Browser Automation** (Playwright)
   - Reuses your real browser authentication session
   - No credential storage needed
   - Maintains session cookies automatically

2. **Network Reconnaissance**
   - Captures actual API calls made by Ashby's web app
   - Extracts GraphQL queries and endpoints
   - Stores them for replay

3. **Programmatic Replay**
   - Uses captured API calls to fetch data programmatically
   - Switches between organization contexts automatically
   - Aggregates data from all orgs

4. **Data Normalization & Export**
   - Converts raw API responses to standardized format
   - Exports to CSV (for Excel/spreadsheets) and JSON (for automation)

### Why This Approach?

- **No official API**: Ashby doesn't provide a public API
- **Read-only safety**: We only replay calls the web app already makes
- **Permission-respecting**: Only sees data you can see in the UI
- **Maintainable**: If Ashby changes their API, we re-run recon to capture new calls

---

## What We've Built (Technical Details)

### 1. Authentication System (`auth` command)
- Opens browser with persistent session
- User logs in once via normal SSO/MFA
- Session persists across runs (no re-login needed)
- **No cookie extraction needed** - browser manages everything

### 2. Network Reconnaissance (`recon` command)
- Captures all API calls while you navigate Ashby
- Saves GraphQL queries, endpoints, and request patterns
- Used to reverse-engineer the API structure

### 3. Data Extraction (`extract` command)
- **Discovers organizations**: Automatically finds all orgs you can access
- **Multi-org support**: Iterates through all orgs and switches context
- **Uses reverse-engineered queries**: Loads API calls from recon log
- **Fetches pipeline data**:
  - Open jobs for each org
  - Active candidates/applications
  - Stage information, activity dates
- **Exports data**: CSV and JSON formats

### 4. Key Technical Components

**`BrowserClient`** (`src/browser-client.ts`)
- Makes API calls through browser context (no cookie management)
- Handles CSRF tokens automatically
- Switches organization contexts
- Uses queries from recon log (reverse-engineered)

**`recon-parser`** (`src/recon-parser.ts`)
- Parses captured API calls from recon log
- Extracts GraphQL queries dynamically
- Falls back to hardcoded queries if recon log missing

**Session Management**
- Uses Playwright's persistent browser context
- No manual cookie handling
- Session stays valid as long as browser context exists

---

## Current Status

### ✅ Completed
- Authentication via browser session
- Organization discovery
- Multi-org context switching
- GraphQL query extraction from recon log
- Pipeline data fetching (jobs + applications)
- Data normalization (Company, Job, Candidate model)
- CSV/JSON export
- Error handling and recovery

### 🔄 In Progress / Needs Testing
- Org switching authentication (some 401 errors observed)
- Org name extraction (showing as "undefined" in some cases)
- Large-scale testing across all 50+ organizations

### 📋 Known Issues
1. **401 Unauthorized errors** after org switching
   - Likely CSRF token refresh timing issue
   - Fix attempted: Added page navigation and token refresh after org switch
   - Needs testing

2. **Org names showing as "undefined"**
   - API may not return names in all cases
   - May need to fetch org names separately

---

## Usage

### Initial Setup (One Time)
```bash
npm install
npm run start -- auth
# Log in with dkimball@candidatelabs.com in the browser window
# Close browser when done
```

### Capture API Calls (One Time, or when Ashby updates)
```bash
npm run start -- recon
# Navigate to Candidates → Pipeline → Active in the browser
# Expand some roles to capture API traffic
# Close browser when done
```

### Extract Data (Run Anytime)
```bash
npm run start -- extract --json output.json --csv output.csv
```

---

## Output Format

### CSV Output
```
Org,Company,Role,Candidate,Stage,Last Activity,Days in Stage
Client A,Acme Corp,Software Engineer,John Doe,Phone Screen,2024-01-15,5
Client B,Tech Inc,Product Manager,Jane Smith,On-site,2024-01-10,10
```

### JSON Output
```json
{
  "companies": [...],
  "jobs": [...],
  "candidates": [
    {
      "id": "...",
      "name": "John Doe",
      "currentStage": "Phone Screen",
      "jobId": "...",
      "companyId": "...",
      "orgId": "...",
      "orgName": "Client A",
      "lastActivityAt": "2024-01-15",
      "daysInStage": 5
    }
  ]
}
```

---

## Next Steps

1. **Testing & Debugging**
   - Test org switching across multiple orgs
   - Fix 401 authentication errors
   - Verify org name extraction

2. **Enhancements**
   - Add filtering options (by org, stage, date range)
   - Add progress indicators for large extractions
   - Add retry logic for failed orgs

3. **Documentation**
   - User guide
   - Troubleshooting guide
   - API change detection (when to re-run recon)

---

## Technical Stack

- **TypeScript**: Type-safe development
- **Playwright**: Browser automation and session management
- **Commander.js**: CLI interface
- **Node.js**: Runtime environment

---

## Risk Assessment

### Low Risk
- **Read-only operations**: No data mutation possible
- **Permission-respecting**: Only sees data user can already access
- **No credential storage**: Uses browser session, no passwords stored

### Medium Risk
- **API changes**: If Ashby changes their internal API, recon needs to be re-run
- **Rate limiting**: Making many API calls quickly could trigger rate limits
- **Session expiration**: Browser session may expire after extended periods

### Mitigation
- Fallback to hardcoded queries if recon log is outdated
- Error handling and retry logic
- Clear instructions for re-authentication

---

## Questions for Discussion

1. **Scope**: Should we add filtering/querying capabilities?
2. **Scheduling**: Should this run automatically on a schedule?
3. **Integration**: Should we integrate with other tools (Slack, email, etc.)?
4. **Access Control**: Who should have access to this tool?
5. **Data Retention**: How long should extracted data be kept?

---

## Summary

We've built a working prototype that:
- ✅ Aggregates candidates from multiple Ashby orgs
- ✅ Uses reverse-engineered API calls (no official API needed)
- ✅ Maintains authentication automatically
- ✅ Exports data in usable formats

**Current blocker**: Some authentication issues when switching between orgs (likely fixable with timing adjustments).

**Recommendation**: Test with a subset of orgs first, then scale to all 50+ once authentication is stable.
