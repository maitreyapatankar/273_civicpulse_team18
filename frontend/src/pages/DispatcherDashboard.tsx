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
import { useTicketStream } from '../hooks/useTicketStream'

delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

// F22/F23/F24/F27: corrected nullable types — the API can return null for any of these
interface Ticket {
  id: string
  raw_report_id: string
  issue_type: string | null       // F24: was non-nullable, crashes on .replace()
  severity: number | null
  urgency_score: number | null    // F22: was non-nullable, NaN in avg calculation
  urgency_factors: {
    safety_risk:    number
    traffic_impact: number
    cluster_volume: number
    low_confidence: number        // F27: was wrongly typed as days_unresolved
  } | null
  ai_reasoning: string | null
  confidence: number | null       // F23: was non-nullable, shows 0% instead of —
  duplicate_of: string | null
  cluster_count: number
  work_order: {
    crew_type: string
    materials: string[]
    est_hours: number
    notes: string
  } | null
  dispatcher_override: boolean
  override_by: string | null
  assigned_at: string | null
  assigned_to: string | null
  resolved_at: string | null
  lifecycle_status: 'open' | 'in_progress' | 'resolved' | 'failed' | null
  created_at: string
  lat: number | null
  lng: number | null
  address: string | null
}

const DEFAULT_PUBLIC_UPDATE = true

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHrs = Math.floor(diffMins / 60)
  if (diffHrs < 24) return `${diffHrs}h ago`
  return `${Math.floor(diffHrs / 24)}d ago`
}

// F22: guard against null urgency_score
function urgencyBadge(score: number | null): { label: string; classes: string } {
  const s = score ?? 0
  if (s >= 5) return { label: 'P1', classes: 'bg-rose-600 text-white' }
  if (s >= 4) return { label: 'P2', classes: 'bg-amber-500 text-white' }
  if (s >= 3) return { label: 'P3', classes: 'bg-yellow-300 text-slate-900' }
  if (s >= 2) return { label: 'P4', classes: 'bg-cyan-500 text-white' }
  return { label: 'P5', classes: 'bg-slate-400 text-white' }
}

// F23: guard against null confidence
function confidenceColor(c: number | null): string {
  if (c == null) return 'bg-slate-300'
  if (c >= 0.70) return 'bg-emerald-500'
  if (c >= 0.50) return 'bg-amber-400'
  return 'bg-rose-500'
}

function FactorBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="mb-2">
      <div className="flex justify-between text-xs text-slate-500 mb-1">
        <span>{label}</span>
        <span>{(value * 100).toFixed(0)}%</span>
      </div>
      <div className="h-2 bg-slate-200 rounded-full">
        <div
          className="h-2 bg-cyan-600 rounded-full"
          style={{ width: `${value * 100}%` }}
        />
      </div>
    </div>
  )
}

