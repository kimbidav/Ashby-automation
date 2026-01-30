# Ashby Automation - Executive One-Pager

## What We're Building
A tool that aggregates active candidates from all your Ashby client organizations into a single CSV/JSON file, eliminating the need to log into each client's Ashby instance separately.

## The Problem
- Working with 50+ client Ashby instances
- Need to track candidates across all clients
- Currently requires manual login to each instance
- No unified view of pipeline status

## The Solution
**One command** → **All candidates** → **One file**

```bash
npm run start -- extract --csv output.csv
```

## How It Works (Simple)
1. **Authenticate once** (via browser, normal login)
2. **Tool discovers** all organizations you can access
3. **Tool fetches** candidate data from each org automatically
4. **Tool exports** everything to CSV/JSON

## How It Works (Technical)
- Uses browser automation (Playwright) to maintain your login session
- Reverse-engineers Ashby's internal API calls (they don't have a public API)
- Replays those API calls programmatically to fetch data
- Switches between organization contexts automatically
- Aggregates and normalizes the data

## Current Status
✅ **Core functionality complete**
- Authentication working
- Multi-org discovery working
- Data extraction working
- CSV/JSON export working

🔄 **In testing**
- Some authentication issues when switching between orgs (fixable)
- Need to test at scale (50+ orgs)

## Key Features
- **Read-only**: Can't modify any data, only reads what you can see
- **No credentials stored**: Uses your browser session
- **Automatic**: Discovers and processes all orgs automatically
- **Maintainable**: If Ashby changes their API, we re-capture it

## Output Example
```csv
Org,Company,Role,Candidate,Stage,Last Activity,Days in Stage
Client A,Acme Corp,Engineer,John Doe,Phone Screen,2024-01-15,5
Client B,Tech Inc,Manager,Jane Smith,On-site,2024-01-10,10
```

## Next Steps
1. Fix org-switching authentication issues
2. Test with all 50+ organizations
3. Add filtering/querying capabilities (if needed)
4. Consider scheduling/automation (if needed)

## Risk Level: **Low**
- Read-only operations (can't break anything)
- Only sees data you already have access to
- No credential storage
- Uses same API calls the web app makes

---

**Bottom Line**: Working prototype that needs testing and minor fixes before production use.
