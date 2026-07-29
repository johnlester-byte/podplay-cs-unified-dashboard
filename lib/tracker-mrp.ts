// Pure, client-safe helpers for wiring MRP hardware data into the Client Opening
// Tracker. NO server imports here (this file is imported by the client table) —
// the snapshot read + matching happens server-side in app/dashboard/clients/page.tsx
// via readSnapshot("mrp:records") + matchByCompanyName (see CONTEXT.md Data flow).
//
// The MRP sheet uses the literal string "N/A" (uppercase, confirmed live) for a
// hardware box that doesn't apply to a club, and M/D/YYYY for real dates.

import type { MrpRecord } from "@/lib/mrp";
import { OPENING_TIER_TEXT_CLASS, type OpeningDateTier } from "@/lib/opening-date-status";

export type BoxKind = "shipped" | "delivered";

// A cell is "not applicable" when it's empty or the sheet's literal "N/A".
export function isNa(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const t = value.trim();
  return t === "" || t.toLowerCase() === "n/a";
}

// Parse the tracker's date shapes into a local-midnight Date:
//   - MRP sheet dates are "M/D/YYYY"
//   - locations.* dates are ISO "YYYY-MM-DD"
// Returns null for empty / "N/A" / unparseable input.
export function parseFlexDate(value: string | null | undefined): Date | null {
  if (isNa(value)) return null;
  const t = (value as string).trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (us) {
    const d = new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const fallback = new Date(t);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

export interface BoxCell {
  index: number; // 1-based box number
  shipped: string | null;
  delivered: string | null;
  // Native cell hyperlink (e.g. UPS tracking) on the matching date cell, null
  // when that cell carries no link. Carried through from MrpRecord (Session 19B).
  shippedUrl: string | null;
  deliveredUrl: string | null;
  // A box "exists" for a club unless BOTH its shipped and delivered cells are N/A.
  applicable: boolean;
}

export function getBoxCells(record: MrpRecord | null): BoxCell[] {
  if (!record) return [];
  const raw = [
    {
      index: 1,
      shipped: record.ppHardwareBox1Shipped,
      delivered: record.ppHardwareBox1Delivered,
      shippedUrl: record.ppHardwareBox1ShippedUrl,
      deliveredUrl: record.ppHardwareBox1DeliveredUrl,
    },
    {
      index: 2,
      shipped: record.ppHardwareBox2Shipped,
      delivered: record.ppHardwareBox2Delivered,
      shippedUrl: record.ppHardwareBox2ShippedUrl,
      deliveredUrl: record.ppHardwareBox2DeliveredUrl,
    },
    {
      index: 3,
      shipped: record.ppHardwareBox3Shipped,
      delivered: record.ppHardwareBox3Delivered,
      shippedUrl: record.ppHardwareBox3ShippedUrl,
      deliveredUrl: record.ppHardwareBox3DeliveredUrl,
    },
  ];
  return raw.map((b) => ({
    ...b,
    applicable: !(isNa(b.shipped) && isNa(b.delivered)),
  }));
}

export interface BoxSummary {
  done: number; // boxes with a real date for this kind
  total: number; // applicable boxes (N/A boxes excluded from the denominator)
}

// "N/M" for a box group. total excludes boxes that are entirely N/A; done counts
// applicable boxes that have a real date in the requested column.
export function boxSummary(record: MrpRecord | null, kind: BoxKind): BoxSummary {
  const cells = getBoxCells(record).filter((b) => b.applicable);
  const done = cells.filter((b) => !isNa(kind === "shipped" ? b.shipped : b.delivered)).length;
  return { done, total: cells.length };
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / 86_400_000);
}

// Per-box SHIPPED tier (only for a box whose shipped cell is still empty),
// relative to the Hardware Delivery Date:
//   - delivery date already past           -> "overdue" (red)
//   - delivery date today or within 3 days  -> "late"    (amber)
//   - otherwise                              -> null
export function boxShippedTier(
  record: MrpRecord | null,
  boxIndex: number,
  today: Date = startOfDay(new Date())
): Exclude<OpeningDateTier, null> | null {
  if (!record) return null;
  const hwd = parseFlexDate(record.hardwareDeliveryDate);
  if (!hwd) return null;
  const box = getBoxCells(record).find((b) => b.index === boxIndex);
  if (!box || !box.applicable || !isNa(box.shipped)) return null;
  const daysUntil = daysBetween(today, hwd);
  if (daysUntil < 0) return "overdue";
  if (daysUntil <= 3) return "late";
  return null;
}

// Per-box DELIVERED tier, relative to the Hardware Delivery Date.
// Not yet delivered (blank):
//   - delivery date past   -> "overdue" (red)
//   - delivery date today  -> "late"    (amber)
//   - otherwise            -> null
// Delivered (has a date):
//   - delivered after the delivery date -> "upcoming" (blue, informational: late arrival)
//   - delivered on/before                -> "today"    (green, on time)
export function boxDeliveredTier(
  record: MrpRecord | null,
  boxIndex: number,
  today: Date = startOfDay(new Date())
): OpeningDateTier {
  if (!record) return null;
  const box = getBoxCells(record).find((b) => b.index === boxIndex);
  if (!box || !box.applicable) return null;
  const hwd = parseFlexDate(record.hardwareDeliveryDate);

  const deliveredDate = parseFlexDate(box.delivered);
  if (deliveredDate) {
    if (!hwd) return "today"; // delivered, nothing to compare against — treat as on time
    return daysBetween(hwd, deliveredDate) > 0 ? "upcoming" : "today";
  }

  // Not yet delivered.
  if (!hwd) return null;
  const daysUntil = daysBetween(today, hwd);
  if (daysUntil < 0) return "overdue";
  if (daysUntil === 0) return "late";
  return null;
}

const ALERT_RANK: Record<string, number> = { overdue: 2, late: 1 };

// Worst ALERT tier (amber/red only — blue/green ignored) across all applicable
// boxes for a group. Drives the compact summary color + Data Health cards.
export function boxGroupAlertTier(
  record: MrpRecord | null,
  kind: BoxKind,
  today: Date = startOfDay(new Date())
): "late" | "overdue" | null {
  if (!record) return null;
  let worst: "late" | "overdue" | null = null;
  for (const b of getBoxCells(record)) {
    if (!b.applicable) continue;
    const tier = kind === "shipped" ? boxShippedTier(record, b.index, today) : boxDeliveredTier(record, b.index, today);
    if (tier === "late" || tier === "overdue") {
      if (!worst || ALERT_RANK[tier] > ALERT_RANK[worst]) worst = tier;
    }
  }
  return worst;
}

// True when any applicable box in the group is "overdue" (red) — the "past
// delivery date" condition behind the Data Health cards.
export function boxGroupOverdue(
  record: MrpRecord | null,
  kind: BoxKind,
  today: Date = startOfDay(new Date())
): boolean {
  return boxGroupAlertTier(record, kind, today) === "overdue";
}

// The single Hardware Delivery Date shown in the tracker: MRP's value when a
// match exists, otherwise the manually-entered locations.delivery_date fallback.
export function resolveHardwareDeliveryDate(
  record: MrpRecord | null,
  manualDeliveryDate: string | null
): { value: string | null; source: "mrp" | "manual" | null } {
  if (record && !isNa(record.hardwareDeliveryDate)) {
    return { value: record.hardwareDeliveryDate, source: "mrp" };
  }
  if (manualDeliveryDate && !isNa(manualDeliveryDate)) {
    return { value: manualDeliveryDate, source: "manual" };
  }
  return { value: null, source: null };
}

export function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

export { OPENING_TIER_TEXT_CLASS };
