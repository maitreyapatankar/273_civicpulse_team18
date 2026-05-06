import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import api from '../api/client'
import { Ticket, TicketDetailResponse, TicketOverride } from '../api/types'
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import api, { clearOfficerSession, isTokenExpired } from '../api/client'
import { Ticket, TicketDetailResponse } from '../api/types'
import AppNav from '../components/AppNav'

function formatDate(iso?: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function urgencyLabel(score: number | null): { label: string; classes: string } {
  if (!score) return { label: 'P?', classes: 'bg-slate-300 text-slate-700' }
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

const ISSUE_TYPES = ['pothole', 'flooding', 'sinkhole', 'crack', 'sign_damage', 'other']

function TicketCard({ ticket, crews }: {
  ticket: Ticket
  crews: { id: string; team_name: string; crew_type: string; lead_name: string }[]
}) {
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [overrideIssueType, setOverrideIssueType] = useState(ticket.issue_type || '')
  const [overrideScore, setOverrideScore] = useState<number>(Math.round(ticket.urgency_score || 3))
  const [comment, setComment] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [selectedCrewId, setSelectedCrewId] = useState('')
  const [savedMsg, setSavedMsg] = useState('')

  function flash(msg: string) {
    setSavedMsg(msg)
    setTimeout(() => setSavedMsg(''), 3000)
  }

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['staff-tickets'] })
    queryClient.invalidateQueries({ queryKey: ['staff-tickets-all'] })
    queryClient.invalidateQueries({ queryKey: ['staff-detail', ticket.id] })
  }

  const detailQuery = useQuery<TicketDetailResponse>({
    queryKey: ['staff-detail', ticket.id],
    queryFn: () => api.get(`/tickets/${ticket.id}`).then((r) => r.data),
    enabled: expanded,
  })

  const overrideMutation = useMutation({
    mutationFn: (payload: TicketOverride) => api.patch(`/tickets/${ticket.id}`, payload).then((r) => r.data),
    onSuccess: () => { flash('Override saved'); invalidate() },
  })
