#!/bin/bash

# Ashby Pipeline Extraction Script
# This script runs the Ashby data extraction and handles session management

# Set working directory
cd "/Users/david/Desktop/Ashby Automation"

# Function to show notification
notify() {
    osascript -e "display notification \"$1\" with title \"Ashby Extraction\" sound name \"Glass\""
}

# Function to show dialog
show_dialog() {
    osascript -e "display dialog \"$1\" with title \"Ashby Extraction\" buttons {\"OK\"} default button \"OK\""
}

# Function to check if session exists and is recent (less than 7 days old)
check_session() {
    if [ ! -f ".ashby-session.json" ]; then
        return 1
    fi

    # Check if file is older than 7 days
    if [ $(find ".ashby-session.json" -mtime +7 | wc -l) -gt 0 ]; then
        return 1
    fi

    return 0
}

# Function to refresh cookies
refresh_cookies() {
    osascript <<'EOF'
    set dialogResult to display dialog "Your Ashby session has expired and needs to be refreshed.

📋 Instructions:
1. Open app.ashbyhq.com in your browser
2. Make sure you're logged in
3. Open DevTools (press Cmd+Option+I)
4. Click the 'Application' tab
5. Expand 'Cookies' → click 'app.ashbyhq.com'
6. Find the 'ashby_session_token' row
7. Copy the entire Value (starts with s%3A)
8. Paste it below

⚠️ Copy the FULL value including s%3A at the start" default answer "" with title "Refresh Ashby Session" buttons {"Cancel", "Continue"} default button "Continue"

    if button returned of dialogResult is "Continue" then
        return text returned of dialogResult
    else
        error number -128
    end if
EOF
}

# Function to update session token
update_session_token() {
    local new_token="$1"

    # Create session file if it doesn't exist
    if [ ! -f ".ashby-session.json" ]; then
        echo '{"cookies":{"ashby_session_token":""}}' > .ashby-session.json
    fi

    # Check if jq is available
    if command -v jq &> /dev/null; then
        # Use jq to update the token
        cat .ashby-session.json | jq --arg token "$new_token" '.cookies.ashby_session_token = $token' > .ashby-session.json.tmp
        mv .ashby-session.json.tmp .ashby-session.json
    else
        # Fallback: direct JSON write
        echo "{\"cookies\":{\"ashby_session_token\":\"$new_token\"}}" > .ashby-session.json
    fi
}

# Main execution
echo "========================================"
echo "Ashby Pipeline Extraction"
echo "========================================"
echo ""

# Check session
if ! check_session; then
    notify "Session expired or missing. Opening authentication..."

    # Try to get new session token
    session_token=$(refresh_cookies)

    if [ $? -eq 0 ] && [ ! -z "$session_token" ]; then
        # Update session file with new token
        update_session_token "$session_token"
        notify "Session refreshed successfully!"
    else
        show_dialog "Session refresh cancelled. Please run again when ready."
        exit 1
    fi
fi

# Show starting notification
notify "Starting detailed extraction with interview feedback from all organizations..."

# Run the extraction with detailed interview feedback (with retry logic)
MAX_RETRIES=2
RETRY_COUNT=0
EXTRACTION_SUCCESS=false

while [ $RETRY_COUNT -lt $MAX_RETRIES ] && [ "$EXTRACTION_SUCCESS" = false ]; do
    if [ $RETRY_COUNT -gt 0 ]; then
        echo ""
        echo "Retrying extraction (attempt $((RETRY_COUNT + 1))/$MAX_RETRIES)..."
        notify "Retrying extraction with new session..."
    fi

    # Run the extraction
    echo "Running detailed extraction..."
    npm run start -- extract --detailed 2>&1 | tee /tmp/ashby_extract.log
    EXTRACTION_EXIT_CODE=${PIPESTATUS[0]}

    # Check if extraction failed due to 401/session expiry
    if grep -q "401 Unauthorized\|Session appears expired\|Failed to fetch CSRF token" /tmp/ashby_extract.log; then
        echo ""
        echo "⚠️  Session expired detected"

        if [ $RETRY_COUNT -lt $((MAX_RETRIES - 1)) ]; then
            notify "Session expired. Opening refresh dialog..."

            # Try to get new session token
            session_token=$(refresh_cookies)

            if [ $? -eq 0 ] && [ ! -z "$session_token" ]; then
                # Update session file with new token
                update_session_token "$session_token"
                notify "Session refreshed! Retrying extraction..."
                RETRY_COUNT=$((RETRY_COUNT + 1))
            else
                show_dialog "Session refresh cancelled. Extraction aborted."
                exit 1
            fi
        else
            notify "❌ Extraction failed after retries"
            show_dialog "Extraction failed after multiple attempts.

The session may be invalid or there may be another issue.

Please:
1. Make sure you're copying the complete ashby_session_token value
2. Ensure you're logged into app.ashbyhq.com
3. Check your internet connection

The log has been saved to /tmp/ashby_extract.log"
            exit 1
        fi
    elif [ $EXTRACTION_EXIT_CODE -eq 0 ]; then
        # Extraction succeeded
        EXTRACTION_SUCCESS=true
    else
        # Other error occurred
        notify "❌ Extraction failed - see terminal for details"
        show_dialog "Extraction failed with an error.

Common issues:
• Network connection problems
• Ashby API changes
• Missing dependencies

The log has been saved to /tmp/ashby_extract.log"
        exit 1
    fi
done

# Check if extraction was successful
if [ "$EXTRACTION_SUCCESS" = true ]; then
    # Count candidates
    candidate_count=$(tail -20 /tmp/ashby_extract.log | grep "Total candidates extracted:" | sed 's/.*: //')

    if [ ! -z "$candidate_count" ]; then
        notify "✅ Success! Extracted $candidate_count candidates"

        # Open the output directory
        open output/

        show_dialog "Extraction complete!

✅ Extracted $candidate_count candidates from all organizations

📊 Detailed data includes:
• Pipeline stages (e.g., Technical Interviews, Offer)
• Interview feedback and rating scores
• Interviewer names and recommendations
• Decision status per stage
• Interview history

Files saved to:
• output/ashby_pipeline_$(date +%Y-%m-%d).csv
• output/ashby_pipeline_$(date +%Y-%m-%d).json

The output folder has been opened for you."
    else
        notify "⚠️ Extraction completed but no data found"
        show_dialog "Extraction completed but no candidates were found. This might mean:

• All organizations have no active candidates
• There was an error during extraction

Check the terminal output for details."
    fi
fi

echo ""
echo "========================================"
echo "Extraction complete!"
echo "========================================"
