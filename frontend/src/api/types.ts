// ── Domain literals ───────────────────────────────────────────────────────────

export type IssueType =
  | 'pothole'
  | 'flooding'
  | 'sinkhole'
  | 'crack'
  | 'sign_damage'
  | 'other'

export type ReportStatus = 'queued' | 'processing' | 'done' | 'failed'

// ── JSONB sub-shapes ──────────────────────────────────────────────────────────

export interface UrgencyFactors {
  safety_risk:     number   // 0–1
  traffic_impact:  number
  cluster_volume:  number
  days_unresolved: number
}

export interface WorkOrder {
  crew_type:          string
  materials:          string[]
  est_hours:          number
  notes:              string
  dispatcher_notes?:  string   // appended by PATCH /tickets/:id
}

// ── raw_reports table ─────────────────────────────────────────────────────────

export interface RawReport {
  id:             string
  source:         string          // 'app' | 'csv' | 'api'
  text:           string | null
  image_url:      string | null
  lat:            number
  lng:            number
  address:        string | null
  reporter_phone: string | null
  submitted_at:   string          // ISO 8601
  status:         ReportStatus
}

// ── tickets table ─────────────────────────────────────────────────────────────

export interface Ticket {
  id:                   string
  raw_report_id:        string | null
  issue_type:           IssueType | null
  severity:             number | null     // 1–5
  urgency_score:        number | null     // 1.0–5.0
  urgency_factors:      UrgencyFactors | null
  ai_reasoning:         string | null
  confidence:           number | null     // 0.0–1.0; < 0.70 → needs review
  duplicate_of:         string | null
  cluster_count:        number
  work_order:           WorkOrder | null
  dispatcher_override:  boolean
  override_by:          string | null
  override_at:          string | null     // ISO 8601
  resolved_at:          string | null
  created_at:           string
}

// ── API response shapes (match FastAPI schemas) ───────────────────────────────

export interface TicketStatusResponse {
  id:            string
  status:        ReportStatus
  issue_type:    IssueType | null
  urgency_score: number | null
  duplicate_of:  string | null
  cluster_count: number
  created_at:    string
}

export interface ReportSubmitted {
  ticket_id: string
  status:    string
}

export interface TicketOverride {
  urgency_score?: number
  issue_type?:    IssueType
  notes?:         string
  comment?:       string
  is_public?:     boolean
}

export interface CitizenAuthResponse {
  access_token: string
  token_type: 'bearer'
  role: 'citizen'
  citizen_id: string
  email: string
  name: string
}

export interface OfficerAuthResponse {
  access_token: string
  token_type: 'bearer'
  role: 'officer' | 'admin'
  officer_id: string | null
  email: string | null
  name: string | null
}

export interface DepartmentUpdate {
  id: string
  message: string
  created_at: string
}

export interface CitizenTicketSummary {
  report_id: string
  ticket_id: string | null
  status: ReportStatus
  issue_type: IssueType | null
  urgency_score: number | null
  address: string | null
  created_at: string
  updated_at: string
}

export interface CitizenTicketDetail {
  report_id: string
  ticket_id: string | null
  status: ReportStatus
  text: string | null
  image_url: string | null
  address: string | null
  lat: number
  lng: number
  issue_type: IssueType | null
  urgency_score: number | null
  department_updates: DepartmentUpdate[]
}

export interface TicketCommentResponse {
  id: string
  author_type: 'citizen' | 'officer'
  author_id: string | null
  message: string
  is_public: boolean
  created_at: string
}

export interface TicketDetailResponse extends Ticket {
  comments: TicketCommentResponse[]
}
