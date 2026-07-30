"use client";

import * as React from "react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { STATUS_BADGE_VARIANT, STATUS_LABEL } from "@/lib/client-hub";
import type { Location, LocationStatus } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const STATUS_OPTIONS: LocationStatus[] = ["on-track", "at-risk", "delayed", "opened", "completed", "archived"];

interface StatusQuickEditProps {
  location: Location;
  userEmail: string;
  onChanged: () => void;
}

export function StatusQuickEdit({ location, userEmail, onChanged }: StatusQuickEditProps) {
  const [pending, setPending] = React.useState<LocationStatus | null>(null);
  const [saving, setSaving] = React.useState(false);

  async function handleConfirm() {
    if (!pending) return;
    setSaving(true);
    const supabase = createClient();
    try {
      const { error } = await supabase
        .from("locations")
        .update({ status: pending } as never)
        .eq("id", location.id);
      if (error) throw error;

      await supabase.from("activity_log").insert({
        user_email: userEmail,
        action: "updated",
        entity: `location:${location.id}`,
        details: `Status changed from ${STATUS_LABEL[location.status]} to ${STATUS_LABEL[pending]}`,
      } as never);

      toast.success(`Status changed to ${STATUS_LABEL[pending]}.`);
      onChanged();
      setPending(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to change status.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" onClick={(e) => e.stopPropagation()} className="cursor-pointer">
            <Badge variant={STATUS_BADGE_VARIANT[location.status]}>{STATUS_LABEL[location.status]}</Badge>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
          {STATUS_OPTIONS.map((s) => (
            <DropdownMenuItem
              key={s}
              disabled={s === location.status}
              onClick={(e) => {
                e.stopPropagation();
                setPending(s);
              }}
            >
              {STATUS_LABEL[s]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Change Status</DialogTitle>
            <DialogDescription>
              Change {location.name} from {STATUS_LABEL[location.status]} to{" "}
              {pending ? STATUS_LABEL[pending] : ""}?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPending(null)} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" onClick={handleConfirm} disabled={saving}>
              {saving ? "Saving…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
