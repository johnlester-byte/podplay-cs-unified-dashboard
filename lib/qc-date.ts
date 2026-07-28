// Pure, testable Recommended QC Date logic for the Client Opening Tracker.
// No component logic here.
//
// Rule (per Session 19A spec — opening-anchored, replaces Session 13's
// delivery-anchored version entirely):
//   - Base: 7 calendar days BEFORE the opening date.
//   - Gate: only computable once EVERY applicable hardware box (N/A boxes
//     excluded, per getBoxCells) has a real Delivered date. Partial delivery,
//     no opening date, or no applicable boxes -> null (render "—").
//   - Weekend shift (base): the base sits BEFORE opening, so shift BACKWARD to
//     the preceding Friday (keeps the buffer, moves away from opening).
//   - Delivery floor: never lands before the LATEST actual box-Delivered date
//     (hardware must be on-site before QC). Keyed to the real per-box delivered
//     dates, NOT the planned `hardwareDeliveryDate` field. If the shifted base
//     is before it, clamp to the day after it, then shift that clamped date
//     FORWARD to Monday if it lands on a weekend (a clamped date sits on a
//     binding floor — shifting it backward would re-breach it).
//
//   DETERMINISTIC — NOT date-of-render dependent. The result is a pure function
//   of (opening date, latest box-delivered date, all-boxes-delivered gate). It does
//   NOT reference "today": once computable it stays put and only re-plots when
//   those inputs move — never because the current date advanced. Consequence: an
//   opening within ~7 days can yield a recommendation in the past, which simply
//   reads as overdue via qcConflict; it is intentionally NOT bumped forward.
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

// Sat (6) -> -1, Sun (0) -> -2 (backward to Friday). Returns a new Date.
function weekendShiftBackward(d: Date): Date {
  const c = new Date(d);
  const day = c.getDay();
  if (day === 6) c.setDate(c.getDate() - 1);
  else if (day === 0) c.setDate(c.getDate() - 2);
  return c;
}

function dayAfter(d: Date): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + 1);
  return c;
}

export function computeRecommendedQcDate(
  record: MrpRecord | null,
  openingDate: string | null
): Date | null {
  if (!record) return null;

  const opening = parseFlexDate(openingDate);
  if (!opening) return null;

  // Gate: every applicable box must have a real Delivered date. Partial
  // delivery (or no applicable boxes) is not yet computable.
  const boxes = getBoxCells(record).filter((b) => b.applicable);
  if (boxes.length === 0) return null;
  if (!boxes.every((b) => parseFlexDate(b.delivered) !== null)) return null;

  // Base: 7 calendar days before opening, weekend-shifted back to Friday.
  const base = startOfDay(opening);
  base.setDate(base.getDate() - 7);
  let qc = weekendShiftBackward(base);

  // Delivery floor: QC can never precede the LATEST actual box-Delivered date
  // (hardware must physically be on-site first). Keyed to the real delivered
  // dates — NOT the planned `hardwareDeliveryDate` field, which may be blank,
  // N/A, or earlier than the actual arrivals. The gate above guarantees every
  // applicable box has a delivered date, so this list is non-empty. Clamp to
  // the day after it, then shift that clamp FORWARD off any weekend (it sits on
  // a binding floor — a backward shift would re-breach it). No "today" floor:
  // the result is deterministic and must not drift as the current date moves.
  const latestDelivered = boxes
    .map((b) => parseFlexDate(b.delivered))
    .filter((d): d is Date => d !== null)
    .reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
  if (qc.getTime() < latestDelivered.getTime()) {
    qc = weekendShiftForward(dayAfter(latestDelivered));
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
