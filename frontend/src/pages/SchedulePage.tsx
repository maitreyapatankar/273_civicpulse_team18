import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import { Link } from 'react-router-dom'
import api from '../api/client'
import AppNav from '../components/AppNav'

const markerIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

interface Zone {
  id: string
  date: string
  zone_lat: number
  zone_lng: number
  crew_type: string
  ticket_ids: string[]
  est_hours: number
  created_at: string
}

interface ZoneTicket {
  id: string
  subcategory_name: string | null
  issue_type: string | null
  urgency_score: number
  address: string | null
  assigned_to: string | null
}

const CREW_COLORS: Record<string, string> = {
  roads:      'bg-blue-100 text-blue-800',
  traffic:    'bg-amber-100 text-amber-800',
  drainage:   'bg-cyan-100 text-cyan-800',
  structures: 'bg-purple-100 text-purple-800',
  operations: 'bg-slate-100 text-slate-700',
}

function urgencyColor(score: number): string {
  if (score >= 4.5) return 'text-red-600 font-bold'
  if (score >= 3.5) return 'text-orange-500 font-semibold'
  if (score >= 2.5) return 'text-yellow-600'
  return 'text-slate-500'
}

function FitBounds({ zones }: { zones: Zone[] }) {
  const map = useMap()
  if (zones.length > 0) {
    const bounds = L.latLngBounds(zones.map((z) => [z.zone_lat, z.zone_lng]))
    map.fitBounds(bounds, { padding: [40, 40] })
  }
  return null
}

