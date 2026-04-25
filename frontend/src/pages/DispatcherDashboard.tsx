import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import api from '../api/client'

// Fix Leaflet default marker icons (broken by Vite/webpack asset pipeline)
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

interface OverridePayload {
  issue_type: string
  urgency_score: number
  dispatcher_override: true
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

function urgencyBadge(score: number): { label: string; classes: string } {
  if (score >= 5) return { label: 'P1', classes: 'bg-red-600 text-white' }
  if (score >= 4) return { label: 'P2', classes: 'bg-orange-500 text-white' }
  if (score >= 3) return { label: 'P3', classes: 'bg-yellow-400 text-gray-900' }
  if (score >= 2) return { label: 'P4', classes: 'bg-blue-400 text-white' }
  return { label: 'P5', classes: 'bg-gray-400 text-white' }
}

function confidenceColor(c: number): string {
  if (c >= 0.70) return 'bg-green-500'
  if (c >= 0.50) return 'bg-amber-400'
  return 'bg-red-500'
}

function FactorBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="mb-1">
      <div className="flex justify-between text-xs text-gray-500 mb-0.5">
        <span>{label}</span>
        <span>{(value * 100).toFixed(0)}%</span>
      </div>
      <div className="h-1.5 bg-gray-200 rounded-full">
        <div
          className="h-1.5 bg-indigo-500 rounded-full"
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

  const { data: tickets = [], isLoading, isError } = useQuery<Ticket[]>({
    queryKey: ['tickets'],
    queryFn: () =>
      api.get('/tickets?status=open&sort=urgency_score').then((r) => r.data),
    refetchInterval: 30_000,
  })

