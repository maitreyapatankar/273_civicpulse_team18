import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import api from '../api/client'
import AppNav from '../components/AppNav'

interface ScheduleTicket {
  id: string
  subcategory_name: string | null
  issue_type: string | null
  urgency_score: number | null
  address: string | null
  assigned_to: string | null
  crew_id?: string | null
  lifecycle_status: string | null
  resolved_at: string | null
}

const URGENCY_COLORS: Record<number, string> = {
  5: 'bg-red-600 text-white',
  4: 'bg-orange-500 text-white',
  3: 'bg-yellow-400 text-slate-900',
  2: 'bg-cyan-500 text-white',
  1: 'bg-slate-400 text-white',
}

function urgencyColor(score: number | null): string {
  if (!score) return 'bg-slate-300 text-slate-700'
  return URGENCY_COLORS[Math.round(score)] || 'bg-slate-300 text-slate-700'
}

export default function SchedulePage() {
  const { data: allTickets = [], isLoading, isError } = useQuery<ScheduleTicket[]>({
    queryKey: ['schedule-tickets'],
    queryFn: () => api.get('/tickets?status=all').then((r) => r.data),
    refetchInterval: 20_000,
  })

  // Filter pending and assigned tickets, group by crew
  const assignedTickets = allTickets.filter((t) => (t.lifecycle_status === 'pending' || t.lifecycle_status === 'forwarded_to_maintenance') && !t.resolved_at)

  const grouped = assignedTickets.reduce<Record<string, ScheduleTicket[]>>((acc, ticket) => {
    const crew = ticket.assigned_to || 'Unassigned'
    acc[crew] = [...(acc[crew] || []), ticket]
    return acc
  }, {})

  const totalTickets = assignedTickets.length
  const totalCrews = Object.keys(grouped).length
  const totalHours = assignedTickets.reduce((sum, t) => sum + (t.urgency_score ? Math.ceil(t.urgency_score * 2) : 0), 0)

  return (
    <div className="min-h-screen bg-slate-50">
      <AppNav activeRole="officer" />

      <div className="max-w-6xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Today's Assignments</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            </p>
          </div>
          <div className="flex flex-col lg:flex-row gap-4 items-start lg:items-center">
            <Link
              to="/staff"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              ← Manage Tickets
            </Link>
            <div className="flex gap-6 text-center">
              <div>
                <p className="text-2xl font-bold text-slate-900">{totalCrews}</p>
                <p className="text-xs text-slate-500">Crews</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-slate-900">{totalTickets}</p>
                <p className="text-xs text-slate-500">Tickets</p>
              </div>
            </div>
          </div>
        </div>

        {isLoading && <p className="text-slate-500 text-sm">Loading assignments…</p>}
        {isError && <p className="text-rose-500 text-sm">Failed to load assignments.</p>}
        {!isLoading && !isError && totalTickets === 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
            <p className="text-slate-500">No tickets assigned yet for today.</p>
            <p className="text-slate-400 text-sm mt-1">Assign tickets from the Manage Tickets page.</p>
          </div>
        )}

        {totalTickets > 0 && (
          <div className="space-y-4">
            {Object.entries(grouped).map(([crewName, tickets]) => (
              <div key={crewName} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                {/* Crew header */}
                <div className="bg-gradient-to-r from-slate-50 to-slate-100 px-6 py-4 border-b border-slate-200">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-semibold text-slate-900">{crewName}</h2>
                      <p className="text-sm text-slate-500 mt-1">{tickets.length} ticket(s)</p>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-bold text-slate-900">{tickets.length}</p>
                    </div>
                  </div>
                </div>

                {/* Tickets list */}
                <div className="divide-y divide-slate-100">
                  {tickets.map((ticket, idx) => (
                    <div key={ticket.id} className="px-6 py-4 hover:bg-slate-50 transition-colors">
                      <div className="flex items-start gap-4">
                        <div className="flex-shrink-0">
                          <span className="text-xs font-semibold text-slate-400">
                            {idx + 1}.
                          </span>
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`inline-flex items-center justify-center h-6 w-10 rounded text-xs font-bold ${urgencyColor(ticket.urgency_score)}`}>
                              P{ticket.urgency_score ? Math.round(ticket.urgency_score) : '?'}
                            </span>
                            <h3 className="text-sm font-medium text-slate-900 truncate">
                              {ticket.subcategory_name || ticket.issue_type || 'Unclassified'}
                            </h3>
                          </div>
                          <p className="text-xs text-slate-500 truncate">
                            📍 {ticket.address || 'No address'}
                          </p>
                        </div>

                        <Link
                          to="/officer/dashboard"
                          className="flex-shrink-0 text-xs text-blue-600 hover:text-blue-700 font-medium whitespace-nowrap"
                        >
                          View →
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
