import { useMemo, useState } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  ColumnDef,
  flexRender,
  SortingState,
  ColumnFiltersState,
} from '@tanstack/react-table'
import { Candidate, PipelineData, Job, Company } from '../types'
import { formatDistanceToNow } from 'date-fns'

interface DashboardProps {
  data: PipelineData
}

export default function Dashboard({ data }: DashboardProps) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState('')

  // Create lookups for jobs and companies
  const jobsMap = useMemo(() => {
    const map = new Map<string, Job>()
    data.jobs.forEach(job => map.set(job.id, job))
    return map
  }, [data.jobs])

  const companiesMap = useMemo(() => {
    const map = new Map<string, Company>()
    data.companies.forEach(company => map.set(company.id, company))
    return map
  }, [data.companies])

  // Enrich candidates with job and company data
  const enrichedCandidates = useMemo(() => {
    return data.candidates.map(candidate => {
      const job = jobsMap.get(candidate.jobId)
      const company = companiesMap.get(candidate.companyId)
      return {
        ...candidate,
        jobTitle: job?.title || 'Unknown',
        companyName: candidate.orgName || company?.name || 'Unknown',
      }
    })
  }, [data.candidates, jobsMap, companiesMap])

  const columns = useMemo<ColumnDef<typeof enrichedCandidates[0]>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Candidate Name',
        cell: info => (
          <div className="font-medium text-gray-900">{info.getValue() as string}</div>
        ),
      },
      {
        accessorKey: 'companyName',
        header: 'Organization',
        cell: info => (
          <div className="text-gray-700">{info.getValue() as string}</div>
        ),
      },
      {
        accessorKey: 'jobTitle',
        header: 'Job Title',
        cell: info => (
          <div className="text-gray-700">{info.getValue() as string}</div>
        ),
      },
      {
        accessorKey: 'currentStage',
        header: 'Current Stage',
        cell: info => (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
            {info.getValue() as string}
          </span>
        ),
      },
      {
        accessorKey: 'stageProgress',
        header: 'Stage',
        cell: info => {
          const progress = info.getValue() as string | null
          return (
            <div className="text-gray-700 font-medium">
              {progress || '-'}
            </div>
          )
        },
      },
      {
        accessorKey: 'creditedTo',
        header: 'Credited To',
        cell: info => (
          <div className="text-gray-700">{(info.getValue() as string) || '-'}</div>
        ),
      },
      {
        accessorKey: 'source',
        header: 'Source',
        cell: info => (
          <div className="text-gray-600 text-sm">{(info.getValue() as string) || '-'}</div>
        ),
      },
      {
        accessorKey: 'daysInStage',
        header: 'Days in Stage',
        cell: info => {
          const days = info.getValue() as number
          const color = days > 14 ? 'text-red-600' : days > 7 ? 'text-yellow-600' : 'text-green-600'
          return (
            <div className={`font-medium ${color}`}>{days}</div>
          )
        },
      },
      {
        accessorKey: 'needsScheduling',
        header: 'Needs Scheduling',
        cell: info => {
          const needs = info.getValue() as boolean
          return needs ? (
            <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-red-100 text-red-800">
              Yes
            </span>
          ) : (
            <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-600">
              No
            </span>
          )
        },
      },
      {
        accessorKey: 'lastActivityAt',
        header: 'Last Activity',
        cell: info => {
          const date = new Date(info.getValue() as string)
          return (
            <div className="text-sm text-gray-600">
              {formatDistanceToNow(date, { addSuffix: true })}
            </div>
          )
        },
      },
    ],
    []
  )

  const table = useReactTable({
    data: enrichedCandidates,
    columns,
    state: {
      sorting,
      columnFilters,
      globalFilter,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: {
        pageSize: 20,
      },
    },
  })

  // Get unique values for filters
  const organizations = useMemo(() =>
    Array.from(new Set(enrichedCandidates.map(c => c.companyName))).sort(),
    [enrichedCandidates]
  )

  const creditedToOptions = useMemo(() =>
    Array.from(new Set(enrichedCandidates.map(c => c.creditedTo).filter(Boolean))).sort() as string[],
    [enrichedCandidates]
  )

  return (
    <div className="bg-white shadow rounded-lg">
      <div className="px-4 py-5 sm:p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Candidate Pipeline
        </h2>

        {/* Filters */}
        <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="search" className="block text-sm font-medium text-gray-700 mb-1">
              Search
            </label>
            <input
              id="search"
              type="text"
              value={globalFilter ?? ''}
              onChange={e => setGlobalFilter(e.target.value)}
              placeholder="Search all columns..."
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border"
            />
          </div>

          <div>
            <label htmlFor="org-filter" className="block text-sm font-medium text-gray-700 mb-1">
              Organization
            </label>
            <select
              id="org-filter"
              onChange={e => {
                const value = e.target.value
                table.getColumn('companyName')?.setFilterValue(value || undefined)
              }}
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border"
            >
              <option value="">All Organizations</option>
              {organizations.map(org => (
                <option key={org} value={org}>{org}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="credited-filter" className="block text-sm font-medium text-gray-700 mb-1">
              Credited To
            </label>
            <select
              id="credited-filter"
              onChange={e => {
                const value = e.target.value
                table.getColumn('creditedTo')?.setFilterValue(value || undefined)
              }}
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm px-3 py-2 border"
            >
              <option value="">All Users</option>
              {creditedToOptions.map(user => (
                <option key={user} value={user}>{user}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              {table.getHeaderGroups().map(headerGroup => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map(header => (
                    <th
                      key={header.id}
                      className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      <div className="flex items-center space-x-1">
                        <span>
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                        </span>
                        {header.column.getIsSorted() && (
                          <span>
                            {header.column.getIsSorted() === 'asc' ? '↑' : '↓'}
                          </span>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {table.getRowModel().rows.map(row => (
                <tr key={row.id} className="hover:bg-gray-50">
                  {row.getVisibleCells().map(cell => (
                    <td key={cell.id} className="px-6 py-4 whitespace-nowrap text-sm">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between border-t border-gray-200 bg-white px-4 py-3 sm:px-6 mt-4">
          <div className="flex flex-1 justify-between sm:hidden">
            <button
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="relative inline-flex items-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Previous
            </button>
            <button
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="relative ml-3 inline-flex items-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Next
            </button>
          </div>
          <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
            <div>
              <p className="text-sm text-gray-700">
                Showing{' '}
                <span className="font-medium">
                  {table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1}
                </span>{' '}
                to{' '}
                <span className="font-medium">
                  {Math.min(
                    (table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize,
                    table.getFilteredRowModel().rows.length
                  )}
                </span>{' '}
                of <span className="font-medium">{table.getFilteredRowModel().rows.length}</span> results
              </p>
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={() => table.setPageIndex(0)}
                disabled={!table.getCanPreviousPage()}
                className="relative inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                First
              </button>
              <button
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
                className="relative inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-sm text-gray-700">
                Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
              </span>
              <button
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
                className="relative inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Next
              </button>
              <button
                onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                disabled={!table.getCanNextPage()}
                className="relative inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Last
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
