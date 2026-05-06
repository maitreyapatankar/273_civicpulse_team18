import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import api from '../api/client'
import { Ticket } from '../api/types'
import AppNav from '../components/AppNav'

function urgencyBadge(score: number | null): { label: string; classes: string } {
  if (!score) return { label: 'P?', classes: 'bg-slate-200 text-slate-600' }
  if (score >= 5) return { label: 'P1', classes: 'bg-rose-600 text-white' }
  if (score >= 4) return { label: 'P2', classes: 'bg-amber-500 text-white' }
  if (score >= 3) return { label: 'P3', classes: 'bg-yellow-300 text-slate-900' }
  if (score >= 2) return { label: 'P4', classes: 'bg-cyan-500 text-white' }
  return { label: 'P5', classes: 'bg-slate-400 text-white' }
}

function lifecycleBadge(status: string | null | undefined): { label: string; classes: string } {
  switch (status) {
    case 'approved':                return { label: 'Approved',                classes: 'bg-blue-100 text-blue-800' }
    case 'forwarded_to_maintenance': return { label: 'Forwarded to Maintenance', classes: 'bg-purple-100 text-purple-800' }
    case 'in_progress':             return { label: 'In Progress',             classes: 'bg-indigo-100 text-indigo-800' }
    case 'resolved':                return { label: 'Resolved',                classes: 'bg-emerald-100 text-emerald-800' }
    case 'failed':                  return { label: 'Failed',                  classes: 'bg-rose-100 text-rose-700' }
    default:                        return { label: 'Open',                    classes: 'bg-amber-100 text-amber-800' }
  }
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHrs = Math.floor(diffMins / 60)
  if (diffHrs < 24) return `${diffHrs}h ago`
  return `${Math.floor(diffHrs / 24)}d ago`
}

export default function DispatcherDashboard() {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'resolved'>('all')

  const { data: tickets = [], isLoading, isError } = useQuery<Ticket[]>({
    queryKey: ['all-tickets', statusFilter],
    queryFn: () => api.get(`/tickets?status=${statusFilter}`).then((r) => r.data),
    refetchInterval: 60_000,
  })

  const visible = tickets.filter((t) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return (
      (t.issue_type || t.subcategory_name || '').toLowerCase().includes(q) ||
      (t.address || '').toLowerCase().includes(q) ||
      (t.assigned_to || '').toLowerCase().includes(q)
    )
  })

  return (
    <div className="min-h-screen bg-grid">
      <AppNav activeRole="officer" />
      <div className="mx-auto max-w-5xl px-6 pb-10">

        <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between pt-2 pb-6">
          <div>
            <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Overview</p>
            <h1 className="font-display text-3xl sm:text-4xl text-slate-900 mt-3">All tickets</h1>
            <p className="text-sm text-slate-500 mt-2">Read-only overview of every ticket in the system.</p>
          </div>
          <Link
            to="/staff"
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 transition-colors self-start lg:self-auto"
          >
            Manage tickets →
          </Link>
        </header>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by issue, address or crew…"
            className="flex-1 rounded-2xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 bg-white/80"
          />
          <div className="flex gap-2">
            {(['all', 'open', 'resolved'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-4 py-2 rounded-full text-xs font-semibold capitalize transition ${
                  statusFilter === s
                    ? 'bg-slate-900 text-white'
                    : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          {[
            { label: 'Total',    value: tickets.length },
            { label: 'Open',     value: tickets.filter((t) => !t.resolved_at).length },
            { label: 'Approved', value: tickets.filter((t) => t.approved && !t.resolved_at).length },
            { label: 'Resolved', value: tickets.filter((t) => t.resolved_at).length },
          ].map((s) => (
            <div key={s.label} className="glass-card rounded-2xl p-4 shadow">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{s.label}</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">{s.value}</p>
            </div>
          ))}
        </div>

        {/* Table */}
        <div className="glass-card rounded-3xl shadow-xl overflow-hidden">
          {isLoading && (
            <p className="text-center text-slate-400 text-sm py-16 animate-pulse">Loading…</p>
          )}
          {isError && (
            <p className="text-center text-rose-500 text-sm py-16">Failed to load tickets.</p>
          )}
          {!isLoading && !isError && visible.length === 0 && (
            <p className="text-center text-slate-400 text-sm py-16">No tickets found.</p>
          )}
          {visible.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-[0.15em]">Priority</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-[0.15em]">Issue</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-[0.15em] hidden md:table-cell">Address</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-[0.15em] hidden sm:table-cell">Crew</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-[0.15em]">Status</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-[0.15em] hidden lg:table-cell">Reported</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white/80">
                {visible.map((ticket) => {
                  const urg = urgencyBadge(ticket.urgency_score)
                  const lc  = lifecycleBadge(ticket.lifecycle_status)
                  return (
                    <tr key={ticket.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-5 py-3">
                        <span className={`inline-flex items-center justify-center h-6 w-8 rounded text-xs font-bold ${urg.classes}`}>
                          {urg.label}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <p className="font-medium text-slate-900 capitalize">
                          {(ticket.issue_type || ticket.subcategory_name || 'Unknown').replace('_', ' ')}
                        </p>
                        {ticket.cluster_count > 1 && (
                          <p className="text-xs text-cyan-600">+{ticket.cluster_count - 1} similar</p>
                        )}
                      </td>
                      <td className="px-5 py-3 text-slate-500 hidden md:table-cell max-w-[200px] truncate">
                        {ticket.address || '—'}
                      </td>
                      <td className="px-5 py-3 text-slate-500 hidden sm:table-cell">
                        {ticket.assigned_to || <span className="text-slate-300">Unassigned</span>}
                      </td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${lc.classes}`}>
                          {lc.label}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-slate-400 hidden lg:table-cell whitespace-nowrap">
                        {relativeTime(ticket.created_at)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

      </div>
    </div>
  )
}
