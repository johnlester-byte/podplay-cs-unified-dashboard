// Session 15D — field-level last-write-wins sync (server-only).
//
// Runs on the same cron heartbeat as 15B/15C (app/api/cron/refresh), AFTER the
// snapshots are rewritten and after runTrackerImportSync. For every SHARED_FIELD
// (lib/tracker-link.ts) on every linked `locations` row it decides, per field,
// whether HubSpot/MRP genuinely CHANGED that field — and only then overwrites.
//
// The rule the user confirmed: three writers (tracker / HubSpot / MRP); the most
// RECENT actual change wins. Concretely — imported value x (from HubSpot), CSA
// edits it to y; next sync HubSpot is STILL x (unchanged) => stays y. Only when
// HubSpot/MRP's own value actually moves does it flow through and overwrite.
//
// Change detection is by VALUE DELTA, not timestamp. HubSpot's hs_lastmodifieddate
// is object-level — an unrelated property edit bumps it — so a timestamp test
// would revert a tracker edit with a stale field value. Instead the ledger
// remembers the value each source last reported (hubspot_seen_value /
// mrp_seen_value, 017). A source "changed" the field only when its freshly
// observed value differs from what it reported last sync. Timestamps
// (hs_lastmodifieddate / snapshot fetchedAt / tracker save time) only arbitrate
// the rare tie where BOTH external sources changed the same field the same tick,
// and feed the audit log.
//
// Tracker edits record source='tracker' + save time via POST /api/tracker/
// field-sync (the ledger is service-role-write-only). That hook deliberately does
// NOT touch the seen-value columns, so a stable external value stays "unchanged"
// and the tracker edit is preserved.
//
// First sight (15A/15B never wrote ledger rows): a non-blank value is recorded as
// a baseline WITHOUT overwriting (seen-values captured so future deltas are
// detectable); a blank field is filled from whatever source has a value.

import { createAdminClient } from "@/lib/supabase/admin";
import { readSnapshot } from "@/lib/snapshot";
import { shouldAllowAutoImport } from "@/lib/api-health";
import { tierToTrackerTier, getEffectiveOpeningDate } from "@/lib/hubspot";
import { SHARED_FIELDS } from "@/lib/tracker-link";
import { toIsoDate } from "@/lib/track-opening-map";
import { parseFlexDate, isNa } from "@/lib/tracker-mrp";
import type { MrpRecord } from "@/lib/mrp";
import type { Location, LocationFieldSync, FieldSyncSource } from "@/lib/types";
import type { PipelineDeals } from "@/lib/onboarding-deals";
import type { OnboardingListItem } from "@/components/onboarding/onboarding-types";

type SharedField = (typeof SHARED_FIELDS)[number];

// Cap real overwrites/fills per tick (locations touched) so a large drift can't
// blow the function timeout. Baseline seeding is bulk (one upsert) and not
// counted. Remainder drains next heartbeat (idempotent).
//
// Session 20 — raised 25 -> 75 for Vercel Pro (was sized against Hobby's 10s cap
// in 17E; prod is now Pro, 60s). DEFAULT used by the lightweight sync-only cron
// (/api/cron/sync). The heavy /api/cron/refresh and the manual refresh pass
// their own explicit lower caps — see those routes.
const MAX_SYNC_WRITES_PER_TICK = 75;

export interface FieldSyncResult {
  linkedScanned: number; // linked rows examined
  seeded: number; // ledger rows written as baselines (no value change)
  overwritten: number; // locations that had >=1 field overwritten/filled
  fieldsChanged: number; // total field values written
  capped: boolean;
  hubspotSkippedPaused: boolean;
  mrpSkippedPaused: boolean;
}

// A field's freshly-observed external values this tick (null = source doesn't
// provide / isn't linked / is paused). ts is the value's "as-of" time.
interface Observed {
  hs: { value: string | null; ts: string } | null;
  mrp: { value: string | null; ts: string } | null;
}