function badge(label: string, classes: string) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${classes}`}>
      {label}
    </span>
  )
}

export default function StaffDashboard() {
  const navigate = useNavigate()
  const [actionMessage, setActionMessage] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const officerToken = localStorage.getItem('jwt_token') || ''
  const officerName = (localStorage.getItem('officer_name') || '').trim()
  const officerEmail = (localStorage.getItem('officer_email') || '').trim()
  const officerId    = (localStorage.getItem('officer_id')    || '').trim()
  const tokenExpired = officerToken ? isTokenExpired(officerToken) : true
  const isSessionValid = Boolean(officerToken) && !tokenExpired

  useEffect(() => {
    if (!isSessionValid) {
      clearOfficerSession()
      navigate('/officer/login', { replace: true })
    }
  }, [isSessionValid, navigate])

  const { data: tickets = [], isLoading, isError, refetch: refetchQueue } = useQuery<Ticket[]>({
    queryKey: ['staff-tickets'],
    queryFn: () => api.get('/tickets?status=open').then((r) => r.data),
    refetchInterval: 60_000,
    enabled: isSessionValid,
  })

  const assigned = useMemo(
    () => tickets.filter((ticket) => ticket.assigned_at || ticket.assigned_to),
    [tickets]
  )

  // F36: match against name, email, and officer_id (assigned_to may store any of these)
  const assignedToMe = useMemo(() => {
    if (!officerName && !officerEmail && !officerId) return assigned
    const name  = officerName.toLowerCase()
    const email = officerEmail.toLowerCase()
    const id    = officerId.toLowerCase()
    return assigned.filter((ticket) => {
      const assignee = (ticket.assigned_to || '').toLowerCase()
      return assignee && (assignee === name || assignee === email || (id && assignee === id))
    })
  }, [assigned, officerName, officerEmail, officerId])

  const assignedToMeIds = useMemo(
    () => new Set(assignedToMe.map((ticket) => ticket.id)),
    [assignedToMe]
  )

  const groupedTickets = useMemo(() => {
    const groups = new Map<string, { master: Ticket | null; duplicates: Ticket[]; all: Ticket[] }>()
    tickets.forEach((ticket) => {
      const key = ticket.duplicate_of || ticket.id
      const existing = groups.get(key) ?? { master: null, duplicates: [], all: [] }
      existing.all.push(ticket)
      if (ticket.duplicate_of) {
        existing.duplicates.push(ticket)
      } else {
        existing.master = ticket
      }
      groups.set(key, existing)
    })
    return Array.from(groups.values())
      .map((group) => {
        const master = group.master ?? group.duplicates[0] ?? null
        const duplicates = group.master ? group.duplicates : group.duplicates.slice(1)
        return { master, duplicates, all: group.all }
      })
      .filter((group) => Boolean(group.master))
  }, [tickets])

  const approveMutation = useMutation({
    mutationFn: () => api.patch(`/tickets/${ticket.id}`, { approve: true } as TicketOverride).then((r) => r.data),
    onSuccess: () => { flash('Approved'); invalidate() },
  })

  const assignMutation = useMutation({
    mutationFn: (crewId: string) => api.patch(`/tickets/${ticket.id}`, { crew_id: crewId } as TicketOverride).then((r) => r.data),
    onSuccess: () => { flash('Crew assigned'); setSelectedCrewId(''); invalidate() },
  const { data: detail, isLoading: detailLoading, isError: detailError, refetch: refetchDetail } = useQuery<TicketDetailResponse>({
    queryKey: ['staff-ticket-detail', expandedId],
    queryFn: () => api.get(`/tickets/${expandedId}`).then((r) => r.data),
    enabled: Boolean(expandedId) && isSessionValid,
  })

  function handleLogout() {
    clearOfficerSession()
    navigate('/officer/login', { replace: true })
  }

  const resolveMutation = useMutation({
    mutationFn: () => api.patch(`/tickets/${ticket.id}`, { resolve: true } as TicketOverride).then((r) => r.data),
    onSuccess: () => { flash('Resolved'); invalidate() },
  })

  const urg = urgencyLabel(ticket.urgency_score)
  const lc = lifecycleBadge(ticket.lifecycle_status)

  return (
    <div className="glass-card rounded-3xl shadow-lg overflow-hidden">
      {/* ── Card header ── */}
      <div className="p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <span className={`inline-flex items-center justify-center h-7 w-9 rounded text-xs font-bold flex-shrink-0 mt-0.5 ${urg.classes}`}>
              {urg.label}
            </span>
            <div>
              <h3 className="text-base font-semibold text-slate-900 capitalize">
                {(ticket.issue_type || ticket.subcategory_name || 'Unclassified').replace('_', ' ')}
              </h3>
              <p className="text-sm text-slate-500 mt-0.5">{ticket.address || 'Address unavailable'}</p>
              <p className="text-xs text-slate-400 mt-0.5">Reported {formatDate(ticket.created_at)}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${lc.classes}`}>
              {lc.label}
            </span>
            {ticket.assigned_to && (
              <span className="inline-flex items-center rounded-full bg-slate-100 text-slate-700 px-2.5 py-0.5 text-xs font-medium">
                {ticket.assigned_to}
              </span>
            )}
            {ticket.needs_review && (
              <span className="inline-flex items-center rounded-full bg-amber-100 text-amber-800 px-2.5 py-0.5 text-xs font-semibold">
                Needs review
              </span>
            )}
          <button
            type="button"
            onClick={handleLogout}
            className="text-xs font-semibold text-rose-600 hover:text-rose-700 transition self-start lg:self-end"
          >
            Sign out
          </button>
        </header>

        {actionMessage && (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {actionMessage}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="rounded-2xl border border-slate-200 text-slate-700 px-4 py-2 text-sm font-semibold hover:bg-slate-50 transition"
          >
            {expanded ? 'Hide details' : 'View details & actions'}
          </button>
          {savedMsg && (
            <span className="text-emerald-600 text-sm font-medium">{savedMsg}</span>
          )}
        </div>
      </div>

      {/* ── Expanded section ── */}
      {expanded && (
        <div className="border-t border-slate-200 px-6 pb-6 pt-5 space-y-5 bg-white/70">

          {/* Customer report */}
          {(detailQuery.isLoading) && (
            <p className="text-sm text-slate-400 animate-pulse">Loading report…</p>
          )}
          {detailQuery.data && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em]">Customer report</p>
              {detailQuery.data.text && (
                <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{detailQuery.data.text}</p>
              )}
              {!detailQuery.data.text && (
                <p className="text-xs text-slate-400">No text submitted.</p>
              )}
              {detailQuery.data.image_url && (
                <div className="rounded-xl overflow-hidden border border-slate-200">
                  <img src={detailQuery.data.image_url} alt="Submitted photo" className="w-full max-h-60 object-cover" />
                </div>
              )}
              {detailQuery.data.image_text_conflict && (
                <div className="rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
                  <span className="font-semibold">Image/text conflict —</span>{' '}
                  {detailQuery.data.image_classification_hint
                    ? `image suggests: ${detailQuery.data.image_classification_hint}`
                    : 'AI trusted the image over the text.'}
                </div>
              )}
        <div className="mt-6 grid gap-4">
          {isLoading && (
            <div className="glass-card rounded-2xl p-6 text-sm text-slate-500">Loading tickets…</div>
          )}

          {/* F34: prominent error with retry */}
          {isError && (
            <div className="glass-card rounded-2xl border border-rose-200 bg-rose-50 p-6 flex items-center justify-between">
              <p className="text-sm font-medium text-rose-700">Unable to load assigned tickets.</p>
              <button
                type="button"
                onClick={() => refetchQueue()}
                className="text-xs font-semibold text-rose-700 hover:text-rose-800 underline ml-4 flex-shrink-0"
              >
                Try again
              </button>
            </div>
          )}

          {/* AI summary */}
          {ticket.ai_reasoning && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-2">AI reasoning</p>
              <p className="text-sm text-slate-700 leading-relaxed">{ticket.ai_reasoning}</p>
          {/* F36: no assigned tickets at all */}
          {!isLoading && !isError && visibleGroups.length === 0 && assigned.length === 0 && (
            <div className="glass-card rounded-2xl p-6 text-sm text-slate-500">
              No tickets are assigned to you yet.
            </div>
          )}

          {/* F36: tickets exist in the system but none match this officer's identity */}
          {!isLoading && !isError && visibleGroups.length === 0 && assigned.length > 0 && (
            <div className="glass-card rounded-2xl border border-amber-200 bg-amber-50 p-6 space-y-1">
              <p className="text-sm font-medium text-amber-800">
                {assigned.length} ticket{assigned.length !== 1 ? 's are' : ' is'} assigned in the system, but none match your profile.
              </p>
              <p className="text-xs text-amber-700">
                Matching on:{' '}
                {[officerName, officerEmail, officerId].filter(Boolean).join(' / ') || 'unknown identity'}.
                Ask a dispatcher to verify the assigned name matches exactly.
              </p>
            </div>
          )}

          {/* Classification */}
          {detailQuery.data && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              <div className="rounded-2xl border border-slate-200 bg-white p-3">
                <p className="text-xs text-slate-400 uppercase tracking-[0.2em]">Category</p>
                <p className="font-semibold text-slate-900 mt-1">{detailQuery.data.category_name || '—'}</p>
                <p className="text-xs text-slate-500">{detailQuery.data.subcategory_name || ''}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-3">
                <p className="text-xs text-slate-400 uppercase tracking-[0.2em]">Severity</p>
                <p className="font-semibold text-slate-900 mt-1">{detailQuery.data.severity ?? '—'} / 5</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-3">
                <p className="text-xs text-slate-400 uppercase tracking-[0.2em]">AI confidence</p>
                <p className="font-semibold text-slate-900 mt-1">
                  {detailQuery.data.confidence != null ? `${Math.round(detailQuery.data.confidence * 100)}%` : '—'}
                </p>
              </div>
            </div>
          )}

          {/* Work order */}
          {ticket.work_order && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-2">Work order</p>
              <p><span className="text-slate-400">Crew type:</span> {ticket.work_order.crew_type}</p>
              <p><span className="text-slate-400">Est. hours:</span> {ticket.work_order.est_hours}h</p>
              {ticket.work_order.materials.length > 0 && (
                <p><span className="text-slate-400">Materials:</span> {ticket.work_order.materials.join(', ')}</p>
              )}
              {ticket.work_order.notes && <p className="mt-1 italic text-slate-600">{ticket.work_order.notes}</p>}
            </div>
          )}

          {/* Activity log */}
          {detailQuery.data?.comments && detailQuery.data.comments.length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-2">Activity log</p>
              <ul className="space-y-2 text-sm text-slate-600">
                {detailQuery.data.comments.map((c) => (
                  <li key={c.id} className="flex gap-2">
                    <span className="mt-2 h-1.5 w-1.5 rounded-full bg-cyan-600 flex-shrink-0" />
                    <div>
                      <p>{c.message}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{c.author_type} · {new Date(c.created_at).toLocaleString()}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── Actions ── */}
          <div className="grid gap-4 sm:grid-cols-2">

            {/* Override priority */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em]">Override priority</p>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Issue type</label>
                <select
                  value={overrideIssueType}
                  onChange={(e) => setOverrideIssueType(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                >
                  <option value="">— unchanged —</option>
                  {ISSUE_TYPES.map((t) => (
                    <option key={t} value={t}>{t.replace('_', ' ')}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Urgency score</label>
                <select
                  value={overrideScore}
                  onChange={(e) => setOverrideScore(Number(e.target.value))}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                >
                  {[5, 4, 3, 2, 1].map((s) => (
                    <option key={s} value={s}>{s} — {['', 'P5 Lowest', 'P4 Low', 'P3 Medium', 'P2 High', 'P1 Critical'][s]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Comment (optional)</label>
                <textarea
                  rows={2}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Note for the citizen…"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                />
                <label className="mt-2 inline-flex items-center gap-2 text-xs text-slate-500">
                  <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500" />
                  Visible to citizen
                </label>
              </div>
              <button
                onClick={() => overrideMutation.mutate({
                  issue_type: overrideIssueType || undefined,
                  urgency_score: overrideScore,
                  comment: comment || undefined,
                  is_public: comment ? isPublic : undefined,
                })}
                disabled={overrideMutation.isPending}
                className="w-full rounded-xl bg-slate-900 text-white text-sm font-semibold py-2 hover:bg-slate-800 disabled:opacity-60 transition"
              >
                {overrideMutation.isPending ? 'Saving…' : 'Apply override'}
              </button>
            </div>

            {/* Crew assignment */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em]">Crew assignment</p>
              {ticket.assigned_to && (
                <p className="text-xs text-slate-500">Currently: <span className="font-medium text-slate-800">{ticket.assigned_to}</span></p>
              )}
              <select
                value={selectedCrewId}
                onChange={(e) => setSelectedCrewId(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 bg-white"
              >
                <option value="">— Select a crew —</option>
                {crews.map((c) => (
                  <option key={c.id} value={c.id}>{c.team_name} ({c.crew_type}) · {c.lead_name}</option>
                ))}
              </select>
              <button
                onClick={() => selectedCrewId && assignMutation.mutate(selectedCrewId)}
                disabled={assignMutation.isPending || !selectedCrewId}
                className="w-full rounded-xl bg-slate-900 text-white text-sm font-semibold py-2 hover:bg-slate-800 disabled:opacity-50 transition"
              >
                {assignMutation.isPending ? 'Assigning…' : ticket.assigned_to ? 'Reassign crew' : 'Assign crew'}
              </button>
            </div>
          </div>

          {/* Approve + Resolve */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-blue-200 bg-white p-4">
              <p className="text-xs font-semibold text-blue-700 uppercase tracking-[0.2em] mb-2">Officer approval</p>
              <p className="text-xs text-slate-500 mb-3">
                Approve so the scheduler can assign this to a crew.
              </p>
              <button
                onClick={() => approveMutation.mutate()}
                disabled={approveMutation.isPending || Boolean(ticket.approved)}
                className="w-full rounded-xl bg-blue-600 text-white text-sm font-semibold py-2 hover:bg-blue-700 disabled:opacity-50 transition"
              >
                {ticket.approved ? 'Already approved' : approveMutation.isPending ? 'Approving…' : 'Approve ticket'}
              </button>
            </div>

            <div className="rounded-2xl border border-emerald-200 bg-white p-4">
              <p className="text-xs font-semibold text-emerald-700 uppercase tracking-[0.2em] mb-2">Resolution</p>
              <p className="text-xs text-slate-500 mb-3">
                Mark as done when crew confirms work is complete.
              </p>
              <button
                onClick={() => resolveMutation.mutate()}
                disabled={resolveMutation.isPending || Boolean(ticket.resolved_at)}
                className="w-full rounded-xl bg-emerald-600 text-white text-sm font-semibold py-2 hover:bg-emerald-700 disabled:opacity-50 transition"
              >
                {ticket.resolved_at ? 'Already resolved' : resolveMutation.isPending ? 'Resolving…' : 'Mark resolved'}
              </button>
            </div>
          </div>

        </div>
      )}
    </div>
  )
}

export default function StaffDashboard() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'open' | 'review'>('open')
  const [search, setSearch] = useState('')

  const { data: openTickets = [], isLoading, isError } = useQuery<Ticket[]>({
    queryKey: ['staff-tickets'],
    queryFn: () => api.get('/tickets?status=open').then((r) => r.data),
    refetchInterval: 60_000,
  })

const { data: crews = [] } = useQuery<{ id: string; team_name: string; crew_type: string; lead_name: string }[]>({
    queryKey: ['crews'],
    queryFn: () => api.get('/crews').then((r) => r.data),
  })

  const open   = openTickets.filter((t) => (t.confidence ?? 1) >= 0.70)
  const review = openTickets.filter((t) => (t.confidence ?? 1) < 0.70)
  const baseList = tab === 'open' ? open : review

  const visible = baseList.filter((t) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return (
      (t.issue_type || t.subcategory_name || '').toLowerCase().includes(q) ||
      (t.address || '').toLowerCase().includes(q)
    )
  })

  const loading = isLoading

  return (
    <div className="min-h-screen bg-grid">
      <AppNav activeRole="officer" />
      <div className="mx-auto max-w-4xl px-6 pb-10">
        <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between pt-2 pb-6">
          <div>
            <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Officer console</p>
            <h1 className="font-display text-3xl sm:text-4xl text-slate-900 mt-3">Ticket queue</h1>
            <p className="text-sm text-slate-500 mt-2">Review, approve, and manage all submitted reports.</p>
          </div>
          <div className="flex gap-2 self-start lg:self-auto">
            <Link
              to="/officer/dashboard"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              All Tickets
            </Link>
            <Link
              to="/officer/schedule"
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
            >
              View Schedule →
            </Link>
          </div>
        </header>

        {/* Tabs + search */}
        <div className="flex flex-col gap-4 mb-6">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by issue type or address…"
            className="w-full rounded-2xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 bg-white/80"
          />
          <div className="flex gap-3 flex-wrap">
            {([
              { key: 'open',   label: `Open (${open.length})` },
              { key: 'review', label: `Needs review (${review.length})` },
            ] as const).map((item) => (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                className={`px-4 py-2 rounded-full text-xs font-semibold transition ${
                  tab === item.key
                    ? 'bg-slate-900 text-white'
                    : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
              {showDetails && (
                <div className="mt-5 border-t border-slate-200 pt-4 space-y-5 text-sm text-slate-700">
                  {detailLoading && (
                    <p className="text-slate-500">Loading ticket details…</p>
                  )}
                  {/* F35: retry button on detail fetch failure */}
                  {detailError && (
                    <div className="flex items-center gap-3">
                      <p className="text-rose-600">Could not load ticket details.</p>
                      <button
                        type="button"
                        onClick={() => refetchDetail()}
                        className="text-xs font-semibold text-cyan-700 hover:text-cyan-800"
                      >
                        Try again
                      </button>
                    </div>
                  )}
                  {detail && (
                    <>
                      {/* ── Conflict / review reason callout ── */}
                      {detail.image_text_conflict && (
                        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-rose-700 mb-3">
                            Image / text conflict — why review is needed
                          </p>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="rounded-xl bg-white border border-rose-100 px-3 py-3">
                              <p className="text-xs font-semibold text-slate-500 mb-1">Text says</p>
                              <p className="text-slate-800 text-sm leading-snug whitespace-pre-wrap">
                                {detail.text || '—'}
                              </p>
                            </div>
                            <div className="rounded-xl bg-white border border-rose-100 px-3 py-3">
                              <p className="text-xs font-semibold text-slate-500 mb-1">Image suggests</p>
                              <p className="text-slate-800 text-sm leading-snug">
                                {detail.image_classification_hint || 'No image hint available'}
                              </p>
                            </div>
                          </div>
                          <p className="mt-3 text-xs text-rose-600">
                            The AI trusted the image and classified accordingly. Review both the text and photo below before approving.
                          </p>
                        </div>
                      )}

                      {!detail.image_text_conflict && detail.needs_review && (
                        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
                          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700 mb-1">
                            Flagged for review
                          </p>
                          {detail.confidence !== null && detail.confidence !== undefined && detail.confidence < 0.7 ? (
                            <p className="text-amber-800 text-sm">
                              AI confidence is low ({Math.round(detail.confidence * 100)}%). The classification may be incorrect — verify the category matches the report.
                            </p>
                          ) : (
                            <p className="text-amber-800 text-sm">
                              This ticket was flagged for manual review by the AI pipeline.
                            </p>
                          )}
                        </div>
                      )}

                      {/* ── Classification summary ── */}
                      <div className="grid gap-4 sm:grid-cols-3">
                        <div>
                          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Category</p>
                          <p className="mt-1 font-semibold text-slate-900">{detail.category_name || '—'}</p>
                          <p className="text-xs text-slate-500">{detail.subcategory_name || detail.subcategory_code || ''}</p>
                        </div>
                        <div>
                          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Severity</p>
                          <p className="mt-1 font-semibold text-slate-900">{detail.severity ?? '—'} / 5</p>
                        </div>
                        <div>
                          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">AI confidence</p>
                          <p className="mt-1 font-semibold text-slate-900">
                            {detail.confidence !== null && detail.confidence !== undefined
                              ? `${Math.round(detail.confidence * 100)}%`
                              : '—'}
                          </p>
                          {detail.confidence !== null && detail.confidence !== undefined && (
                            <div className="mt-1 h-1.5 w-full rounded-full bg-slate-200">
                              <div
                                className={`h-1.5 rounded-full ${detail.confidence >= 0.7 ? 'bg-emerald-500' : 'bg-amber-400'}`}
                                style={{ width: `${Math.round(detail.confidence * 100)}%` }}
                              />
                            </div>
                          )}
                        </div>
                      </div>

        {/* List */}
        <div className="space-y-4">
          {loading && (
            <div className="glass-card rounded-2xl p-6 text-sm text-slate-500 animate-pulse">Loading tickets…</div>
          )}
          {isError && (
            <div className="glass-card rounded-2xl p-6 text-sm text-rose-600">Unable to load tickets.</div>
          )}
          {!loading && !isError && visible.length === 0 && (
            <div className="glass-card rounded-2xl p-6 text-sm text-slate-500">No tickets found.</div>
          )}
          {visible.map((ticket) => (
            <TicketCard key={ticket.id} ticket={ticket} crews={crews} />
          ))}
        </div>
      </div>
    </div>
  )
}
