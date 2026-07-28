// Pure, testable Recommended QC Date logic for the Client Opening Tracker.
// No component logic here.
//
// Rule (per Session 19A spec — opening-anchored, replaces Session 13's
// delivery-anchored version entirely):
//   - Base: 7 calendar days BEFORE the opening date.
//   - Gate: only computable once EVERY applicable hardware box (N/A boxes
//     excluded, per getBoxCells) has a real Delivered date. Partial delivery,
//     no opening date, or no applicable boxes -> null (render "—").
//   - Weekend shift: if it lands on Sat/Sun, move forward to the following
//     Monday (same forward convention Session 13 used, kept for app-wide
//     consistency).
//   - Floor #1 (compute-time only): never lands in the past. If the shifted
//     base is before today, clamp to the day after today.
//   - Floor #2: never lands before the Hardware Delivery Date. If the shifted
//     base is before it, clamp to the day after it.
//   - Both floors violated: clamp to the day after whichever floor is later.
//   - Re-apply the weekend shift to any clamped result.
//   The floors apply only at compute time — this is a pure derived-on-render
//   value (no persistence), so a previously-valid date that today has caught up
//   to naturally reads as overdue; the floors only prevent COMPUTING a fresh
//   backdated value, they never bump an already-valid date forward.
//
// Conflict vs Opening Date: if the recommended QC date falls within 7 days of
// opening (before or after — both are bad), flag it. 0–3 days = red (overdue),
// 4–6 days = amber (late), reusing the existing opening-date alert palette.
// The naive base sits exactly 7 days out and is intentionally NOT flagged; only
// a weekend shift or floor-clamp that pushes it inside the window triggers it.

import type { MrpRecord } from "@/lib/mrp";
import { getBoxCells, parseFlexDate, startOfDay } from "@/lib/tracker-mrp";
import type { OpeningDateTier } from "@/lib/opening-date-status";

// Sat (6) -> +2, Sun (0) -> +1 (forward to Monday). Returns a new Date.
function weekendShiftForward(d: Date): Date {
  const c = new Date(d);
  const day = c.getDay();
  if (day === 6) c.setDate(c.getDate() + 2);
  else if (day === 0) c.setDate(c.getDate() + 1);
  return c;
}

function dayAfter(d: Date): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + 1);
  return c;
}

export function computeRecommendedQcDate(
  record: MrpRecord | null,
  openingDate: string | null,
  today: Date = startOfDay(new Date())
): Date | null {
  if (!record) return null;

  const opening = parseFlexDate(openingDate);
  if (!opening) return null;

  // Gate: every applicable box must have a real Delivered date. Partial
  // delivery (or no applicable boxes) is not yet computable.
  const boxes = getBoxCells(record).filter((b) => b.applicable);
  if (boxes.length === 0) return null;
  if (!boxes.every((b) => parseFlexDate(b.delivered) !== null)) return null;

  // Base: 7 calendar days before opening, then weekend-shifted.
  const base = startOfDay(opening);
  base.setDate(base.getDate() - 7);
  let qc = weekendShiftForward(base);

  // Floors (evaluated against the shifted base). Clamp to the day after the
  // later of any violated floor.
  const hwd = parseFlexDate(record.hardwareDeliveryDate);
  let floor: Date | null = null;
  if (qc.getTime() < today.getTime()) floor = today;
  if (hwd) {
    const h = startOfDay(hwd);
    if (qc.getTime() < h.getTime() && (!floor || h.getTime() > floor.getTime())) {
      floor = h;
    }
  }

  if (floor) {
    // Clamp could itself land on a weekend — re-apply the shift.
    qc = weekendShiftForward(dayAfter(floor));
  }

  return qc;
}

export interface QcConflict {
  tier: Exclude<OpeningDateTier, null>; // "late" (amber) | "overdue" (red)
  daysFromOpening: number; // signed: negative = QC before opening, positive = after
  message: string;
}

// Returns null when there's no conflict (QC missing, opening missing, or the two
// are 7 or more days apart).
export function qcConflict(
  qcDate: Date | null,
  openingDate: string | null
): QcConflict | null {
  if (!qcDate) return null;
  const opening = parseFlexDate(openingDate);
  if (!opening) return null;

  const diff = Math.round(
    (startOfDay(qcDate).getTime() - startOfDay(opening).getTime()) / 86_400_000
  );
  const abs = Math.abs(diff);
  // Strictly INSIDE 7 days is a conflict; exactly 7 (the ideal opening-minus-7
  // target) is the safe boundary and is not flagged.
  if (abs >= 7) return null;

  const tier: Exclude<OpeningDateTier, null> = abs <= 3 ? "overdue" : "late";

  let message: string;
  if (diff === 0) {
    message = "QC lands on opening day — recommend rescheduling";
  } else if (diff > 0) {
    message = `QC ${abs} day${abs === 1 ? "" : "s"} after opening — recommend rescheduling`;
  } else {
    message = `QC ${abs} day${abs === 1 ? "" : "s"} before opening — recommend rescheduling`;
  }

  return { tier, daysFromOpening: diff, message };
}
