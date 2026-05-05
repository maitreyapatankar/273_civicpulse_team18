import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet'
import L from 'leaflet'
import { Link, useNavigate, useParams } from 'react-router-dom'
import api, { extractErrorMessage } from '../api/client'
import { ReportSubmitted } from '../api/types'
import AppNav from '../components/AppNav'

interface StatusResponse {
  id: string
  status: 'queued' | 'processing' | 'open' | 'in_progress' | 'resolved' | 'failed'
  issue_type: string | null
  urgency_score: number | null
  duplicate_of: string | null
  cluster_count: number
  assigned_to: string | null
  assigned_at: string | null
  resolved_at: string | null
  created_at: string
}

interface ReceiptSnapshot {
  title: string
  details: string
  address: string
  lat: string
  lng: string
  phone: string
}

const TERMINAL = new Set(['resolved', 'failed'])
// F6: max image size the server will accept without a 413 / 502 from S3
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10 MB

function formatDate(iso?: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

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
  const { ticketId } = useParams<{ ticketId: string }>()
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState('')
  const [address, setAddress] = useState('')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [phone, setPhone] = useState('')
  const [image, setImage] = useState<File | null>(null)
  const [imageError, setImageError] = useState('')       // F6
  const [mapTileError, setMapTileError] = useState(false) // F9
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [submitResult, setSubmitResult] = useState<ReportSubmitted | null>(null)
  const [addressLoading, setAddressLoading] = useState(false)
  const [addressError, setAddressError] = useState('')
  const [searchingAddress, setSearchingAddress] = useState(false)
  const [addressResolved, setAddressResolved] = useState(false)
  const [mapCenter, setMapCenter] = useState<[number, number]>([37.3387, -121.8853])
  const [locating, setLocating] = useState(true)

  const parsedLat = Number(lat)
  const parsedLng = Number(lng)
  const markerPosition: [number, number] | null =
    Number.isFinite(parsedLat) && Number.isFinite(parsedLng)
      ? [parsedLat, parsedLng]
      : null

  // F7: warn when the user tries to leave with an unsaved form
  const formIsDirty = Boolean(title || details || address || image)
  useEffect(() => {
    if (!formIsDirty || ticketId) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [formIsDirty, ticketId])

  const { data: ticketStatus, isLoading, isError } = useQuery<StatusResponse>({
    queryKey: ['ticket-status', ticketId],
    queryFn: () => api.get(`/tickets/${ticketId}/status`).then((r) => r.data),
    refetchInterval: (query) =>
      TERMINAL.has(query.state.data?.status ?? '') ? false : 60_000,
    enabled: Boolean(ticketId),
  })

  // F42: discard receipts older than 7 days so stale localStorage entries don't accumulate
  const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000
  const receipt = useMemo<ReceiptSnapshot | null>(() => {
    if (!ticketId) return null
    try {
      const raw = localStorage.getItem(`report_receipt_${ticketId}`)
      if (!raw) return null
      const parsed = JSON.parse(raw) as ReceiptSnapshot & { savedAt?: number }
      if (parsed.savedAt && Date.now() - parsed.savedAt > RECEIPT_TTL_MS) {
        localStorage.removeItem(`report_receipt_${ticketId}`)
        return null
      }
      return { title: parsed.title, details: parsed.details, address: parsed.address, lat: parsed.lat, lng: parsed.lng, phone: parsed.phone }
    } catch {
      return null
    }
  }, [ticketId])

  useEffect(() => {
    if (!navigator.geolocation) { setLocating(false); return }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setMapCenter([pos.coords.latitude, pos.coords.longitude])
        setLocating(false)
      },
      () => setLocating(false),
      { timeout: 6000 },
    )
  }, [])

  // F6: validate image before storing it
  function handleImageChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    setImageError('')
    if (!file) { setImage(null); return }
    if (!file.type.startsWith('image/')) {
      setImageError('Only image files are supported (JPEG, PNG, WebP, etc.).')
      e.target.value = ''
      setImage(null)
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError(`Photo must be under 10 MB. Yours is ${(file.size / 1024 / 1024).toFixed(1)} MB.`)
      e.target.value = ''
      setImage(null)
      return
    }
    setImage(file)
  }

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
      // F10: handle rate limiting from Nominatim
      if (response.status === 429) {
        setAddressError('Address lookup is temporarily rate-limited. Wait a moment and try again.')
        setAddressLoading(false)
        return
      }
      if (!response.ok) throw new Error('reverse geocode failed')
      const data = await response.json()
      if (data?.display_name) {
        setAddress(data.display_name)
        setAddressResolved(true)
      } else {
        setAddressResolved(false)
      }
    } catch {
      setAddressResolved(false)
      setAddressError('Unable to fetch address for this location.')
    } finally {
      setAddressLoading(false)
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitError('')
    setSubmitResult(null)

    if (!addressResolved || !lat || !lng) {
      setSubmitError('Please search and confirm a valid address before submitting.')
      return
    }

    // F8: phone format validation
    if (phone && !/^\+?[\d\s\-()\[\]]{7,20}$/.test(phone.trim())) {
      setSubmitError('Enter a valid phone number (e.g. +1 202 555 0114).')
      return
    }

    if (imageError) return

    setSubmitting(true)

    const formData = new FormData()
    formData.append('text', `${title}\n\n${details}`)
    formData.append('lat', lat)
    formData.append('lng', lng)
    formData.append('address', address)
    if (phone) formData.append('reporter_phone', phone.trim())
    formData.append('source', 'app')
    if (image) formData.append('image', image)

    // F12: track navigation so we don't call setSubmitting on an unmounted component
    let navigating = false
    try {
      const { data } = await api.post<ReportSubmitted>('/reports', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 60_000, // image uploads need more time than the 20s default
      })
      setSubmitResult(data)
      localStorage.setItem(
        `report_receipt_${data.ticket_id}`,
        JSON.stringify({ title, details, address, lat, lng, phone, savedAt: Date.now() })
      )
      navigating = true
      navigate(`/report/${data.ticket_id}`, { replace: true })
    } catch (error) {
      // F5: use the centralised extractor for meaningful error messages
      setSubmitError(
        extractErrorMessage(error, 'We could not submit your complaint. Please try again.')
      )
    } finally {
      // F12: skip state update if we already navigated away
      if (!navigating) setSubmitting(false)
    }
  }

  async function handleAddressSearch() {
    if (!address.trim()) {
      setAddressError('Enter an address or postcode to search.')
      return
    }
    setSearchingAddress(true)
    setAddressError('')
    setAddressResolved(false)
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(address)}`,
        { headers: { Accept: 'application/json' } }
      )
      // F10: handle Nominatim rate limiting (1 req/s limit)
      if (response.status === 429) {
        setAddressError('Too many search requests. Wait a moment and try again.')
        return
      }
      if (!response.ok) throw new Error('search failed')
      const results = await response.json()
      if (Array.isArray(results) && results[0]) {
        const foundLat = Number(results[0].lat)
        const foundLng = Number(results[0].lon)
        if (Number.isFinite(foundLat) && Number.isFinite(foundLng)) {
          setLat(foundLat.toFixed(6))
          setLng(foundLng.toFixed(6))
          setMapCenter([foundLat, foundLng])
          if (results[0].display_name) setAddress(results[0].display_name)
          setAddressResolved(true)
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

  // ── Confirmation view (post-submit) ──────────────────────────────────────────
  if (ticketId) {
    return (
      <div className="min-h-screen bg-grid">
        <AppNav activeRole="public" />
        <div className="mx-auto max-w-3xl px-6 pb-10">
          <header className="flex flex-col gap-4 text-center mt-6">
            <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Report submitted</p>
            <h1 className="font-display text-3xl sm:text-4xl text-slate-900">
              Your complaint is in the system.
            </h1>
            <p className="text-sm text-slate-500">
              Save this ticket ID to track status updates.
            </p>
            <p className="text-xs text-slate-500 font-mono break-all">{ticketId}</p>
          </header>

          <div className="mt-8 glass-card rounded-3xl p-6 shadow-xl space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Status</p>
                {isLoading && <p className="text-sm text-slate-400 mt-1 animate-pulse">Checking…</p>}
                {/* F11: status poll failure ≠ submission failure — use neutral wording */}
                {isError && (
                  <p className="text-sm text-slate-500 mt-1">
                    Status temporarily unavailable.
                  </p>
                )}
                {ticketStatus && (
                  <p className="text-sm font-semibold text-slate-900 mt-1 capitalize">
                    {ticketStatus.status.replace('_', ' ')}
                  </p>
                )}
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Submitted</p>
                <p className="text-sm text-slate-700 mt-1">
                  {formatDate(ticketStatus?.created_at)}
                </p>
              </div>
            </div>

            {receipt && (
              <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Issue</p>
                  <p className="text-sm text-slate-900 font-semibold mt-1">{receipt.title}</p>
                  <p className="text-sm text-slate-600 mt-1">{receipt.details}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Address</p>
                  <p className="text-sm text-slate-700 mt-1">{receipt.address}</p>
                </div>
              </div>
            )}

            {!receipt && (
              <p className="text-sm text-slate-500">
                Ticket details are stored on your device after submission. If you cleared
                storage, use the tracker link below.
              </p>
            )}

            <div className="flex flex-col sm:flex-row gap-3">
              <Link
                to={`/track/${ticketId}`}
                className="rounded-2xl bg-slate-900 text-white px-4 py-2.5 text-xs font-semibold hover:bg-slate-800 transition text-center"
              >
                Track this ticket
              </Link>
              <Link
                to="/report"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition text-center"
              >
                Submit another report
              </Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Report form ──────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-grid">
      <AppNav activeRole="public" />
      <div className="mx-auto max-w-5xl px-6 pb-10">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Anonymous report</p>
            <h1 className="font-display text-3xl sm:text-4xl text-slate-900 mt-3">
              Submit a complaint without an account.
            </h1>
          </div>
        </header>

        <div className="mt-8">
          <form onSubmit={handleSubmit} className="glass-card rounded-3xl p-6 shadow-xl">
            <h2 className="text-xl font-semibold text-slate-900">Report an issue</h2>
            <p className="text-sm text-slate-500 mt-1">
              Address and issue details are required. Photo is optional (max 10 MB).
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
                  <label className="text-xs uppercase tracking-[0.2em] text-slate-500">Address (required)</label>
                  <input
                    type="text"
                    required
                    value={address}
                    onChange={(e) => {
                      setAddress(e.target.value)
                      setAddressResolved(false)
                      setLat('')
                      setLng('')
                    }}
                    placeholder="Street or landmark"
                    className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                  <button
                    type="button"
                    onClick={handleAddressSearch}
                    disabled={searchingAddress}
                    className="mt-2 text-xs font-semibold text-cyan-700 hover:text-cyan-800 disabled:opacity-60"
                  >
                    {searchingAddress ? 'Searching…' : 'Search address'}
                  </button>
                  {addressResolved && (
                    <p className="text-xs text-emerald-600 mt-2">Address confirmed.</p>
                  )}
                </div>

                {/* F6: accept="image/*" restricts picker to images; onChange validates type + size */}
                <div>
                  <label className="text-xs uppercase tracking-[0.2em] text-slate-500">Photo (optional, max 10 MB)</label>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageChange}
                    className="mt-2 w-full rounded-2xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500"
                  />
                  {imageError && (
                    <p className="mt-1 text-xs text-rose-600">{imageError}</p>
                  )}
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs uppercase tracking-[0.2em] text-slate-500">Latitude</label>
                  <input
                    type="text"
                    readOnly
                    required
                    value={lat}
                    placeholder="Auto-filled"
                    className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-500 bg-slate-50"
                  />
                </div>
                <div>
                  <label className="text-xs uppercase tracking-[0.2em] text-slate-500">Longitude</label>
                  <input
                    type="text"
                    readOnly
                    required
                    value={lng}
                    placeholder="Auto-filled"
                    className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-500 bg-slate-50"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs uppercase tracking-[0.2em] text-slate-500">
                  Pick on map{locating ? ' — locating you…' : ''}
                </label>
                {/* F9: relative wrapper so we can layer a tile-error overlay */}
                <div className="mt-2 h-48 rounded-2xl overflow-hidden border border-slate-200 relative">
                  <MapContainer
                    center={mapCenter}
                    zoom={12}
                    style={{ height: '100%', width: '100%' }}
                    scrollWheelZoom={false}
                  >
                    <TileLayer
                      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                      attribution='&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors'
                      eventHandlers={{
                        tileerror: () => setMapTileError(true),
                        load:      () => setMapTileError(false),
                      }}
                    />
                    <MapRecenter center={mapCenter} />
                    <LocationPicker onPick={handleMapPick} />
                    {markerPosition && <Marker position={markerPosition} />}
                  </MapContainer>
                  {/* F9: overlay when tile server is unreachable */}
                  {mapTileError && (
                    <div className="absolute inset-0 flex items-center justify-center bg-slate-100/80 z-[1000] text-xs text-slate-600 text-center px-4">
                      Map tiles unavailable. You can still click to set coordinates, or search an address above.
                    </div>
                  )}
                </div>
                <div className="mt-2 text-xs text-slate-500 space-y-0.5">
                  <p>Click the map to auto-fill latitude and longitude.</p>
                  {/* F13: Nominatim attribution (required by their usage policy) */}
                  <p>Address search powered by <a href="https://nominatim.openstreetmap.org" target="_blank" rel="noreferrer" className="underline">Nominatim</a> / © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">OpenStreetMap</a> contributors.</p>
                  {addressLoading && <p className="text-cyan-700">Resolving address…</p>}
                  {addressError && <p className="text-rose-600">{addressError}</p>}
                </div>
              </div>

              <div>
                {/* F8: tel input with format hint */}
                <label className="text-xs uppercase tracking-[0.2em] text-slate-500">Phone (optional — for SMS updates)</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 202 555 0114"
                  className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                />
                <p className="mt-1 text-xs text-slate-400">Include country code, e.g. +1 for US.</p>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting || Boolean(imageError)}
              className="mt-6 w-full rounded-2xl bg-slate-900 text-white py-3 text-sm font-semibold hover:bg-slate-800 transition disabled:opacity-60"
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
        </div>
      </div>
    </div>
  )
}
