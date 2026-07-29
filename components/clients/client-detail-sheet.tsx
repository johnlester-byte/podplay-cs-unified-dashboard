"use client";

import * as React from "react";
import { AlertTriangle, Check, ExternalLink, Pencil } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { formatDate, isFollowUpOverdue, openReadinessChecklist } from "@/lib/client-hub";
import { OPENING_TIER_TEXT_CLASS, type OpeningDateTier } from "@/lib/opening-date-status";
import { boxDeliveredTier, boxShippedTier, getBoxCells, isNa, parseFlexDate } from "@/lib/tracker-mrp";
import { computeRowFlags } from "@/lib/tracker-flags";
import type { MrpRecord } from "@/lib/mrp";
import type { ActivityLogEntry, Location, Readiness } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/clients/status-badge";

interface ClientDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location: Location | null;
  mrpRecord: MrpRecord | null;
  userEmail: string;
  rosterMap: Record<string, string>;
  onEdit: (location: Location) => void;
  onChanged: () => void;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-sidebar-foreground/70">{label}</p>
      <p className="text-sm text-sidebar-foreground">{value || "—"}</p>
    </div>
  );
}

function MissingValue() {
  return (
    <span className={`inline-flex items-center gap-1 ${OPENING_TIER_TEXT_CLASS.overdue}`}>
      <AlertTriangle className="h-3 w-3" />—
    </span>
  );
}

