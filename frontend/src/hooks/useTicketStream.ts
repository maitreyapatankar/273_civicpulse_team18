import { useEffect, useRef } from 'react'

export type TicketStreamEvent =
  | 'ticket_ready'
  | 'ticket_updated'
  | 'ticket_resolved'
  | 'ready'
  | 'ping'

export interface TicketStreamPayload {
  ticket_id?: string
  report_id?: string | null
  ok?: boolean
}

interface Options {
  /** Path on the API host, e.g. `/events/officer?token=...` or `/events/citizen/<id>` */
  path: string
  /** Called every time the server pushes a real event (skips `ready` + `ping`). */
  onEvent: (event: TicketStreamEvent, payload: TicketStreamPayload) => void
  /** Pass `false` to skip opening the stream (e.g. when the id is not ready yet). */
  enabled?: boolean
}

/**
 * Long-lived SSE subscription. Reconnects automatically on transient failure
 * because the browser's EventSource does that for free.
 */
export function useTicketStream({ path, onEvent, enabled = true }: Options) {
  const handlerRef = useRef(onEvent)
  handlerRef.current = onEvent

  useEffect(() => {
    if (!enabled) return

    const base = import.meta.env.VITE_API_BASE_URL ?? ''
    const url = `${base}${path}`
    const source = new EventSource(url)

    const dispatch = (eventName: TicketStreamEvent) => (raw: MessageEvent) => {
      try {
        const payload = raw.data ? JSON.parse(raw.data) : {}
        handlerRef.current(eventName, payload)
      } catch {
        handlerRef.current(eventName, {})
      }
    }

    source.addEventListener('ticket_ready', dispatch('ticket_ready'))
    source.addEventListener('ticket_updated', dispatch('ticket_updated'))
    source.addEventListener('ticket_resolved', dispatch('ticket_resolved'))

    return () => {
      source.close()
    }
  }, [path, enabled])
}
