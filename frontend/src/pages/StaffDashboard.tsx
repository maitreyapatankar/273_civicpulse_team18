import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import api from '../api/client'
import { Ticket, TicketDetailResponse, TicketOverride } from '../api/types'
import AppNav from '../components/AppNav'

function isTokenExpired(): boolean {
  const token = localStorage.getItem('access_token')
  if (!token) return true
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return true
    const payload = JSON.parse(atob(parts[1]))
    return payload.exp * 1000 < Date.now()
  } catch {
    return true
  }
}

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

  const approveMutation = useMutation({
    mutationFn: () => api.patch(`/tickets/${ticket.id}`, { approve: true } as TicketOverride).then((r: any) => r.data),
    onSuccess: () => { flash('Approved - scheduler will assign crew'); invalidate() },
  })

  const rejectMutation = useMutation({
    mutationFn: () => api.patch(`/tickets/${ticket.id}`, { reject: true } as TicketOverride).then((r) => r.data),
    onSuccess: () => { flash('Rejected'); invalidate() },
  })

  const assignMutation = useMutation({
    mutationFn: (crewId: string) => api.patch(`/tickets/${ticket.id}`, { crew_id: crewId } as TicketOverride).then((r) => r.data),
    onSuccess: () => { flash('Crew assigned'); setSelectedCrewId(''); invalidate() },
  })

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
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {!ticket.approved && ticket.lifecycle_status !== 'forwarded_to_maintenance' && (
            <>
              <button
                onClick={() => approveMutation.mutate()}
                disabled={approveMutation.isPending}
                className="rounded-2xl bg-emerald-600 text-white px-4 py-2 text-sm font-semibold hover:bg-emerald-700 disabled:opacity-60 transition"
              >
                {approveMutation.isPending ? 'Approving…' : 'Approve'}
              </button>
              <button
                onClick={() => rejectMutation.mutate()}
                disabled={rejectMutation.isPending}
                className="rounded-2xl bg-rose-600 text-white px-4 py-2 text-sm font-semibold hover:bg-rose-700 disabled:opacity-60 transition"
              >
                {rejectMutation.isPending ? 'Rejecting…' : 'Reject'}
              </button>
            </>
          )}
          {ticket.lifecycle_status === 'forwarded_to_maintenance' && !ticket.resolved_at && (
            <button
              onClick={() => resolveMutation.mutate()}
              disabled={resolveMutation.isPending}
              className="rounded-2xl bg-blue-600 text-white px-4 py-2 text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 transition"
            >
              {resolveMutation.isPending ? 'Resolving…' : 'Mark Resolved'}
            </button>
          )}
          {!ticket.resolved_at && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="rounded-2xl border border-slate-200 text-slate-700 px-4 py-2 text-sm font-semibold hover:bg-slate-50 transition"
            >
              {expanded ? 'Hide details' : 'View details & actions'}
            </button>
          )}
          {savedMsg && (
            <span className="text-emerald-600 text-sm font-medium">{savedMsg}</span>
          )}
        </div>
      </div>

      {/* ── Expanded section ── */}
      {expanded && (
        <div className="border-t border-slate-200 px-6 pb-6 pt-5 space-y-5 bg-white/70">

          {/* Metadata (Category, Severity, Confidence) */}
          {detailQuery.data && (
            <div className="flex flex-wrap gap-3 text-xs">
              <div className="flex-1 min-w-max rounded-xl bg-slate-100 px-3 py-2">
                <p className="text-slate-400 uppercase tracking-[0.1em]">Category</p>
                <p className="font-medium text-slate-900">{detailQuery.data.category_name || '—'}</p>
                {detailQuery.data.subcategory_name && (
                  <p className="text-slate-500">{detailQuery.data.subcategory_name}</p>
                )}
              </div>
              <div className="flex-1 min-w-max rounded-xl bg-slate-100 px-3 py-2">
                <p className="text-slate-400 uppercase tracking-[0.1em]">Severity</p>
                <p className="font-medium text-slate-900">{detailQuery.data.severity ?? '—'} / 5</p>
              </div>
              <div className="flex-1 min-w-max rounded-xl bg-slate-100 px-3 py-2">
                <p className="text-slate-400 uppercase tracking-[0.1em]">AI Confidence</p>
                <p className="font-medium text-slate-900">
                  {detailQuery.data.confidence != null ? `${Math.round(detailQuery.data.confidence * 100)}%` : '—'}
                </p>
              </div>
            </div>
          )}

          {/* AI reasoning */}
          {ticket.ai_reasoning && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-2">AI reasoning</p>
              <p className="text-sm text-slate-700 leading-relaxed">{ticket.ai_reasoning}</p>
            </div>
          )}

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
            </div>
          )}

          {/* Crew reassignment (only for approved/pending tickets) */}
          {ticket.approved && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em]">Crew assignment</p>
              {ticket.assigned_to && (
                <p className="text-xs text-slate-600 mt-1">Currently: <span className="font-medium text-slate-800">{ticket.assigned_to}</span></p>
              )}
            </div>
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
              className="w-full rounded-xl bg-slate-700 text-white text-sm font-semibold py-2 hover:bg-slate-800 disabled:opacity-50 transition"
            >
              {assignMutation.isPending ? 'Assigning…' : ticket.assigned_to ? 'Reassign crew' : 'Assign crew'}
            </button>
            </div>
          )}

          {/* Override priority (not for pending tickets) */}
          {ticket.lifecycle_status !== 'forwarded_to_maintenance' && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em]">Override priority</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">Issue type</label>
                <select
                  value={overrideIssueType}
                  onChange={(e) => setOverrideIssueType(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500"
                >
                  <option value="">— unchanged —</option>
                  {ISSUE_TYPES.map((t) => (
                    <option key={t} value={t}>{t.replace('_', ' ')}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">Priority</label>
                <select
                  value={overrideScore}
                  onChange={(e) => setOverrideScore(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500"
                >
                  {[5, 4, 3, 2, 1].map((s) => (
                    <option key={s} value={s}>P{s}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Note (optional)</label>
              <input
                type="text"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Add a note…"
                className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500"
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
              className="w-full rounded-lg bg-slate-700 text-white text-xs font-semibold py-1.5 hover:bg-slate-800 disabled:opacity-60 transition"
            >
              {overrideMutation.isPending ? 'Saving…' : 'Apply'}
            </button>
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

        </div>
      )}

    </div>
  )
}

export default function StaffDashboard() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'open' | 'review' | 'pending' | 'resolved'>('open')
  const [search, setSearch] = useState('')

  const { data: openTickets = [], isLoading, isError, refetch } = useQuery<Ticket[]>({
    queryKey: ['staff-tickets'],
    queryFn: () => api.get('/tickets?status=all').then((r) => r.data),
    refetchInterval: 60_000,
  })

const { data: crews = [] } = useQuery<{ id: string; team_name: string; crew_type: string; lead_name: string }[]>({
    queryKey: ['crews'],
    queryFn: () => api.get('/crews').then((r) => r.data),
  })

  const open    = openTickets.filter((t) => !t.approved && !t.needs_review && t.lifecycle_status !== 'forwarded_to_maintenance' && !t.resolved_at)
  const review  = openTickets.filter((t) => !t.approved && t.needs_review && t.lifecycle_status !== 'forwarded_to_maintenance' && !t.resolved_at)
  const pending = openTickets.filter((t) => t.lifecycle_status === 'forwarded_to_maintenance' && !t.resolved_at)
  const resolved = openTickets.filter((t) => t.resolved_at !== null)
  const baseList = tab === 'open' ? open : tab === 'review' ? review : tab === 'pending' ? pending : resolved

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
          <div className="flex gap-2 self-start lg:self-auto flex-wrap">
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
              { key: 'open',    label: `Open (${open.length})` },
              { key: 'review',  label: `Needs review (${review.length})` },
              { key: 'pending', label: `Pending (${pending.length})` },
              { key: 'resolved', label: `Resolved (${resolved.length})` },
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

        {/* List */}
        <div className="space-y-4">
          {loading && (
            <div className="glass-card rounded-2xl p-6 text-sm text-slate-500 animate-pulse">Loading tickets…</div>
          )}
          {isError && (
            <div className="glass-card rounded-2xl p-6 flex items-center justify-between">
              <span className="text-sm text-rose-600">Unable to load tickets.</span>
              <button
                onClick={() => refetch()}
                className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 transition"
              >
                Retry
              </button>
            </div>
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
