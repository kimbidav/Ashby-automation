# Ashby Pipeline Extractor - User Guide

## Quick Start (For Non-Technical Users)

### What This Does
This tool automatically extracts all active candidates from every Ashby organization you have access to and saves them to a spreadsheet (CSV file) on your Desktop.

### How to Use

#### Option 1: Double-Click the App (Easiest!)

1. **Double-click** `Ashby Pipeline Extractor.app` on your Desktop
2. A Terminal window will open automatically
3. Follow the prompts if your session needs refreshing
4. Wait for completion notification
5. The `output` folder will open automatically with your data!

#### Option 2: Right-Click for Weekly Schedule

To run this automatically every week:

1. Right-click `Ashby Pipeline Extractor.app`
2. Select **Open** (first time only, for security)
3. Set up a Calendar reminder or use macOS Automator to schedule it

---

## First Time Setup (One Time Only)

The first time you run the app, you'll need to provide your Ashby session:

1. Open `app.ashbyhq.com` in your browser
2. Make sure you're logged in
3. Open DevTools:
   - Press `Cmd + Option + I` (Mac)
   - Or right-click → Inspect
4. Click the **Application** tab at the top
5. In the left sidebar, expand **Cookies** → `https://app.ashbyhq.com`
6. Find the cookie named `ashby_session_token`
7. Click it and copy the **Value** (the long string)
8. Paste it when the app asks for it

**You only need to do this once!** The app will remember your session.

---

## When to Refresh Your Session

Your Ashby session will expire after about 7 days. The app will automatically detect this and ask you to refresh it by following the same steps as First Time Setup.

Signs your session has expired:
- The app shows a dialog asking for a new session token
- You see "401 Unauthorized" errors in the Terminal

---

## Output Files

After each run, you'll find two new files in the `output/` folder:

### 1. CSV File (Open with Excel or Google Sheets)
`ashby_pipeline_2026-01-22.csv`

**Columns:**
- `company_name` - Organization name (e.g., "Graphite", "Epsilon Labs")
- `job_title` - Role being hired for
- `job_id` - Unique job identifier
- `candidate_name` - Candidate's name
- `candidate_id` - Unique candidate identifier
- `stage_name` - Current pipeline stage
- `stage_type` - Type of stage (e.g., "Active")
- `last_activity_at` - When the candidate last had activity
- `days_in_stage` - How many days they've been in this stage
- `needs_scheduling` - Whether they need interview scheduling

### 2. JSON File (For developers/automation)
`ashby_pipeline_2026-01-22.json`

---

## Typical Weekly Workflow

**Monday Morning Routine:**

1. Double-click `Ashby Pipeline Extractor.app`
2. Wait 1-2 minutes for extraction to complete
3. Get notification: "✅ Success! Extracted 261 candidates"
4. Open the CSV file from the `output/` folder
5. Review candidates, identify who needs attention
6. Follow up with stuck candidates (high `days_in_stage` numbers)

**That's it!**

---

## Troubleshooting

### App won't open - "Can't be opened because it is from an unidentified developer"

1. Right-click the app
2. Select **Open**
3. Click **Open** in the dialog
4. (First time only)

### Session keeps expiring

- Make sure you're copying the `ashby_session_token` cookie, not just any cookie
- Try logging out and back into Ashby, then copy a fresh token
- Check that you're copying the full value (it's usually quite long)

### No candidates found

This could mean:
- All your organizations genuinely have no active candidates
- Your session expired (run again to refresh)
- Network connectivity issues

### Terminal shows errors

- Screenshot the error
- Check if your session needs refreshing
- Make sure you have internet connection

---

## Advanced: Running from Command Line

If you're comfortable with Terminal, you can also run:

```bash
cd "/Users/david/Desktop/Ashby Automation"
./run_ashby_extract.sh
```

Or just the extraction without the wrapper:

```bash
cd "/Users/david/Desktop/Ashby Automation"
npm run start -- extract
```

---

## Files Location

- **App**: `/Users/david/Desktop/Ashby Pipeline Extractor.app`
- **Project**: `/Users/david/Desktop/Ashby Automation/`
- **Output**: `/Users/david/Desktop/Ashby Automation/output/`
- **Session**: `/Users/david/Desktop/Ashby Automation/.ashby-session.json`

---

## Support

If you encounter issues:

1. Check the Terminal output for error messages
2. Try refreshing your session
3. Make sure you're connected to the internet
4. Ensure Ashby's website is accessible in your browser

---

## Data Privacy

- This tool only reads data you already have access to in Ashby
- No data is sent anywhere except to your local computer
- Files are saved only on your Desktop
- Your session token is stored locally in `.ashby-session.json`
