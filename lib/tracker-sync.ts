// Session 15B — hourly auto-import + MRP backfill (server-only).
//
// Two steps, both run on the existing cron heartbeat (app/api/cron/refresh),
// reading ONLY the DB snapshot cache (CONTEXT.md Data flow) — never a live
// HubSpot/Sheets fetch:
//
//   PART A  HubSpot -> tracker auto-import. Every onboarding with no matching
//           `locations` row (ID-match on hubspot_deal_id first, name-match
//           fallback) is inserted, reusing the shared Track Opening mapping.
//   PART B  MRP -> tracker backfill. Every `locations` row with an mrp_row_key
//           (from 15A) gets its BLANK date fields filled from the matched MRP
//           row. An already-populated field is left untouched — 15D owns the
//           ongoing overwrite/conflict logic.
//
// Each half is gated by shouldAllowAutoImport() — a dedicated auto-import pause
// (api_integrations.auto_import_paused), independent of the board's polling
// pause. Idempotent: a row that already
// exists / a field that's already filled is skipped, so re-running is a no-op.

import { createAdminClient } from "@/lib/supabase/admin";
import { readSnapshot } from "@/lib/snapshot";
import { shouldAllowAutoImport } from "@/lib/api-health";
import { matchNames, type MrpRecord } from "@/lib/mrp";
import { parseFlexDate, isNa } from "@/lib/tracker-mrp";
import { mapOnboardingToLocation, deriveImportStatus } from "@/lib/track-opening-map";
import type { HubspotOwner } from "@/lib/hubspot";
import type { Location } from "@/lib/types";
import type { PipelineDeals } from "@/lib/onboarding-deals";
import type { OnboardingListItem } from "@/components/onboarding/onboarding-types";

// Cap writes per tick so a large backlog can't blow the function timeout.
// Remaining rows are picked up on the next heartbeat (idempotent).
//
// Session 20 — raised 25 -> 75 for Vercel Pro. The old 25 was sized against
// Hobby's hard 10s cap (17E); prod is now on Pro (60s default via maxDuration).
// This is the DEFAULT, used by the lightweight sync-only cron (/api/cron/sync,
// :30 — no snapshot rebuild, ~3.5s base) which has ample headroom for 75 writes
// under 60s. Two paths deliberately DON'T use this default:
//   - the heavy /api/cron/refresh (:00) passes an explicit lower cap because it
//     first rebuilds four external snapshots (~48s) and can't afford a big sync
//     bite on top (see that route);
//   - the manual refresh (17E) passes MANUAL_REFRESH_MAX_WRITES so an
//     interactive user isn't left waiting — see refresh route.
const MAX_IMPORTS_PER_TICK = 75;

export interface TrackerSyncResult {
  importScanned: number;
  imported: number;
  trackerFilled: number; // existing linked rows whose blank tracker was set from the owner
  statusSynced: number; // existing rows whose HubSpot stage changed (status may be updated)
  importCapped: boolean;
  importSkippedPaused: boolean;
  backfillScanned: number;
  backfilled: number; // rows that had >=1 field filled
  backfillSkippedPaused: boolean;
}

async function readOnboardingDeals(): Promise<OnboardingListItem[]> {
  const [basic, pro] = await Promise.all([
    readSnapshot<PipelineDeals>("onboarding:basic"),
    readSnapshot<PipelineDeals>("onboarding:pro"),
  ]);
  return [...(basic?.data.deals ?? []), ...(pro?.data.deals ?? [])];
}

// Team roster resolver: HubSpot owner -> tracker name. The tracker only ever
// holds people who exist on the team (profiles), so an onboarding owned by
// someone not on the team resolves to null (blank tracker), per the Session 15B
// follow-up. Built once, reused by the sweep and the single-record import.
async function buildTrackerResolver(
  admin: ReturnType<typeof createAdminClient>
): Promise<(deal: OnboardingListItem) => string | null> {
  const { data: profData } = await admin.from("profiles").select("email, first_name");
  const profiles = (profData ?? []) as unknown as { email: string; first_name: string }[];
  const emailToName = new Map(profiles.map((p) => [p.email.toLowerCase(), p.first_name]));
  const ownersSnap = await readSnapshot<HubspotOwner[]>("hubspot:owners");
  const ownerById = new Map((ownersSnap?.data ?? []).map((o) => [o.id, o]));
  return (deal) => {
    const ownerId = deal.properties.hubspot_owner_id;
    if (!ownerId) return null;
    const owner = ownerById.get(ownerId);
    if (!owner?.email) return null;
    return emailToName.get(owner.email.toLowerCase()) ?? null; // not on team -> blank
  };
}

