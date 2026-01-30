# Ashby Extraction - Output Format Guide

## CSV Columns (Updated)

### Basic Info
1. **`company_name`** - Organization name (e.g., "CollegeVine", "Canals")
2. **`job_title`** - Role being hired for
3. **`job_id`** - Unique job identifier
4. **`candidate_name`** - Candidate's name
5. **`candidate_id`** - Unique candidate identifier

### Pipeline Position
6. **`pipeline_stage`** ⭐ **NEW** - Actual pipeline stage name
   - Examples: "Technical Interviews", "Hard Skills Check", "Offer", "Hiring Manager Screen"
   - **Note:** This varies by client - each organization customizes their pipeline stages
   - Only populated when using `--detailed` flag

7. **`decision_status`** - Current decision status
   - Examples: "Needs Decision", "Scheduled", "Waiting on Availability"

8. **`stage_type`** - Type of stage (usually "Active")

### Interview Details (requires `--detailed` flag)

#### Latest Interviews
19. **`current_stage_interviews`** ⭐ **INTUITIVE FORMAT**
    - Shows most recent interviews (within 1 day) with interview names and scores
    - Format: `"Live-Coding Interview (Alan Comley: 2, Thor Paul: 2); System Design Interview (Ian Clarkson: 2)"`
    - Includes interviewer names and their ratings

20. **`current_stage_avg_score`** - Average rating of latest interviews
    - Example: `"2.0"`, `"3.5"`

21. **`current_stage_date`** - Date of latest interviews
    - Format: `"2026-01-16"`

#### Previous Interviews  
22. **`interview_history_summary`** ⭐ **CHRONOLOGICAL**
    - All previous interviews in order
    - Format: `"2026-01-13: Engineering Technical Screen (3.0) | 2026-01-06: Hiring Manager Screen (4.0)"`
    - Shows date, interview name, and average score

### Quick Stats
15. **`feedback_count`** - Total number of feedback submissions
16. **`latest_recommendation`** - Most recent rating score
17. **`latest_feedback_author`** - Who gave the latest feedback
18. **`latest_feedback_date`** - When latest feedback was submitted

### Other Fields
- `last_activity_at`, `days_in_stage`, `needs_scheduling`
- `credited_to`, `source`
- `current_stage_index`, `total_stages`, `stage_progress`

---

## Example Output for Max Cembalest

```
company_name: CollegeVine
job_title: Senior Software Engineer
candidate_name: Max Cembalest
pipeline_stage: Technical Interviews  ⭐ NEW - Actual stage!
decision_status: Needs Decision
days_in_stage: 30

LATEST INTERVIEWS:
  Live-Coding Interview (Alan Comley: 2, Thor Paul Thordarson: 2)
  System Design Interview (Ian Clarkson: 2)
  Average: 2.0
  Date: 2026-01-16

PREVIOUS INTERVIEWS:
  2026-01-13: Engineering Technical Screen (3.0)
  2026-01-06: Hiring Manager Screen (4.0)

STATS:
  Total Interviews: 5
  Latest Recommendation: 2
  Latest Feedback From: Ian Clarkson
```

---

## How to Run

### Basic Extraction (Fast - No Interview Details)
```bash
npm run start -- extract
```
- Gets basic candidate data
- **Does NOT populate:** `pipeline_stage`, interview details, feedback

### Detailed Extraction (Comprehensive)
```bash
npm run start -- extract --detailed
```
- Gets everything including:
  - ✅ Pipeline stage names
  - ✅ Interview feedback with ratings
  - ✅ Interviewer names and scores
  - ✅ Interview history
- Takes longer (~5-10 min for 50 orgs)

### Test with Few Orgs
```bash
npm run start -- extract --detailed --max-orgs 5
```

---

## Important Notes

### Pipeline Stages Vary by Client
Different organizations have different stage names:

**CollegeVine:**
- Hiring Manager Screen
- Hard Skills Check
- Technical Interviews
- TopGrade
- Meet the Team
- Offer

**Other clients** may have:
- Phone Screen
- Technical Assessment
- Onsite Interview
- Executive Interview
- References
- etc.

The `pipeline_stage` column captures whatever stage name that specific organization uses.

---

## CSV vs JSON

### CSV
- Great for Excel/Google Sheets
- Easy to sort, filter, pivot
- Interview history in compact text format

### JSON
- Full structured data
- Individual interview events with all details
- Easier for programmatic processing
- Contains arrays of interview events with timestamps

Both are exported automatically.