function MapRecenter({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap()
  useEffect(() => {
    map.setView([lat, lng], 15)
  }, [lat, lng, map])
  return null
}

const ISSUE_TYPES = ['pothole', 'flooding', 'sinkhole', 'crack', 'sign_damage', 'other']

export default function DispatcherDashboard() {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'resolved'>('all')
  const queryClient = useQueryClient()
  const [tab, setTab]                     = useState<'open' | 'review'>('open')
  const [selected, setSelected]           = useState<Ticket | null>(null)
  const [overrideIssueType, setOverrideIssueType] = useState('')
  const [overrideScore, setOverrideScore] = useState<number>(3)
  const [overrideSaved, setOverrideSaved] = useState(false)
  const [search, setSearch]               = useState('')
  const [comment, setComment]             = useState('')
  const [isPublic, setIsPublic]           = useState(DEFAULT_PUBLIC_UPDATE)
  const [commentSaved, setCommentSaved]   = useState(false)  // F29
  const [crewName, setCrewName]           = useState('')
  const [assignSaved, setAssignSaved]     = useState(false)
  const [resolveSaved, setResolveSaved]   = useState(false)
  const [resolveConfirm, setResolveConfirm] = useState(false)  // F28

  const officerToken = typeof window === 'undefined' ? '' : (localStorage.getItem('jwt_token') || '')

  const { data: tickets = [], isLoading, isError } = useQuery<Ticket[]>({
    queryKey: ['tickets'],
    queryFn: () => api.get('/tickets?status=open&sort=urgency_score').then((r) => r.data),
    refetchInterval: 5 * 60_000,
  })

  const detailQuery = useQuery<TicketDetailResponse>({
    queryKey: ['ticket-detail', selected?.id],
    queryFn: () => api.get(`/tickets/${selected?.id}`).then((r) => r.data),
    enabled: Boolean(selected?.id),
  })

  useTicketStream({
    path: `/events/officer?token=${encodeURIComponent(officerToken)}`,
    enabled: Boolean(officerToken),
    onEvent: () => {
      queryClient.invalidateQueries({ queryKey: ['tickets'] })
      queryClient.invalidateQueries({ queryKey: ['ticket-detail'] })
    },
  })

  // Override priority (issue type + urgency score)
  const mutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: TicketOverride }) =>
      api.patch(`/tickets/${id}`, payload).then((r) => r.data),
    onSuccess: (updated: Ticket) => {
      queryClient.setQueryData<Ticket[]>(['tickets'], (prev = []) =>
        prev.map((t) => (t.id === updated.id ? updated : t))
      )
      setSelected(updated)
      setOverrideSaved(true)
      setTimeout(() => setOverrideSaved(false), 3_000)
      queryClient.invalidateQueries({ queryKey: ['ticket-detail'] })
    },
  })

  // F29: separate mutation for posting a department update comment without touching priority
  const commentMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: TicketOverride }) =>
      api.patch(`/tickets/${id}`, payload).then((r) => r.data),
    onSuccess: () => {
      setComment('')
      setIsPublic(DEFAULT_PUBLIC_UPDATE)
      setCommentSaved(true)
      setTimeout(() => setCommentSaved(false), 3_000)
      queryClient.invalidateQueries({ queryKey: ['ticket-detail'] })
    },
  })

  const assignMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: TicketOverride }) =>
      api.patch(`/tickets/${id}`, payload).then((r) => r.data),
    onSuccess: (updated: Ticket) => {
      queryClient.setQueryData<Ticket[]>(['tickets'], (prev = []) =>
        prev.map((t) => (t.id === updated.id ? updated : t))
      )
      setSelected(updated)
      setAssignSaved(true)
      setTimeout(() => setAssignSaved(false), 3_000)
      setCrewName('')
      queryClient.invalidateQueries({ queryKey: ['ticket-detail'] })
    },
    queryKey: ['all-tickets', statusFilter],
    queryFn: () => api.get(`/tickets?status=${statusFilter}`).then((r) => r.data),
    refetchInterval: 60_000,
  })

  const visible = tickets.filter((t) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
  const resolveMutation = useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.patch(`/tickets/${id}`, { resolve: true } as TicketOverride).then((r) => r.data),
    onSuccess: (updated: Ticket) => {
      queryClient.setQueryData<Ticket[]>(['tickets'], (prev = []) =>
        prev.filter((t) => t.id !== updated.id)
      )
      setSelected(updated)
      setResolveSaved(true)
      setTimeout(() => setResolveSaved(false), 3_000)
      queryClient.invalidateQueries({ queryKey: ['tickets'] })
      queryClient.invalidateQueries({ queryKey: ['ticket-detail'] })
    },
  })

  // F23: null confidence → treat as < 0.70 (goes to review tab)
  const open   = tickets.filter((t) => (t.confidence ?? 0) >= 0.70)
  const review = tickets.filter((t) => (t.confidence ?? 0) < 0.70)
  const baseVisible = tab === 'open' ? open : review
  const visible = baseVisible.filter((ticket) => {
    const query = search.trim().toLowerCase()
    if (!query) return true
    // F24: issue_type may be null
    return (
      (t.issue_type || t.subcategory_name || '').toLowerCase().includes(q) ||
      (t.address || '').toLowerCase().includes(q) ||
      (t.assigned_to || '').toLowerCase().includes(q)
    )
  })
      (ticket.issue_type ?? '').toLowerCase().includes(query) ||
      (ticket.address ?? '').toLowerCase().includes(query)
    )
  })

  // F22: null urgency_score → treat as 0 for average; show — when no data yet
  const avgUrgency = tickets.length
    ? (tickets.reduce((sum, t) => sum + (t.urgency_score ?? 0), 0) / tickets.length).toFixed(1)
    : '—'

  // F26: clear ALL per-ticket action state when switching selection
  function handleSelect(ticket: Ticket) {
    setSelected(ticket)
    setOverrideIssueType(ticket.issue_type ?? '')
    setOverrideScore(Math.round(ticket.urgency_score ?? 3))
    setOverrideSaved(false)
    setAssignSaved(false)   // F26
    setResolveSaved(false)  // F26
    setResolveConfirm(false) // F28
    setComment('')
  }

  function handleApplyOverride() {
    if (!selected) return
    mutation.mutate({
      id: selected.id,
      payload: {
        issue_type: overrideIssueType,
        urgency_score: overrideScore,
      },
    })
  }

  // F29: post comment without touching priority
  function handlePostComment() {
    if (!selected || !comment.trim()) return
    commentMutation.mutate({
      id: selected.id,
      payload: { comment: comment.trim(), is_public: isPublic },
    })
  }

  function handleAssign() {
    if (!selected || !crewName.trim()) return
    assignMutation.mutate({
      id: selected.id,
      payload: { assign_to: crewName.trim() },
    })
  }

  // F28: two-step confirmation — first click arms it, second click fires
  function handleResolve() {
    if (!selected) return
    if (!resolveConfirm) {
      setResolveConfirm(true)
      return
    }
    setResolveConfirm(false)
    resolveMutation.mutate({ id: selected.id })
  }

  function lifecycleBadge(status: string | null | undefined): { label: string; classes: string } {
    switch (status) {
      case 'in_progress': return { label: 'In Progress', classes: 'bg-indigo-100 text-indigo-800' }
      case 'resolved':    return { label: 'Resolved',    classes: 'bg-emerald-100 text-emerald-800' }
      case 'failed':      return { label: 'Failed',      classes: 'bg-rose-100 text-rose-700' }
      default:            return { label: 'Open',        classes: 'bg-amber-100 text-amber-800' }
    }
  }

  return (
    <div className="min-h-screen bg-grid">
      <AppNav activeRole="officer" />
      <div className="px-6 pb-8">
        <div className="mx-auto max-w-7xl">

          {/* Stat cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
            <div className="glass-card rounded-2xl p-4 shadow-lg">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Active</p>
              <p className="text-2xl font-semibold text-slate-900 mt-2">{tickets.length}</p>
              <p className="text-xs text-slate-500 mt-1">Total tickets in queue</p>
            </div>
            <div className="glass-card rounded-2xl p-4 shadow-lg">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Needs review</p>
              <p className="text-2xl font-semibold text-slate-900 mt-2">{review.length}</p>
              <p className="text-xs text-slate-500 mt-1">Low confidence AI results</p>
            </div>
            <div className="glass-card rounded-2xl p-4 shadow-lg">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Avg urgency</p>
              {/* F22: avgUrgency is now — when empty, never NaN */}
              <p className="text-2xl font-semibold text-slate-900 mt-2">{avgUrgency}</p>
              <p className="text-xs text-slate-500 mt-1">Across open tickets</p>
            </div>
            <div className="glass-card rounded-2xl p-4 shadow-lg">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Auto refresh</p>
              <p className="text-2xl font-semibold text-slate-900 mt-2">SSE</p>
              <p className="text-xs text-slate-500 mt-1">Realtime pipeline sync</p>
            </div>
      <div className="mx-auto max-w-5xl px-6 pb-10">

        <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between pt-2 pb-6">
          <div>
            <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Overview</p>
            <h1 className="font-display text-3xl sm:text-4xl text-slate-900 mt-3">All tickets</h1>
            <p className="text-sm text-slate-500 mt-2">Read-only overview of every ticket in the system.</p>
          </div>

          {/* F31: prominent error banner for queue load failure */}
          {isError && (
            <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-3 text-sm text-rose-700 font-medium">
              Unable to load the ticket queue. Check your connection and refresh the page.
            </div>
          )}

          <div className="grid lg:grid-cols-[1.1fr_0.9fr] gap-6">

          {/* ── Ticket list ── */}
          <section className="glass-card rounded-3xl shadow-xl overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-200 bg-white/90">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Officer console</p>
                  <h1 className="font-display text-2xl text-slate-900 mt-2">Priority queue</h1>
                </div>
                <div className="text-right text-xs text-slate-500">
                  {isLoading && <span className="animate-pulse">Syncing…</span>}
                  {!isLoading && !isError && <span>{tickets.length} active tickets</span>}
                </div>
              </div>

              <div className="mt-5 flex flex-col gap-4">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by issue type or address"
                  className="w-full rounded-2xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                />
                <div className="flex gap-3">
                  {[
                    { key: 'open',   label: `Open (${open.length})` },
                    { key: 'review', label: `Needs review (${review.length})` },
                  ].map((item) => (
                    <button
                      key={item.key}
                      onClick={() => setTab(item.key as 'open' | 'review')}
                      className={`px-4 py-2 rounded-full text-xs font-semibold transition ${
                        tab === item.key
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
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
            <div className="divide-y divide-slate-100 max-h-[70vh] overflow-y-auto bg-white/80">
              {visible.length === 0 && !isLoading && (
                <p className="text-center text-slate-400 text-sm py-16">No tickets</p>
              )}
              {visible.map((ticket) => {
                const badge = urgencyBadge(ticket.urgency_score)
                const isSelected = selected?.id === ticket.id
                return (
                  <button
                    key={ticket.id}
                    onClick={() => handleSelect(ticket)}
                    className={`w-full text-left px-6 py-4 transition ${
                      isSelected ? 'bg-cyan-50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <span
                          className={`inline-flex items-center justify-center h-7 w-9 rounded text-xs font-bold ${badge.classes}`}
                        >
                          {badge.label}
                        </span>
                        <div className="min-w-0">
                          {/* F24: null-safe issue_type */}
                          <p className="text-sm font-semibold text-slate-900 capitalize truncate">
                            {(ticket.issue_type ?? 'Unknown').replace(/_/g, ' ')}
                            {ticket.cluster_count > 1 && (
                              <span className="ml-2 text-xs text-cyan-700 font-normal">
                                +{ticket.cluster_count - 1} similar
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-slate-500 truncate">
                            {ticket.address ?? (
                              ticket.lat != null && ticket.lng != null
                                ? `${ticket.lat.toFixed(4)}, ${ticket.lng.toFixed(4)}`
                                : 'Location unavailable'
                            )}
                          </p>
                        </div>
                      </div>
                      <span className="text-xs text-slate-400 flex-shrink-0">
                        {relativeTime(ticket.created_at)}
                      </span>
                    </div>

                    {/* F23: null confidence — show — instead of 0% */}
                    <div className="mt-3 flex items-center gap-2">
                      <div className="flex-1 h-2 bg-slate-200 rounded-full">
                        {ticket.confidence != null && (
                          <div
                            className={`h-2 rounded-full ${confidenceColor(ticket.confidence)}`}
                            style={{ width: `${ticket.confidence * 100}%` }}
                          />
                        )}
                      </div>
                      <span className="text-xs text-slate-400 w-10 text-right">
                        {ticket.confidence != null
                          ? `${(ticket.confidence * 100).toFixed(0)}%`
                          : '—'}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          </section>

          {/* ── Detail panel ── */}
          <section className="glass-card rounded-3xl shadow-xl overflow-hidden">
            {!selected ? (
              <div className="h-full flex items-center justify-center text-slate-400 text-sm p-10 bg-white/80">
                Select a ticket to view details
              </div>
            ) : (
              <div className="p-6 space-y-5 bg-white/90">

                {/* Header */}
                <div>
                  <div className="flex items-center justify-between">
                    {/* F24: null-safe issue_type */}
                    <h2 className="text-lg font-semibold text-slate-900 capitalize">
                      {(selected.issue_type ?? 'Unknown').replace(/_/g, ' ')}
                      {selected.severity != null && ` — Severity ${selected.severity}`}
                    </h2>
                    <span
                      className={`inline-flex items-center justify-center h-7 w-9 rounded text-xs font-bold ${
                        urgencyBadge(selected.urgency_score).classes
                      }`}
                    >
                      {urgencyBadge(selected.urgency_score).label}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    {selected.address ?? (
                      selected.lat != null && selected.lng != null
                        ? `${selected.lat.toFixed(5)}, ${selected.lng.toFixed(5)}`
                        : 'Location unavailable'
                    )}
                  </p>
                  <p className="text-xs text-slate-400 mt-1">
                    Reported {relativeTime(selected.created_at)}
                    {selected.dispatcher_override && (
                      <span className="ml-2 text-amber-600 font-medium">
                        — Override by {selected.override_by}
                      </span>
                    )}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-semibold ${lifecycleBadge(selected.lifecycle_status).classes}`}>
                      {lifecycleBadge(selected.lifecycle_status).label}
                    </span>
                    {selected.assigned_to && (
                      <span className="inline-flex items-center rounded-full bg-slate-100 text-slate-700 px-2.5 py-0.5 font-medium">
                        Crew: {selected.assigned_to}
                      </span>
                    )}
                  </div>
                </div>

                {/* Map — only render when coords are available (F24/F32) */}
                {selected.lat != null && selected.lng != null && (
                  <div className="h-[220px] rounded-2xl overflow-hidden border border-slate-200">
                    <MapContainer
                      center={[selected.lat, selected.lng]}
                      zoom={15}
                      style={{ height: '100%', width: '100%' }}
                      scrollWheelZoom={false}
                    >
                      <TileLayer
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                      />
                      <MapRecenter lat={selected.lat} lng={selected.lng} />
                      <Marker position={[selected.lat, selected.lng]}>
                        <Popup>
                          {/* F24: null-safe in Popup too */}
                          <span className="capitalize">
                            {(selected.issue_type ?? 'Unknown').replace(/_/g, ' ')}
                          </span>
                        </Popup>
                      </Marker>
                    </MapContainer>
                  </div>
                )}

                {selected.cluster_count > 1 && (
                  <div className="rounded-2xl bg-cyan-50 border border-cyan-100 px-4 py-3 text-sm text-cyan-900">
                    Merged with <strong>{selected.cluster_count - 1}</strong> nearby report
                    {selected.cluster_count > 2 ? 's' : ''}.
                  </div>
                )}

                {/* Customer submission — F25: show error state */}
                <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em]">
                    Customer report
                  </h3>
                  {detailQuery.isLoading && (
                    <p className="text-xs text-slate-400 animate-pulse">Loading submission…</p>
                  )}
                  {/* F25: surface detail fetch errors */}
                  {detailQuery.isError && (
                    <p className="text-xs text-rose-500">
                      Could not load submission details. Try selecting the ticket again.
                    </p>
                  )}
                  {detailQuery.data?.text && (
                    <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                      {detailQuery.data.text}
                    </p>
                  )}
                  {!detailQuery.isLoading && !detailQuery.isError && !detailQuery.data?.text && (
                    <p className="text-xs text-slate-400">No text submitted.</p>
                  )}
                  {detailQuery.data?.image_url && (
                    <div className="rounded-xl overflow-hidden border border-slate-200">
                      <img
                        src={detailQuery.data.image_url}
                        alt="Customer submitted photo"
                        className="w-full max-h-56 object-cover"
                      />
                    </div>
                  )}
                  {detailQuery.data?.image_text_conflict && (
                    <div className="rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
                      <span className="font-semibold">Image/text conflict —</span>{' '}
                      {detailQuery.data.image_classification_hint
                        ? `image suggests: ${detailQuery.data.image_classification_hint}`
                        : 'AI classification trusted the image over the text.'}
                    </div>
                  )}
                </div>

                {/* AI urgency reasoning */}
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-2">
                    AI urgency reasoning
                  </h3>
                  <p className="text-sm text-slate-700 leading-relaxed">
                    {selected.ai_reasoning || '—'}
                  </p>
                </div>

                {/* F27: corrected factor labels — low_confidence not days_unresolved */}
                {selected.urgency_factors && (
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-3">
                      Urgency factors
                    </h3>
                    <FactorBar label="Safety Risk"    value={selected.urgency_factors.safety_risk} />
                    <FactorBar label="Traffic Impact" value={selected.urgency_factors.traffic_impact} />
                    <FactorBar label="Cluster Volume" value={selected.urgency_factors.cluster_volume} />
                    <FactorBar label="Low Confidence" value={selected.urgency_factors.low_confidence} />
                  </div>
                )}

                {/* Activity log */}
                {detailQuery.data?.comments && detailQuery.data.comments.length > 0 && (
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-2">
                      Activity log
                    </h3>
                    <ul className="space-y-2 text-sm text-slate-600">
                      {detailQuery.data.comments.map((c) => (
                        <li key={c.id} className="flex gap-2">
                          <span className="mt-2 h-1.5 w-1.5 rounded-full bg-cyan-600 flex-shrink-0" />
                          <div>
                            <p>{c.message}</p>
                            <p className="text-xs text-slate-400 mt-1">
                              {c.author_type} • {new Date(c.created_at).toLocaleString()}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Work order */}
                {selected.work_order && (
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-2">
                      Work order
                    </h3>
                    <div className="space-y-1 text-sm text-slate-700">
                      <p><span className="text-slate-500">Crew:</span> {selected.work_order.crew_type}</p>
                      <p><span className="text-slate-500">Est. hours:</span> {selected.work_order.est_hours}h</p>
                      {selected.work_order.materials.length > 0 && (
                        <p><span className="text-slate-500">Materials:</span> {selected.work_order.materials.join(', ')}</p>
                      )}
                      {selected.work_order.notes && (
                        <p className="text-slate-600 mt-1 italic">{selected.work_order.notes}</p>
                      )}
                    </div>
                  </div>
                )}

                {/* Override priority */}
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-3">
                    Override priority
                  </h3>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Issue Type</label>
                      <select
                        value={overrideIssueType}
                        onChange={(e) => setOverrideIssueType(e.target.value)}
                        className="w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      >
                        {ISSUE_TYPES.map((t) => (
                          <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Urgency Score</label>
                      <select
                        value={overrideScore}
                        onChange={(e) => setOverrideScore(Number(e.target.value))}
                        className="w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      >
                        {[5, 4, 3, 2, 1].map((s) => (
                          <option key={s} value={s}>
                            {s} — {['', 'P5 Lowest', 'P4 Low', 'P3 Medium', 'P2 High', 'P1 Critical'][s]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-3 pt-1">
                      <button
                        onClick={handleApplyOverride}
                        disabled={mutation.isPending}
                        className="flex-1 rounded-2xl bg-slate-900 text-white text-sm font-semibold py-2.5 hover:bg-slate-800 disabled:opacity-60 transition"
                      >
                        {mutation.isPending ? 'Saving…' : 'Apply override'}
                      </button>
                      {overrideSaved && (
                        <span className="text-emerald-600 text-sm font-medium">Saved</span>
                      )}
                    </div>
                    {mutation.isError && (
                      <p className="text-xs text-rose-500">Failed to save override. Try again.</p>
                    )}
                  </div>
                </div>

                {/* F29: department update is now independent — has its own Post button */}
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-3">
                    Department update
                  </h3>
                  <textarea
                    rows={3}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Share an update for the citizen or internal log."
                    className="w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={isPublic}
                        onChange={(e) => setIsPublic(e.target.checked)}
                        className="h-4 w-4 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500"
                      />
                      Visible to citizen
                    </label>
                    <div className="flex items-center gap-2">
                      {commentSaved && (
                        <span className="text-emerald-600 text-xs font-medium">Posted</span>
                      )}
                      <button
                        onClick={handlePostComment}
                        disabled={commentMutation.isPending || !comment.trim()}
                        className="rounded-2xl bg-cyan-700 text-white text-xs font-semibold px-4 py-2 hover:bg-cyan-800 disabled:opacity-50 transition"
                      >
                        {commentMutation.isPending ? 'Posting…' : 'Post update'}
                      </button>
                    </div>
                  </div>
                  {commentMutation.isError && (
                    <p className="text-xs text-rose-500 mt-2">Could not post update. Try again.</p>
                  )}
                </div>

                {/* Crew assignment */}
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-3">
                    Crew assignment
                  </h3>
                  <div className="space-y-3">
                    <input
                      value={crewName}
                      onChange={(e) => setCrewName(e.target.value)}
                      placeholder={selected.assigned_to ?? 'e.g. Crew Alpha / Pothole Team 3'}
                      className="w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    />
                    <div className="flex items-center gap-3">
                      <button
                        onClick={handleAssign}
                        disabled={assignMutation.isPending || !crewName.trim()}
                        className="flex-1 rounded-2xl bg-slate-900 text-white text-sm font-semibold py-2.5 hover:bg-slate-800 disabled:opacity-50 transition"
                      >
                        {assignMutation.isPending
                          ? 'Assigning…'
                          : selected.assigned_to
                          ? 'Reassign crew'
                          : 'Assign crew'}
                      </button>
                      {assignSaved && (
                        <span className="text-emerald-600 text-sm font-medium">Saved</span>
                      )}
                    </div>
                    {assignMutation.isError && (
                      <p className="text-xs text-rose-500">Could not assign crew. Try again.</p>
                    )}
                  </div>
                </div>

                {/* F28: two-step resolve confirmation */}
                <div className="rounded-2xl border border-emerald-200 bg-white p-4">
                  <h3 className="text-xs font-semibold text-emerald-700 uppercase tracking-[0.2em] mb-3">
                    Resolution
                  </h3>
                  <p className="text-xs text-slate-500 mb-3">
                    Mark as resolved when the crew confirms the work is complete. The
                    citizen sees the update instantly and receives an SMS.
                  </p>
                  {resolveConfirm && !resolveMutation.isPending && (
                    <p className="text-xs text-amber-700 font-medium mb-2">
                      Click again to confirm — this cannot be undone.
                    </p>
                  )}
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleResolve}
                      disabled={resolveMutation.isPending || Boolean(selected.resolved_at)}
                      className={`flex-1 rounded-2xl text-white text-sm font-semibold py-2.5 disabled:opacity-50 transition ${
                        resolveConfirm
                          ? 'bg-rose-600 hover:bg-rose-700'
                          : 'bg-emerald-600 hover:bg-emerald-700'
                      }`}
                    >
                      {selected.resolved_at
                        ? 'Already resolved'
                        : resolveMutation.isPending
                        ? 'Resolving…'
                        : resolveConfirm
                        ? 'Confirm resolution'
                        : 'Mark resolved'}
                    </button>
                    {resolveConfirm && !resolveMutation.isPending && (
                      <button
                        onClick={() => setResolveConfirm(false)}
                        className="text-xs text-slate-500 hover:text-slate-700"
                      >
                        Cancel
                      </button>
                    )}
                    {resolveSaved && (
                      <span className="text-emerald-600 text-sm font-medium">Resolved</span>
                    )}
                  </div>
                  {resolveMutation.isError && (
                    <p className="text-xs text-rose-500 mt-2">Could not resolve ticket. Try again.</p>
                  )}
                </div>

              </div>
            )}
          </section>

          </div>
        </div>

      </div>
    </div>
  )
}
