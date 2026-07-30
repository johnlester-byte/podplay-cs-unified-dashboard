"use client";

import * as React from "react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { CLOSE_REASON_LABELS, type CloseReason, type ClosedLocation } from "@/lib/types";
import { easternWallClockToUtcIso, formatEastern, utcIsoToEasternParts } from "@/lib/tz";
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

const REASONS = Object.keys(CLOSE_REASON_LABELS) as CloseReason[];

type ReminderMode = "none" | "date" | "before";

// close_date (yyyy-mm-dd) minus n days -> yyyy-mm-dd
function subtractDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

interface CloseLocationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  closure?: ClosedLocation | null;
  userEmail: string;
  onSaved: () => void;
}

export function CloseLocationDialog({
  open,
  onOpenChange,
  closure,
  userEmail,
  onSaved,
}: CloseLocationDialogProps) {
  const isEdit = Boolean(closure);
  const [clientName, setClientName] = React.useState("");
  const [locationName, setLocationName] = React.useState("");
  const [closeDate, setCloseDate] = React.useState("");
  const [reason, setReason] = React.useState<CloseReason | "">("");
  const [note, setNote] = React.useState("");
  const [reminderMode, setReminderMode] = React.useState<ReminderMode>("none");
  const [remindDate, setRemindDate] = React.useState("");
  const [remindTime, setRemindTime] = React.useState("09:00");
  const [daysBefore, setDaysBefore] = React.useState("3");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    if (closure) {
      setClientName(closure.client_name ?? "");
      setLocationName(closure.location_name ?? "");
      setCloseDate(closure.close_date ?? "");
      setReason(closure.close_reason ?? "");
      setNote(closure.close_note ?? "");
      if (closure.remind_at) {
        const { date, time } = utcIsoToEasternParts(closure.remind_at);
        setReminderMode("date");
        setRemindDate(date);
        setRemindTime(time);
      } else {
        setReminderMode("none");
        setRemindDate("");
        setRemindTime("09:00");
      }
      setDaysBefore("3");
    } else {
      setClientName("");
      setLocationName("");
      setCloseDate(new Date().toISOString().slice(0, 10));
      setReason("");
      setNote("");
      setReminderMode("none");
      setRemindDate("");
      setRemindTime("09:00");
      setDaysBefore("3");
    }
  }, [open, closure]);

  // The resolved UTC instant the reminder fires on (from the Eastern date+time),
  // for the live preview + save.
  const resolvedRemindAt = React.useMemo<string | null>(() => {
    let dateStr: string | null = null;
    if (reminderMode === "date") dateStr = remindDate || null;
    else if (reminderMode === "before") {
      const n = parseInt(daysBefore, 10);
      if (Number.isFinite(n) && n >= 0 && closeDate) dateStr = subtractDays(closeDate, n);
    }
    if (!dateStr || !remindTime) return null;
    return easternWallClockToUtcIso(dateStr, remindTime);
  }, [reminderMode, remindDate, daysBefore, closeDate, remindTime]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!locationName.trim()) return toast.error("Location name is required.");
    if (!closeDate) return toast.error("Close date is required.");
    if (!reason) return toast.error("Pick a reason.");
    if (reminderMode === "date" && !remindDate) return toast.error("Pick a reminder date.");
    if (reminderMode === "before" && !(parseInt(daysBefore, 10) >= 0))
      return toast.error("Enter how many days before close to remind you.");

    setSaving(true);
    const supabase = createClient();
    try {
      const fields = {
        client_name: clientName.trim() || null,
        location_name: locationName.trim(),
        close_date: closeDate,
        close_reason: reason,
        close_note: note.trim() || null,
        // Reminder — reset the done/sent tracking on every save so a new or
        // edited reminder fires fresh.
        remind_at: resolvedRemindAt,
        remind_user_email: resolvedRemindAt ? userEmail : null,
        reminder_done: false,
        reminder_slack_sent_at: null,
      };

      if (isEdit && closure) {
        const { error } = await supabase
          .from("closed_locations")
          .update(fields as never)
          .eq("id", closure.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("closed_locations")
          .insert({ ...fields, created_by: userEmail } as never);
        if (error) throw error;
      }

      toast.success(isEdit ? "Closure updated." : "Closure added.");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      // Supabase errors aren't Error instances but do carry a `message`.
      const msg =
        err instanceof Error
          ? err.message
          : err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : "Failed to save.";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit closure" : "Mark location closed"}</DialogTitle>
          <DialogDescription>Record when and why a location shut down.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="cl-client">Client Name</Label>
              <Input
                id="cl-client"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                placeholder="Client name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cl-location">Location / Franchise Name</Label>
              <Input
                id="cl-location"
                value={locationName}
                onChange={(e) => setLocationName(e.target.value)}
                placeholder="Location / franchise name"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="cl-date">Close date</Label>
              <Input
                id="cl-date"
                type="date"
                value={closeDate}
                onChange={(e) => setCloseDate(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cl-reason">Reason</Label>
              <Select value={reason} onValueChange={(v) => setReason(v as CloseReason)}>
                <SelectTrigger id="cl-reason">
                  <SelectValue placeholder="Select..." />
                </SelectTrigger>
                <SelectContent>
                  {REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {CLOSE_REASON_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cl-note">Note</Label>
            <Textarea
              id="cl-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Context for the team..."
            />
          </div>

          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="cl-remind">Remind me</Label>
              <Select value={reminderMode} onValueChange={(v) => setReminderMode(v as ReminderMode)}>
                <SelectTrigger id="cl-remind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No reminder</SelectItem>
                  <SelectItem value="date">On a specific date</SelectItem>
                  <SelectItem value="before">Days before close date</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {reminderMode !== "none" && (
              <div className="grid grid-cols-2 gap-4">
                {reminderMode === "date" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="cl-remind-date">Reminder date</Label>
                    <Input
                      id="cl-remind-date"
                      type="date"
                      value={remindDate}
                      onChange={(e) => setRemindDate(e.target.value)}
                    />
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label htmlFor="cl-remind-days">Days before close</Label>
                    <Input
                      id="cl-remind-days"
                      type="number"
                      min={0}
                      value={daysBefore}
                      onChange={(e) => setDaysBefore(e.target.value)}
                    />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="cl-remind-time">Time (ET)</Label>
                  <Input
                    id="cl-remind-time"
                    type="time"
                    value={remindTime}
                    onChange={(e) => setRemindTime(e.target.value)}
                  />
                </div>
              </div>
            )}

            {resolvedRemindAt && (
              <p className="text-xs text-muted-foreground">
                You&rsquo;ll be reminded{" "}
                <span className="font-medium text-foreground">{formatEastern(resolvedRemindAt)}</span> (in-app and
                Slack #cs-team-daily).
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : isEdit ? "Save" : "Mark closed"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
