import { NextRequest, NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { shouldAllowPoll } from "@/lib/api-health";
import { type PipelineKey } from "@/lib/hubspot";
import { refreshPipelineSnapshot } from "@/lib/onboarding-deals";
import { getCombinedNextRefreshAllowedAt, runOnboardingSync } from "@/lib/onboarding-sync";
import { runTrackerImportSync } from "@/lib/tracker-sync";
import { runFieldSync } from "@/lib/tracker-field-sync";

export const dynamic = "force-dynamic";
// maxDuration is honored on paid Vercel plans; prod is now on Vercel Pro, so
// this 60s applies (was inert under the old Hobby 10s cap). The manual refresh
// is still kept lean by (a) rebuilding ONLY the viewed pipeline, (b) reusing the
// prior snapshot's enrichment so the HubSpot rebuild is a single search call
// (see refreshPipelineSnapshot), (c) running the HubSpot and MRP refreshes
// concurrently below rather than back-to-back, and (d) 17E — capping the import
// sweep and field-sync at a LOWER per-tick write budget than the hourly cron, so
// a single user click finishes in seconds, not near the ceiling, even under
// heavy backlog (the remainder drains on the next cron tick, both idempotent).
export const maxDuration = 60;

// Per-tick write budget for the MANUAL refresh path only. Bounded separately
// from the cron so an interactive user isn't left waiting on a huge batch.
//
// Session 20 — raised 10 -> 25 for Vercel Pro. The old 10 was sized to keep a
// click well under Hobby's hard 10s cap (17E); prod is now Pro (60s), so the
// interactive path gets real room while still taking a smaller bite than the
// cron so the browser user isn't waiting near a minute — the client abort
// (onboarding-grid.tsx) was widened to 30s to match. Worst case: ~25 import
// writes + ~25 field-sync writes, each 2 DB round trips, plus the single
// HubSpot search — comfortably inside 30s, far under the 60s ceiling.
const MANUAL_REFRESH_MAX_WRITES = 25;

// Stage timing: this route has accumulated sequential stages across 17A/17B/17D,
// and a platform timeout kills the function with NO response, so a silent slow
// refresh was previously undiagnosable. Log each stage's wall-clock (always, not
// just on error) so a future timeout regression is measurable in Vercel logs
// without redeploying instrumentation. Cheap: one console line per refresh.
function ms(start: number): number {
  return Math.round(performance.now() - start);
}

// POST — server-only. The Onboarding board's Refresh button calls this instead
// of hitting HubSpot directly, so one click refreshes both HubSpot and MRP,
// then re-runs the cross-check.
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  // Rebuild the currently-viewed pipeline's snapshot DIRECTLY (no server-to-
  // server loopback fetch to /api/hubspot/deals). refreshPipelineSnapshot reuses
  // the prior snapshot's enrichment, so this is one HubSpot search call.
  const pipelineParam = request.nextUrl.searchParams.get("pipeline");
  const pipelines: PipelineKey[] =
    pipelineParam === "basic" || pipelineParam === "pro" ? [pipelineParam] : ["basic", "pro"];

  // HubSpot rebuild and MRP refresh are independent — run them concurrently so
  // total wall-clock is max(hubspot, mrp), not their sum. Sequential execution
  // was part of what pushed Pro/Auto past the Hobby 10s cap.
  const t0 = performance.now();
  const hubspotTask = (async (): Promise<"ran" | "skipped" | "error"> => {
    try {
      if (!(await shouldAllowPoll("hubspot", "manual"))) return "skipped";
      await Promise.all(pipelines.map((p) => refreshPipelineSnapshot(p)));
      return "ran";
    } catch (err) {
      // Surface the real failure server-side so this class of bug is diagnosable
      // next time instead of a silent generic "error" outcome with no trace.
      console.error(
        `[onboarding-sync/refresh] HubSpot rebuild failed (pipelines=${pipelines.join(",")}):`,
        err
      );
      return "error";
    }
  })();

  const [hubspotOutcome, syncOutcome] = await Promise.all([hubspotTask, runOnboardingSync("manual")]);
  const snapshotMs = ms(t0);

  const actorEmail = data.user.email ?? "system@refresh";

  // Auto-import sweep (Session 15B) over the snapshots just rewritten above —
  // wired in here (17B) so clicking Refresh pulls a brand-new HubSpot onboarding
  // into the tracker, matching the hourly cron. Previously only the cron and the
  // per-record "Import Now" button created `locations` rows, so a CSA who
  // refreshed expecting a new record to appear got a silent no-op. Same function
  // the cron uses; it self-gates on shouldAllowAutoImport (hubspot / mrp_sheets)
  // and caps its writes at 25/tick, so it respects the same pause state and
  // Vercel Hobby duration budget. Runs BEFORE field-sync, matching cron order
  // (import/backfill, then last-write-wins over the fresh rows).
  //
  // 17E — import sweep and field-sync stay SEQUENTIAL (not Promise.all'd like the
  // HubSpot+MRP pair). They share mutable state: both read `locations` (SELECT *)
  // and both UPDATE it, and they overlap on the same fields (import Part B
  // backfills blank opening_date/delivery_date; field-sync also writes those).
  // Running them concurrently would (a) race UPDATEs on the same row+field and
  // (b) let field-sync's SELECT miss rows the import just inserted. Latency is
  // instead bounded by the lower per-tick write cap below, not by parallelizing.
  const tImport = performance.now();
  let importSync: {
    imported: number;
    importScanned: number;
    importCapped: boolean;
    importSkippedPaused: boolean;
  } | null = null;
  try {
    const r = await runTrackerImportSync(actorEmail, MANUAL_REFRESH_MAX_WRITES);
    importSync = {
      imported: r.imported,
      importScanned: r.importScanned,
      importCapped: r.importCapped,
      importSkippedPaused: r.importSkippedPaused,
    };
  } catch (err) {
    console.error("[onboarding-sync/refresh] tracker import sync failed:", err);
  }
  const importMs = ms(tImport);

  // Field-level last-write-wins sync (Session 15D) over the snapshots the two
  // tasks above just rewrote. Wired in here (17A) so a CSA clicking Refresh
  // pulls genuine HubSpot/MRP date changes into the tracker — previously this
  // only happened on the hourly cron, so a fresh HubSpot edit didn't reflect in
  // the tracker until the next tick. runFieldSync self-gates on
  // shouldAllowAutoImport (hubspot / mrp_sheets) and caps its own writes/tick,
  // so it respects the same pause state and Vercel duration budget as the cron.
  const tField = performance.now();
  let fieldSync: { overwritten: number; fieldsChanged: number } | null = null;
  try {
    const r = await runFieldSync(actorEmail, MANUAL_REFRESH_MAX_WRITES);
    fieldSync = { overwritten: r.overwritten, fieldsChanged: r.fieldsChanged };
  } catch (err) {
    console.error("[onboarding-sync/refresh] field sync failed:", err);
  }
  const fieldMs = ms(tField);

  const nextRefreshAllowedAt = await getCombinedNextRefreshAllowedAt();

  const totalMs = ms(t0);
  // Always log the stage breakdown (Hobby's 10s cap is the ceiling to watch).
  // console.warn so it isn't stripped as a stray debug log; one line per refresh.
  console.warn(
    `[onboarding-sync/refresh] timing ms: snapshot=${snapshotMs} import=${importMs} field=${fieldMs} total=${totalMs}` +
      ` (imported=${importSync?.imported ?? 0} synced=${fieldSync?.overwritten ?? 0})`
  );

  return NextResponse.json({
    hubspot: hubspotOutcome,
    mrp: syncOutcome.mrp,
    importSync,
    fieldSync,
    nextRefreshAllowedAt,
    timingMs: { snapshot: snapshotMs, import: importMs, field: fieldMs, total: totalMs },
  });
}
