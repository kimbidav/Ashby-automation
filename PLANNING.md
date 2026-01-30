# Ashby Automation - Planning & Architecture Review

## Goal
Aggregate **active pipeline candidates** across **all Ashby orgs** you have access to, export to CSV/JSON with columns:
- Org, Company, Role, Candidate, Stage, Last Activity, Days in Stage

## Current Problems

### 1. **Session Management is Brittle**
- Cookies expire quickly (401 errors)
- CSRF tokens need refreshing after org switches
- `auth-cookie` command has readline issues
- Manual cookie pasting is tedious

### 2. **Multi-Org Complexity**
- Need to discover all orgs
- Need to switch context for each org (`/api/auth/change_user/{userId}`)
- CSRF token invalidates after each switch
- 50+ orgs = 50+ context switches = many failure points

### 3. **Architecture Issues**
- Mixing Playwright (browser automation) with direct API calls
- Session persistence is unreliable
- Error handling is scattered

## Alternative Approaches

### Option A: **Browser-Only Approach** (Simplest)
**Idea**: Use Playwright to actually navigate and scrape, not just for auth.

**Pros:**
- No cookie/CSRF management - browser handles it
- No org switching complexity - just navigate in browser
- More reliable (browser maintains session)
- Can use existing `recon` infrastructure

**Cons:**
- Slower (browser automation)
- More fragile to UI changes
- Harder to parallelize

**Flow:**
1. `auth` - Login once, save browser context
2. `extract` - For each org:
   - Switch org in browser (click org switcher)
   - Navigate to pipeline page
   - Extract data from DOM or network requests
   - Aggregate results

### Option B: **Hybrid: Browser for Auth, API for Data** (Current, but improved)
**Idea**: Keep current approach but fix session management.

**Improvements:**
- Use Playwright's persistent browser context (`.playwright-browser-data`) for auth
- Extract cookies directly from browser context when needed
- Cache org list from recon log (don't query API every time)
- Batch org processing with better error recovery

**Flow:**
1. `auth` - Login via Playwright, save context
2. `extract` - Load cookies from browser context, use for API calls
3. If session expires, auto-refresh from browser context

### Option C: **Recon-First Approach** (Most Reliable)
**Idea**: Do all the work during `recon`, extract data from the log.

**Pros:**
- No session management issues (you're logged in during recon)
- Can capture all orgs in one session
- Data is already captured, just needs parsing

**Cons:**
- Requires manual navigation during recon
- Recon log is huge (5MB+)
- Need to parse/clean the data

**Flow:**
1. `recon` - Navigate through all orgs manually, capture everything
2. `extract` - Parse `ashby-recon-log.json` to extract pipeline data
3. No API calls needed - data already captured

### Option D: **Simplified API Approach** (Minimal)
**Idea**: Fix the current approach but simplify dramatically.

**Changes:**
- Remove org switching - just query current org
- Use `auth` command (Playwright) instead of `auth-cookie`
- Accept that you might need to run `extract` multiple times (once per org)
- Or: Use recon log to get org list, but query them one at a time manually

## Recommendation: **Option B (Hybrid, Improved)**

### Why:
1. **Leverage Playwright's persistent context** - It already maintains session
2. **Extract cookies from browser when needed** - No manual pasting
3. **Use recon log as cache** - Don't query API for org list every time
4. **Better error handling** - If one org fails, continue with others

### Implementation Plan:

1. **Fix Session Management**
   - Use Playwright's persistent browser context (`.playwright-browser-data`)
   - Extract cookies directly from browser context
   - Auto-refresh CSRF token from browser context if needed

2. **Simplify Org Discovery**
   - Cache org list from recon log (extract once, reuse)
   - Only query API if recon log is missing/outdated

3. **Improve Org Switching**
   - Use browser context to switch orgs (more reliable than API)
   - Or: Accept sequential processing (run extract once per org)

4. **Better Error Recovery**
   - If session expires, prompt to re-run `auth`
   - Continue processing other orgs if one fails
   - Save partial results

## Questions to Answer:

1. **How often will you run this?** 
   - Daily? Weekly? One-time?
   - Affects how much we optimize for automation vs. manual steps

2. **How many orgs do you typically need?**
   - All 50? Or just a subset?
   - Affects whether we need full automation

3. **What's your tolerance for manual steps?**
   - Can you run `auth` once and then `extract` multiple times?
   - Or do you need fully automated?

4. **Is the recon log approach viable?**
   - Can you navigate through all orgs during one recon session?
   - Would you prefer to parse existing recon data?

## Next Steps:

1. **Decide on approach** (A, B, C, or D)
2. **Simplify session management** (use Playwright context)
3. **Fix the immediate blocker** (auth-cookie readline issue)
4. **Test with one org first**, then scale to many