  const mutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: OverridePayload }) =>
      api.patch(`/tickets/${id}`, payload).then((r) => r.data),
    onSuccess: (updated: Ticket) => {
      queryClient.setQueryData<Ticket[]>(['tickets'], (prev = []) =>
        prev.map((t) => (t.id === updated.id ? updated : t))
      )
      setSelected(updated)
      setOverrideSaved(true)
      setTimeout(() => setOverrideSaved(false), 3_000)
    },
  })

  const open = tickets.filter((t) => t.confidence >= 0.70)
  const review = tickets.filter((t) => t.confidence < 0.70)
  const visible = tab === 'open' ? open : review

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
        dispatcher_override: true,
      },
    })
  }

  return (
    <div className="flex h-screen bg-gray-100 font-sans">
      {/* LEFT PANE — 60% */}
      <div className="flex flex-col w-3/5 border-r border-gray-200 bg-white">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-800">CivicPulse Dispatcher</h1>
          {isLoading && (
            <span className="text-xs text-gray-400 animate-pulse">Loading…</span>
          )}
          {isError && (
            <span className="text-xs text-red-500">Failed to load tickets</span>
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 px-4 pt-2 gap-4">
          <button
            onClick={() => setTab('open')}
            className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'open'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Open ({open.length})
          </button>
          <button
            onClick={() => setTab('review')}
            className={`pb-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
              tab === 'review'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Needs Review
            {review.length > 0 && (
              <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-amber-400 text-gray-900 text-xs font-bold">
                {review.length}
              </span>
            )}
          </button>
        </div>

        {/* Ticket list */}
        <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
          {visible.length === 0 && !isLoading && (
            <p className="text-center text-gray-400 text-sm py-12">No tickets</p>
          )}
          {visible.map((ticket) => {
            const badge = urgencyBadge(ticket.urgency_score)
            const isSelected = selected?.id === ticket.id
            return (
              <div
                key={ticket.id}
                onClick={() => handleSelect(ticket)}
                className={`px-4 py-3 cursor-pointer transition-colors hover:bg-gray-50 ${
                  isSelected ? 'bg-indigo-50 border-l-2 border-indigo-500' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`inline-flex items-center justify-center h-6 w-8 rounded text-xs font-bold flex-shrink-0 ${badge.classes}`}
                    >
                      {badge.label}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-800 capitalize truncate">
                        {ticket.issue_type.replace('_', ' ')}
                        {ticket.cluster_count > 1 && (
                          <span className="ml-1.5 text-xs text-indigo-600 font-normal">
                            +{ticket.cluster_count - 1} similar
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-gray-500 truncate">
                        {ticket.address || `${ticket.lat.toFixed(4)}, ${ticket.lng.toFixed(4)}`}
                      </p>
                    </div>
                  </div>
                  <span className="text-xs text-gray-400 flex-shrink-0">
                    {relativeTime(ticket.created_at)}
                  </span>
                </div>

                {/* Confidence bar */}
                <div className="mt-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-gray-200 rounded-full">
                      <div
                        className={`h-1.5 rounded-full ${confidenceColor(ticket.confidence)}`}
                        style={{ width: `${ticket.confidence * 100}%` }}
                      />
                    </div>
                    <span className="text-xs text-gray-400 w-8 text-right">
                      {(ticket.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* RIGHT PANE — 40% */}
      <div className="flex flex-col w-2/5 bg-gray-50 overflow-y-auto">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
            Select a ticket to view details
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {/* Ticket header */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-base font-semibold text-gray-800 capitalize">
                  {selected.issue_type.replace('_', ' ')} — Severity {selected.severity}
                </h2>
                <span
                  className={`inline-flex items-center justify-center h-6 w-8 rounded text-xs font-bold ${
                    urgencyBadge(selected.urgency_score).classes
                  }`}
                >
                  {urgencyBadge(selected.urgency_score).label}
                </span>
              </div>
              <p className="text-xs text-gray-500">
                {selected.address || `${selected.lat.toFixed(5)}, ${selected.lng.toFixed(5)}`}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">
                Reported {relativeTime(selected.created_at)}
                {selected.dispatcher_override && (
                  <span className="ml-2 text-amber-600 font-medium">
                    — Dispatcher override by {selected.override_by}
                  </span>
                )}
              </p>
            </div>

            {/* Map */}
            <div className="h-[220px] rounded-lg overflow-hidden border border-gray-200">
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

            {/* Cluster info */}
            {selected.cluster_count > 1 && (
              <div className="bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2 text-sm text-indigo-800">
                Your report was merged with{' '}
                <strong>{selected.cluster_count - 1}</strong> similar nearby report
                {selected.cluster_count > 2 ? 's' : ''}.
              </div>
            )}

            {/* AI Reasoning */}
            <div className="bg-white border border-gray-200 rounded-lg p-3">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                AI Reasoning
              </h3>
              <p className="text-sm text-gray-700 leading-relaxed">
                {selected.ai_reasoning || '—'}
              </p>
            </div>

            {/* Urgency Factors */}
            {selected.urgency_factors && (
              <div className="bg-white border border-gray-200 rounded-lg p-3">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                  Urgency Factors
                </h3>
                <FactorBar label="Safety Risk" value={selected.urgency_factors.safety_risk} />
                <FactorBar label="Traffic Impact" value={selected.urgency_factors.traffic_impact} />
                <FactorBar label="Cluster Volume" value={selected.urgency_factors.cluster_volume} />
                <FactorBar label="Days Unresolved" value={selected.urgency_factors.days_unresolved} />
              </div>
            )}

            {/* Work Order */}
            {selected.work_order && (
              <div className="bg-white border border-gray-200 rounded-lg p-3">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Work Order
                </h3>
                <div className="space-y-1 text-sm text-gray-700">
                  <p>
                    <span className="text-gray-500">Crew:</span>{' '}
                    {selected.work_order.crew_type}
                  </p>
                  <p>
                    <span className="text-gray-500">Est. hours:</span>{' '}
                    {selected.work_order.est_hours}h
                  </p>
                  {selected.work_order.materials.length > 0 && (
                    <p>
                      <span className="text-gray-500">Materials:</span>{' '}
                      {selected.work_order.materials.join(', ')}
                    </p>
                  )}
                  {selected.work_order.notes && (
                    <p className="text-gray-600 mt-1 italic">{selected.work_order.notes}</p>
                  )}
                </div>
              </div>
            )}

            {/* Override Panel */}
            <div className="bg-white border border-gray-200 rounded-lg p-3">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Override
              </h3>
              <div className="space-y-2">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Issue Type</label>
                  <select
                    value={overrideIssueType}
                    onChange={(e) => setOverrideIssueType(e.target.value)}
                    className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  >
                    {ISSUE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">
                    Urgency Score
                  </label>
                  <select
                    value={overrideScore}
                    onChange={(e) => setOverrideScore(Number(e.target.value))}
                    className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  >
                    {[5, 4, 3, 2, 1].map((s) => (
                      <option key={s} value={s}>
                        {s} — {['', 'P5 Lowest', 'P4 Low', 'P3 Medium', 'P2 High', 'P1 Critical'][s]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={handleApplyOverride}
                    disabled={mutation.isPending}
                    className="flex-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-medium py-1.5 rounded transition-colors"
                  >
                    {mutation.isPending ? 'Saving…' : 'Apply Override'}
                  </button>
                  {overrideSaved && (
                    <span className="text-green-600 text-sm font-medium">
                      Override saved
                    </span>
                  )}
                </div>
                {mutation.isError && (
                  <p className="text-xs text-red-500">Failed to save override. Try again.</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
