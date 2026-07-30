import Link from "next/link";
import {
  ArrowRight,
  ClipboardList,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Link2,
  UserX,
  Clock3,
} from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeClientStats, STATUS_LABEL } from "@/lib/client-hub";
import { getOnboardingOverviewStats } from "@/lib/hubspot";
import { getOpsGuideOverviewStats } from "@/lib/ops-guide-server";
import { getCallerProfile, isAdmin } from "@/lib/permissions";
import { parseDateOnly, dateOnlyToUtcMs, todayUtcMs } from "@/lib/date-only";
import type { Location, LocationStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ApiHealthChip } from "@/components/api-health/api-health-chip";
import { OpsGuideCard } from "@/components/overview/ops-guide-card";

export const dynamic = "force-dynamic";

type Tone = "default" | "warning" | "danger";

interface StatDef {
  label: string;
  value: number | string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: Tone;
}

const TONE_CARD: Record<Tone, string> = {
  default: "border-border bg-card",
  warning: "border-amber-500/30 bg-amber-500/5",
  danger: "border-destructive/30 bg-destructive/5",
};

const TONE_ICON: Record<Tone, string> = {
  default: "bg-muted text-muted-foreground",
  warning: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  danger: "bg-destructive/15 text-destructive",
};

const TONE_VALUE: Record<Tone, string> = {
  default: "text-foreground",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-destructive",
};

function StatCard({ stat }: { stat: StatDef }) {
  const tone = stat.tone ?? "default";
  const Icon = stat.icon;
  return (
    <div className={cn("rounded-xl border p-4 shadow-sm", TONE_CARD[tone])}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground">{stat.label}</span>
        <span className={cn("flex h-7 w-7 items-center justify-center rounded-lg", TONE_ICON[tone])}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className={cn("mt-2 text-3xl font-bold tracking-tight", TONE_VALUE[tone])}>{stat.value}</div>
      {stat.hint && <div className="mt-0.5 text-xs font-medium text-muted-foreground">{stat.hint}</div>}
    </div>
  );
}

interface UpcomingOpening {
  id: string;
  name: string;
  tier: string | null;
  openingDate: string; // ISO
  readyPct: number;
  status: LocationStatus;
}

const STATUS_PILL: Record<LocationStatus, string> = {
  "on-track": "bg-emerald-600 text-white",
  "at-risk": "bg-amber-500 text-white",
  delayed: "bg-destructive text-white",
  opened: "bg-blue-600 text-white",
  completed: "bg-emerald-600 text-white",
  archived: "bg-slate-500 text-white",
};

