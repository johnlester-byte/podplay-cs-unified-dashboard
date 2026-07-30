"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  type ColumnDef,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  Columns3,
  ChevronRight,
  ClipboardList,
  ExternalLink,
  Filter,
  MoreHorizontal,
  PackageCheck,
  PackageX,
  Plus,
  Search,
  ShieldAlert,
  Truck,
  UserX,
} from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import {
  computeClientStats,
  formatDate,
  formatRelativeDays,
  isFollowUpOverdue,
  isOpenedThisMonth,
  isOpeningThisWeek,
  openReadinessChecklist,
  STATUS_BADGE_VARIANT,
  STATUS_LABEL,
} from "@/lib/client-hub";
import { OPENING_TIER_TEXT_CLASS } from "@/lib/opening-date-status";
import {
  boxDeliveredTier,
  boxShippedTier,
  boxSummary,
  getBoxCells,
  isNa,
  parseFlexDate,
} from "@/lib/tracker-mrp";
import { computeRowFlags, type RowFlags } from "@/lib/tracker-flags";
import type { MrpRecord } from "@/lib/mrp";
import type { Location, LocationStatus } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusQuickEdit } from "@/components/clients/status-quick-edit";
import { ClientDetailSheet } from "@/components/clients/client-detail-sheet";
import { ClientFormDialog } from "@/components/clients/client-form-dialog";
import { DeleteClientDialog } from "@/components/clients/delete-client-dialog";

type Tab = "active" | "opened" | "completed" | "archived";

interface ClientsTableProps {
  initialLocations: Location[];
  userEmail: string;
  loginRoster: string[];
  rosterMap: Record<string, string>;
  mrpByLocation: Record<string, MrpRecord | null>;
}

// Friendly labels for the Columns show/hide dropdown, keyed by column id.
// "date" is tab-dependent, resolved inline in the render.
const COLUMN_LABELS: Record<string, string> = {
  client_name: "Client Name",
  name: "Location",
  tier: "Tier",
  presale_date: "Pre-sale Date",
  hardware_delivery: "Hardware Delivery Date",
  box_shipped: "PP Hardware Box Shipped",
  box_delivered: "PP Hardware Box Delivered",
  qc_date: "QC Date",
  tracker: "Tracking",
  notes: "Notes",
  readiness: "Readiness",
  status: "Status",
  followUp: "Follow-up",
};

const STATUS_SORT_RANK: Record<LocationStatus, number> = {
  "on-track": 0,
  "at-risk": 1,
  delayed: 2,
  opened: 3,
  completed: 4,
  archived: 5,
};

type StatKey =
  | "total-active"
  | "at-risk"
  | "opening-week"
  | "followups"
  | "conflicting"
  | "qc-conflict"
  | "shipped-late"
  | "delivered-late"
  | "missing-dates"
  | "no-tracking"
  | "total-opened"
  | "opened-month";

