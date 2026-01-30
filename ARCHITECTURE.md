# Simplified Architecture for Single-User Dashboard

## Goal
**One command** → **One CSV/JSON** with all active candidates across all your client orgs.

## User Story
As dkimball@candidatelabs.com (external recruiter), I want to:
1. Run `npm run start -- extract` 
2. Get a CSV with all active candidates from all my client orgs
3. See: Org, Company, Role, Candidate, Stage, Last Activity, Days in Stage

## Simplified Architecture

### Phase 1: Auth (One-Time Setup)
**Command**: `npm run start -- auth`

**What it does:**
- Opens Playwright browser
- You log in once with dkimball@candidatelabs.com
- Saves browser context to `.playwright-browser-data/`
- Browser context persists cookies automatically

**Why this works:**
- Playwright's persistent context maintains session
- No manual cookie pasting
- No readline issues
- Session stays valid longer

### Phase 2: Extract (The Main Command)
**Command**: `npm run start -- extract --json output.json --csv output.csv`

**What it does:**
1. **Load browser context** (from `.playwright-browser-data/`)
2. **Extract fresh cookies** from browser context
3. **Discover orgs** (from API or recon log)
4. **For each org:**
   - Switch org context (via browser or API)
   - Fetch jobs + active applications
   - Normalize data
5. **Aggregate everything** into one CSV/JSON

**Key insight**: Use browser context as the source of truth for auth, not a separate session file.

## Implementation Plan

### Step 1: Fix Session Management
- Remove dependency on `.ashby-session.json` for auth
- Always extract cookies from Playwright browser context
- Browser context = single source of truth

### Step 2: Simplify Org Discovery
- First try: Query API for available orgs (using browser cookies)
- Fallback: Extract from recon log
- Cache org list (don't query every time)

### Step 3: Reliable Org Switching
- Option A: Use browser to switch orgs (navigate to each org)
- Option B: Use API `/api/auth/change_user/{userId}` (current approach)
- Extract fresh cookies after each switch

### Step 4: Error Handling
- If browser context missing → prompt to run `auth`
- If session expired → prompt to re-run `auth`
- If one org fails → continue with others, log errors

## Code Changes Needed

1. **New function**: `extractCookiesFromBrowserContext()`
   - Loads Playwright browser context
   - Extracts all cookies
   - Returns `AshbySession` object

2. **Modify `extract` command**:
   - Try to load from browser context first
   - Fall back to `.ashby-session.json` if needed
   - Always refresh cookies from browser if available

3. **Simplify `auth-cookie`**:
   - Remove it (use `auth` instead)
   - Or make it optional helper

4. **Better error messages**:
   - "Browser context not found. Run 'auth' first."
   - "Session expired. Run 'auth' to refresh."

## User Flow (Simplified)

```
# First time setup
npm run start -- auth
# → Browser opens, you log in, close browser

# Every time you want data
npm run start -- extract --json output.json --csv output.csv
# → Aggregates all orgs, outputs one CSV
```

## Benefits

1. **Single source of truth**: Browser context
2. **No manual steps**: No cookie pasting
3. **Reliable**: Playwright handles session management
4. **Simple**: One command to get everything
5. **Resilient**: If session expires, just re-run `auth`
