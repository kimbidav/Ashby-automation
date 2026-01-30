# 📊 Ashby Pipeline Dashboard - Quick Start Guide

## ✅ What's Been Built

I've created a **professional, interactive web dashboard** for visualizing and filtering your Ashby candidate pipeline data!

### Dashboard Features

#### 1. **Real-Time Statistics** (Top Cards)
- 📊 Total Candidates (259)
- 💼 Open Jobs (348)
- ⏱️ Average Days in Stage
- ⚠️ Candidates Needing Scheduling

#### 2. **Data Visualizations** (Charts Section)
- **Top 10 Organizations**: Bar chart showing which orgs have the most candidates
- **Candidates by Attribution**: Bar chart of who sourced the most candidates
- **Stage Distribution**: Pie chart showing the breakdown of pipeline stages

#### 3. **Interactive Data Table** (Bottom Section)
**Powerful filtering & sorting:**
- 🔍 **Global Search**: Search across all columns instantly
- 🏢 **Filter by Organization**: Dropdown to see specific orgs only
- 👤 **Filter by Credited To**: See only your candidates or specific team members
- ↕️ **Sortable Columns**: Click any header to sort
- 📄 **Pagination**: Browse 20 candidates per page

**Table Columns:**
- Candidate Name
- Organization
- Job Title
- Current Stage (with color badges)
- Credited To
- Source
- Days in Stage (color-coded: 🟢 <7 days, 🟡 7-14 days, 🔴 >14 days)
- Needs Scheduling (Yes/No badges)
- Last Activity (e.g., "2 days ago")

---

## 🚀 How to Start the Dashboard

### Option 1: One Command Start (Easiest!)

```bash
cd "/Users/david/Desktop/Ashby Automation/dashboard"
./start-dashboard.sh
```

This starts both the API server and dashboard, then opens your browser automatically.

### Option 2: Manual Start (Two Terminals)

**Terminal 1 - Start API Server:**
```bash
cd "/Users/david/Desktop/Ashby Automation/dashboard"
node server.js
```

**Terminal 2 - Start Dashboard:**
```bash
cd "/Users/david/Desktop/Ashby Automation/dashboard"
npm run dev
```

Then open: **http://localhost:3000**

---

## 📈 How to Use the Dashboard

### Viewing Your Data

1. **Overview**: Stats cards at the top show your key metrics
2. **Charts**: Scroll down to see visual breakdowns
3. **Table**: Interactive table shows all candidates with full details

### Filtering Examples

**Filter by Organization:**
- Select "Graphite" from the Organization dropdown → See only Graphite's 16 candidates

**Filter by Your Candidates:**
- Select "David Kimball" from Credited To dropdown → See only candidates you sourced

**Search for Specific Candidate:**
- Type "Anna" in the search box → Instantly find Anna Klaussen

**Find Candidates Needing Attention:**
- Click "Days in Stage" header twice → Sort by highest days first
- Look for red numbers (>14 days)

### Sorting Data

Click any column header to sort:
- **Days in Stage**: Find stuck candidates
- **Last Activity**: See who needs follow-up
- **Organization**: Group by company
- **Credited To**: See team performance

---

## 🔄 Updating Dashboard Data

The dashboard automatically loads the most recent extraction file from:
```
/Users/david/Desktop/Ashby Automation/output/
```

**To refresh with new data:**

1. Run a new extraction:
   ```bash
   cd "/Users/david/Desktop/Ashby Automation"
   npm run start -- extract
   ```

2. Refresh your browser (the API automatically picks up the latest file)

**Or use the macOS app:**
```
Double-click "Ashby Pipeline Extractor.app"
```

---

## 💡 Common Use Cases

### Weekly Pipeline Review
1. Start dashboard
2. Look at stats cards for overview
3. Check "Needs Scheduling" count
4. Filter by each team member to review their candidates
5. Sort by "Days in Stage" to find stuck candidates

### Find Your Candidates
1. Select your name from "Credited To" dropdown
2. See all candidates you've sourced
3. Sort by "Days in Stage" to prioritize follow-ups

### Organization Deep Dive
1. Select organization from dropdown (e.g., "Epsilon Labs")
2. See all 10 Epsilon candidates
3. Check their stages and timing
4. Identify who needs scheduling

### Track Team Performance
1. Look at "Candidates by Attribution" chart
2. See who's sourcing the most candidates
3. Filter by specific team members to review their pipeline

---

## 🛠️ Tech Stack

**Frontend:**
- React 18 + TypeScript
- TanStack Table v8 (Advanced data tables)
- Recharts (Visualizations)
- Tailwind CSS (Styling)
- Vite (Fast dev server)

**Backend:**
- Express.js API server
- Serves latest extraction data
- Calculates statistics on-the-fly

---

## 📁 Project Structure

```
dashboard/
├── src/
│   ├── components/
│   │   ├── Dashboard.tsx        # Main data table with filters
│   │   ├── StatsCards.tsx       # Top stats cards
│   │   └── Charts.tsx           # Data visualizations
│   ├── App.tsx                  # Main app component
│   ├── types.ts                 # TypeScript interfaces
│   └── main.tsx                 # Entry point
├── server.js                    # API server
├── start-dashboard.sh           # One-command startup script
└── package.json                 # Dependencies
```

---

## 🐛 Troubleshooting

### Dashboard Won't Load

**Check if servers are running:**
```bash
# API server should be on port 3001
curl http://localhost:3001/api/pipeline

# Dashboard should be on port 3000
curl http://localhost:3000
```

**Restart servers:**
```bash
# Kill any existing processes
lsof -i :3000 -i :3001 | grep LISTEN | awk '{print $2}' | xargs kill -9

# Restart
cd "/Users/david/Desktop/Ashby Automation/dashboard"
./start-dashboard.sh
```

### No Data Showing

1. Make sure you've run an extraction first
2. Check that files exist in `../output/`
3. Restart the API server to pick up latest data

### Port Already in Use

```bash
# Find and kill process using port 3000
lsof -i :3000 | grep LISTEN | awk '{print $2}' | xargs kill -9

# Or port 3001
lsof -i :3001 | grep LISTEN | awk '{print $2}' | xargs kill -9
```

---

## 🎯 Next Steps

### Integration with Extraction Workflow

You can add the dashboard start command to your extraction workflow:

```bash
# Extract data
npm run start -- extract

# Start dashboard
cd dashboard && ./start-dashboard.sh
```

### Customization Ideas

Want to customize the dashboard? Here are some ideas:

1. **Add more charts**: Edit `src/components/Charts.tsx`
2. **Change color schemes**: Update Tailwind classes
3. **Add export to CSV**: Add a download button
4. **Custom filters**: Modify `src/components/Dashboard.tsx`
5. **Real-time updates**: Add WebSocket for live data

---

## 📊 Dashboard is Live!

**URL**: http://localhost:3000

The dashboard is currently running and displaying your 259 candidates!

Try these now:
1. ✅ View the stats cards
2. ✅ Check the charts
3. ✅ Filter by "Graphite"
4. ✅ Sort by "Days in Stage"
5. ✅ Search for a candidate name

Enjoy your new pipeline dashboard! 🎉
