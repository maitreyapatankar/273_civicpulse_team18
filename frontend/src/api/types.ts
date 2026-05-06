// ── Domain literals ───────────────────────────────────────────────────────────

export type IssueType =
  | 'pothole'
  | 'flooding'
  | 'sinkhole'
  | 'crack'
  | 'sign_damage'
  | 'other'

export type ReportStatus =
  | 'queued'
  | 'processing'
  | 'open'
  | 'in_progress'
  | 'resolved'
  | 'failed'

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
  category_code:        string | null
  category_name:        string | null
  subcategory_code:     string | null
  subcategory_name:     string | null
  severity:             number | null     // 1–5
  urgency_score:        number | null     // 1.0–5.0
  urgency_factors:      UrgencyFactors | null
  ai_reasoning:         string | null
  confidence:           number | null     // 0.0–1.0; < 0.70 → needs review
  image_text_conflict:       boolean
  image_classification_hint: string | null
  needs_review:              boolean
  duplicate_of:         string | null
  cluster_count:        number
  work_order:           WorkOrder | null
  dispatcher_override:  boolean
  override_by:          string | null
  override_at:          string | null     // ISO 8601
  assigned_at:          string | null
  assigned_to:          string | null
  resolved_at:          string | null
  lifecycle_status:     'open' | 'approved' | 'forwarded_to_maintenance' | 'in_progress' | 'resolved' | 'failed' | null
  approved:             boolean
  lat:                  number | null
  lng:                  number | null
  address:              string | null
  created_at:           string
}

// ── API response shapes (match FastAPI schemas) ───────────────────────────────

export interface TicketStatusResponse {
  id:            string
  status:        ReportStatus
  issue_type:    IssueType | null
  category_code?: string | null
  category_name?: string | null
  subcategory_code?: string | null
  subcategory_name?: string | null
  urgency_score: number | null
  duplicate_of:  string | null
  cluster_count: number
  image_text_conflict?: boolean | null
  needs_review?: boolean | null
  assigned_to:   string | null
  assigned_at:   string | null
  resolved_at:   string | null
  created_at:    string
}

export interface ReportSubmitted {
  ticket_id: string
  status:    string
}

export interface TicketOverride {
  urgency_score?: number
  issue_type?:    IssueType | string
  notes?:         string
  comment?:       string
  is_public?:     boolean
  assign_to?:     string
  crew_id?:       string
  resolve?:       boolean
  approve?:       boolean
  reject?:        boolean
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
  assigned_to: string | null
  assigned_at: string | null
  resolved_at: string | null
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
  text?: string | null
  image_url?: string | null
  comments: TicketCommentResponse[]
}
