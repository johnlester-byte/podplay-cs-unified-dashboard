export type LocationStatus = "on-track" | "at-risk" | "delayed" | "opened" | "completed" | "archived";

// Why a location shut down. Stored in locations.close_reason; a location is
// considered "closed" once close_date is set.
export type CloseReason = "churned" | "relocated" | "contract-ended" | "temporary" | "other";

export const CLOSE_REASON_LABELS: Record<CloseReason, string> = {
  churned: "Churned",
  relocated: "Relocated",
  "contract-ended": "Contract ended",
  temporary: "Temporary closure",
  other: "Other",
};

export interface Location {
  id: string;
  client_name: string | null;
  name: string;
  tier: string | null;
  opening_date: string | null;
  presale_date: string | null;
  // 019 — true = confirmed "no pre-sale" (suppresses the missing-date alert);
  // false = not yet set (blank presale_date still alerts as missing).
  presale_date_na: boolean;
  delivery_date: string | null;
  tracker: string | null;
  status: LocationStatus;
  notes: string | null;
  pre_open_done: boolean;
  post_open_done: boolean;
  opened_date: string | null;
  open_outcome: string | null;
  qc_date: string | null;
  csa_owner: string | null;
  hubspot_deal_id: string | null;
  mrp_row_key: string | null;
  // Last HubSpot pipeline stage the status-sync acted on (022). Lets the sync
  // apply Completed/Archived only when the stage changes, preserving manual edits.
  hs_stage_seen: string | null;
  // Confirmed Grand Opening date (023), synced one-way from HubSpot's
  // grand_opening. null = no confirmed grand opening (opening_date is then the
  // anticipated date). Powers the reminders' grand-vs-anticipated logic.
  grand_opening_date: string | null;
}

// Closed Locations (020) — a standalone log of locations that shut down.
// Free-text client/location names (not linked to the tracker's `locations`),
// so a closure can be recorded for any site, tracked or not.
export interface ClosedLocation {
  id: string;
  client_name: string | null;
  location_name: string;
  close_date: string;
  close_reason: CloseReason | null;
  close_note: string | null;
  created_by: string | null;
  created_at: string;
  // Personal reminder (021). remind_at is the resolved UTC timestamp to fire on
  // (the form interprets the chosen date/time as US Eastern, America/New_York).
  remind_at: string | null;
  remind_user_email: string | null;
  reminder_done: boolean;
  reminder_slack_sent_at: string | null;
}

export type FieldSyncSource = "tracker" | "hubspot" | "mrp";

export interface LocationFieldSync {
  location_id: string;
  field_name: string;
  source: FieldSyncSource;
  source_updated_at: string;
  value: string | null;
  // Last value each external source reported for this field (015D/017). A source
  // "changed" the field only when its freshly-observed value differs from these
  // — per-field delta detection, so an unrelated HubSpot edit can't revert a
  // tracker value via a stale object-level timestamp.
  hubspot_seen_value: string | null;
  mrp_seen_value: string | null;
  updated_at: string;
}

export type ActivityAction = "created" | "updated" | "deleted" | "opened";

export interface ActivityLogEntry {
  id: number;
  created_at: string;
  user_email: string | null;
  action: ActivityAction;
  entity: string | null;
  details: string | null;
}

export interface Readiness {
  location_id: string;
  token: string;
  pct: number;
  updated_at: string;
  submitted_at: string | null;
}

export type ProfileRole = "default" | "admin";

export interface Profile {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: ProfileRole;
  created_by: string | null;
  created_at: string;
  last_active_at: string | null;
}

export type ApiIntegrationStatus = "active" | "unresponsive" | "broken" | "down" | "not_configured" | "access_pending";

export interface ApiIntegration {
  id: string;
  label: string;
  status: ApiIntegrationStatus;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error_message: string | null;
  requests_used_today: number;
  requests_used_date: string;
  requests_limit_per_day: number | null;
  auto_poll_interval_minutes: number;
  auto_poll_paused: boolean;
  auto_import_paused: boolean;
  manual_refresh_paused: boolean;
  paused_all: boolean;
  next_refresh_allowed_at: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

export interface OpsCategory {
  id: string;
  name: string;
  display_order: number;
  color: string | null;
  created_at: string;
}

export interface OpsArticle {
  id: string;
  title: string;
  category: string;
  content: string;
  tags: string[];
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  published: boolean;
}

export type OpsArticleStub = Omit<OpsArticle, "content">;

export interface OpsArticleChecklistState {
  user_id: string;
  article_id: string;
  checked_indexes: number[];
  updated_at: string;
}

export interface OpsArticleFavorite {
  user_id: string;
  article_id: string;
  created_at: string;
}

export interface OpsArticleView {
  id: number;
  user_id: string;
  article_id: string;
  viewed_at: string;
}

export interface Database {
  public: {
    Tables: {
      locations: {
        Row: Location;
        Insert: Partial<Location> & { id: string; name: string };
        Update: Partial<Location>;
        Relationships: [];
      };
      activity_log: {
        Row: ActivityLogEntry;
        Insert: Partial<ActivityLogEntry>;
        Update: Partial<ActivityLogEntry>;
        Relationships: [];
      };
      location_field_sync: {
        Row: LocationFieldSync;
        Insert: Partial<LocationFieldSync> & { location_id: string; field_name: string; source: FieldSyncSource; source_updated_at: string };
        Update: Partial<LocationFieldSync>;
        Relationships: [];
      };
      closed_locations: {
        Row: ClosedLocation;
        Insert: Partial<ClosedLocation> & { location_name: string; close_date: string };
        Update: Partial<ClosedLocation>;
        Relationships: [];
      };
      readiness: {
        Row: Readiness;
        Insert: Partial<Readiness> & { location_id: string; token: string };
        Update: Partial<Readiness>;
        Relationships: [];
      };
      profiles: {
        Row: Profile;
        Insert: Partial<Profile> & { id: string; email: string; first_name: string; last_name: string };
        Update: Partial<Profile>;
        Relationships: [];
      };
      api_integrations: {
        Row: ApiIntegration;
        Insert: Partial<ApiIntegration> & { id: string; label: string };
        Update: Partial<ApiIntegration>;
        Relationships: [];
      };
      ops_articles: {
        Row: OpsArticle;
        Insert: Partial<OpsArticle> & { title: string; category: string; content: string };
        Update: Partial<OpsArticle>;
        Relationships: [];
      };
      ops_categories: {
        Row: OpsCategory;
        Insert: Partial<OpsCategory> & { name: string };
        Update: Partial<OpsCategory>;
        Relationships: [];
      };
      ops_article_checklist_state: {
        Row: OpsArticleChecklistState;
        Insert: Partial<OpsArticleChecklistState> & { user_id: string; article_id: string };
        Update: Partial<OpsArticleChecklistState>;
        Relationships: [];
      };
      ops_article_favorites: {
        Row: OpsArticleFavorite;
        Insert: Partial<OpsArticleFavorite> & { user_id: string; article_id: string };
        Update: Partial<OpsArticleFavorite>;
        Relationships: [];
      };
      ops_article_views: {
        Row: OpsArticleView;
        Insert: Partial<OpsArticleView> & { user_id: string; article_id: string };
        Update: Partial<OpsArticleView>;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
}