// MRP "M/D/YYYY" (or ISO) -> date-only ISO "YYYY-MM-DD"; null for empty/N/A.
function toIsoFromFlex(value: string | null | undefined): string | null {
  const d = parseFlexDate(value);
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// HubSpot date-only property -> "YYYY-MM-DD", or null if not a real date. Native
// date properties arrive as "YYYY-MM-DD"; toIsoDate slices the first 10 chars.
// The regex guard means a form-entered "N/A" (or any non-date text) becomes null
// instead of being written verbatim to the Postgres `date` column (hard error).
function toIsoDateStrict(value: string | null | undefined): string | null {
  const s = toIsoDate(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function newer(a: string, b: string): boolean {
  return new Date(a).getTime() > new Date(b).getTime();
}

// Values compare equal when both normalize to "nothing" (null / "" / N/A) or are
// the same trimmed string.
function sameValue(a: string | null, b: string | null): boolean {
  const na = isNa(a);
  const nb = isNa(b);
  if (na && nb) return true;
  if (na !== nb) return false;
  return (a as string).trim() === (b as string).trim();
}

// What each source reports for a given field on this location, this tick.
function observeField(
  field: SharedField,
  deal: OnboardingListItem | undefined,
  dealFetchedAt: string,
  mrp: MrpRecord | undefined,
  mrpFetchedAt: string,
  allowHubspot: boolean,
  allowMrp: boolean
): Observed {
  const obs: Observed = { hs: null, mrp: null };

  if (allowHubspot && deal) {
    const ts = deal.properties.hs_lastmodifieddate || dealFetchedAt;
    if (field === "opening_date") {
      const v = toIsoDate(getEffectiveOpeningDate(deal.properties)) || null;
      if (v) obs.hs = { value: v, ts };
    } else if (field === "tier") {
      // tierToTrackerTier maps null -> "Basic (+)"; don't fabricate that as an
      // observed HubSpot value when podplay_tier is actually empty.
      if (deal.properties.podplay_tier) obs.hs = { value: tierToTrackerTier(deal.properties.podplay_tier), ts };
    } else if (field === "presale_date") {
      // 17D — membership_presale_date on the Onboarding object (0-162), now in
      // LIST_PROPERTIES. Unlike opening_date/tier, presale is observed ALWAYS
      // (value = a real date, or "" when HubSpot is empty / "N/A"), so a
      // date<->empty transition is a detectable delta and syncs BOTH ways under
      // last-write-wins. Notes:
      //   - "" (empty string), not null, is the "observed empty" seen-value —
      //     distinct from null = "never observed" (a 15D-seeded row). That lets a
      //     later empty->date or date->empty move register as a change.
      //   - isNa() treats "", null and a literal "N/A" string alike, so a native
      //     date (empty when unset) and a text "N/A" both collapse to empty here.
      //   - toIsoDateStrict guards any non-date text to "", never the date column.
      obs.hs = { value: toIsoDateStrict(deal.properties.membership_presale_date) ?? "", ts };
    }
  }

  if (allowMrp && mrp) {
    if (field === "delivery_date") {
      const v = toIsoFromFlex(mrp.hardwareDeliveryDate);
      if (v) obs.mrp = { value: v, ts: mrpFetchedAt };
    } else if (field === "opening_date") {
      const v = toIsoFromFlex(mrp.grandOpening ?? mrp.softOpening);
      if (v) obs.mrp = { value: v, ts: mrpFetchedAt };
    }
    // delivery_date/opening_date are the only MRP-sourced shared fields.
  }

  return obs;
}

export async function runFieldSync(
  actorEmail: string,
  maxWrites: number = MAX_SYNC_WRITES_PER_TICK
): Promise<FieldSyncResult> {
  const admin = createAdminClient();

  const result: FieldSyncResult = {
    linkedScanned: 0,
    seeded: 0,
    overwritten: 0,
    fieldsChanged: 0,
    capped: false,
    hubspotSkippedPaused: false,
    mrpSkippedPaused: false,
  };

  const allowHubspot = await shouldAllowAutoImport("hubspot");
  const allowMrp = await shouldAllowAutoImport("mrp_sheets");
  result.hubspotSkippedPaused = !allowHubspot;
  result.mrpSkippedPaused = !allowMrp;
  if (!allowHubspot && !allowMrp) return result;

  const [{ data: locData, error }, basicSnap, proSnap, mrpSnap] = await Promise.all([
    admin.from("locations").select("*"),
    readSnapshot<PipelineDeals>("onboarding:basic"),
    readSnapshot<PipelineDeals>("onboarding:pro"),
    readSnapshot<MrpRecord[]>("mrp:records"),
  ]);
  if (error) throw new Error(error.message);

  const locations = (locData ?? []) as unknown as Location[];
  const linked = locations.filter((l) => l.hubspot_deal_id || l.mrp_row_key);
  result.linkedScanned = linked.length;
  if (linked.length === 0) return result;

  const dealFetchedAt = basicSnap?.fetchedAt ?? proSnap?.fetchedAt ?? new Date().toISOString();
  const dealById = new Map<string, OnboardingListItem>();
  for (const d of [...(basicSnap?.data.deals ?? []), ...(proSnap?.data.deals ?? [])]) dealById.set(d.id, d);
  const mrpFetchedAt = mrpSnap?.fetchedAt ?? new Date().toISOString();
  const mrpByClub = new Map((mrpSnap?.data ?? []).map((r) => [r.club, r]));

  const { data: ledgerData } = await admin
    .from("location_field_sync")
    .select("*")
    .in(
      "location_id",
      linked.map((l) => l.id)
    );
  const ledger = new Map<string, LocationFieldSync>();
  for (const row of (ledgerData ?? []) as unknown as LocationFieldSync[]) {
    ledger.set(`${row.location_id} ${row.field_name}`, row);
  }

  const now = new Date().toISOString();

  // Every ledger row we (re)write this tick — both silent baselines/seen-value
  // refreshes and real overwrites. Bulk-upserted at the end.
  const ledgerWrites: LocationFieldSync[] = [];
  interface PendingChange {
    loc: Location;
    updates: Partial<Record<SharedField, string | null>>;
    // 17D — target for the presale_date_na flag written alongside the date:
    //   true  -> HubSpot cleared its presale (date -> empty): tracker goes N/A
    //   false -> a genuine presale value flowed in: clear any prior N/A
    //   undefined -> leave the flag untouched
    presaleNa?: boolean;
    logLines: string[];
  }
  const pending: PendingChange[] = [];
  let stop = false;

  for (const loc of linked) {
    if (stop) break;
    const deal = loc.hubspot_deal_id ? dealById.get(loc.hubspot_deal_id) : undefined;
    const mrp = loc.mrp_row_key ? mrpByClub.get(loc.mrp_row_key) : undefined;

    let change: PendingChange | null = null;

    for (const field of SHARED_FIELDS) {
      const obs = observeField(field, deal, dealFetchedAt, mrp, mrpFetchedAt, allowHubspot, allowMrp);
      if (!obs.hs && !obs.mrp) continue; // no external source for this field

      const key = `${loc.id} ${field}`;
      const prev = ledger.get(key);
      const current = (loc[field] ?? null) as string | null;
      // 17D — presale_date carries a sibling "confirmed N/A" flag (locations
      // .presale_date_na). It's driven purely by what HubSpot reports under LWW:
      // a HubSpot value fills the date + clears the flag; a HubSpot clear
      // (date -> empty) sets the flag; a CSA toggle sets it directly and sticks
      // while HubSpot stays unchanged. The flag isn't read here — the value-delta
      // engine decides, and presaleNa targets are set on the pending change.
      const isPresale = field === "presale_date";

      // First sight: capture a baseline. Fill a blank from an available source;
      // never overwrite a non-blank value on first contact (we don't yet know
      // whether it was a CSA edit). Record seen-values either way.
      if (!prev) {
        let baseValue = current;
        let baseSource: FieldSyncSource = "tracker";
        let baseTs = now;
        if (isNa(current)) {
          // Prefer the newest source that actually has a value. Only genuine
          // values are candidates, so a blank HubSpot never fills over N/A; a
          // genuine one does, and clears the N/A flag.
          const cands = [obs.hs && { ...obs.hs, source: "hubspot" as const }, obs.mrp && { ...obs.mrp, source: "mrp" as const }].filter(
            Boolean
          ) as { value: string | null; ts: string; source: FieldSyncSource }[];
          const pick = cands.filter((c) => !isNa(c.value)).reduce<(typeof cands)[number] | null>(
            (a, b) => (a && newer(a.ts, b.ts) ? a : b),
            null
          );
          if (pick) {
            baseValue = pick.value;
            baseSource = pick.source;
            baseTs = pick.ts;
            change ??= { loc, updates: {}, logLines: [] };
            change.updates[field] = pick.value;
            // pick is always a genuine value (empties filtered out), so a presale
            // fill clears any confirmed-N/A state.
            if (isPresale) change.presaleNa = false;
            change.logLines.push(`${field}: filled "${pick.value}" (${pick.source}, first sight)`);
            result.fieldsChanged++;
          }
        }
        ledgerWrites.push({
          location_id: loc.id,
          field_name: field,
          source: baseSource,
          source_updated_at: baseTs,
          value: baseValue,
          hubspot_seen_value: obs.hs ? obs.hs.value : null,
          mrp_seen_value: obs.mrp ? obs.mrp.value : null,
          updated_at: now,
        });
        if (isNa(current)) result.seeded += change?.updates[field] !== undefined ? 0 : 1;
        else result.seeded++;
        continue;
      }

      // A source CHANGED the field iff its freshly-observed value differs from
      // what it reported last sync (per-field delta — not a timestamp bump).
      // A null seen-value means "never observed" (e.g. the ledger row was just
      // created by a tracker edit) — capture it as a baseline this tick, don't
      // treat it as a change (that would revert the edit with the stale external
      // value). Real deltas are detected from the next sync on.
      const hsChanged = obs.hs && prev.hubspot_seen_value !== null && !sameValue(obs.hs.value, prev.hubspot_seen_value);
      const mrpChanged = obs.mrp && prev.mrp_seen_value !== null && !sameValue(obs.mrp.value, prev.mrp_seen_value);

      // 17D presale fill: 15D seeded presale ledger rows with null seen-values
      // BEFORE presale was ever observed, so the delta test above can never fire
      // for the "tracker blank, HubSpot populated" case (Reaction Lab). A blank
      // OR confirmed-N/A presale should adopt a genuine HubSpot value regardless
      // of the stale baseline — filling can't revert a real CSA date, and a
      // genuine value legitimately supersedes N/A (the win path clears the flag).
      // N/A still sticks when HubSpot is blank, because obs.hs is null then.
      // Scoped to presale_date so opening_date/tier behavior is unchanged (those
      // have no N/A sentinel; a blank there stays ambiguous).
      const hsPresaleFill = Boolean(isPresale && isNa(current) && obs.hs && !isNa(obs.hs.value));

      // Always refresh seen-values to this tick's observation, so "changed"
      // means "changed since last sync" going forward.
      const nextHsSeen = obs.hs ? obs.hs.value : prev.hubspot_seen_value;
      const nextMrpSeen = obs.mrp ? obs.mrp.value : prev.mrp_seen_value;

      // Winner among sources that actually changed AND whose value differs from
      // what's currently stored (a same-as-current change is a no-op write).
      const winners = [
        (hsChanged || hsPresaleFill) && obs.hs && !sameValue(obs.hs.value, current) ? { ...obs.hs, source: "hubspot" as const } : null,
        mrpChanged && obs.mrp && !sameValue(obs.mrp.value, current) ? { ...obs.mrp, source: "mrp" as const } : null,
      ].filter(Boolean) as { value: string | null; ts: string; source: FieldSyncSource }[];

      const win = winners.reduce<(typeof winners)[number] | null>((a, b) => (a && newer(a.ts, b.ts) ? a : b), null);

      if (win) {
        change ??= { loc, updates: {}, logLines: [] };
        // presale: an empty win ("" — HubSpot cleared its value) writes null to
        // the date column and flips the tracker to confirmed-N/A; a genuine win
        // writes the date and clears N/A. Other fields write win.value as-is.
        const presaleEmptyWin = isPresale && isNa(win.value);
        change.updates[field] = presaleEmptyWin ? null : win.value;
        if (isPresale) change.presaleNa = presaleEmptyWin;
        change.logLines.push(`${field}: "${current ?? "—"}" -> "${presaleEmptyWin ? "N/A" : win.value ?? "—"}" (${win.source} changed)`);
        result.fieldsChanged++;
        ledgerWrites.push({
          location_id: loc.id,
          field_name: field,
          source: win.source,
          source_updated_at: win.ts,
          value: win.value,
          hubspot_seen_value: nextHsSeen,
          mrp_seen_value: nextMrpSeen,
          updated_at: now,
        });
      } else if (nextHsSeen !== prev.hubspot_seen_value || nextMrpSeen !== prev.mrp_seen_value) {
        // No overwrite, but a source's observed value moved (e.g. it changed to
        // match the current tracker value, or changed while paused-out). Persist
        // the refreshed seen-values; keep the existing winner metadata + value.
        ledgerWrites.push({
          location_id: loc.id,
          field_name: field,
          source: prev.source,
          source_updated_at: prev.source_updated_at,
          value: prev.value,
          hubspot_seen_value: nextHsSeen,
          mrp_seen_value: nextMrpSeen,
          updated_at: now,
        });
      }
    }

    if (change) {
      pending.push(change);
      if (pending.length >= maxWrites) {
        result.capped = true;
        stop = true;
      }
    }
  }

  // Apply real value changes: per-location UPDATE + one audit log each.
  for (const change of pending) {
    const updates: Record<string, unknown> = { ...change.updates };
    if (change.presaleNa !== undefined) updates.presale_date_na = change.presaleNa;
    const { error: upErr } = await admin
      .from("locations")
      .update(updates as never)
      .eq("id", change.loc.id);
    if (upErr) {
      result.fieldsChanged -= change.logLines.length;
      continue;
    }
    await admin.from("activity_log").insert({
      user_email: actorEmail,
      action: "updated",
      entity: change.loc.name,
      details: `Sync (last-write-wins): ${change.logLines.join("; ")}`,
    } as never);
    result.overwritten++;
  }

  // Persist all ledger rows (baselines, seen-value refreshes, and winners) in one
  // round trip. Only fields whose location UPDATE succeeded matter for value
  // correctness; a ledger row for a failed-update field just re-decides next tick.
  if (ledgerWrites.length) {
    await admin
      .from("location_field_sync")
      .upsert(ledgerWrites as never, { onConflict: "location_id,field_name" });
  }

  return result;
}
