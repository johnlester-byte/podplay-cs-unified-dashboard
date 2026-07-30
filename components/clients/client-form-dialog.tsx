"use client";

import * as React from "react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { joinTracker, parseTracker } from "@/lib/client-hub";
import type { Location, LocationStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TrackingMultiSelect } from "@/components/shared/tracking-multi-select";
import { Switch } from "@/components/ui/switch";

const STATUS_OPTIONS: LocationStatus[] = ["on-track", "at-risk", "delayed", "opened", "completed", "archived"];
// Statuses that keep the opened date / outcome (a location that's opened, then
// completed or archived, still has a real opened date to preserve).
const KEEPS_OPENED_FIELDS: LocationStatus[] = ["opened", "completed", "archived"];
const TIER_OPTIONS = ["Basic (+)", "Pro/Auto (+)"];

interface FormState {
  id: string;
  client_name: string;
  name: string;
  tier: string;
  opening_date: string;
  presale_date: string;
  presale_date_na: boolean;
  delivery_date: string;
  qc_date: string;
  tracker: string[];
  status: LocationStatus;
  notes: string;
  opened_date: string;
  open_outcome: string;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "location"
  );
}

function toFormState(location?: Location): FormState {
  return {
    id: location?.id ?? "",
    client_name: location?.client_name ?? "",
    name: location?.name ?? "",
    tier: location?.tier ?? "",
    opening_date: location?.opening_date ?? "",
    presale_date: location?.presale_date ?? "",
    presale_date_na: location?.presale_date_na ?? false,
    delivery_date: location?.delivery_date ?? "",
    qc_date: location?.qc_date ?? "",
    tracker: parseTracker(location?.tracker ?? null),
    status: location?.status ?? "on-track",
    notes: location?.notes ?? "",
    opened_date: location?.opened_date ?? "",
    open_outcome: location?.open_outcome ?? "",
  };
}

interface ClientFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location?: Location;
  userEmail: string;
  trackerRoster: string[];
  onSaved: () => void;
}

