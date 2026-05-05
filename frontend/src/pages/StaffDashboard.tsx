import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import api from '../api/client'
import { Ticket, TicketDetailResponse } from '../api/types'
import AppNav from '../components/AppNav'

function formatDate(iso?: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function badge(label: string, classes: string) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${classes}`}>
      {label}
    </span>
  )
}

export default function StaffDashboard() {
  const [actionMessage, setActionMessage] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const officerName = (localStorage.getItem('officer_name') || '').trim()
  const officerEmail = (localStorage.getItem('officer_email') || '').trim()

  const { data: tickets = [], isLoading, isError } = useQuery<Ticket[]>({
    queryKey: ['staff-tickets'],
    queryFn: () => api.get('/tickets?status=open').then((r) => r.data),
    refetchInterval: 60_000,
  })

  const assigned = useMemo(
    () => tickets.filter((ticket) => ticket.assigned_at || ticket.assigned_to),
    [tickets]
  )

  const assignedToMe = useMemo(() => {
    if (!officerName && !officerEmail) return assigned
    const name = officerName.toLowerCase()
    const email = officerEmail.toLowerCase()
    return assigned.filter((ticket) => {
      const assignee = (ticket.assigned_to || '').toLowerCase()
      return assignee && (assignee === name || assignee === email)
    })
  }, [assigned, officerName, officerEmail])

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

  const visibleGroups = useMemo(
    () => groupedTickets.filter((group) => group.all.some((t) => assignedToMeIds.has(t.id))),
    [groupedTickets, assignedToMeIds]
  )

  const { data: detail, isLoading: detailLoading, isError: detailError } = useQuery<TicketDetailResponse>({
    queryKey: ['staff-ticket-detail', expandedId],
    queryFn: () => api.get(`/tickets/${expandedId}`).then((r) => r.data),
    enabled: Boolean(expandedId),
  })

  function handlePlaceholder(action: string, ticketId: string) {
    setActionMessage(`${action} pending for ticket ${ticketId.slice(0, 8)}… (workflow coming soon)`)
    setTimeout(() => setActionMessage(''), 4000)
  }

  function toggleDetails(ticketId: string) {
    setExpandedId((current) => (current === ticketId ? null : ticketId))
  }

  return (
    <div className="min-h-screen bg-grid">
      <AppNav activeRole="officer" />
      <div className="mx-auto max-w-6xl px-6 pb-10">
        <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Staff</p>
            <h1 className="font-display text-3xl sm:text-4xl text-slate-900 mt-3">
              Assigned tickets
            </h1>
            <p className="text-sm text-slate-500 mt-2">
              Tickets currently assigned to your team.
            </p>
          </div>
        </header>

        {actionMessage && (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {actionMessage}
          </div>
        )}

        <div className="mt-6 grid gap-4">
          {isLoading && (
            <div className="glass-card rounded-2xl p-6 text-sm text-slate-500">Loading tickets…</div>
          )}

          {isError && (
            <div className="glass-card rounded-2xl p-6 text-sm text-rose-600">
              Unable to load assigned tickets.
            </div>
          )}

          {!isLoading && !isError && visibleGroups.length === 0 && (
            <div className="glass-card rounded-2xl p-6 text-sm text-slate-500">
              No tickets are assigned to you yet.
            </div>
          )}

          {visibleGroups.map((group) => {
            const ticket = group.master as Ticket
            const duplicates = group.duplicates
            const showDetails = expandedId === ticket.id
            return (
            <div key={ticket.id} className="glass-card rounded-3xl p-6 shadow-lg">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Ticket</p>
                  <h3 className="text-lg font-semibold text-slate-900 mt-2">
                    {ticket.issue_type
                      ? ticket.issue_type.replace('_', ' ')
                      : ticket.subcategory_name || 'Unclassified report'}
                  </h3>
                  <p className="text-sm text-slate-500 mt-1">{ticket.address || 'Address unavailable'}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {ticket.needs_review && badge('Needs review', 'bg-amber-100 text-amber-800')}
                  {ticket.image_text_conflict && badge('Image/text conflict', 'bg-rose-100 text-rose-700')}
                  {duplicates.length > 0 && badge(`Cluster +${duplicates.length}`, 'bg-cyan-100 text-cyan-800')}
                </div>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2 text-sm text-slate-600">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Assigned to</p>
                  <p className="mt-1 text-slate-900 font-semibold">
                    {ticket.assigned_to || 'Unassigned'}
                  </p>
                  <p className="text-xs text-slate-400">{formatDate(ticket.assigned_at)}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Urgency</p>
                  <p className="mt-1 text-slate-900 font-semibold">
                    {ticket.urgency_score ?? '—'}
                  </p>
                  <p className="text-xs text-slate-400">Reported {formatDate(ticket.created_at)}</p>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
                <Link
                  to={`/track/${ticket.id}`}
                  className="text-cyan-700 font-semibold hover:text-cyan-800"
                >
                  View public tracker
                </Link>
                {duplicates.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span>Duplicates:</span>
                    {duplicates.map((dup) => (
                      <Link
                        key={dup.id}
                        to={`/track/${dup.id}`}
                        className="text-cyan-700 font-semibold hover:text-cyan-800"
                      >
                        {dup.id.slice(0, 8)}
                      </Link>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-5 flex flex-col sm:flex-row gap-3">
                <button
                  type="button"
                  onClick={() => toggleDetails(ticket.id)}
                  className="rounded-2xl border border-slate-200 text-slate-700 px-4 py-2 text-sm font-semibold hover:bg-slate-50 transition"
                >
                  {showDetails ? 'Hide details' : 'More details'}
                </button>
                <button
                  type="button"
                  onClick={() => handlePlaceholder('Approved', ticket.id)}
                  className="rounded-2xl bg-emerald-600 text-white px-4 py-2 text-sm font-semibold hover:bg-emerald-700 transition"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => handlePlaceholder('Rejected', ticket.id)}
                  className="rounded-2xl border border-rose-200 text-rose-700 px-4 py-2 text-sm font-semibold hover:bg-rose-50 transition"
                >
                  Reject
                </button>
              </div>

              {showDetails && (
                <div className="mt-5 border-t border-slate-200 pt-4 space-y-5 text-sm text-slate-700">
                  {detailLoading && (
                    <p className="text-slate-500">Loading ticket details…</p>
                  )}
                  {detailError && (
                    <p className="text-rose-600">Unable to load ticket details.</p>
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

                      {/* ── Submitted image ── */}
                      {detail.image_url && (
                        <div>
                          <p className="text-xs uppercase tracking-[0.2em] text-slate-500 mb-2">Submitted photo</p>
                          <div className="rounded-2xl overflow-hidden border border-slate-200">
                            <img src={detail.image_url} alt="Submitted issue" className="w-full max-h-72 object-cover" />
                          </div>
                        </div>
                      )}

                      {/* ── Report text (shown separately if no conflict callout consumed it) ── */}
                      {detail.text && !detail.image_text_conflict && (
                        <div>
                          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Report text</p>
                          <p className="mt-2 text-slate-700 whitespace-pre-wrap">{detail.text}</p>
                        </div>
                      )}

                      {/* ── AI reasoning ── */}
                      {detail.ai_reasoning && (
                        <div>
                          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">AI urgency reasoning</p>
                          <p className="mt-2 text-slate-600 leading-relaxed">{detail.ai_reasoning}</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
