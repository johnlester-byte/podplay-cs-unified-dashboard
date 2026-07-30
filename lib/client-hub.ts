import type { Location, LocationStatus } from "@/lib/types";
import { parseDateOnly } from "@/lib/date-only";

export const STATUS_LABEL: Record<LocationStatus, string> = {
  "on-track": "On Track",
  "at-risk": "At Risk",
  delayed: "Delayed",
  opened: "Opened",
  completed: "Completed",
  archived: "Archived",
};

export const STATUS_BADGE_VARIANT: Record<
  LocationStatus,
  "default" | "amber" | "destructive" | "blue" | "green" | "secondary"
> = {
  "on-track": "default",
  "at-risk": "amber",
  delayed: "destructive",
  opened: "blue",
  completed: "green",
  archived: "secondary",
};

export function isFollowUpOverdue(location: Location): boolean {
  // Only active openings can be follow-up overdue — opened/completed/archived are done.
  if (location.status !== "on-track" && location.status !== "at-risk" && location.status !== "delayed") return false;
  if (!location.opening_date) return false;
  const opening = parseDateOnly(location.opening_date);
  if (!opening) return false;
  const today = new Date();
  opening.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  const isPastOpening = opening.getTime() < today.getTime();
  return isPastOpening && (!location.pre_open_done || !location.post_open_done);
}

// This calendar week, Monday–Sunday (not a rolling 7-day window).
export function isOpeningThisWeek(location: Location): boolean {
  if (location.status === "opened" || location.status === "completed" || location.status === "archived") return false;
  if (!location.opening_date) return false;
  const opening = parseDateOnly(location.opening_date);
  if (!opening) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  opening.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7; // Mon=0 … Sun=6
  const monday = new Date(today);
  monday.setDate(today.getDate() - dow);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return opening.getTime() >= monday.getTime() && opening.getTime() <= sunday.getTime();
}

export function isOpenedThisMonth(location: Location): boolean {
  if (location.status !== "opened" || !location.opened_date) return false;
  const opened = parseDateOnly(location.opened_date);
  if (!opened) return false;
  const today = new Date();
  return opened.getFullYear() === today.getFullYear() && opened.getMonth() === today.getMonth();
}

export function computeClientStats(locations: Location[]) {
  return {
    totalActive: locations.filter(
      (l) => l.status === "on-track" || l.status === "at-risk" || l.status === "delayed"
    ).length,
    atRisk: locations.filter((l) => l.status === "at-risk").length,
    openingThisWeek: locations.filter(isOpeningThisWeek).length,
    followUpsOverdue: locations.filter(isFollowUpOverdue).length,
    openedThisMonth: locations.filter(isOpenedThisMonth).length,
  };
}

export function formatDate(dateStr: string | null): string {
  const target = parseDateOnly(dateStr);
  if (!target) return "—";
  return target.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatRelativeDays(dateStr: string | null): string | null {
  const target = parseDateOnly(dateStr);
  if (!target) return null;
  const today = new Date();
  target.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000);

  if (diffDays === 0) return "today";
  if (diffDays > 0) return `in ${diffDays}d`;
  return `${Math.abs(diffDays)}d ago`;
}

export function parseTracker(tracker: string | null): string[] {
  if (!tracker) return [];
  return tracker
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function joinTracker(names: string[]): string | null {
  return names.length > 0 ? names.join(" | ") : null;
}

// Opens a location's readiness checklist in a new tab/window, creating the
// underlying `readiness` row first if one doesn't exist yet.
export async function openReadinessChecklist(locationId: string): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const res = await fetch("/api/readiness/ensure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location_id: locationId }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to open readiness checklist.");
    if (tab) tab.location.href = `/readiness/${json.token}`;
  } catch (err) {
    tab?.close();
    throw err;
  }
}
