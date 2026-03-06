/**
 * ============================================================
 * LOVABLE FRONTEND CHANGES
 * ============================================================
 *
 * Copy these components into your Lovable project to enable
 * self-serve extraction. Replace YOUR_RAILWAY_URL with your
 * deployed Railway URL (e.g., https://ashby-automation-production.up.railway.app).
 *
 * Files to create/modify in Lovable:
 *   1. src/components/AshbyExtract.tsx  (NEW - the extract button component)
 *   2. src/pages/Index.tsx              (MODIFY - add AshbyExtract alongside CsvUpload)
 */

// ============================================================
// FILE 1: src/components/AshbyExtract.tsx
// ============================================================

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Candidate } from "@/data/candidates";

// IMPORTANT: Replace with your Railway URL after deploying
const API_URL = "YOUR_RAILWAY_URL";

interface AshbyExtractProps {
  onExtract: (candidates: Candidate[]) => void;
}

export function AshbyExtract({ onExtract }: AshbyExtractProps) {
  const [open, setOpen] = useState(false);
  const [cookie, setCookie] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");

  const handleExtract = async () => {
    if (!cookie.trim()) {
      toast.error("Please paste your Ashby cookie.");
      return;
    }

    setLoading(true);
    setProgress("Connecting to Ashby...");

    try {
      const res = await fetch(`${API_URL}/api/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: cookie.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 401) {
          toast.error("Session expired. Please paste a fresh cookie from Ashby.");
        } else {
          toast.error(data.error || "Extraction failed.");
        }
        return;
      }

      if (data.candidates && data.candidates.length > 0) {
        onExtract(data.candidates);
        toast.success(
          `Extracted ${data.candidates.length} candidates from ${data.stats.companies} companies.`
        );
        setOpen(false);
        setCookie("");
      } else {
        toast.error("No candidates found. Check your Ashby access.");
      }
    } catch (err: any) {
      toast.error("Could not connect to extraction server. Is it running?");
      console.error("Extraction error:", err);
    } finally {
      setLoading(false);
      setProgress("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default" size="sm" className="gap-2">
          <RefreshCw className="h-4 w-4" />
          Fetch from Ashby
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fetch Pipeline from Ashby</DialogTitle>
          <DialogDescription>
            Paste your Ashby session cookie to pull the latest pipeline data.
            This replaces any currently loaded data.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">How to get your cookie:</label>
            <ol className="text-sm text-muted-foreground list-decimal list-inside space-y-1">
              <li>Open <strong>app.ashbyhq.com</strong> in Chrome (make sure you're logged in)</li>
              <li>Press <strong>F12</strong> to open DevTools</li>
              <li>Go to <strong>Application</strong> tab → <strong>Cookies</strong> → <strong>app.ashbyhq.com</strong></li>
              <li>Find <strong>ashby_session_token</strong>, right-click → <strong>Copy value</strong></li>
              <li>Paste it below as: <code className="bg-muted px-1 rounded">ashby_session_token=VALUE</code></li>
            </ol>
          </div>

          <Input
            placeholder="ashby_session_token=..."
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            disabled={loading}
          />

          {progress && (
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              {progress}
            </p>
          )}

          <Button
            onClick={handleExtract}
            disabled={loading || !cookie.trim()}
            className="w-full"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Extracting pipeline data...
              </>
            ) : (
              "Extract Pipeline"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// FILE 2: Modify src/pages/Index.tsx
// ============================================================
// Add this import at the top:
//
//   import { AshbyExtract } from "@/components/AshbyExtract";
//
// Then in the header actions area (around line 99-112), add the AshbyExtract
// component next to the existing CsvUpload:
//
//   <div className="flex items-center gap-2">
//     {sessionId && (
//       <Button variant="outline" size="sm" onClick={handleCopyLink} className="gap-2">
//         <Share2 className="h-4 w-4" />
//         Copy Share Link
//       </Button>
//     )}
//     <AshbyExtract onExtract={handleCsvUpload} />    {/* <-- ADD THIS */}
//     <CsvUpload onUpload={handleCsvUpload} />
//   </div>
//
// And in the empty state (around line 129), add it there too:
//
//   <AshbyExtract onExtract={handleCsvUpload} />    {/* <-- ADD THIS */}
//   <CsvUpload onUpload={handleCsvUpload} />

// ============================================================
// FILE 3: src/components/GoogleCalendarSync.tsx (NEW)
// ============================================================
//
// This component adds a "Sync to Calendar" button that batch-adds
// upcoming interviews for all currently-filtered candidates to
// Google Calendar. It handles Google OAuth if not yet connected.
//
// IMPORTANT: The Candidate type must be updated to include interview_events:
//
//   interface InterviewEvent {
//     id: string;
//     interview_title: string;
//     start_time: string;
//     end_time: string;
//   }
//
//   // Add to Candidate interface:
//   interview_events?: InterviewEvent[];
//
// Props:
//   candidates: Candidate[]  — the *filtered* candidates currently visible in the table
//
// Usage in Index.tsx:
//   import { GoogleCalendarSync } from "@/components/GoogleCalendarSync";
//
//   // In the header actions area, add next to AshbyFetchButton:
//   <GoogleCalendarSync candidates={filteredCandidates} />
//
// Component implementation for Lovable:

import { useState, useEffect, useCallback } from "react";
import { Calendar, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Candidate } from "@/data/candidates";

const API_URL = "https://ashby-automation-production.up.railway.app";

interface GoogleCalendarSyncProps {
  candidates: Candidate[];
}

export function GoogleCalendarSync({ candidates }: GoogleCalendarSyncProps) {
  const [googleAuth, setGoogleAuth] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/google/status`);
      const data = await res.json();
      setGoogleAuth(data.authenticated);
    } catch {
      // Server unreachable — leave as not authenticated
    } finally {
      setCheckingAuth(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
    // Check if returning from OAuth redirect
    const params = new URLSearchParams(window.location.search);
    if (params.get("google_auth") === "success") {
      setGoogleAuth(true);
      toast.success("Google Calendar connected!");
      // Clean up URL
      params.delete("google_auth");
      const newUrl = params.toString()
        ? `${window.location.pathname}?${params}`
        : window.location.pathname;
      window.history.replaceState({}, "", newUrl);
    }
  }, [checkAuth]);

  const handleConnect = async () => {
    try {
      const res = await fetch(`${API_URL}/api/google/auth`);
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      toast.error("Could not reach the server to start Google auth.");
    }
  };

  const handleSync = async () => {
    const now = new Date();
    const events = candidates.flatMap((c) =>
      (c.interview_events || [])
        .filter((ev) => new Date(ev.start_time) > now)
        .map((ev) => ({
          candidate_name: c.candidate_name,
          company_name: c.company_name,
          interview_title: ev.interview_title,
          start_time: ev.start_time,
          end_time: ev.end_time,
        }))
    );

    if (events.length === 0) {
      toast.info("No upcoming interviews found for the filtered candidates.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/calendar/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Failed to add calendar events.");
        return;
      }

      const parts: string[] = [];
      if (data.created > 0) parts.push(`${data.created} added`);
      if (data.skipped_duplicate > 0) parts.push(`${data.skipped_duplicate} already on calendar`);
      if (data.skipped_past > 0) parts.push(`${data.skipped_past} past events skipped`);
      if (data.errors > 0) parts.push(`${data.errors} errors`);

      toast.success(`Calendar sync: ${parts.join(", ")}`);
    } catch {
      toast.error("Could not connect to the server.");
    } finally {
      setLoading(false);
    }
  };

  if (checkingAuth) return null;

  if (!googleAuth) {
    return (
      <Button variant="outline" size="sm" className="gap-2" onClick={handleConnect}>
        <Calendar className="h-4 w-4" />
        Connect Google Calendar
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-2"
      onClick={handleSync}
      disabled={loading || candidates.length === 0}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Calendar className="h-4 w-4" />
      )}
      {loading ? "Syncing..." : "Sync to Calendar"}
    </Button>
  );
}
