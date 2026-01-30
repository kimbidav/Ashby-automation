import { useState, useEffect } from 'react'
import { PipelineData, Stats } from './types'
import Dashboard from './components/Dashboard'
import StatsCards from './components/StatsCards'
import Charts from './components/Charts'

function App() {
  const [data, setData] = useState<PipelineData | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)

        // Fetch pipeline data
        const pipelineRes = await fetch('http://localhost:3001/api/pipeline')
        if (!pipelineRes.ok) {
          throw new Error('Failed to fetch pipeline data')
        }
        const pipelineData = await pipelineRes.json()
        setData(pipelineData)

        // Fetch stats
        const statsRes = await fetch('http://localhost:3001/api/stats')
        if (!statsRes.ok) {
          throw new Error('Failed to fetch stats')
        }
        const statsData = await statsRes.json()
        setStats(statsData)

        setLoading(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred')
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading pipeline data...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 max-w-md">
          <h2 className="text-red-800 font-semibold text-lg mb-2">Error Loading Data</h2>
          <p className="text-red-600">{error}</p>
          <p className="text-sm text-red-500 mt-4">
            Make sure the API server is running on port 3001
          </p>
        </div>
      </div>
    )
  }

  if (!data || !stats) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-600">No data available</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <h1 className="text-2xl font-bold text-gray-900">
            Ashby Pipeline Dashboard
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Real-time view of your candidate pipeline across all organizations
          </p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <StatsCards stats={stats} />
        <Charts stats={stats} data={data} />
        <Dashboard data={data} />
      </main>
    </div>
  )
}

export default App