function formatFlex(value: string | null): string {
  const d = parseFlexDate(value);
  if (!d) return value ?? "—";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// A single box Shipped/Delivered value. When the sheet cell carries a native
// hyperlink (e.g. UPS tracking) and holds a real date, render it as an anchor
// with an external-link icon; otherwise plain text (Session 19B).
function BoxDateValue({
  label,
  raw,
  url,
  tier,
}: {
  label: string;
  raw: string | null;
  url: string | null;
  tier: OpeningDateTier;
}) {
  const tierClass = tier ? OPENING_TIER_TEXT_CLASS[tier] : "text-sidebar-foreground";
  if (isNa(raw)) {
    return <span className={tierClass}>{label}: —</span>;
  }
  const text = formatFlex(raw);
  if (!url) {
    return (
      <span className={tierClass}>
        {label}: {text}
      </span>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:decoration-solid ${tierClass}`}
    >
      {label}: {text}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

export function ClientDetailSheet({
  open,
  onOpenChange,
  location,
  mrpRecord,
  userEmail,
  rosterMap,
  onEdit,
  onChanged,
}: ClientDetailSheetProps) {
  const [activity, setActivity] = React.useState<ActivityLogEntry[]>([]);
  const [readiness, setReadiness] = React.useState<Readiness | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [togglingField, setTogglingField] = React.useState<"pre_open_done" | "post_open_done" | null>(null);
  const [openingReadiness, setOpeningReadiness] = React.useState(false);

  React.useEffect(() => {
    if (!open || !location) return;

    let cancelled = false;
    setLoading(true);
    const supabase = createClient();

    async function load() {
      try {
        const [activityRes, readinessRes] = await Promise.all([
          supabase
            .from("activity_log")
            .select("*")
            .eq("entity", `location:${location!.id}`)
            .order("created_at", { ascending: false })
            .limit(20),
          supabase.from("readiness").select("*").eq("location_id", location!.id).maybeSingle(),
        ]);

        if (activityRes.error) throw activityRes.error;
        if (readinessRes.error) throw readinessRes.error;

        if (!cancelled) {
          setActivity(activityRes.data ?? []);
          setReadiness(readinessRes.data);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load client details.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [open, location]);

  async function toggleFollowUp(field: "pre_open_done" | "post_open_done") {
    if (!location) return;
    const label = field === "pre_open_done" ? "Pre-open" : "Post-open";
    const nextValue = !location[field];

    setTogglingField(field);
    const supabase = createClient();
    try {
      const { error } = await supabase
        .from("locations")
        .update({ [field]: nextValue } as never)
        .eq("id", location.id);
      if (error) throw error;

      await supabase.from("activity_log").insert({
        user_email: userEmail,
        action: "updated",
        entity: `location:${location.id}`,
        details: `${label} follow-up marked ${nextValue ? "done" : "not done"} for ${location.name}`,
      } as never);

      toast.success(`${label} follow-up marked ${nextValue ? "done" : "not done"}.`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update follow-up.");
    } finally {
      setTogglingField(null);
    }
  }

  async function handleOpenReadiness() {
    if (!location) return;
    setOpeningReadiness(true);
    try {
      await openReadinessChecklist(location.id);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to open readiness checklist.");
    } finally {
      setOpeningReadiness(false);
    }
  }

  if (!location) return null;

  const overdue = isFollowUpOverdue(location);
  const completed = location.status === "opened";
  const flags = computeRowFlags(location, mrpRecord);
  const openingTier = flags.openingTier;
  const hardware = flags.hardware;
  const qcConf = flags.qc;
  const boxCells = getBoxCells(mrpRecord).filter((b) => b.applicable);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <div className="space-y-6 pr-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-sidebar-foreground">{location.name}</h2>
              <p className="text-sm text-sidebar-foreground/70">{location.client_name}</p>
            </div>
            <StatusBadge status={location.status} />
          </div>

          {overdue && (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-500">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Follow-up overdue — opening date has passed with pre/post checklist incomplete.
            </div>
          )}

          <Button size="sm" variant="secondary" onClick={() => onEdit(location)} className="gap-2">
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>

          <Separator className="bg-sidebar-border" />

          <div className="grid grid-cols-2 gap-4">
            <Field label="Tier" value={location.tier} />
            <Field
              label="Pre-sale Date"
              value={
                location.presale_date
                  ? formatDate(location.presale_date)
                  : location.presale_date_na
                    ? "N/A"
                    : completed
                      ? null
                      : <MissingValue />
              }
            />
            <Field
              label="Hardware Delivery Date"
              value={
                hardware.value ? (
                  <>
                    {formatFlex(hardware.value)}
                    {hardware.source === "manual" && (
                      <span className="ml-1 text-xs text-sidebar-foreground/50">(manual)</span>
                    )}
                  </>
                ) : completed || !flags.hardwareRequired ? null : (
                  <MissingValue />
                )
              }
            />
            <Field
              label="Opening Date"
              value={
                location.opening_date ? (
                  <span className={openingTier ? OPENING_TIER_TEXT_CLASS[openingTier] : ""}>
                    {formatDate(location.opening_date)}
                    {openingTier === "overdue" && " (overdue)"}
                  </span>
                ) : completed ? null : (
                  <MissingValue />
                )
              }
            />
            <Field
              label="QC Date"
              value={
                flags.recommendedQcDate || flags.manualQcDate ? (
                  <span className="space-y-0.5">
                    {flags.recommendedQcDate && (
                      <span
                        className={`block ${flags.qcSource === "recommended" && qcConf ? OPENING_TIER_TEXT_CLASS[qcConf.tier] : ""}`}
                        title={flags.qcSource === "recommended" ? qcConf?.message : undefined}
                      >
                        <span className="text-xs text-sidebar-foreground/50">Recommended: </span>
                        {flags.recommendedQcDate.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
                      </span>
                    )}
                    {flags.manualQcDate && (
                      <span
                        className={`block ${flags.qcSource === "manual" && qcConf ? OPENING_TIER_TEXT_CLASS[qcConf.tier] : ""}`}
                        title={flags.qcSource === "manual" ? qcConf?.message : undefined}
                      >
                        <span className="text-xs text-sidebar-foreground/50">Manual: </span>
                        {flags.manualQcDate.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
                      </span>
                    )}
                  </span>
                ) : null
              }
            />
            <Field
              label="Tracking"
              value={
                flags.noTracking ? (
                  <span className={`inline-flex items-center gap-1 ${OPENING_TIER_TEXT_CLASS.overdue}`}>
                    <AlertTriangle className="h-3 w-3" />None
                  </span>
                ) : (
                  location.tracker
                )
              }
            />
            {location.status === "opened" && (
              <>
                <Field label="Opened Date" value={formatDate(location.opened_date)} />
                <Field label="Open Outcome" value={location.open_outcome} />
              </>
            )}
          </div>

          {mrpRecord && boxCells.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-sidebar-foreground/70">
                PP Hardware Boxes
              </p>
              <div className="space-y-1.5 text-sm">
                {boxCells.map((b) => {
                  const shipTier = boxShippedTier(mrpRecord, b.index);
                  const delTier = boxDeliveredTier(mrpRecord, b.index);
                  return (
                    <div key={b.index} className="flex items-center justify-between gap-3">
                      <span className="text-sidebar-foreground/70">Box {b.index}</span>
                      <span className="flex gap-3">
                        <BoxDateValue label="Shipped" raw={b.shipped} url={b.shippedUrl} tier={shipTier} />
                        <BoxDateValue label="Delivered" raw={b.delivered} url={b.deliveredUrl} tier={delTier} />
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={location.pre_open_done ? "default" : "secondary"}
              disabled={togglingField !== null}
              onClick={() => toggleFollowUp("pre_open_done")}
              className="gap-1.5"
            >
              {location.pre_open_done && <Check className="h-3.5 w-3.5" />}
              Pre-open follow-up done
            </Button>
            <Button
              size="sm"
              variant={location.post_open_done ? "default" : "secondary"}
              disabled={togglingField !== null}
              onClick={() => toggleFollowUp("post_open_done")}
              className="gap-1.5"
            >
              {location.post_open_done && <Check className="h-3.5 w-3.5" />}
              Post-open follow-up done
            </Button>
          </div>

          {location.notes && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-sidebar-foreground/70">Notes</p>
              <p className="whitespace-pre-wrap text-sm">{location.notes}</p>
            </div>
          )}

          <Separator className="bg-sidebar-border" />

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">Readiness</p>
              <span className="text-sm text-sidebar-foreground/70">{readiness?.pct ?? 0}%</span>
            </div>
            <Progress value={readiness?.pct ?? 0} />
            <Button
              size="sm"
              variant="secondary"
              disabled={openingReadiness}
              onClick={handleOpenReadiness}
              className="mt-2 gap-1.5"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {openingReadiness ? "Opening…" : "Open Readiness Checklist"}
            </Button>
          </div>

          <Separator className="bg-sidebar-border" />

          <div>
            <p className="mb-2 text-sm font-medium">Activity</p>
            {loading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : activity.length === 0 ? (
              <p className="text-sm text-sidebar-foreground/60">No activity logged yet.</p>
            ) : (
              <ul className="space-y-3">
                {activity.map((entry) => (
                  <li key={entry.id} className="text-sm">
                    <p>{entry.details ?? entry.action}</p>
                    <p className="text-xs text-sidebar-foreground/50">
                      {(entry.user_email && rosterMap[entry.user_email]) ?? entry.user_email} ·{" "}
                      {formatDate(entry.created_at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
