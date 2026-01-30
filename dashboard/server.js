import express from 'express';
import cors from 'cors';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Get the most recent pipeline data file
function getLatestDataFile() {
  const outputDir = join(__dirname, '..', 'output');
  const files = readdirSync(outputDir)
    .filter(f => f.startsWith('ashby_pipeline_') && f.endsWith('.json'))
    .map(f => ({
      name: f,
      path: join(outputDir, f),
      mtime: statSync(join(outputDir, f)).mtime
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  return files.length > 0 ? files[0].path : null;
}

// API endpoint to get pipeline data
app.get('/api/pipeline', (req, res) => {
  try {
    const dataFile = getLatestDataFile();
    if (!dataFile) {
      return res.status(404).json({ error: 'No pipeline data found' });
    }

    const data = JSON.parse(readFileSync(dataFile, 'utf-8'));
    res.json(data);
  } catch (error) {
    console.error('Error reading pipeline data:', error);
    res.status(500).json({ error: 'Failed to load pipeline data' });
  }
});

// API endpoint to get stats
app.get('/api/stats', (req, res) => {
  try {
    const dataFile = getLatestDataFile();
    if (!dataFile) {
      return res.status(404).json({ error: 'No pipeline data found' });
    }

    const data = JSON.parse(readFileSync(dataFile, 'utf-8'));

    // Calculate stats
    const stats = {
      totalCandidates: data.candidates.length,
      totalJobs: data.jobs.length,
      totalCompanies: data.companies.length,
      candidatesByOrg: {},
      candidatesByStage: {},
      candidatesByCreditedTo: {},
      avgDaysInStage: 0,
      needsScheduling: 0
    };

    // Group by organization
    data.candidates.forEach(candidate => {
      const orgName = candidate.orgName || 'Unknown';
      stats.candidatesByOrg[orgName] = (stats.candidatesByOrg[orgName] || 0) + 1;

      // Group by stage
      const stage = candidate.currentStage || 'Unknown';
      stats.candidatesByStage[stage] = (stats.candidatesByStage[stage] || 0) + 1;

      // Group by credited to
      const creditedTo = candidate.creditedTo || 'Unassigned';
      stats.candidatesByCreditedTo[creditedTo] = (stats.candidatesByCreditedTo[creditedTo] || 0) + 1;

      // Count needs scheduling
      if (candidate.needsScheduling) {
        stats.needsScheduling++;
      }
    });

    // Calculate average days in stage
    const totalDays = data.candidates.reduce((sum, c) => sum + (c.daysInStage || 0), 0);
    stats.avgDaysInStage = data.candidates.length > 0
      ? Math.round(totalDays / data.candidates.length)
      : 0;

    res.json(stats);
  } catch (error) {
    console.error('Error calculating stats:', error);
    res.status(500).json({ error: 'Failed to calculate stats' });
  }
});

app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});
