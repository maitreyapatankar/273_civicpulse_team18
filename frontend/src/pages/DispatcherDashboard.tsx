import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import api from '../api/client'
import { TicketDetailResponse, TicketOverride } from '../api/types'
import AppNav from '../components/AppNav'

delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

interface Ticket {
  id: string
  raw_report_id: string
  issue_type: string
  severity: number
  urgency_score: number
  urgency_factors: {
    safety_risk: number
    traffic_impact: number
    cluster_volume: number
    days_unresolved: number
  } | null
  ai_reasoning: string
  confidence: number
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
  resolved_at: string | null
  created_at: string
  lat: number
  lng: number
  address: string
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

function urgencyBadge(score: number): { label: string; classes: string } {
  if (score >= 5) return { label: 'P1', classes: 'bg-rose-600 text-white' }
  if (score >= 4) return { label: 'P2', classes: 'bg-amber-500 text-white' }
  if (score >= 3) return { label: 'P3', classes: 'bg-yellow-300 text-slate-900' }
  if (score >= 2) return { label: 'P4', classes: 'bg-cyan-500 text-white' }
  return { label: 'P5', classes: 'bg-slate-400 text-white' }
}

function confidenceColor(c: number): string {
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
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'open' | 'review'>('open')
  const [selected, setSelected] = useState<Ticket | null>(null)
  const [overrideIssueType, setOverrideIssueType] = useState('')
  const [overrideScore, setOverrideScore] = useState<number>(3)
  const [overrideSaved, setOverrideSaved] = useState(false)
  const [search, setSearch] = useState('')
  const [comment, setComment] = useState('')
  const [isPublic, setIsPublic] = useState(DEFAULT_PUBLIC_UPDATE)

  const { data: tickets = [], isLoading, isError } = useQuery<Ticket[]>({
    queryKey: ['tickets'],
    queryFn: () => api.get('/tickets?status=open&sort=urgency_score').then((r) => r.data),
    refetchInterval: 30_000,
  })

  const detailQuery = useQuery<TicketDetailResponse>({
    queryKey: ['ticket-detail', selected?.id],
    queryFn: () => api.get(`/tickets/${selected?.id}`).then((r) => r.data),
    enabled: Boolean(selected?.id),
  })

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
      setComment('')
      setIsPublic(DEFAULT_PUBLIC_UPDATE)
      queryClient.invalidateQueries({ queryKey: ['ticket-detail'] })
    },
  })

  const open = tickets.filter((t) => t.confidence >= 0.70)
  const review = tickets.filter((t) => t.confidence < 0.70)
  const baseVisible = tab === 'open' ? open : review
  const visible = baseVisible.filter((ticket) => {
    const query = search.trim().toLowerCase()
    if (!query) return true
    return (
      ticket.issue_type.toLowerCase().includes(query) ||
      (ticket.address || '').toLowerCase().includes(query)
    )
  })
  const avgUrgency = tickets.length
    ? (tickets.reduce((sum, t) => sum + t.urgency_score, 0) / tickets.length).toFixed(1)
    : '0.0'

  function handleSelect(ticket: Ticket) {
    setSelected(ticket)
    setOverrideIssueType(ticket.issue_type)
    setOverrideScore(Math.round(ticket.urgency_score))
    setOverrideSaved(false)
  }

  function handleApplyOverride() {
    if (!selected) return
    mutation.mutate({
      id: selected.id,
      payload: {
        issue_type: overrideIssueType,
        urgency_score: overrideScore,
        comment: comment || undefined,
        is_public: comment ? isPublic : undefined,
      },
    })
  }

  return (
    <div className="min-h-screen bg-grid">
      <AppNav activeRole="officer" />
      <div className="px-6 pb-8">
        <div className="mx-auto max-w-7xl">
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
              <p className="text-2xl font-semibold text-slate-900 mt-2">{avgUrgency}</p>
              <p className="text-xs text-slate-500 mt-1">Across open tickets</p>
            </div>
            <div className="glass-card rounded-2xl p-4 shadow-lg">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Auto refresh</p>
              <p className="text-2xl font-semibold text-slate-900 mt-2">30s</p>
              <p className="text-xs text-slate-500 mt-1">Realtime pipeline sync</p>
            </div>
          </div>

          <div className="grid lg:grid-cols-[1.1fr_0.9fr] gap-6">
          <section className="glass-card rounded-3xl shadow-xl overflow-hidden">
          <div className="px-6 py-5 border-b border-slate-200 bg-white/90">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Officer console</p>
                <h1 className="font-display text-2xl text-slate-900 mt-2">Priority queue</h1>
              </div>
              <div className="text-right text-xs text-slate-500">
                {isLoading && <span className="animate-pulse">Syncing…</span>}
                {isError && <span className="text-rose-600">Failed to load</span>}
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
                { key: 'open', label: `Open (${open.length})` },
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
                        <p className="text-sm font-semibold text-slate-900 capitalize truncate">
                          {ticket.issue_type.replace('_', ' ')}
                          {ticket.cluster_count > 1 && (
                            <span className="ml-2 text-xs text-cyan-700 font-normal">
                              +{ticket.cluster_count - 1} similar
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-slate-500 truncate">
                          {ticket.address || `${ticket.lat.toFixed(4)}, ${ticket.lng.toFixed(4)}`}
                        </p>
                      </div>
                    </div>
                    <span className="text-xs text-slate-400 flex-shrink-0">
                      {relativeTime(ticket.created_at)}
                    </span>
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <div className="flex-1 h-2 bg-slate-200 rounded-full">
                      <div
                        className={`h-2 rounded-full ${confidenceColor(ticket.confidence)}`}
                        style={{ width: `${ticket.confidence * 100}%` }}
                      />
                    </div>
                    <span className="text-xs text-slate-400 w-10 text-right">
                      {(ticket.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
          </section>

          <section className="glass-card rounded-3xl shadow-xl overflow-hidden">
          {!selected ? (
            <div className="h-full flex items-center justify-center text-slate-400 text-sm p-10 bg-white/80">
              Select a ticket to view details
            </div>
          ) : (
            <div className="p-6 space-y-5 bg-white/90">
              <div>
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-slate-900 capitalize">
                    {selected.issue_type.replace('_', ' ')} — Severity {selected.severity}
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
                  {selected.address || `${selected.lat.toFixed(5)}, ${selected.lng.toFixed(5)}`}
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  Reported {relativeTime(selected.created_at)}
                  {selected.dispatcher_override && (
                    <span className="ml-2 text-amber-600 font-medium">
                      — Override by {selected.override_by}
                    </span>
                  )}
                </p>
              </div>

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
                      <span className="capitalize">{selected.issue_type.replace('_', ' ')}</span>
                    </Popup>
                  </Marker>
                </MapContainer>
              </div>

              {selected.cluster_count > 1 && (
                <div className="rounded-2xl bg-cyan-50 border border-cyan-100 px-4 py-3 text-sm text-cyan-900">
                  Merged with <strong>{selected.cluster_count - 1}</strong> nearby report
                  {selected.cluster_count > 2 ? 's' : ''}.
                </div>
              )}

              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-2">
                  AI reasoning
                </h3>
                <p className="text-sm text-slate-700 leading-relaxed">
                  {selected.ai_reasoning || '—'}
                </p>
              </div>

              {selected.urgency_factors && (
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-3">
                    Urgency factors
                  </h3>
                  <FactorBar label="Safety Risk" value={selected.urgency_factors.safety_risk} />
                  <FactorBar label="Traffic Impact" value={selected.urgency_factors.traffic_impact} />
                  <FactorBar label="Cluster Volume" value={selected.urgency_factors.cluster_volume} />
                  <FactorBar label="Days Unresolved" value={selected.urgency_factors.days_unresolved} />
                </div>
              )}

              {detailQuery.data?.comments && detailQuery.data.comments.length > 0 && (
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-2">
                    Activity log
                  </h3>
                  <ul className="space-y-2 text-sm text-slate-600">
                    {detailQuery.data.comments.map((commentItem) => (
                      <li key={commentItem.id} className="flex gap-2">
                        <span className="mt-2 h-1.5 w-1.5 rounded-full bg-cyan-600" />
                        <div>
                          <p>{commentItem.message}</p>
                          <p className="text-xs text-slate-400 mt-1">
                            {commentItem.author_type} • {new Date(commentItem.created_at).toLocaleString()}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {selected.work_order && (
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-2">
                    Work order
                  </h3>
                  <div className="space-y-1 text-sm text-slate-700">
                    <p>
                      <span className="text-slate-500">Crew:</span> {selected.work_order.crew_type}
                    </p>
                    <p>
                      <span className="text-slate-500">Est. hours:</span> {selected.work_order.est_hours}h
                    </p>
                    {selected.work_order.materials.length > 0 && (
                      <p>
                        <span className="text-slate-500">Materials:</span> {selected.work_order.materials.join(', ')}
                      </p>
                    )}
                    {selected.work_order.notes && (
                      <p className="text-slate-600 mt-1 italic">{selected.work_order.notes}</p>
                    )}
                  </div>
                </div>
              )}

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
                        <option key={t} value={t}>
                          {t.replace('_', ' ')}
                        </option>
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

              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-3">
                  Department update
                </h3>
                <textarea
                  rows={3}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Share an update for the citizen."
                  className="w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                />
                <label className="mt-3 inline-flex items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={isPublic}
                    onChange={(e) => setIsPublic(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500"
                  />
                  Visible to citizen
                </label>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-[0.2em] mb-3">
                  Quick actions
                </h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button className="rounded-2xl bg-slate-900 text-white text-sm font-semibold py-2.5 hover:bg-slate-800 transition">
                    Assign crew
                  </button>
                  <button className="rounded-2xl border border-slate-200 text-sm font-semibold py-2.5 text-slate-700 hover:bg-slate-50 transition">
                    Request follow-up
                  </button>
                  <button className="rounded-2xl border border-cyan-200 text-sm font-semibold py-2.5 text-cyan-900 hover:bg-cyan-50 transition">
                    Notify citizen
                  </button>
                  <button className="rounded-2xl border border-amber-200 text-sm font-semibold py-2.5 text-amber-800 hover:bg-amber-50 transition">
                    Escalate ticket
                  </button>
                </div>
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