function formatFlexDate(value: string | null): string {
  const d = parseFlexDate(value);
  if (!d) return value ?? "—";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// Empty required-for-completeness date: warning icon + dash, red. No extra text.
function MissingMark() {
  return (
    <span className={cn("inline-flex items-center gap-1", OPENING_TIER_TEXT_CLASS.overdue)}>
      <AlertTriangle className="h-3 w-3" />—
    </span>
  );
}

function SortableHeader({
  label,
  sorted,
  onClick,
}: {
  label: string;
  sorted: false | "asc" | "desc";
  onClick: () => void;
}) {
  const Icon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-1 hover:text-foreground">
      {label}
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

// Box-group column header — the single expand/collapse control for ALL rows.
function BoxGroupHeader({
  label,
  expanded,
  onToggle,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" onClick={onToggle} className="flex items-center gap-1 hover:text-foreground">
      {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

function FollowUpTag({ label, done, overdue }: { label: string; done: boolean; overdue: boolean }) {
  const variant = done ? "default" : overdue ? "amber" : "secondary";
  return (
    <Badge variant={variant} className="gap-1 text-[10px]">
      {done && <Check className="h-2.5 w-2.5" />}
      {label}
    </Badge>
  );
}

function BoxGroupCell({
  record,
  kind,
  expanded,
  alert,
}: {
  record: MrpRecord | null;
  kind: "shipped" | "delivered";
  expanded: boolean;
  alert: "late" | "overdue" | null;
}) {
  const cells = getBoxCells(record).filter((b) => b.applicable);
  if (!record || cells.length === 0) return <span className="text-muted-foreground">—</span>;
  const summary = boxSummary(record, kind);
  const label = kind === "shipped" ? "Shipped" : "Delivered";

  if (!expanded) {
    // Compact summary is just the N/M fraction — links live in the expanded
    // per-box view only.
    return (
      <span className={alert ? OPENING_TIER_TEXT_CLASS[alert] : ""}>
        {summary.done}/{summary.total} {label}
      </span>
    );
  }

  return (
    <div className="space-y-1 text-xs">
      {cells.map((b) => {
        const raw = kind === "shipped" ? b.shipped : b.delivered;
        const url = kind === "shipped" ? b.shippedUrl : b.deliveredUrl;
        const tier = kind === "shipped" ? boxShippedTier(record, b.index) : boxDeliveredTier(record, b.index);
        const hasDate = !isNa(raw);
        const display = hasDate ? formatFlexDate(raw) : kind === "shipped" ? "not shipped" : "not delivered";
        const tierClass = tier ? OPENING_TIER_TEXT_CLASS[tier] : "";
        return (
          <div key={b.index} className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Box {b.index}</span>
            {/* Only a cell with a real date AND a native sheet link becomes an
                anchor (e.g. UPS tracking); stopPropagation keeps the row's
                detail-sheet click from also firing. No link -> plain text. */}
            {hasDate && url ? (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  "inline-flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:decoration-solid",
                  tierClass
                )}
              >
                {display}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <span className={tierClass}>{display}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface ReadinessInfo {
  pct: number;
  token: string;
}

export function ClientsTable({
  initialLocations,
  userEmail,
  loginRoster,
  rosterMap,
  mrpByLocation,
}: ClientsTableProps) {
  const [locations, setLocations] = React.useState<Location[]>(initialLocations);
  const [readinessByLocation, setReadinessByLocation] = React.useState<Record<string, ReadinessInfo>>({});
  const [tab, setTab] = React.useState<Tab>("active");
  const [statFilter, setStatFilter] = React.useState<StatKey | null>(null);
  const [expandShipped, setExpandShipped] = React.useState(false);
  const [expandDelivered, setExpandDelivered] = React.useState(false);
  // Seed from the ?q deep-link (global search / cross-module jump), like ops-guide-shell.
  const searchParams = useSearchParams();
  const router = useRouter();
  const [search, setSearch] = React.useState(() => searchParams.get("q") ?? "");
  // Generic multi-select facet filters. Each holds the selected values for that
  // facet; empty = no constraint. OR within a facet, AND across facets.
  const [clientSel, setClientSel] = React.useState<string[]>([]);
  const [locationSel, setLocationSel] = React.useState<string[]>([]);
  const [tierSel, setTierSel] = React.useState<string[]>([]);
  const [trackerSel, setTrackerSel] = React.useState<string[]>([]);
  const [statusSel, setStatusSel] = React.useState<string[]>([]);
  const [sorting, setSorting] = React.useState<SortingState>([{ id: "date", desc: false }]);
  // Client Name hidden by default; user re-shows it via the Columns dropdown.
  // Session-scoped only (component state) — no browser storage, per project persistence rule.
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({ client_name: false });

  const [selected, setSelected] = React.useState<Location | null>(null);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Location | undefined>(undefined);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<Location | null>(null);

  React.useEffect(() => {
    refreshReadiness();
    const supabase = createClient();
    const channel = supabase
      .channel("locations-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "locations" }, () => {
        refresh();
      })
      .subscribe();
    const readinessChannel = supabase
      .channel("readiness-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "readiness" }, () => {
        refreshReadiness();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(readinessChannel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    const supabase = createClient();
    const { data, error } = await supabase.from("locations").select("*").order("opening_date");
    if (!error && data) setLocations(data);
  }

  async function refreshReadiness() {
    const supabase = createClient();
    const { data, error } = await supabase.from("readiness").select("*");
    if (error || !data) return;
    const rows = data as unknown as { location_id: string; pct: number; token: string }[];
    const map: Record<string, ReadinessInfo> = {};
    for (const r of rows) {
      map[r.location_id] = { pct: r.pct, token: r.token };
    }
    setReadinessByLocation(map);
  }

  async function handleOpenReadiness(locationId: string) {
    try {
      await openReadinessChecklist(locationId);
      refreshReadiness();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to open readiness checklist.");
    }
  }

  const flagsByLocation = React.useMemo(() => {
    const map: Record<string, RowFlags> = {};
    for (const l of locations) {
      map[l.id] = computeRowFlags(l, mrpByLocation[l.id] ?? null);
    }
    return map;
  }, [locations, mrpByLocation]);

  // Active = still being worked (not opened/completed/archived). The other three
  // are terminal states, each its own tab.
  const activeRows = React.useMemo(
    () => locations.filter((l) => l.status !== "opened" && l.status !== "completed" && l.status !== "archived"),
    [locations]
  );
  const openedRows = React.useMemo(() => locations.filter((l) => l.status === "opened"), [locations]);
  const completedRows = React.useMemo(() => locations.filter((l) => l.status === "completed"), [locations]);
  const archivedRows = React.useMemo(() => locations.filter((l) => l.status === "archived"), [locations]);
  const tabRows =
    tab === "opened" ? openedRows : tab === "completed" ? completedRows : tab === "archived" ? archivedRows : activeRows;

  // Dropdown options are scoped to the CURRENT tab's rows only — a value that
  // lives solely on the other tab (e.g. an opened-only client) never appears.
  const clients = React.useMemo(
    () => Array.from(new Set(tabRows.map((l) => l.client_name).filter(Boolean))) as string[],
    [tabRows]
  );

  const tiers = React.useMemo(
    () => Array.from(new Set(tabRows.map((l) => l.tier).filter(Boolean))) as string[],
    [tabRows]
  );

  // Distinct tracker names present in the current tab (tracker is a " | "-joined
  // list, so split before de-duping).
  const trackerNames = React.useMemo(() => {
    const set = new Set<string>();
    for (const l of tabRows) {
      (l.tracker ?? "")
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((n) => set.add(n));
    }
    return Array.from(set).sort();
  }, [tabRows]);

  const statuses = React.useMemo(
    () => Array.from(new Set(tabRows.map((l) => l.status))) as string[],
    [tabRows]
  );

  const trackerRoster = loginRoster;

  // Location options cascade off the selected clients (all locations when no
  // client is selected).
  const locationOptions = React.useMemo(() => {
    const scoped = clientSel.length === 0 ? tabRows : tabRows.filter((l) => clientSel.includes(l.client_name ?? ""));
    return Array.from(new Set(scoped.map((l) => l.name)));
  }, [tabRows, clientSel]);

  const activeFilterCount =
    clientSel.length + locationSel.length + tierSel.length + trackerSel.length + statusSel.length;

  function toggle(setter: React.Dispatch<React.SetStateAction<string[]>>, value: string) {
    setter((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }

  function clearFilters() {
    setClientSel([]);
    setLocationSel([]);
    setTierSel([]);
    setTrackerSel([]);
    setStatusSel([]);
  }

  // Which filter sections are expanded in the dropdown. Collapsed by default so
  // the menu stays short; selections persist regardless of collapse state.
  const [openSections, setOpenSections] = React.useState<Set<string>>(new Set());
  function toggleSection(label: string) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  // Predicate for each filterable stat card.
  const statMatches = React.useCallback(
    (key: StatKey, l: Location): boolean => {
      const f = flagsByLocation[l.id];
      switch (key) {
        case "at-risk":
          return l.status === "at-risk";
        case "opening-week":
          return isOpeningThisWeek(l);
        case "followups":
          return isFollowUpOverdue(l);
        case "opened-month":
          return isOpenedThisMonth(l);
        case "qc-conflict":
          return !!f?.qc;
        case "shipped-late":
          return f?.shippedOverdue ?? false;
        case "delivered-late":
          return f?.deliveredOverdue ?? false;
        case "missing-dates":
          return !!f && (f.missingOpening || f.missingPresale || f.missingHardware);
        case "no-tracking":
          return f?.noTracking ?? false;
        case "conflicting":
          // Real date conflicts only — NOT missing dates.
          return (
            !!f &&
            (!!f.qc ||
              f.shippedAlert !== null ||
              f.deliveredAlert !== null ||
              f.openingTier === "late" ||
              f.openingTier === "overdue")
          );
        default:
          return true;
      }
    },
    [flagsByLocation]
  );

  const filtered = React.useMemo(() => {
    return tabRows.filter((l) => {
      if (clientSel.length && !clientSel.includes(l.client_name ?? "")) return false;
      if (locationSel.length && !locationSel.includes(l.name)) return false;
      if (tierSel.length && !tierSel.includes(l.tier ?? "")) return false;
      if (trackerSel.length) {
        const names = (l.tracker ?? "").split("|").map((s) => s.trim());
        if (!trackerSel.some((t) => names.includes(t))) return false;
      }
      if (statusSel.length && !statusSel.includes(l.status)) return false;
      if (statFilter && statFilter !== "total-active" && statFilter !== "total-opened" && !statMatches(statFilter, l))
        return false;
      if (search) {
        const q = search.toLowerCase();
        const haystack = `${l.client_name ?? ""} ${l.name} ${l.tracker ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [tabRows, clientSel, locationSel, tierSel, trackerSel, statusSel, statFilter, statMatches, search]);

  const stats = React.useMemo(() => computeClientStats(locations), [locations]);

  // All Data Health / conflict counts are scoped to the CURRENT tab's rows so a
  // card never promises rows that live on the other tab (which produced a silent
  // empty table before).
  const count = React.useCallback((key: StatKey) => tabRows.filter((l) => statMatches(key, l)).length, [tabRows, statMatches]);

  function handleTabChange(next: Tab) {
    setTab(next);
    setStatFilter(null); // filters are tab-scoped; clear on switch
    clearFilters();
  }

  function handleStatCard(key: StatKey) {
    if (key === "total-active" || key === "total-opened") {
      setStatFilter(null);
      return;
    }
    setStatFilter((prev) => (prev === key ? null : key));
  }

  const columns = React.useMemo<ColumnDef<Location>[]>(() => {
    const groupedSort = (a: { original: Location }, b: { original: Location }) => {
      const client = (a.original.client_name ?? "").localeCompare(b.original.client_name ?? "");
      if (client !== 0) return client;
      return a.original.name.localeCompare(b.original.name);
    };

    const base: ColumnDef<Location>[] = [
      {
        header: ({ column }) => (
          <SortableHeader label="Client Name" sorted={column.getIsSorted()} onClick={() => column.toggleSorting(column.getIsSorted() === "asc")} />
        ),
        accessorKey: "client_name",
        sortingFn: groupedSort,
        cell: ({ row }) => row.original.client_name || "—",
      },
      {
        header: ({ column }) => (
          <SortableHeader label="Location" sorted={column.getIsSorted()} onClick={() => column.toggleSorting(column.getIsSorted() === "asc")} />
        ),
        accessorKey: "name",
        sortingFn: groupedSort,
      },
      {
        header: ({ column }) => (
          <SortableHeader label="Tier" sorted={column.getIsSorted()} onClick={() => column.toggleSorting(column.getIsSorted() === "asc")} />
        ),
        accessorKey: "tier",
        cell: ({ row }) => row.original.tier || "—",
      },
      {
        id: "date",
        header: ({ column }) => (
          <SortableHeader
            label={tab === "active" ? "Opening Date" : "Opened Date"}
            sorted={column.getIsSorted()}
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          />
        ),
        accessorFn: (l) => (tab === "active" ? l.opening_date : l.opened_date),
        cell: ({ row }) => {
          const l = row.original;
          const dateStr = tab === "active" ? l.opening_date : l.opened_date;
          if (tab === "active" && !dateStr) return <MissingMark />;
          const relative = formatRelativeDays(dateStr);
          const tier = tab === "active" ? flagsByLocation[l.id]?.openingTier ?? null : null;
          return (
            <div>
              <div className={tier ? OPENING_TIER_TEXT_CLASS[tier] : ""}>
                {formatDate(dateStr)}
                {tier === "overdue" && " (overdue)"}
              </div>
              {relative && <div className="text-xs text-muted-foreground">{relative}</div>}
            </div>
          );
        },
      },
      {
        id: "presale_date",
        header: ({ column }) => (
          <SortableHeader label="Pre-sale Date" sorted={column.getIsSorted()} onClick={() => column.toggleSorting(column.getIsSorted() === "asc")} />
        ),
        accessorFn: (l) => l.presale_date,
        cell: ({ row }) => {
          const l = row.original;
          if (l.presale_date) return formatDate(l.presale_date);
          if (l.presale_date_na) return <span className="text-muted-foreground">N/A</span>;
          return tab === "active" ? <MissingMark /> : <span className="text-muted-foreground">—</span>;
        },
      },
      {
        id: "hardware_delivery",
        header: ({ column }) => (
          <SortableHeader label="Hardware Delivery Date" sorted={column.getIsSorted()} onClick={() => column.toggleSorting(column.getIsSorted() === "asc")} />
        ),
        accessorFn: (l) => {
          const d = parseFlexDate(flagsByLocation[l.id]?.hardware.value ?? null);
          return d ? d.getTime() : 0;
        },
        cell: ({ row }) => {
          const f = flagsByLocation[row.original.id];
          const hw = f?.hardware ?? { value: null, source: null };
          if (!hw.value) {
            // Only required (non-Basic) active rows get the red missing nudge;
            // Basic (+) shows a plain dash.
            const needsFlag = tab === "active" && (f?.hardwareRequired ?? true);
            return needsFlag ? <MissingMark /> : <span className="text-muted-foreground">—</span>;
          }
          return (
            <div>
              <div>{formatFlexDate(hw.value)}</div>
              {hw.source === "manual" && <div className="text-xs text-muted-foreground">manual</div>}
            </div>
          );
        },
      },
      {
        id: "box_shipped",
        header: () => <BoxGroupHeader label="PP Hardware Box Shipped" expanded={expandShipped} onToggle={() => setExpandShipped((v) => !v)} />,
        enableSorting: false,
        cell: ({ row }) => (
          <BoxGroupCell
            record={mrpByLocation[row.original.id] ?? null}
            kind="shipped"
            expanded={expandShipped}
            alert={flagsByLocation[row.original.id]?.shippedAlert ?? null}
          />
        ),
      },
      {
        id: "box_delivered",
        header: () => <BoxGroupHeader label="PP Hardware Box Delivered" expanded={expandDelivered} onToggle={() => setExpandDelivered((v) => !v)} />,
        enableSorting: false,
        cell: ({ row }) => (
          <BoxGroupCell
            record={mrpByLocation[row.original.id] ?? null}
            kind="delivered"
            expanded={expandDelivered}
            alert={flagsByLocation[row.original.id]?.deliveredAlert ?? null}
          />
        ),
      },
      {
        id: "qc_date",
        header: "QC Date",
        enableSorting: false,
        cell: ({ row }) => {
          const f = flagsByLocation[row.original.id];
          if (!f?.recommendedQcDate && !f?.manualQcDate) return <span className="text-muted-foreground">—</span>;
          const fmt = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
          const conflictCls = f.qc ? OPENING_TIER_TEXT_CLASS[f.qc.tier] : "";
          return (
            <div className="space-y-0.5 text-sm">
              {f.recommendedQcDate && (
                <div className={f.qcSource === "recommended" ? conflictCls : ""} title={f.qcSource === "recommended" ? f.qc?.message : undefined}>
                  <span className="text-xs text-muted-foreground">Recommended: </span>
                  {fmt(f.recommendedQcDate)}
                </div>
              )}
              {f.manualQcDate && (
                <div className={f.qcSource === "manual" ? conflictCls : ""} title={f.qcSource === "manual" ? f.qc?.message : undefined}>
                  <span className="text-xs text-muted-foreground">Manual: </span>
                  {fmt(f.manualQcDate)}
                </div>
              )}
            </div>
          );
        },
      },
      {
        header: ({ column }) => (
          <SortableHeader label="Tracking" sorted={column.getIsSorted()} onClick={() => column.toggleSorting(column.getIsSorted() === "asc")} />
        ),
        accessorKey: "tracker",
        cell: ({ row }) => {
          const f = flagsByLocation[row.original.id];
          if (f?.noTracking)
            return (
              <span className={cn("inline-flex items-center gap-1", OPENING_TIER_TEXT_CLASS.overdue)}>
                <AlertTriangle className="h-3 w-3" />None
              </span>
            );
          return row.original.tracker;
        },
      },
      {
        header: "Notes",
        accessorKey: "notes",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="line-clamp-2 max-w-xs text-sm text-muted-foreground">{row.original.notes || "—"}</span>
        ),
      },
      {
        id: "readiness",
        header: "Readiness",
        enableSorting: false,
        cell: ({ row }) => {
          const info = readinessByLocation[row.original.id];
          return (
            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <Progress value={info?.pct ?? 0} className="h-1.5 w-16" />
              <span className="w-8 text-xs text-muted-foreground">{info?.pct ?? 0}%</span>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleOpenReadiness(row.original.id)}>
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        },
      },
      {
        header: ({ column }) => (
          <SortableHeader label="Status" sorted={column.getIsSorted()} onClick={() => column.toggleSorting(column.getIsSorted() === "asc")} />
        ),
        accessorFn: (l) => STATUS_SORT_RANK[l.status],
        id: "status",
        cell: ({ row }) => <StatusQuickEdit location={row.original} userEmail={userEmail} onChanged={refresh} />,
      },
      {
        id: "followUp",
        header: ({ column }) => (
          <SortableHeader label="Follow-up" sorted={column.getIsSorted()} onClick={() => column.toggleSorting(column.getIsSorted() === "asc")} />
        ),
        accessorFn: (l) => (isFollowUpOverdue(l) ? 1 : 0),
        cell: ({ row }) => {
          const l = row.original;
          const overdue = isFollowUpOverdue(l);
          return (
            <div className="flex gap-1">
              <FollowUpTag label="Pre" done={l.pre_open_done} overdue={overdue && !l.pre_open_done} />
              <FollowUpTag label="Post" done={l.post_open_done} overdue={overdue && !l.post_open_done} />
            </div>
          );
        },
      },
    ];

    base.push({
      id: "actions",
      header: "",
      enableSorting: false,
      enableHiding: false,
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" onClick={(e) => e.stopPropagation()} className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                setSelected(row.original);
                setSheetOpen(true);
              }}
            >
              View details
            </DropdownMenuItem>
            {row.original.hubspot_deal_id ? (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  router.push(`/dashboard/onboarding?deal=${row.original.hubspot_deal_id}`);
                }}
              >
                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                Open in Onboarding
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled>
                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                Not linked to HubSpot
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                setEditing(row.original);
                setFormOpen(true);
              }}
            >
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                setDeleting(row.original);
                setDeleteOpen(true);
              }}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    });

    return base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, readinessByLocation, userEmail, mrpByLocation, flagsByLocation, expandShipped, expandDelivered]);

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="flex flex-col gap-6 [@media(min-height:768px)]:h-full [@media(min-height:768px)]:min-h-0">
      <div className="flex items-center justify-end gap-2">
        <Button
          className="gap-2"
          onClick={() => {
            setEditing(undefined);
            setFormOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          Add Client
        </Button>
      </div>

      {tab === "active" ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatCard compact label="Total Active" value={stats.totalActive} icon={ClipboardList} active={statFilter === null} onClick={() => handleStatCard("total-active")} />
            <StatCard compact label="At Risk" value={count("at-risk")} icon={AlertTriangle} active={statFilter === "at-risk"} onClick={() => handleStatCard("at-risk")} />
            <StatCard compact label="Opening This Week" value={count("opening-week")} icon={CalendarClock} active={statFilter === "opening-week"} onClick={() => handleStatCard("opening-week")} />
            <StatCard compact label="Follow-ups Overdue" value={count("followups")} icon={AlertTriangle} active={statFilter === "followups"} onClick={() => handleStatCard("followups")} />
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Data Health</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard compact label="Conflicting Dates" value={count("conflicting")} icon={ShieldAlert} tone="alert" active={statFilter === "conflicting"} onClick={() => handleStatCard("conflicting")} />
              <StatCard compact label="QC-to-Opening Conflict" value={count("qc-conflict")} icon={CalendarClock} tone="alert" active={statFilter === "qc-conflict"} onClick={() => handleStatCard("qc-conflict")} />
              <StatCard compact label="Not Shipped Past Delivery" value={count("shipped-late")} icon={Truck} tone="alert" active={statFilter === "shipped-late"} onClick={() => handleStatCard("shipped-late")} />
              <StatCard compact label="Not Delivered Past Delivery" value={count("delivered-late")} icon={PackageX} tone="alert" active={statFilter === "delivered-late"} onClick={() => handleStatCard("delivered-late")} />
              <StatCard compact label="Missing Required Dates" value={count("missing-dates")} icon={PackageCheck} tone="alert" active={statFilter === "missing-dates"} onClick={() => handleStatCard("missing-dates")} />
              <StatCard compact label="No Tracking" value={count("no-tracking")} icon={UserX} tone="alert" active={statFilter === "no-tracking"} onClick={() => handleStatCard("no-tracking")} />
            </div>
          </div>
        </>
      ) : tab === "opened" ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatCard compact label="Total Opened" value={openedRows.length} icon={CheckCircle2} active={statFilter === null} onClick={() => handleStatCard("total-opened")} />
          <StatCard compact label="Opened This Month" value={count("opened-month")} icon={CheckCircle2} active={statFilter === "opened-month"} onClick={() => handleStatCard("opened-month")} />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatCard
            compact
            label={tab === "completed" ? "Total Completed" : "Total Archived"}
            value={tabRows.length}
            icon={CheckCircle2}
            active={statFilter === null}
            onClick={() => setStatFilter(null)}
          />
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => handleTabChange(v as Tab)}>
        <TabsList>
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="opened">Opened</TabsTrigger>
          <TabsTrigger value="completed">Completed</TabsTrigger>
          <TabsTrigger value="archived">Archived</TabsTrigger>
        </TabsList>
      </Tabs>

      <Card>
        <CardContent className="flex items-center gap-2 p-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search by client, location, or tracking..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2">
                <Filter className="h-4 w-4" />
                Filter
                {activeFilterCount > 0 && (
                  <Badge variant="default" className="ml-1 h-5 min-w-5 justify-center px-1">
                    {activeFilterCount}
                  </Badge>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[70vh] w-60 overflow-y-auto">
              {(
                [
                  { label: "Client Name", opts: clients, sel: clientSel, setter: setClientSel },
                  { label: "Location", opts: locationOptions, sel: locationSel, setter: setLocationSel },
                  { label: "Tier", opts: tiers, sel: tierSel, setter: setTierSel },
                  { label: "Tracking", opts: trackerNames, sel: trackerSel, setter: setTrackerSel },
                  { label: "Status", opts: statuses, sel: statusSel, setter: setStatusSel },
                ] as const
              )
                .filter((f) => f.opts.length > 0)
                .map((f, i) => {
                  const open = openSections.has(f.label);
                  return (
                    <React.Fragment key={f.label}>
                      {i > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuItem
                        onSelect={(e) => {
                          e.preventDefault();
                          toggleSection(f.label);
                        }}
                        className="flex items-center justify-between font-medium"
                      >
                        <span className="flex items-center gap-2">
                          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          {f.label}
                        </span>
                        {f.sel.length > 0 && (
                          <Badge variant="secondary" className="h-5 min-w-5 justify-center px-1">
                            {f.sel.length}
                          </Badge>
                        )}
                      </DropdownMenuItem>
                      {open &&
                        f.opts.map((o) => (
                          <DropdownMenuCheckboxItem
                            key={o}
                            checked={f.sel.includes(o)}
                            onSelect={(e) => e.preventDefault()}
                            onCheckedChange={() => toggle(f.setter, o)}
                            className="pl-8"
                          >
                            {o}
                          </DropdownMenuCheckboxItem>
                        ))}
                    </React.Fragment>
                  );
                })}
              {activeFilterCount > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={(e) => { e.preventDefault(); clearFilters(); }} className="justify-center text-muted-foreground">
                    Clear all filters
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2">
                <Columns3 className="h-4 w-4" />
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[70vh] w-56 overflow-y-auto">
              {table
                .getAllLeafColumns()
                .filter((col) => col.getCanHide())
                .map((col) => {
                  const label =
                    col.id === "date"
                      ? tab === "active"
                        ? "Opening Date"
                        : "Opened Date"
                      : COLUMN_LABELS[col.id] ?? col.id;
                  return (
                    <DropdownMenuCheckboxItem
                      key={col.id}
                      checked={col.getIsVisible()}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(v) => col.toggleVisibility(!!v)}
                    >
                      {label}
                    </DropdownMenuCheckboxItem>
                  );
                })}
            </DropdownMenuContent>
          </DropdownMenu>
        </CardContent>
      </Card>

      {statFilter && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Filtered by stat card.</span>
          <Button variant="ghost" size="sm" className="h-7" onClick={() => setStatFilter(null)}>
            Clear
          </Button>
        </div>
      )}

      <Card className="hidden flex-col md:flex [@media(min-height:768px)]:min-h-0 [@media(min-height:768px)]:flex-1">
        <div className="overflow-auto [&>div]:overflow-visible [@media(min-height:768px)]:min-h-0 [@media(min-height:768px)]:flex-1">
          <Table>
            <TableHeader className="sticky top-0 z-10 [&_th]:bg-background">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                    {statFilter ? "No rows match this stat card. Clear the filter to see all rows." : "No clients match your filters."}
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => {
                  const f = flagsByLocation[row.original.id];
                  const attention = tab === "active" && !!f?.needsAttention;
                  return (
                    <TableRow
                      key={row.id}
                      title={f && f.issues.length > 0 ? f.issues.join("\n") : undefined}
                      className={cn("cursor-pointer", attention && "border-l-2 border-l-destructive/60 bg-destructive/[0.04]")}
                      onClick={() => {
                        setSelected(row.original);
                        setSheetOpen(true);
                      }}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                      ))}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Mobile card list — the 15-column table is unusable on phones. */}
      <div className="space-y-2 md:hidden">
        {table.getRowModel().rows.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            {statFilter ? "No rows match this stat card." : "No clients match your filters."}
          </Card>
        ) : (
          table.getRowModel().rows.map((row) => {
            const l = row.original;
            const f = flagsByLocation[l.id];
            const attention = tab === "active" && !!f?.needsAttention;
            const dateStr = tab === "active" ? l.opening_date : l.opened_date;
            const dateTier = tab === "active" ? f?.openingTier ?? null : null;
            const overdue = isFollowUpOverdue(l);
            const pct = readinessByLocation[l.id]?.pct ?? 0;
            return (
              <Card
                key={l.id}
                onClick={() => {
                  setSelected(l);
                  setSheetOpen(true);
                }}
                className={cn(
                  "cursor-pointer p-3",
                  attention && "border-l-2 border-l-destructive/60 bg-destructive/[0.04]"
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{l.client_name || "—"}</div>
                    <div className="truncate text-sm text-muted-foreground">{l.name}</div>
                  </div>
                  <Badge variant={STATUS_BADGE_VARIANT[l.status]} className="shrink-0">
                    {STATUS_LABEL[l.status]}
                  </Badge>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                  <div>
                    <span className="text-xs text-muted-foreground">Tier</span>
                    <div>{l.tier || "—"}</div>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">{tab === "active" ? "Opening" : "Opened"}</span>
                    <div className={dateTier ? OPENING_TIER_TEXT_CLASS[dateTier] : ""}>
                      {dateStr ? formatDate(dateStr) : tab === "active" ? <MissingMark /> : "—"}
                    </div>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Tracking</span>
                    <div className={f?.noTracking ? OPENING_TIER_TEXT_CLASS.overdue : ""}>
                      {f?.noTracking ? "None" : l.tracker}
                    </div>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Readiness</span>
                    <div className="flex items-center gap-2">
                      <Progress value={pct} className="h-1.5 flex-1" />
                      <span className="text-xs text-muted-foreground">{pct}%</span>
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-1">
                  <FollowUpTag label="Pre" done={l.pre_open_done} overdue={overdue && !l.pre_open_done} />
                  <FollowUpTag label="Post" done={l.post_open_done} overdue={overdue && !l.post_open_done} />
                </div>
              </Card>
            );
          })
        )}
      </div>

      <ClientDetailSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        location={(selected && locations.find((l) => l.id === selected.id)) ?? selected}
        mrpRecord={selected ? mrpByLocation[selected.id] ?? null : null}
        userEmail={userEmail}
        rosterMap={rosterMap}
        onEdit={(location) => {
          setSheetOpen(false);
          setEditing(location);
          setFormOpen(true);
        }}
        onChanged={refresh}
      />

      <ClientFormDialog open={formOpen} onOpenChange={setFormOpen} location={editing} userEmail={userEmail} trackerRoster={trackerRoster} onSaved={refresh} />

      <DeleteClientDialog open={deleteOpen} onOpenChange={setDeleteOpen} location={deleting} userEmail={userEmail} onDeleted={refresh} />
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  active,
  onClick,
  tone = "default",
  compact = false,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  active?: boolean;
  onClick?: () => void;
  tone?: "default" | "alert";
  compact?: boolean;
}) {
  const alertOn = tone === "alert" && value > 0;
  const cardCls = cn(
    "cursor-pointer transition-colors hover:border-accent/60",
    active && "border-accent ring-1 ring-accent",
    alertOn && "border-destructive/40"
  );
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick?.();
    }
  };

  if (compact) {
    return (
      <Card role="button" tabIndex={0} onClick={onClick} onKeyDown={handleKey} className={cn(cardCls, "p-2.5")}>
        <div className="flex items-center gap-2">
          <Icon className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", alertOn && "text-destructive")} />
          <div className="min-w-0">
            <div className={cn("text-lg font-bold leading-none", alertOn && "text-destructive")}>{value}</div>
            <div className="mt-1 truncate text-[11px] leading-tight text-muted-foreground" title={label}>{label}</div>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card role="button" tabIndex={0} onClick={onClick} onKeyDown={handleKey} className={cardCls}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className={cn("h-4 w-4 text-muted-foreground", alertOn && "text-destructive")} />
      </CardHeader>
      <CardContent>
        <div className={cn("text-2xl font-bold", alertOn && "text-destructive")}>{value}</div>
      </CardContent>
    </Card>
  );
}