// Existing-row lookup: ID match on hubspot_deal_id first (15A's durable link is
// authoritative), name-match fallback only for rows not yet linked.
function findExistingLocation(deal: OnboardingListItem, locations: Location[]): Location | null | undefined {
  return (
    (deal.id ? locations.find((l) => l.hubspot_deal_id === deal.id) : undefined) ??
    matchNames(deal.properties.hs_name ?? "", locations, (l) => l.name)
  );
}

// The canonical insert payload for an auto-imported onboarding — shared so the
// sweep and the single-record "Import Now" build identical rows.
function buildImportPayload(deal: OnboardingListItem, trackerName: string | null) {
  const m = mapOnboardingToLocation(deal);
  const status = deriveImportStatus(deal);
  return {
    id: m.id,
    client_name: m.client_name,
    name: m.name,
    tier: m.tier || null,
    opening_date: m.opening_date,
    // A completed onboarding gets an opened_date so it doesn't render dateless.
    opened_date: status === "completed" ? m.opening_date : null,
    tracker: trackerName,
    status,
    notes: null,
    hubspot_deal_id: deal.id,
    // Seed the stage we imported at, so the ongoing sync only re-acts on a change.
    hs_stage_seen: deal.properties.hs_pipeline_stage ?? null,
    pre_open_done: false,
    post_open_done: false,
  };
}

export type ImportOnboardingResult =
  | { status: "imported"; locationId: string }
  | { status: "exists" }
  | { status: "not_found" }
  | { status: "error" };

// Single-record import used by the "Import Now" button (Session 15C). Runs the
// SAME mapping/insert/logging path as the cron sweep for exactly one onboarding,
// so a CSA can pull a record in immediately instead of waiting for the next
// hourly tick. Not gated by shouldAllowPoll — the UI only surfaces this button
// when auto-import is ON; a paused integration shows the manual dialog instead.
export async function importOnboardingById(
  dealId: string,
  actorEmail: string
): Promise<ImportOnboardingResult> {
  const admin = createAdminClient();

  const [deals, { data: locData, error }] = await Promise.all([
    readOnboardingDeals(),
    admin.from("locations").select("*"),
  ]);
  if (error) return { status: "error" };
  const locations = (locData ?? []) as unknown as Location[];

  const deal = deals.find((d) => d.id === dealId);
  if (!deal) return { status: "not_found" };

  if (findExistingLocation(deal, locations)) return { status: "exists" };
  if (!(deal.properties.hs_name ?? "").trim()) return { status: "error" };

  const resolveTracker = await buildTrackerResolver(admin);
  const payload = buildImportPayload(deal, resolveTracker(deal));

  const { error: insErr } = await admin.from("locations").insert(payload as never);
  if (insErr) {
    // Unique-index violation (a racing cron tick / concurrent click already
    // inserted the row) surfaces here — treat as already-tracked, not a failure.
    return { status: "exists" };
  }

  await admin.from("activity_log").insert({
    user_email: actorEmail,
    action: "created",
    entity: payload.name,
    details: `Imported from HubSpot (deal ${deal.id})`,
  } as never);

  return { status: "imported", locationId: payload.id };
}

