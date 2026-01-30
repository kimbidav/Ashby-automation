# Failure Analysis - Detailed Technical Breakdown

## Overview
The tool successfully authenticates and discovers organizations, but fails when attempting to fetch data from individual organizations.

---

## Command-by-Command Status

### ✅ `auth` Command - **WORKING**
**Status**: Fully functional

**What it does**:
- Opens browser with persistent session
- User logs in via normal SSO/MFA
- Saves session to `.playwright-browser-data/`

**Evidence of success**:
```
✓ Authenticated via browser context
```

**No failures observed** in this command.

---

### ✅ `recon` Command - **WORKING**
**Status**: Fully functional

**What it does**:
- Captures API calls while user navigates Ashby
- Saves to `ashby-recon-log.json`

**Evidence of success**:
- File `ashby-recon-log.json` exists with 1,222 captured requests
- Contains 890 GraphQL POST requests
- Successfully captured `ApiOpenJobs` and other operations

**No failures observed** in this command.

---

### ⚠️ `extract` Command - **PARTIALLY WORKING**
**Status**: Fails at data extraction step

**What it does**:
1. Opens browser context ✅
2. Validates authentication ✅
3. Discovers organizations ✅
4. **FAILS HERE** → Fetches data from each org ❌

---

## Detailed Failure Analysis: `extract` Command

### Step 1: Authentication ✅ **SUCCESS**
```
Opening browser context...
Validating authentication...
✓ Authenticated via browser context
```
**Status**: Working perfectly

---

### Step 2: Organization Discovery ✅ **SUCCESS**
```
Discovering accessible organizations...
Found 50 accessible organization(s)
```
**Status**: Working perfectly
- Successfully calls `/api/auth/available_identities`
- Returns 50 organizations with IDs and user IDs

**Issue**: Organization names are `undefined`
- API response may not include `organizationName` field
- Or field name is different than expected

---

### Step 3: Data Extraction ❌ **FAILURE**

**Failure Point**: When attempting to fetch pipeline data from each organization

**Error Pattern**: All 50 organizations fail with the same error

#### Error Details

**Error Type**: `401 Unauthorized`

**Error Message**: 
```
GraphQL request failed 401: {"error":"Unauthorized"}
```

**Where it fails**:
- File: `src/browser-client.ts`
- Function: `BrowserClient.graphqlQuery()`
- Line: ~72 (when making GraphQL POST request)
- Operation: `ApiOpenJobs` (first query attempted)

**Full Error Stack**:
```
Error: GraphQL request failed 401: {"error":"Unauthorized"}
    at BrowserClient.graphqlQuery (file:///.../src/browser-client.ts:72:19)
    at async BrowserClient.fetchPipelineForOrg (file:///.../src/browser-client.ts:306:24)
    at async Command.<anonymous> (file:///.../src/cli.ts:209:57)
```

---

## Root Cause Analysis

### Primary Issue: CSRF Token / Session Context After Org Switch

**What's happening**:

1. ✅ User authenticates successfully (initial session valid)
2. ✅ Tool discovers all 50 orgs successfully
3. ✅ Tool attempts to switch to first org context
4. ❌ **FAILURE**: After org switch, CSRF token becomes invalid
5. ❌ All subsequent GraphQL requests return 401

**Technical Details**:

1. **Org Switch Process**:
   ```typescript
   // In BrowserClient.switchOrgContext()
   POST /api/auth/change_user/{userId}
   // This switches the active organization context
   ```

2. **What Should Happen After Switch**:
   - CSRF token should be refreshed
   - Page should be reloaded to get new session cookies
   - New CSRF token should be fetched

3. **What's Actually Happening**:
   - CSRF token is cleared (`this.csrfToken = null`)
   - Page is navigated to refresh
   - New CSRF token is fetched
   - **BUT**: The token may not be valid for the new org context yet
   - **OR**: The session cookies aren't properly updated for the new org

### Secondary Issue: Organization Names

**Problem**: All org names show as `undefined` in output

**Where it happens**:
- `src/browser-client.ts` line ~151-155
- When mapping API response to org info

**Possible causes**:
1. API response doesn't include `organizationName` field
2. Field name is different (e.g., `name` instead of `organizationName`)
3. Field is nested differently in response

**Evidence**:
```
[1/50] Processing org: undefined (undefined)
```

---

## Specific Code Locations

### Failure Location 1: GraphQL Query Execution
**File**: `src/browser-client.ts`
**Function**: `graphqlQuery()`
**Line**: ~77-95

```typescript
async graphqlQuery<T>(operationName: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const csrfToken = await this.getCsrfToken(); // ← May get invalid token here
  
  const response = await this.page.request.post(url, {
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken, // ← 401 error occurs here
      'accept': 'application/json'
    },
    data: JSON.stringify({ operationName, query, variables })
  });
  
  if (!response.ok()) {
    throw new Error(`GraphQL request failed ${response.status()}: ...`); // ← FAILS HERE
  }
}
```

### Failure Location 2: Org Context Switching
**File**: `src/browser-client.ts`
**Function**: `switchOrgContext()`
**Line**: ~118-140

```typescript
async switchOrgContext(userId: string): Promise<void> {
  await this.getCsrfToken(); // Get token for switch request
  const response = await this.page.request.post(`/api/auth/change_user/${userId}`, ...);
  
  this.csrfToken = null; // Clear token
  await this.page.goto('https://app.ashbyhq.com', ...); // Navigate
  await this.getCsrfToken(); // Refresh token
  // ← Problem: Token may not be valid yet, or cookies not updated
}
```