export function ClientFormDialog({
  open,
  onOpenChange,
  location,
  userEmail,
  trackerRoster,
  onSaved,
}: ClientFormDialogProps) {
  const [form, setForm] = React.useState<FormState>(() => toFormState(location));
  const [saving, setSaving] = React.useState(false);
  const isEdit = Boolean(location);

  React.useEffect(() => {
    if (open) {
      setForm(toFormState(location));
    }
  }, [open, location]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Required to save: Client Name, Location, Tier, and at least one Tracking
    // entry. All dates (opening/presale/delivery) are optional — gaps surface as
    // a red "missing" nudge in the table/detail sheet, not a hard block.
    if (!form.client_name.trim() || !form.name.trim() || !form.tier.trim() || form.tracker.length === 0) {
      toast.error("Client Name, Location, Tier, and at least one Tracking name are required.");
      return;
    }

    setSaving(true);
    const supabase = createClient();

    try {
      const id = isEdit ? location!.id : slugify(form.name);

      const payload: Partial<Location> = {
        id,
        client_name: form.client_name || null,
        name: form.name,
        tier: form.tier || null,
        opening_date: form.opening_date || null,
        // N/A wins: a confirmed "no pre-sale" clears any stray date value.
        presale_date: form.presale_date_na ? null : form.presale_date || null,
        presale_date_na: form.presale_date_na,
        delivery_date: form.delivery_date || null,
        qc_date: form.qc_date || null,
        tracker: joinTracker(form.tracker),
        status: form.status,
        notes: form.notes || null,
        opened_date: KEEPS_OPENED_FIELDS.includes(form.status) ? form.opened_date || null : null,
        open_outcome: KEEPS_OPENED_FIELDS.includes(form.status) ? form.open_outcome || null : null,
      };

      // @supabase/ssr's createBrowserClient<Database> mistypes .update()/.insert() as `never`
      // regardless of the Database generic (confirmed upstream typing defect, not a local
      // schema mistake — `payload` itself is fully typed as Partial<Location> above).
      if (isEdit) {
        const { error } = await supabase.from("locations").update(payload as never).eq("id", id);
        if (error) throw error;
      } else {
        const insertPayload = { ...payload, pre_open_done: false, post_open_done: false };
        const { error } = await supabase.from("locations").insert(insertPayload as never);
        if (error) throw error;
      }

      const activityPayload = {
        user_email: userEmail,
        action: isEdit ? "updated" : "created",
        entity: `location:${id}`,
        details: `${isEdit ? "Updated" : "Created"} ${form.name}`,
      };
      await supabase.from("activity_log").insert(activityPayload as never);

      // Session 15D Part C — record this CSA edit in the last-write-wins ledger
      // so a later cron sync can't revert it with a stale HubSpot/MRP value.
      // Service-role write only, so it goes through a server route (the ledger
      // isn't client-writable). Best-effort: a hiccup here must not fail the save.
      try {
        await fetch("/api/tracker/field-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            locationId: id,
            fields: {
              opening_date: payload.opening_date ?? null,
              presale_date: payload.presale_date ?? null,
              delivery_date: payload.delivery_date ?? null,
              qc_date: payload.qc_date ?? null,
              tier: payload.tier ?? null,
            },
          }),
        });
      } catch {
        // ledger is a best-effort audit aid — never block the user's save on it
      }

      toast.success(isEdit ? "Client updated." : "Client added.");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save client.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Client" : "Add Client"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update location details. Changes are logged to the activity feed."
              : "Add a new client location to the tracker."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="client_name">Client Name *</Label>
              <Input
                id="client_name"
                required
                value={form.client_name}
                onChange={(e) => update("client_name", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="name">Location *</Label>
              <Input
                id="name"
                required
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="tier">Tier *</Label>
              <Select value={form.tier} onValueChange={(v) => update("tier", v)}>
                <SelectTrigger id="tier">
                  <SelectValue placeholder="Select tier..." />
                </SelectTrigger>
                <SelectContent>
                  {TIER_OPTIONS.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="opening_date">Opening Date</Label>
              <Input
                id="opening_date"
                type="date"
                value={form.opening_date}
                onChange={(e) => update("opening_date", e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="presale_date">Pre-sale Date</Label>
              <Input
                id="presale_date"
                type="date"
                value={form.presale_date_na ? "" : form.presale_date}
                disabled={form.presale_date_na}
                onChange={(e) => update("presale_date", e.target.value)}
              />
              <div className="flex items-center gap-2 pt-0.5">
                <Switch
                  id="presale_date_na"
                  checked={form.presale_date_na}
                  onCheckedChange={(v) => update("presale_date_na", v)}
                />
                <Label htmlFor="presale_date_na" className="text-xs font-normal text-muted-foreground">
                  No pre-sale (N/A)
                </Label>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="delivery_date">Hardware Delivery Date (manual)</Label>
              <Input
                id="delivery_date"
                type="date"
                value={form.delivery_date}
                onChange={(e) => update("delivery_date", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Fallback shown only when no MRP match.</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="qc_date">QC Date (manual)</Label>
              <Input
                id="qc_date"
                type="date"
                value={form.qc_date}
                onChange={(e) => update("qc_date", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Overrides the recommended QC date.</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Tracking *</Label>
            <TrackingMultiSelect
              selected={form.tracker}
              roster={trackerRoster}
              onChange={(names) => update("tracker", names)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="status">Status</Label>
            <Select value={form.status} onValueChange={(v) => update("status", v as LocationStatus)}>
              <SelectTrigger id="status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {KEEPS_OPENED_FIELDS.includes(form.status) && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="opened_date">Opened Date</Label>
                <Input
                  id="opened_date"
                  type="date"
                  value={form.opened_date}
                  onChange={(e) => update("opened_date", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="open_outcome">Open Outcome</Label>
                <Input
                  id="open_outcome"
                  value={form.open_outcome}
                  onChange={(e) => update("open_outcome", e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" value={form.notes} onChange={(e) => update("notes", e.target.value)} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : isEdit ? "Save Changes" : "Add Client"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