// MRP "M/D/YYYY" (or ISO) -> date-only ISO "YYYY-MM-DD"; null for empty/N/A.
function toIsoFromFlex(value: string | null | undefined): string | null {
  const d = parseFlexDate(value);
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function runTrackerImportSync(
  actorEmail: string,
  maxImports: number = MAX_IMPORTS_PER_TICK
): Promise<TrackerSyncResult> {
  const admin = createAdminClient();

  const result: TrackerSyncResult = {
    importScanned: 0,
    imported: 0,
    trackerFilled: 0,
    statusSynced: 0,
    importCapped: false,
    importSkippedPaused: false,
    backfillScanned: 0,
    backfilled: 0,
    backfillSkippedPaused: false,
  };

  const [{ data: locData, error }, trackerForDeal] = await Promise.all([
    admin.from("locations").select("*"),
    buildTrackerResolver(admin),
  ]);
  if (error) throw new Error(error.message);
  let locations = (locData ?? []) as unknown as Location[];

  // ---- PART A: HubSpot -> tracker auto-import -------------------------------
  const allowHubspot = await shouldAllowAutoImport("hubspot");
  if (!allowHubspot) {
    result.importSkippedPaused = true;
  } else {
    const deals = await readOnboardingDeals();
    result.importScanned = deals.length;

    const inserted: Location[] = [];
    for (const deal of deals) {
      // Combined write budget (inserts + tracker fills + status syncs) so a large
      // backlog can't blow the function timeout. Remainder drains on the next
      // tick (idempotent). Cap re-tuned for Vercel Pro in Session 20 — see
      // MAX_IMPORTS_PER_TICK.
      if (result.imported + result.trackerFilled + result.statusSynced >= maxImports) {
        result.importCapped = true;
        break;
      }

      const trackerName = trackerForDeal(deal);

      const existing = findExistingLocation(deal, locations);

      if (existing) {
        // Ongoing HubSpot stage -> status sync. Only act when the stage has
        // CHANGED since we last saw it (hs_stage_seen), so a manual status edit
        // made between stage changes is preserved (manual override wins). Only
        // the terminal buckets are auto-applied — Completed and Archived — so an
        // active-tab manual status (on-track/at-risk/delayed) is never clobbered.
        const stageId = deal.properties.hs_pipeline_stage ?? "";
        if (stageId && existing.hs_stage_seen !== stageId) {
          const derived = deriveImportStatus(deal); // archived | completed | on-track
          const upd: Record<string, string> = { hs_stage_seen: stageId };
          const applyStatus = (derived === "completed" || derived === "archived") && existing.status !== derived;
          if (applyStatus) upd.status = derived;

          const { error: e } = await admin.from("locations").update(upd as never).eq("id", existing.id);
          if (!e) {
            existing.hs_stage_seen = stageId;
            result.statusSynced++;
            if (applyStatus) {
              existing.status = derived;
              await admin.from("activity_log").insert({
                user_email: actorEmail,
                action: "updated",
                entity: existing.name,
                details: `Status set to "${derived}" from HubSpot stage change`,
              } as never);
            }
          }
        }

        // Row already tracked — only backfill a BLANK tracker from the owner.
        if (trackerName && !existing.tracker) {
          const { error: e } = await admin
            .from("locations")
            .update({ tracker: trackerName } as never)
            .eq("id", existing.id);
          if (!e) {
            existing.tracker = trackerName;
            result.trackerFilled++;
            await admin.from("activity_log").insert({
              user_email: actorEmail,
              action: "updated",
              entity: existing.name,
              details: `Set tracking from HubSpot owner: ${trackerName}`,
            } as never);
          }
        }
        continue;
      }

      if (!(deal.properties.hs_name ?? "").trim()) continue; // no name -> can't map

      const payload = buildImportPayload(deal, trackerName);

      const { error: insErr } = await admin.from("locations").insert(payload as never);
      if (insErr) {
        // A slug collision means the row effectively already exists — skip, don't
        // abort the whole sweep.
        continue;
      }

      await admin.from("activity_log").insert({
        user_email: actorEmail,
        action: "created",
        entity: payload.name,
        details: `Auto-imported from HubSpot (deal ${deal.id})`,
      } as never);

      inserted.push({ ...(payload as unknown as Location) });
      result.imported++;
    }

    // Fold new rows into the working set so Part B can backfill them too if they
    // ever gain an mrp_row_key (they won't this tick — kept for correctness).
    if (inserted.length) locations = [...locations, ...inserted];
  }

  // ---- PART B: MRP -> tracker backfill (blanks only) ------------------------
  const allowMrp = await shouldAllowAutoImport("mrp_sheets");
  if (!allowMrp) {
    result.backfillSkippedPaused = true;
    return result;
  }

  const mrpSnap = await readSnapshot<MrpRecord[]>("mrp:records");
  const mrpRecords = mrpSnap?.data ?? [];
  const byClub = new Map(mrpRecords.map((r) => [r.club, r]));

  for (const loc of locations) {
    if (!loc.mrp_row_key) continue;
    result.backfillScanned++;
    const rec = byClub.get(loc.mrp_row_key);
    if (!rec) continue;

    // MRP-sourced tracker fields (only what the sheet genuinely provides).
    const candidates: { field: keyof Location; value: string | null }[] = [
      { field: "delivery_date", value: toIsoFromFlex(rec.hardwareDeliveryDate) },
      { field: "opening_date", value: toIsoFromFlex(rec.grandOpening ?? rec.softOpening) },
    ];

    const update: Record<string, string> = {};
    const logged: string[] = [];
    for (const c of candidates) {
      // Fill only when the tracker field is BLANK and MRP has a real value.
      if (c.value && isNa(loc[c.field] as string | null)) {
        update[c.field] = c.value;
        logged.push(`${c.field}=${c.value}`);
      }
    }

    if (Object.keys(update).length === 0) continue;

    const { error: upErr } = await admin
      .from("locations")
      .update(update as never)
      .eq("id", loc.id);
    if (upErr) continue;

    await admin.from("activity_log").insert({
      user_email: actorEmail,
      action: "updated",
      entity: loc.name,
      details: `Backfilled from MRP: ${logged.join(", ")}`,
    } as never);
    result.backfilled++;
  }

  return result;
}