const BAR_COLOR: Record<LocationStatus, string> = {
  "on-track": "bg-emerald-600",
  "at-risk": "bg-amber-500",
  delayed: "bg-destructive",
  opened: "bg-blue-600",
  completed: "bg-emerald-600",
  archived: "bg-slate-500",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function UpcomingRow({ item }: { item: UpcomingOpening }) {
  // item.openingDate is a date-only string ("2026-08-01"); parse at local
  // midnight so getDate()/getMonth() render the intended calendar day.
  const d = parseDateOnly(item.openingDate) ?? new Date(item.openingDate);
  return (
    <Link
      href={`/dashboard/clients?q=${encodeURIComponent(item.name)}`}
      className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-muted/60"
    >
      <div className="w-11 shrink-0 text-center">
        <div className="text-base font-bold leading-none text-foreground">
          {String(d.getDate()).padStart(2, "0")}
        </div>
        <div className="text-[9.5px] font-semibold uppercase text-muted-foreground">{MONTHS[d.getMonth()]}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-foreground">{item.name}</div>
        {item.tier && <div className="truncate text-xs text-muted-foreground">{item.tier}</div>}
      </div>
      <div className="hidden w-24 shrink-0 sm:block">
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", BAR_COLOR[item.status])}
            style={{ width: `${item.readyPct}%` }}
          />
        </div>
        <div className="mt-1 text-[9.5px] text-muted-foreground">{item.readyPct}% ready</div>
      </div>
      <span className={cn("shrink-0 rounded-full px-2.5 py-1 text-[10.5px] font-bold", STATUS_PILL[item.status])}>
        {STATUS_LABEL[item.status]}
      </span>
    </Link>
  );
}

// Next-3-weeks tracker openings: opening_date within [today, today+21d], not
// opened, not delayed. Readiness % comes from the readiness table. Sorted
// soonest first. "Delayed"/overdue rows are intentionally excluded.
function computeUpcomingOpenings(
  locations: Location[],
  readinessByLocation: Record<string, number>
): UpcomingOpening[] {
  // Runs server-side (force-dynamic Overview page), so compare in UTC-normalized
  // date-only terms rather than against a server-clock local midnight.
  const today = todayUtcMs();
  const horizon = today + 21 * 86_400_000;

  return locations
    .filter((l) => {
      if (l.status === "opened" || l.status === "delayed" || l.status === "completed" || l.status === "archived")
        return false;
      if (!l.opening_date) return false;
      const t = dateOnlyToUtcMs(l.opening_date);
      if (t === null) return false;
      return t >= today && t <= horizon;
    })
    .map((l) => ({
      id: l.id,
      name: l.name || l.client_name || "Untitled location",
      tier: l.tier,
      openingDate: l.opening_date as string,
      readyPct: readinessByLocation[l.id] ?? 0,
      status: l.status,
    }))
    .sort((a, b) => (dateOnlyToUtcMs(a.openingDate) ?? 0) - (dateOnlyToUtcMs(b.openingDate) ?? 0))
    .slice(0, 6);
}

export default async function OverviewPage() {
  const supabase = createClient();
  const admin = createAdminClient();
  const [{ data: locations, error }, { data: readinessRows }, onboardingStats, opsGuideStats, categoriesResp, callerProfile] =
    await Promise.all([
      supabase.from("locations").select("*"),
      supabase.from("readiness").select("location_id, pct"),
      getOnboardingOverviewStats().catch(() => null),
      getOpsGuideOverviewStats().catch(() => null),
      admin.from("ops_categories").select("name").order("display_order", { ascending: true }).limit(4),
      getCallerProfile(),
    ]);
  const callerIsAdmin = isAdmin(callerProfile);

  const rows = (locations ?? []) as unknown as Location[];
  const stats = computeClientStats(rows);
  const quickTags = ((categoriesResp.data ?? []) as unknown as { name: string }[]).map((c) => c.name);

  const readinessByLocation: Record<string, number> = {};
  for (const r of (readinessRows ?? []) as unknown as { location_id: string; pct: number | null }[]) {
    readinessByLocation[r.location_id] = r.pct ?? 0;
  }
  const upcoming = computeUpcomingOpenings(rows, readinessByLocation);

  const CLIENT_STATS: StatDef[] = [
    { label: "Active clients", value: stats.totalActive, icon: ClipboardList },
    {
      label: "At-risk openings",
      value: stats.atRisk,
      hint: `${stats.openingThisWeek} opening this week`,
      icon: AlertTriangle,
      tone: stats.atRisk > 0 ? "warning" : "default",
    },
    {
      label: "Follow-ups due",
      value: stats.followUpsOverdue,
      icon: CalendarClock,
      tone: stats.followUpsOverdue > 0 ? "warning" : "default",
    },
    { label: "Opened this month", value: stats.openedThisMonth, icon: CheckCircle2 },
  ];

  const ONBOARDING_STATS: StatDef[] = onboardingStats
    ? [
        { label: "Total onboardings", value: onboardingStats.total, hint: "Basic+ & Pro+", icon: Link2 },
        { label: "Opening this week", value: onboardingStats.openingThisWeek, icon: Clock3 },
        {
          label: "Overdue openings",
          value: onboardingStats.overdueOpenings,
          icon: AlertTriangle,
          tone: onboardingStats.overdueOpenings > 0 ? "warning" : "default",
        },
        {
          label: "Stuck / MIA",
          value: onboardingStats.stuck,
          hint: "no response 14+ days",
          icon: UserX,
          tone: onboardingStats.stuck > 0 ? "danger" : "default",
        },
      ]
    : [];

  return (
    <div className="space-y-5">
      {callerIsAdmin && (
        <div className="flex justify-end">
          <ApiHealthChip />
        </div>
      )}

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load stats: {error.message}
        </div>
      ) : (
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {CLIENT_STATS.map((stat) => (
            <StatCard key={stat.label} stat={stat} />
          ))}
        </div>
      )}

      {onboardingStats === null ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load HubSpot stats — try refreshing.
        </div>
      ) : (
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {ONBOARDING_STATS.map((stat) => (
            <StatCard key={stat.label} stat={stat} />
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
        {/* Upcoming openings */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-foreground">Upcoming openings</div>
              <div className="text-xs text-muted-foreground">Client Opening Tracker · next 3 weeks</div>
            </div>
            <Link
              href="/dashboard/clients"
              className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              View tracker <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="flex-1 p-2">
            {upcoming.length > 0 ? (
              upcoming.map((item) => <UpcomingRow key={item.id} item={item} />)
            ) : (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                No openings scheduled in the next 3 weeks.
              </p>
            )}
          </div>
        </div>

        {/* OPS Guide */}
        {opsGuideStats === null ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            Failed to load OPS Guide stats — try refreshing.
          </div>
        ) : (
          <OpsGuideCard mostViewed={opsGuideStats.mostViewed} quickTags={quickTags} />
        )}
      </div>
    </div>
  );
}
