import { FormEvent, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet'
import L from 'leaflet'
import { Link, useNavigate, useParams } from 'react-router-dom'
import api from '../api/client'
import { CitizenTicketDetail, CitizenTicketSummary, ReportSubmitted } from '../api/types'
import AppNav from '../components/AppNav'
import { useTicketStream } from '../hooks/useTicketStream'

delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

function LocationPicker({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click: (event) => {
      onPick(event.latlng.lat, event.latlng.lng)
    },
  })
  return null
}

function MapRecenter({ center }: { center: [number, number] }) {
  const map = useMap()
  useEffect(() => {
    map.setView(center, map.getZoom())
  }, [center, map])
  return null
}

export default function CitizenDashboard() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { ticketId } = useParams<{ ticketId: string }>()
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState('')
  const [address, setAddress] = useState('')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [phone, setPhone] = useState('')
  const [image, setImage] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [submitResult, setSubmitResult] = useState<ReportSubmitted | null>(null)
  const [addressLoading, setAddressLoading] = useState(false)
  const [addressError, setAddressError] = useState('')
  const [searchingAddress, setSearchingAddress] = useState(false)
  const [selectedTicketId, setSelectedTicketId] = useState('')
  const [editMode, setEditMode] = useState(false)
  const [editNotes, setEditNotes] = useState('')
  const [editMessage, setEditMessage] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState('')
  const [mapCenter, setMapCenter] = useState<[number, number]>([37.3387, -121.8853])

  const { data: tickets = [], isLoading: ticketsLoading } = useQuery<CitizenTicketSummary[]>({
    queryKey: ['citizen-tickets'],
    queryFn: () => api.get('/citizens/tickets').then((r) => r.data),
  })

  const { data: ticketDetail } = useQuery<CitizenTicketDetail>({
    queryKey: ['citizen-ticket', selectedTicketId],
    queryFn: () => api.get(`/citizens/tickets/${selectedTicketId}`).then((r) => r.data),
    enabled: Boolean(selectedTicketId),
  })

  const selectedTicket = useMemo(
    () => tickets.find((ticket) => ticket.report_id === selectedTicketId) ?? null,
    [selectedTicketId, tickets]
  )

  const parsedLat = Number(lat)
  const parsedLng = Number(lng)
  const markerPosition =
    Number.isFinite(parsedLat) && Number.isFinite(parsedLng)
      ? [parsedLat, parsedLng]
      : null

  useEffect(() => {
    if (ticketId) {
      setSelectedTicketId(ticketId)
    }
  }, [ticketId])

  useTicketStream({
    path: `/events/citizen/${selectedTicketId}`,
    enabled: Boolean(selectedTicketId),
    onEvent: () => {
      queryClient.invalidateQueries({ queryKey: ['citizen-tickets'] })
      queryClient.invalidateQueries({ queryKey: ['citizen-ticket', selectedTicketId] })
    },
  })

  useEffect(() => {
    if (markerPosition) {
      setMapCenter(markerPosition)
    }
  }, [markerPosition])

  async function handleMapPick(pickedLat: number, pickedLng: number) {
    setLat(pickedLat.toFixed(6))
    setLng(pickedLng.toFixed(6))
    setMapCenter([pickedLat, pickedLng])
    setAddressError('')
    setAddressLoading(true)

    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${pickedLat}&lon=${pickedLng}`,
        { headers: { Accept: 'application/json' } }
      )
      if (!response.ok) {
        throw new Error('reverse geocode failed')
      }
      const data = await response.json()
      if (data?.display_name) {
        setAddress(data.display_name)
      }
    } catch {
      setAddressError('Unable to fetch address for this location.')
    } finally {
      setAddressLoading(false)
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setSubmitError('')
    setSubmitResult(null)

    const formData = new FormData()
    formData.append('text', `${title}\n\n${details}`)
    formData.append('lat', lat)
    formData.append('lng', lng)
    if (address) formData.append('address', address)
    if (phone) formData.append('reporter_phone', phone)
    formData.append('source', 'app')
    if (image) formData.append('image', image)

    try {
      const { data } = await api.post<ReportSubmitted>('/reports', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setSubmitResult(data)
      setSelectedTicketId(data.ticket_id)
      setTitle('')
      setDetails('')
      setAddress('')
      setLat('')
      setLng('')
      setPhone('')
      setImage(null)
      navigate(`/citizen/tickets/${data.ticket_id}`, { replace: true })
    } catch {
      setSubmitError('We could not submit your complaint. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleAddressSearch() {
    if (!address.trim()) {
      setAddressError('Enter an address or postcode to search.')
      return
    }
    setSearchingAddress(true)
    setAddressError('')
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(address)}`,
        { headers: { Accept: 'application/json' } }
      )
      if (!response.ok) {
        throw new Error('search failed')
      }
      const results = await response.json()
      if (Array.isArray(results) && results[0]) {
        const foundLat = Number(results[0].lat)
        const foundLng = Number(results[0].lon)
        if (Number.isFinite(foundLat) && Number.isFinite(foundLng)) {
          setLat(foundLat.toFixed(6))
          setLng(foundLng.toFixed(6))
          setMapCenter([foundLat, foundLng])
        }
      } else {
        setAddressError('No results found for that address.')
      }
    } catch {
      setAddressError('Unable to find that address. Please try again.')
    } finally {
      setSearchingAddress(false)
    }
  }

  async function handleEditSave() {
    if (!selectedTicketId) return
    setEditSaving(true)
    setEditError('')
    setEditMessage('')

    const formData = new FormData()
    if (editNotes.trim()) {
      formData.append('text', editNotes.trim())
    }
    if (lat) formData.append('lat', lat)
    if (lng) formData.append('lng', lng)
    if (address) formData.append('address', address)

    if (!Array.from(formData.keys()).length) {
      setEditError('Add at least one change before saving.')
      setEditSaving(false)
      return
    }

    try {
      const { data } = await api.patch(`/reports/${selectedTicketId}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setEditMessage('Update submitted. We are reprocessing your report.')
      setEditMode(false)
      setSelectedTicketId(data.ticket_id)
    } catch {
      setEditError('Could not update the report. Please try again.')
    } finally {
      setEditSaving(false)
      setTimeout(() => setEditMessage(''), 4000)
    }
  }

  return (
    <div className="min-h-screen bg-grid">
      <AppNav activeRole="citizen" />
      <div className="mx-auto max-w-6xl px-6 pb-10">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Citizen dashboard</p>
            <h1 className="font-display text-3xl sm:text-4xl text-slate-900 mt-3">
              Report, track, and stay informed.
            </h1>
          </div>
        </header>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <form onSubmit={handleSubmit} className="glass-card rounded-3xl p-6 shadow-xl">
            <h2 className="text-xl font-semibold text-slate-900">Submit a new complaint</h2>
            <p className="text-sm text-slate-500 mt-1">
              Describe the issue and we will route it to the right crew.
            </p>

            <div className="mt-6 space-y-4">
              <div>
                <label className="text-xs uppercase tracking-[0.2em] text-slate-500">Issue Title</label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Deep pothole near the intersection"
                  className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                />
              </div>
              <div>
                <label className="text-xs uppercase tracking-[0.2em] text-slate-500">Details</label>
                <textarea
                  rows={4}
                  required
                  value={details}
                  onChange={(e) => setDetails(e.target.value)}
                  placeholder="Share details that help dispatchers prioritize."
                  className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                />
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs uppercase tracking-[0.2em] text-slate-500">Location</label>
                  <input
                    type="text"
                    required
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Street or landmark"
                    className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                  <button
                    type="button"
                    onClick={handleAddressSearch}
                    disabled={searchingAddress}
                    className="mt-2 text-xs font-semibold text-cyan-700 hover:text-cyan-800 disabled:opacity-60"
                  >
                    {searchingAddress ? 'Searching…' : 'Find on map'}
                  </button>
                </div>
                <div>
                  <label className="text-xs uppercase tracking-[0.2em] text-slate-500">Photo (optional)</label>
                  <input
                    type="file"
                    onChange={(e) => setImage(e.target.files?.[0] ?? null)}
                    className="mt-2 w-full rounded-2xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500"
                  />
                </div>
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs uppercase tracking-[0.2em] text-slate-500">Latitude</label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={lat}
                    onChange={(e) => setLat(e.target.value)}
                    placeholder="37.7749"
                    className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                </div>
                <div>
                  <label className="text-xs uppercase tracking-[0.2em] text-slate-500">Longitude</label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={lng}
                    onChange={(e) => setLng(e.target.value)}
                    placeholder="-122.4194"
                    className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs uppercase tracking-[0.2em] text-slate-500">Pick on map</label>
                <div className="mt-2 h-48 rounded-2xl overflow-hidden border border-slate-200">
                  <MapContainer
                    center={mapCenter}
                    zoom={12}
                    style={{ height: '100%', width: '100%' }}
                    scrollWheelZoom={false}
                  >
                    <TileLayer
                      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                      attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    />
                    <MapRecenter center={mapCenter} />
                    <LocationPicker
                      onPick={handleMapPick}
                    />
                    {markerPosition && (
                      <Marker position={markerPosition} />
                    )}
                  </MapContainer>
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  <p>Click the map to auto-fill latitude and longitude.</p>
                  {addressLoading && <p className="text-cyan-700">Resolving address…</p>}
                  {addressError && <p className="text-rose-600">{addressError}</p>}
                </div>
              </div>
              <div>
                <label className="text-xs uppercase tracking-[0.2em] text-slate-500">Phone (optional)</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 202 555 0114"
                  className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="mt-6 w-full rounded-2xl bg-slate-900 text-white py-3 text-sm font-semibold hover:bg-slate-800 transition"
            >
              {submitting ? 'Submitting…' : 'Submit complaint'}
            </button>

            {submitError && (
              <p className="mt-4 text-sm text-rose-600 font-semibold">
                {submitError}
              </p>
            )}
            {submitResult && (
              <div className="mt-4 rounded-2xl border border-cyan-100 bg-cyan-50 px-4 py-3 text-sm text-cyan-800">
                Complaint submitted. Opening ticket details…
              </div>
            )}
          </form>

          <div className="glass-card rounded-3xl p-6 shadow-xl">
            <h2 className="text-xl font-semibold text-slate-900">Your current tickets</h2>
            <p className="text-sm text-slate-500 mt-1">
              Synced with your latest reports.
            </p>

            <div className="mt-6 space-y-4">
              {ticketsLoading && (
                <p className="text-sm text-slate-500">Loading tickets…</p>
              )}
              {!ticketsLoading && tickets.length === 0 && (
                <p className="text-sm text-slate-500">No tickets yet.</p>
              )}
              {tickets.map((ticket) => (
                <div
                  key={ticket.report_id}
                  className={`rounded-2xl border px-4 py-3 cursor-pointer transition ${
                    selectedTicketId === ticket.report_id
                      ? 'border-cyan-300 bg-cyan-50'
                      : 'border-slate-200 bg-white hover:bg-slate-50'
                  }`}
                  onClick={() => setSelectedTicketId(ticket.report_id)}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-900">
                      {ticket.issue_type ? ticket.issue_type.replace('_', ' ') : 'New report'}
                    </p>
                    <span className="text-xs text-slate-500">
                      {ticket.report_id.slice(0, 8)}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                    <span>{ticket.status}</span>
                    <span>Updated {new Date(ticket.updated_at).toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {selectedTicket && ticketDetail && (
          <div className="mt-6 glass-card rounded-3xl p-6 shadow-xl">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Ticket details</p>
                <h3 className="text-xl font-semibold text-slate-900 mt-2">
                  {selectedTicket.issue_type
                    ? selectedTicket.issue_type.replace('_', ' ')
                    : 'New report'}
                </h3>
                <p className="text-sm text-slate-500 mt-1">{ticketDetail.address}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center rounded-full bg-slate-900 text-white px-3 py-1 text-xs font-semibold">
                  {ticketDetail.status}
                </span>
                <button
                  type="button"
                  onClick={() => setEditMode((prev) => !prev)}
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  {editMode ? 'Close edit' : 'Edit report'}
                </button>
              </div>
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
              <div>
                {editMode ? (
                  <div className="space-y-3">
                    <label className="text-xs uppercase tracking-[0.2em] text-slate-500">
                      Notes
                    </label>
                    <textarea
                      rows={4}
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      placeholder="Describe updates to your report"
                      className="w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    />
                    {editError && (
                      <p className="text-xs text-rose-600">{editError}</p>
                    )}
                    <button
                      type="button"
                      onClick={handleEditSave}
                      disabled={editSaving}
                      className="rounded-2xl bg-slate-900 text-white px-4 py-2 text-sm font-semibold hover:bg-slate-800 disabled:opacity-60"
                    >
                      {editSaving ? 'Saving…' : 'Save changes'}
                    </button>
                    {editMessage && (
                      <p className="text-xs text-slate-500">{editMessage}</p>
                    )}
                  </div>
                ) : (
                  ticketDetail.text && (
                    <p className="text-sm text-slate-700 leading-relaxed">
                      {ticketDetail.text}
                    </p>
                  )
                )}
                {ticketDetail.image_url && (
                  <div className="mt-4 rounded-2xl overflow-hidden border border-slate-200">
                    <img
                      src={ticketDetail.image_url}
                      alt="Submitted issue"
                      className="w-full h-48 object-cover"
                    />
                  </div>
                )}
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Department updates</p>
                {ticketDetail.department_updates.length === 0 ? (
                  <p className="text-sm text-slate-500 mt-3">No updates yet.</p>
                ) : (
                  <ul className="mt-3 space-y-2 text-sm text-slate-600">
                    {ticketDetail.department_updates.map((update) => (
                      <li key={update.id} className="flex gap-2">
                        <span className="mt-2 h-1.5 w-1.5 rounded-full bg-cyan-600" />
                        <span>{update.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-slate-400 mt-4">
                  Updated {new Date(selectedTicket.updated_at).toLocaleString()}
                </p>
                {ticketDetail.ticket_id && (
                  <Link
                    to={`/track/${ticketDetail.ticket_id}`}
                    className="mt-3 inline-flex text-xs font-semibold text-cyan-700 hover:text-cyan-800"
                  >
                    View public tracker
                  </Link>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
