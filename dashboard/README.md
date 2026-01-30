# Ashby Pipeline Dashboard

Interactive web dashboard for visualizing and filtering your Ashby candidate pipeline data.

## Features

- **📊 Real-time Stats**: View total candidates, open jobs, average days in stage, and scheduling needs
- **📈 Data Visualizations**:
  - Top 10 organizations by candidate count
  - Candidates by attribution/sourcer
  - Stage distribution pie chart
- **🔍 Advanced Filtering**: Filter by organization, attributed user, or search across all columns
- **↕️ Sorting**: Click any column header to sort ascending/descending
- **📄 Pagination**: Browse large datasets with pagination controls
- **⚡ Fast Performance**: Built with React + TypeScript + Vite

## Quick Start

### 1. Start the Dashboard

```bash
cd "/Users/david/Desktop/Ashby Automation/dashboard"
./start-dashboard.sh
```

This will:
- Start the API server on port 3001
- Start the dashboard on port 3000
- Automatically open your browser to http://localhost:3000

### 2. View Your Data

The dashboard automatically loads the most recent extraction from `/Users/david/Desktop/Ashby Automation/output/`

## Manual Start (Alternative)

If you prefer to run the servers separately:

**Terminal 1 - API Server:**
```bash
cd "/Users/david/Desktop/Ashby Automation/dashboard"
node server.js
```

**Terminal 2 - Dashboard:**
```bash
cd "/Users/david/Desktop/Ashby Automation/dashboard"
npm run dev
```

## Dashboard Sections

### 1. Stats Cards (Top)
- Total Candidates
- Open Jobs
- Average Days in Stage
- Candidates Needing Scheduling

### 2. Charts (Middle)
- **Top Organizations**: Bar chart of top 10 orgs by candidate count
- **Attribution**: Bar chart showing which users have sourced the most candidates
- **Stage Distribution**: Pie chart of top 6 stages

### 3. Data Table (Bottom)
**Columns:**
- Candidate Name
- Organization
- Job Title
- Current Stage
- Credited To (who sourced them)
- Source (e.g., "Candidate Labs")
- Days in Stage (color-coded: green <7, yellow 7-14, red >14)
- Needs Scheduling
- Last Activity

**Features:**
- **Search**: Global search across all columns
- **Filter by Organization**: Dropdown to filter specific orgs
- **Filter by Credited To**: Dropdown to filter by attribution
- **Sortable Columns**: Click headers to sort
- **Pagination**: 20 results per page with navigation

## Tech Stack

- **Frontend**: React 18 + TypeScript + Vite
- **Styling**: Tailwind CSS
- **Data Table**: TanStack Table v8 (React Table)
- **Charts**: Recharts
- **Backend**: Express.js API server
- **Date Formatting**: date-fns

## Development

### Build for Production

```bash
npm run build
```

### Preview Production Build

```bash
npm run preview
```

## Troubleshooting

### "Failed to fetch pipeline data"

- Make sure the API server is running on port 3001
- Check that you have extraction data in `../output/`

### No Data Showing

- Run an extraction first: `cd .. && npm run start -- extract`
- Restart the API server to pick up the latest data

### Port Already in Use

If ports 3000 or 3001 are in use:

1. Find the process: `lsof -i :3000` or `lsof -i :3001`
2. Kill it: `kill -9 <PID>`
3. Restart the dashboard

## API Endpoints

### GET /api/pipeline
Returns the full pipeline data (candidates, jobs, companies)

### GET /api/stats
Returns aggregated statistics and counts

## License

Part of the Ashby Pipeline Extractor project.
