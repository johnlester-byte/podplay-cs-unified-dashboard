// Pure, client-safe per-row flag + issue computation for the Client Opening
// Tracker. Centralized so the table, detail sheet and stat cards agree on what
// counts as a problem. No server imports.

import type { Location } from "@/lib/types";
import type { MrpRecord } from "@/lib/mrp";
import { getOpeningDateTier, type OpeningDateTier } from "@/lib/opening-date-status";
import { parseTracker } from "@/lib/client-hub";
import {
  boxGroupAlertTier,
  parseFlexDate,
  resolveHardwareDeliveryDate,
  startOfDay,
} from "@/lib/tracker-mrp";
import { computeRecommendedQcDate, qcConflict, type QcConflict } from "@/lib/qc-date";

export interface RowFlags {
  missingOpening: boolean;
  missingPresale: boolean;
  missingHardware: boolean;
  noTracking: boolean;
  hardwareRequired: boolean;
  shippedAlert: "late" | "overdue" | null;
  deliveredAlert: "late" | "overdue" | null;
  shippedOverdue: boolean;
  deliveredOverdue: boolean;
  qc: QcConflict | null;
  recommendedQcDate: Date | null;
  manualQcDate: Date | null;
  effectiveQcDate: Date | null;
  qcSource: "manual" | "recommended" | null;
  openingTier: OpeningDateTier;
  hardware: { value: string | null; source: "mrp" | "manual" | null };
  issues: string[];
  // Any amber/red-level signal worth surfacing in the row highlight.
  needsAttention: boolean;
}

export function computeRowFlags(
  location: Location,
  mrp: MrpRecord | null,
  today: Date = startOfDay(new Date())
): RowFlags {
  const completed = location.status === "opened";
  // Basic (+) clubs don't ship the full hardware kit — hardware dates aren't
  // required there, so an empty hardware delivery is NOT flagged. Hardware alerts
  // only apply once a date is actually pulled from MRP or entered manually.
  const isBasic = (location.tier ?? "").toLowerCase().startsWith("basic");
  const hardwareRequired = !isBasic;
  const hardware = resolveHardwareDeliveryDate(mrp, location.delivery_date);

  const recommendedQcDate = computeRecommendedQcDate(mrp, location.opening_date);
  const manualQcDate = parseFlexDate(location.qc_date);
  const effectiveQcDate = manualQcDate ?? recommendedQcDate;
  const qcSource: RowFlags["qcSource"] = manualQcDate
    ? "manual"
    : recommendedQcDate
      ? "recommended"
      : null;

  const shippedAlert = completed ? null : boxGroupAlertTier(mrp, "shipped", today);
  const deliveredAlert = completed ? null : boxGroupAlertTier(mrp, "delivered", today);

  const flags: RowFlags = {
    missingOpening: !completed && !location.opening_date,
    // Confirmed-N/A presale (019) is intentional, not missing — don't flag it.
    missingPresale: !completed && !location.presale_date && !location.presale_date_na,
    missingHardware: !completed && hardwareRequired && hardware.value === null,
    noTracking: parseTracker(location.tracker).length === 0,
    hardwareRequired,
    shippedAlert,
    deliveredAlert,
    shippedOverdue: shippedAlert === "overdue",
    deliveredOverdue: deliveredAlert === "overdue",
    qc: completed ? null : qcConflict(effectiveQcDate, location.opening_date),
    recommendedQcDate,
    manualQcDate,
    effectiveQcDate,
    qcSource,
    openingTier: completed ? null : getOpeningDateTier(location.opening_date, completed),
    hardware,
    issues: [],
    needsAttention: false,
  };

  flags.issues = buildIssues(flags);
  flags.needsAttention = flags.issues.length > 0;
  return flags;
}

function buildIssues(f: RowFlags): string[] {
  const out: string[] = [];
  if (f.missingOpening) out.push("Missing opening date");
  if (f.missingPresale) out.push("Missing pre-sale date");
  if (f.missingHardware) out.push("Missing hardware delivery date");
  if (f.noTracking) out.push("No one tracking");
  if (f.openingTier === "overdue") out.push("Opening date is overdue");
  else if (f.openingTier === "late") out.push("Opening date has just passed");

  if (f.shippedAlert === "overdue") out.push("Hardware not yet shipped, past delivery date");
  else if (f.shippedAlert === "late") out.push("Hardware not yet shipped, nearing delivery date");

  if (f.deliveredAlert === "overdue") out.push("Hardware not yet delivered, past delivery date");
  else if (f.deliveredAlert === "late") out.push("Hardware not yet delivered, delivery date is today");

  if (f.qc) out.push(f.qc.message);
  return out;
}
