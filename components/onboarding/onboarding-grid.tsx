"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import useSWR, { preload } from "swr";
import { toast } from "sonner";
import { ExternalLink, RefreshCw, Search } from "lucide-react";

import { formatRelativeTime, PIPELINE_MAP, type HubspotOwner } from "@/lib/hubspot";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OnboardingCard } from "@/components/onboarding/onboarding-card";
import { OnboardingDetailSheet } from "@/components/onboarding/onboarding-detail-sheet";
import { TrackOpeningDialog } from "@/components/onboarding/track-opening-dialog";
import type { DealsResponse, OnboardingListItem, OnboardingSyncRefreshResponse, OwnersResponse } from "@/components/onboarding/onboarding-types";

const fetcher = (url: string) => fetch(url).then(async (res) => {
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "Request failed");
  return json;
});

// Fallback auto-refresh interval used only until /api/integrations/hubspot/polling
// resolves — after that, the interval (and whether auto-polling runs at all)
// comes from the shared api_integrations settings an admin controls. Focus/
// reconnect revalidation is intentionally OFF: tabbing in and out would
// otherwise trigger a fetch on every switch, and once the server cache TTL
// lapses that fetch hits HubSpot directly — the interval + manual refresh
// below are the only ways this ever re-fetches.
const REFRESH_INTERVAL = 30 * 60_000;

interface PollingSettings {
  autoPollIntervalMinutes: number;
  autoPollPaused: boolean;
  autoImportPaused: boolean;
  manualRefreshPaused: boolean;
  pausedAll: boolean;
  nextRefreshAllowedAt: string | null;
}

type PipelineKey = "basic" | "pro";
type SortMode = "recent" | "alpha" | "date";

interface OnboardingGridProps {
  userEmail: string;
  trackerName: string;
  trackerRoster: string[];
  trackedDealIds: Set<string>;
  autoImportEnabled: boolean;
}

