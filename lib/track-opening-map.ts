// Shared field-mapping from a HubSpot onboarding record to a tracker `locations`
// row. Used by BOTH the manual Track Opening dialog (track-opening-dialog.tsx)
// and the hourly auto-import (lib/tracker-sync.ts, Session 15B) so the mapping
// lives in exactly one place. Pure — safe to import from client or server.

import { tierToTrackerTier, getPipelineById, getEffectiveOpeningDate } from "@/lib/hubspot";
import type { LocationStatus } from "@/lib/types";
import type { OnboardingListItem } from "@/components/onboarding/onboarding-types";

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "location"
  );
}

// HubSpot dates arrive as ISO/epoch strings; the tracker stores date-only ISO.
export function toIsoDate(value: string | null | undefined): string {
  if (!value) return "";
  return value.slice(0, 10);
}

export interface MappedOnboarding {
  id: string;
  client_name: string | null;
  name: string;
  tier: string;
  opening_date: string | null;
}

// HubSpot onboarding stage -> tracker status mapping. Used both on auto-import
// and by the ongoing stage-change sync (lib/tracker-sync.ts):
//   "MIA/No Response" stage -> "archived"
//   closed/"Completed" stage -> "completed"
//   anything else            -> "on-track"
// "Opened" (club went live) is a manual status the team sets — it is NOT derived
// from HubSpot. The manual Track Opening dialog always uses "on-track".
export function deriveImportStatus(deal: OnboardingListItem): LocationStatus {
  const pipeline = deal.properties.hs_pipeline ? getPipelineById(deal.properties.hs_pipeline) : undefined;
  const stage = pipeline?.stages.find((s) => s.id === deal.properties.hs_pipeline_stage);
  if (!stage) return "on-track";
  if (stage.label === "MIA/No Response") return "archived";
  if (stage.isClosed) return "completed";
  return "on-track";
}

// The canonical HubSpot -> tracker field mapping:
//   client_name  <- company name
//   name         <- onboarding name (hs_name)
//   tier         <- podplay_tier (normalized to the tracker's two tier labels)
//   opening_date <- grand_opening, falling back to anticipated_opening
export function mapOnboardingToLocation(deal: OnboardingListItem): MappedOnboarding {
  const name = deal.properties.hs_name ?? "";
  return {
    id: slugify(name),
    client_name: deal.company?.name ?? null,
    name,
    tier: tierToTrackerTier(deal.properties.podplay_tier),
    opening_date: toIsoDate(getEffectiveOpeningDate(deal.properties)) || null,
  };
}