export default function SchedulePage() {
  const [selected, setSelected] = useState<Zone | null>(null)

  const { data: zones = [], isLoading, isError } = useQuery<Zone[]>({
    queryKey: ['schedule-today'],
    queryFn: () => api.get('/schedule/today').then((r) => r.data),
    refetchInterval: 5 * 60_000,
  })

  const { data: allTickets = [] } = useQuery<ZoneTicket[]>({
    queryKey: ['schedule-tickets'],
    queryFn: () => api.get('/tickets?status=open').then((r) => r.data),
  })

  const ticketMap = new Map(allTickets.map((t) => [t.id, t]))

  const grouped = zones.reduce<Record<string, Zone[]>>((acc, z) => {
    acc[z.crew_type] = [...(acc[z.crew_type] || []), z]
    return acc
  }, {})

  const totalTickets = zones.reduce((sum, z) => sum + z.ticket_ids.length, 0)
  const totalHours = zones.reduce((sum, z) => sum + (z.est_hours || 0), 0)

  const defaultCenter: [number, number] = zones.length > 0
    ? [zones[0].zone_lat, zones[0].zone_lng]
    : [37.35, -121.93]

  return (
    <div className="min-h-screen bg-slate-50">
      <AppNav activeRole="officer" />

      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Today's Schedule</h1>
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
              <p className="text-2xl font-bold text-slate-900">{zones.length}</p>
              <p className="text-xs text-slate-500">Zones</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{totalTickets}</p>
              <p className="text-xs text-slate-500">Tickets</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{totalHours.toFixed(1)}h</p>
              <p className="text-xs text-slate-500">Est. Hours</p>
            </div>
            </div>
          </div>
        </div>

        {isLoading && <p className="text-slate-500 text-sm">Loading schedule…</p>}
        {isError && <p className="text-rose-500 text-sm">Failed to load schedule.</p>}
        {!isLoading && !isError && zones.length === 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
            <p className="text-slate-500">No schedule built yet for today.</p>
            <p className="text-slate-400 text-sm mt-1">The scheduler runs every 30 minutes automatically.</p>
          </div>
        )}

        {zones.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Map */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden" style={{ height: 480 }}>
              <MapContainer center={defaultCenter} zoom={12} style={{ height: '100%', width: '100%' }}>
                <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                <FitBounds zones={zones} />
                {zones.map((zone) => (
                  <Marker
                    key={zone.id}
                    position={[zone.zone_lat, zone.zone_lng]}
                    icon={markerIcon}
                    eventHandlers={{ click: () => setSelected(zone) }}
                  >
                    <Popup>
                      <div className="text-sm">
                        <p className="font-semibold capitalize">{zone.crew_type} crew</p>
                        <p>{zone.ticket_ids.length} ticket(s) · {zone.est_hours?.toFixed(1)}h</p>
                        <button
                          className="mt-1 text-blue-600 underline text-xs"
                          onClick={() => setSelected(zone)}
                        >
                          View details
                        </button>
                      </div>
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>
            </div>

            {/* Zone list / detail */}
            <div className="space-y-4 overflow-y-auto" style={{ maxHeight: 480 }}>
              {selected ? (
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${CREW_COLORS[selected.crew_type] || CREW_COLORS.operations}`}>
                        {selected.crew_type}
                      </span>
                      <p className="text-xs text-slate-400 mt-1">
                        Zone center: {selected.zone_lat}, {selected.zone_lng}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-slate-700">{selected.ticket_ids.length} tickets</p>
                      <p className="text-xs text-slate-400">{selected.est_hours?.toFixed(1)}h estimated</p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {selected.ticket_ids.map((tid, i) => {
                      const t = ticketMap.get(tid)
                      return (
                        <div key={tid} className="flex items-start gap-3 p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                          <span className="text-xs text-slate-400 w-5 pt-0.5">{i + 1}.</span>
                          <div className="flex-1 min-w-0">
                            {t ? (
                              <>
                                <div className="flex items-center gap-2">
                                  <span className={`text-xs font-semibold ${urgencyColor(t.urgency_score)}`}>
                                    P{Math.round(t.urgency_score)}
                                  </span>
                                  <span className="text-sm text-slate-800 truncate">
                                    {t.subcategory_name || t.issue_type || 'Unknown'}
                                  </span>
                                </div>
                                <p className="text-xs text-slate-400 mt-0.5 truncate">{t.address || 'No address'}</p>
                                {t.assigned_to && (
                                  <p className="text-xs text-slate-400">Assigned: {t.assigned_to}</p>
                                )}
                              </>
                            ) : (
                              <p className="text-xs text-slate-400 font-mono">{tid}</p>
                            )}
                          </div>
                          <Link
                            to={`/officer/dashboard`}
                            className="text-xs text-blue-600 hover:underline whitespace-nowrap"
                          >
                            View →
                          </Link>
                        </div>
                      )
                    })}
                  </div>
                  <button
                    className="mt-3 text-xs text-slate-400 hover:text-slate-600"
                    onClick={() => setSelected(null)}
                  >
                    ← Back to all zones
                  </button>
                </div>
              ) : (
                Object.entries(grouped).map(([crewType, crewZones]) => (
                  <div key={crewType} className="bg-white rounded-xl border border-slate-200 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${CREW_COLORS[crewType] || CREW_COLORS.operations}`}>
                        {crewType} crew
                      </span>
                      <span className="text-xs text-slate-400">
                        {crewZones.reduce((s, z) => s + z.ticket_ids.length, 0)} tickets · {crewZones.reduce((s, z) => s + (z.est_hours || 0), 0).toFixed(1)}h
                      </span>
                    </div>
                    <div className="space-y-2">
                      {crewZones.map((zone) => (
                        <button
                          key={zone.id}
                          onClick={() => setSelected(zone)}
                          className="w-full text-left flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50 border border-slate-100 hover:bg-slate-100 transition-colors"
                        >
                          <span className="text-sm text-slate-700">
                            Zone ({zone.zone_lat}, {zone.zone_lng})
                          </span>
                          <span className="text-xs text-slate-400">
                            {zone.ticket_ids.length} ticket(s) · {zone.est_hours?.toFixed(1)}h →
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