export function OnboardingGrid({
  userEmail,
  trackerName,
  trackerRoster,
  trackedDealIds: initialTracked,
  autoImportEnabled: initialAutoImportEnabled,
}: OnboardingGridProps) {
  const [pipeline, setPipeline] = React.useState<PipelineKey>("basic");
  const [owner, setOwner] = React.useState<string>("all");
  const [sortMode, setSortMode] = React.useState<SortMode>("recent");
  // Seed from the ?q deep-link (global search / cross-module jump), like ops-guide-shell.
  const searchParams = useSearchParams();
  const [searchInput, setSearchInput] = React.useState(() => searchParams.get("q") ?? "");
  const [search, setSearch] = React.useState(() => searchParams.get("q") ?? "");
  // Seed from the ?deal deep-link (e.g. the tracker row's "Open in Onboarding"
  // button) so the detail sheet for that record opens on load — same lazy-init
  // pattern as ops-guide-shell's ?article handling. The sheet fetches full
  // detail by id, so this works even when the deal is in the non-default pipeline.
  const [selectedDealId, setSelectedDealId] = React.useState<string | null>(() => searchParams.get("deal"));
  const [trackDeal, setTrackDeal] = React.useState<OnboardingListItem | null>(null);
  const [trackedIds, setTrackedIds] = React.useState(initialTracked);
  const [, forceTick] = React.useState(0);

  // "Updated Xs ago" and the cooldown countdown would otherwise freeze until
  // the next poll/re-render — tick every second purely to recompute those live.
  React.useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  React.useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // revalidateOnFocus so a pause/interval change made by an admin in another
  // tab is reflected the moment this board regains focus, not up to 60s later.
  const { data: polling } = useSWR<PollingSettings>("/api/integrations/hubspot/polling", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
  });
  // MRP shares the same auto-poll interval as HubSpot (read above), but has
  // its own independent pause state — read separately so the board can show
  // "MRP sync skipped" without affecting the HubSpot half of a refresh.
  const { data: mrpPolling } = useSWR<PollingSettings>("/api/integrations/mrp_sheets/polling", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
  });
  const [combinedNextRefreshAllowedAt, setCombinedNextRefreshAllowedAt] = React.useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = React.useState(false);

  const buildDealsKey = React.useCallback(
    (forPipeline: PipelineKey) => {
      const params = new URLSearchParams({ pipeline: forPipeline });
      if (owner !== "all") params.set("owner", owner);
      if (search) params.set("search", search);
      return `/api/hubspot/deals?${params.toString()}`;
    },
    [owner, search]
  );
  const dealsKey = React.useMemo(() => buildDealsKey(pipeline), [buildDealsKey, pipeline]);

  // The inactive pipeline tab is never fetched until clicked, so the first
  // switch always eats a cold multi-second fetch. Warm its cache in the
  // background shortly after the active tab settles — low priority, doesn't
  // block or compete with the visible tab's own load.
  React.useEffect(() => {
    const otherPipeline: PipelineKey = pipeline === "basic" ? "pro" : "basic";
    const t = setTimeout(() => {
      preload(buildDealsKey(otherPipeline), fetcher);
    }, 2000);
    return () => clearTimeout(t);
  }, [pipeline, buildDealsKey]);

  // Auto-refresh pauses entirely (refreshInterval 0) when an admin has paused
  // all polling or auto polling specifically; otherwise the interval comes
  // live from the shared api_integrations setting, not a hardcoded constant.
  const autoRefreshInterval = !polling
    ? REFRESH_INTERVAL
    : polling.pausedAll || polling.autoPollPaused
      ? 0
      : polling.autoPollIntervalMinutes * 60_000;

  const { data, error, mutate } = useSWR<DealsResponse>(dealsKey, fetcher, {
    refreshInterval: autoRefreshInterval,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 15_000,
    keepPreviousData: true,
  });

  // keepPreviousData keeps `data` populated with the OLD pipeline's deals while
  // the new pipeline's fetch is in flight — filtering those against the new
  // pipeline's stage IDs mismatches almost everything, rendering a
  // near-empty grid that looks broken instead of loading. Only treat `data`
  // as usable once it actually echoes back the currently-selected pipeline.
  const currentData = data?.pipeline === pipeline ? data : undefined;

  const { data: ownersData } = useSWR<OwnersResponse>("/api/hubspot/owners", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 5 * 60_000,
  });
  const ownerMap = React.useMemo(() => {
    const map = new Map<string, HubspotOwner>();
    ownersData?.owners.forEach((o) => map.set(o.id, o));
    return map;
  }, [ownersData]);

  const deals = React.useMemo(() => {
    const list = currentData?.deals ?? [];
    const sorted = [...list];
    if (sortMode === "alpha") {
      sorted.sort((a, b) => (a.properties.hs_name ?? "").localeCompare(b.properties.hs_name ?? ""));
    } else if (sortMode === "date") {
      sorted.sort((a, b) => {
        const da = a.properties.grand_opening ?? a.properties.anticipated_opening;
        const db = b.properties.grand_opening ?? b.properties.anticipated_opening;
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return new Date(da).getTime() - new Date(db).getTime();
      });
    }
    // "recent" keeps the API's own hs_lastmodifieddate-desc order.
    return sorted;
  }, [currentData, sortMode]);
  const pipelineDef = PIPELINE_MAP[pipeline];

  const columns = React.useMemo(() => {
    return pipelineDef.stages.map((stage) => ({
      stage,
      deals: deals.filter((d) => d.properties.hs_pipeline_stage === stage.id),
    }));
  }, [pipelineDef, deals]);

  // Cooldown is derived from the server's shared next_refresh_allowed_at
  // (returned on every deals response, or the combined value from the last
  // onboarding-sync refresh — whichever is later) rather than a local click
  // timestamp, so every open tab's countdown reads identically and doesn't
  // re-enable until BOTH HubSpot and MRP are actually ready again.
  const effectiveNextRefreshAllowedAt = [data?.nextRefreshAllowedAt, combinedNextRefreshAllowedAt]
    .filter((t): t is string => Boolean(t))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
  const cooldownSeconds = effectiveNextRefreshAllowedAt
    ? Math.max(0, Math.ceil((new Date(effectiveNextRefreshAllowedAt).getTime() - Date.now()) / 1000))
    : 0;
  const manualRefreshDisabled =
    cooldownSeconds > 0 || Boolean(data?.manualRefreshPaused) || Boolean(data?.pausedAll) || Boolean(polling?.manualRefreshPaused) || Boolean(polling?.pausedAll);
  const manualRefreshReason = data?.pausedAll || polling?.pausedAll
    ? "All polling is paused by an admin."
    : data?.manualRefreshPaused || polling?.manualRefreshPaused
      ? "Manual refresh is paused by an admin."
      : undefined;

  async function handleManualRefresh() {
    if (manualRefreshDisabled || isRefreshing) return;
    setIsRefreshing(true);
    // 17E — the refresh route runs several sequential stages. A platform timeout
    // kills the function with NO response, so the fetch would otherwise hang
    // until the browser's own long default. Abort past the server ceiling and
    // tell the CSA honestly that some changes may not have applied, rather than
    // spinning silently. Work already committed server-side by earlier stages is
    // safe (each stage is idempotent); the next refresh or the cron finishes the
    // rest. Session 20 — widened 11s -> 30s: prod is now Vercel Pro (60s cap, was
    // Hobby's 10s), and the manual write budget rose to 25/stage, so a heavy
    // click can legitimately run longer than the old Hobby-era 11s without being
    // a real timeout. Still well under the 60s server ceiling.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    try {
      const params = new URLSearchParams({ pipeline });
      if (owner !== "all") params.set("owner", owner);
      if (search) params.set("search", search);
      const res = await fetch(`/api/onboarding-sync/refresh?${params.toString()}`, {
        method: "POST",
        signal: controller.signal,
      });
      const json = (await res.json()) as OnboardingSyncRefreshResponse & { error?: string };
      if (!res.ok) {
        toast.error(json.error ?? "Refresh failed.");
        return;
      }
      setCombinedNextRefreshAllowedAt(json.nextRefreshAllowedAt);
      // The sync route already rebuilt the snapshot server-side — revalidate so
      // the board (and its "Updated X ago") reflects the just-written snapshot.
      await mutate();
      // Surface what the refresh actually changed in the tracker, so a CSA
      // refresh that catches a new onboarding (17B) or a HubSpot/MRP date change
      // (17A) isn't a silent no-op. Import count leads (it's the new-record
      // signal the user is usually waiting on); field-sync count follows.
      const imported = json.importSync?.imported ?? 0;
      const synced = json.fieldSync?.overwritten ?? 0;
      const parts: string[] = [];
      if (imported > 0) {
        parts.push(`${imported} new ${imported === 1 ? "onboarding" : "onboardings"} imported`);
      }
      if (synced > 0) {
        parts.push(`${synced} ${synced === 1 ? "record" : "records"} synced from HubSpot/MRP`);
      }
      if (parts.length > 0) {
        toast.success(`Refreshed — ${parts.join(", ")}.`);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Hit the client cap — the server may still be finishing. Be honest:
        // some changes might not have applied; a follow-up refresh is safe.
        toast.warning(
          "Refresh is taking longer than expected — some changes may not have applied. Try again shortly.",
        );
        // Revalidate anyway: earlier stages likely committed the snapshot before
        // the abort, so the board can still reflect what did land.
        await mutate();
      } else {
        toast.error("Refresh failed.");
      }
    } finally {
      clearTimeout(timeoutId);
      setIsRefreshing(false);
    }
  }

  function handleTracked(dealId: string) {
    setTrackedIds((prev) => new Set(prev).add(dealId));
  }

  // Auto-import ON unless the kill switch or the dedicated auto-import pause is
  // set — independent of the board's polling pause. Live from the same SWR poll
  // the refresh controls read, falling back to the server-rendered seed until it
  // resolves. Mirrors shouldAllowAutoImport("hubspot") server-side.
  const autoImportEnabled = polling
    ? !(polling.pausedAll || polling.autoImportPaused)
    : initialAutoImportEnabled;

  const [importingDealId, setImportingDealId] = React.useState<string | null>(null);

  async function handleImportNow(deal: OnboardingListItem) {
    setImportingDealId(deal.id);
    try {
      const res = await fetch("/api/onboarding/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: deal.id }),
      });
      const json = (await res.json()) as { status?: string; error?: string };
      if (!res.ok) {
        toast.error(json.error ?? "Import failed.");
        return;
      }
      setTrackedIds((prev) => new Set(prev).add(deal.id));
      toast.success(json.status === "exists" ? "Already in the tracker." : "Imported to the tracker.");
    } catch {
      toast.error("Import failed.");
    } finally {
      setImportingDealId(null);
    }
  }

  const hasAnyFilter = owner !== "all" || search.length > 0;

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-end gap-3">
          <div className="flex items-center gap-2">
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              {currentData?.fetchedAt ? `Updated ${formatRelativeTime(new Date(currentData.fetchedAt).toISOString())}` : "Loading…"}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={manualRefreshDisabled || isRefreshing}
              onClick={handleManualRefresh}
              className="gap-1.5"
              title={manualRefreshReason ?? (cooldownSeconds > 0 ? "Wait for the shared cooldown to clear." : undefined)}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
              {isRefreshing ? "Refreshing…" : cooldownSeconds > 0 ? `Refresh (${cooldownSeconds}s)` : "Refresh"}
            </Button>
            {(mrpPolling?.pausedAll || mrpPolling?.autoPollPaused) && (
              <span className="whitespace-nowrap text-xs text-muted-foreground">MRP sync skipped — paused</span>
            )}
            <Button size="sm" variant="outline" className="gap-1.5" asChild>
              <a href="https://app.hubspot.com/contacts/44006894/objects/0-162" target="_blank" rel="noreferrer">
                Open in HubSpot <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs value={pipeline} onValueChange={(v) => setPipeline(v as PipelineKey)}>
            <TabsList>
              <TabsTrigger value="basic">Basic (+)</TabsTrigger>
              <TabsTrigger value="pro">Pro/Auto (+)</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex flex-1 items-center justify-end gap-2">
            <div className="relative w-full max-w-[240px]">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search deal or contact…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="bg-muted/60 pl-8"
              />
            </div>
            <Select value={owner} onValueChange={setOwner}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder="All Owners" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Owners</SelectItem>
                {(ownersData?.owners ?? []).map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.firstName} {o.lastName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sortMode} onValueChange={(v) => setSortMode(v as SortMode)}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">Recently Updated</SelectItem>
                <SelectItem value="alpha">Alphabetical (A–Z)</SelectItem>
                <SelectItem value="date">Opening Date</SelectItem>
              </SelectContent>
            </Select>
            {currentData && <Badge variant="secondary">{deals.length} total</Badge>}
          </div>
        </div>
      </div>

      {error && !currentData && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load — try refreshing.
          <Button size="sm" variant="outline" className="ml-3" onClick={() => mutate()}>
            Retry
          </Button>
        </div>
      )}

      {!currentData && !error && (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[60vh] w-72 shrink-0 rounded-xl" />
          ))}
        </div>
      )}

      {currentData && deals.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-12 text-center">
          <p className="font-medium">No onboardings match your filters</p>
          <p className="text-sm text-muted-foreground">Try clearing filters or search.</p>
          {hasAnyFilter && (
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => {
                setOwner("all");
                setSearchInput("");
              }}
            >
              Clear filters
            </Button>
          )}
        </div>
      )}

      {deals.length > 0 && (
        <div className="flex flex-1 gap-4 overflow-x-auto pb-4">
          {columns.map(({ stage, deals: stageDeals }) => (
            <div key={stage.id} className="flex w-72 shrink-0 flex-col rounded-xl border border-border bg-secondary/50 shadow-sm">
              <div className="flex items-center justify-between rounded-t-xl border-b border-border bg-secondary px-3 py-2.5">
                <p className="truncate text-sm font-semibold text-foreground" title={stage.label}>
                  {stage.label}
                </p>
                <Badge variant="secondary" className="shrink-0 bg-background/70">
                  {stageDeals.length}
                </Badge>
              </div>
              <div className="max-h-[65vh] min-h-[80px] space-y-2 overflow-y-auto p-2">
                {stageDeals.length === 0 ? (
                  <p className="px-2 py-4 text-center text-xs text-muted-foreground">No onboardings</p>
                ) : (
                  stageDeals.map((deal) => (
                    <OnboardingCard
                      key={deal.id}
                      deal={deal}
                      owner={deal.properties.hubspot_owner_id ? ownerMap.get(deal.properties.hubspot_owner_id) : undefined}
                      isTracked={trackedIds.has(deal.id)}
                      stageIsClosed={stage.isClosed}
                      onOpen={() => setSelectedDealId(deal.id)}
                    />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <OnboardingDetailSheet
        dealId={selectedDealId}
        open={selectedDealId !== null}
        onOpenChange={(open) => !open && setSelectedDealId(null)}
        listItem={deals.find((d) => d.id === selectedDealId) ?? null}
        ownerMap={ownerMap}
        isTracked={selectedDealId ? trackedIds.has(selectedDealId) : false}
        onTrackOpening={(deal) => setTrackDeal(deal)}
        autoImportEnabled={autoImportEnabled}
        onImportNow={handleImportNow}
        isImporting={selectedDealId ? importingDealId === selectedDealId : false}
      />

      <TrackOpeningDialog
        deal={trackDeal}
        open={trackDeal !== null}
        onOpenChange={(open) => !open && setTrackDeal(null)}
        userEmail={userEmail}
        trackerName={trackerName}
        trackerRoster={trackerRoster}
        onTracked={handleTracked}
      />
    </div>
  );
}