### Failure Location 3: Org Name Extraction
**File**: `src/browser-client.ts`
**Function**: `fetchAllAvailableOrgs()`
**Line**: ~145-155

```typescript
const data = await response.json() as Array<{
  organizationId: string;
  organizationName?: string; // ← May not exist in response
  userId: string;
}>;

return data.map(item => ({
  id: item.organizationId,
  name: item.organizationName, // ← Returns undefined if field missing
  userId: item.userId
}));
```

---

## Error Frequency

**Pattern**: 100% failure rate on data extraction

- **Total orgs discovered**: 50
- **Orgs that fail**: 50 (100%)
- **Orgs that succeed**: 0 (0%)

**Error distribution**:
- 49 orgs: `401 Unauthorized` 
- 1 org: `Unidentified server error` (different error, but also failed)

---

## What Works vs. What Doesn't

### ✅ What Works
1. Browser authentication
2. Session persistence
3. Organization discovery (finding all 50 orgs)
4. Org context switching API call (the POST succeeds)
5. Query loading from recon log
6. Error handling and recovery (continues to next org on failure)

### ❌ What Doesn't Work
1. **CSRF token validity after org switch** - Token becomes invalid
2. **GraphQL queries after org switch** - All return 401
3. **Organization name extraction** - Returns undefined
4. **Data extraction** - 0% success rate

---

## Attempted Fixes

### Fix Attempt 1: CSRF Token Refresh
**What we tried**:
- Clear CSRF token after org switch
- Navigate to page to refresh cookies
- Fetch new CSRF token

**Result**: Still getting 401 errors

**Why it might not work**:
- Timing issue: Token fetched before cookies fully updated
- Cookie domain issue: Cookies may not be properly scoped for new org
- Session state: Browser context may need explicit cookie refresh

### Fix Attempt 2: Page Navigation
**What we tried**:
- Navigate to `https://app.ashbyhq.com` after org switch
- Wait for `networkidle` to ensure page loaded
- Wait additional 1 second for cookies to settle

**Result**: Still getting 401 errors

**Why it might not work**:
- May need to wait longer
- May need to check for specific page elements to confirm org switch
- May need to make a "warm-up" API call before the real query

---

## Recommended Next Steps

### Immediate Fixes Needed

1. **Debug CSRF Token Flow**
   - Add logging to see token value before/after org switch
   - Verify token is actually being sent in headers
   - Check if token format is correct

2. **Verify Cookie State**
   - Log all cookies before/after org switch
   - Verify `ashby_session_token` cookie is updated
   - Check cookie domain/path settings

3. **Add Warm-up Request**
   - After org switch, make a simple API call (e.g., `ApiGetSessionUser`)
   - This may "activate" the session for the new org
   - Then proceed with pipeline queries

4. **Fix Org Name Extraction**
   - Inspect actual API response structure
   - Add fallback to fetch org name separately if needed
   - Or use org ID as display name if name unavailable

### Testing Strategy

1. **Test with single org first**
   - Skip org switching, just query current org
   - Verify basic query works

2. **Test org switching separately**
   - Switch org, then manually verify session is valid
   - Check cookies and CSRF token state

3. **Gradual scale-up**
   - Test with 2-3 orgs
   - Then 10 orgs
   - Then all 50

---

## Technical Environment

**Runtime**: Node.js with TypeScript
**Browser Automation**: Playwright
**API**: Ashby's internal GraphQL API (reverse-engineered)
**Session Management**: Playwright persistent browser context

**Key Dependencies**:
- `playwright`: Browser automation
- `commander`: CLI interface
- `cross-fetch`: HTTP requests (not used in browser-client, but in old client)

---

## Exact Code Locations

### Failure Point 1: GraphQL Request (401 Error)
**File**: `src/browser-client.ts`
**Line**: 98
**Function**: `graphqlQuery()`
**Code**:
```typescript
if (!response.ok()) {
  throw new Error(`GraphQL request failed ${response.status()}: ${errorText.substring(0, 200)}`);
  // ↑ FAILS HERE with status 401
}
```

### Failure Point 2: Org Context Switch
**File**: `src/browser-client.ts`
**Line**: 116-140
**Function**: `switchOrgContext()`
**Issue**: After this function completes, subsequent GraphQL calls fail

### Failure Point 3: Pipeline Data Fetch
**File**: `src/browser-client.ts`
**Line**: 306
**Function**: `fetchPipelineForOrg()`
**Code**:
```typescript
jobsData = await this.graphqlQuery<JobsPipelinesResponse>(
  openJobsOpName,
  openJobsQuery,
  { ... }
);
// ↑ This call fails with 401
```

### Failure Point 4: Org Name Extraction
**File**: `src/browser-client.ts`
**Line**: 151-155
**Function**: `fetchAllAvailableOrgs()`
**Code**:
```typescript
return data.map(item => ({
  id: item.organizationId,
  name: item.organizationName, // ← Returns undefined
  userId: item.userId
}));
```

---

## Summary

**Working**: Authentication, org discovery, query loading
**Failing**: Data extraction after org context switch (401 errors)
**Root Cause**: CSRF token/session state not properly maintained after org switch
**Impact**: 0% success rate on data extraction (50/50 orgs fail)
**Priority**: **HIGH** - Blocks all data extraction functionality

**Confidence in Fix**: **MEDIUM-HIGH**
- Issue is well-isolated (org switching)
- Multiple potential solutions to try
- Can test incrementally

**Estimated Fix Time**: 2-4 hours of debugging and testing
