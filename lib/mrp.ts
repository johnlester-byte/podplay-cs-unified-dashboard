// MRP Google Sheet integration — read-only.
//
// Session 9: Viewer access is now LIVE (confirmed with a real spreadsheets.values.get
// on the DeploymentStatus tab). Column mapping below is derived from the REAL header
// row, no longer a guess:
//   - The sheet's first rows (0-4) are sheet-level summary cells (Total Clubs, Queue,
//     Revenue totals, etc.), NOT per-row data. The real header row is the one that
//     contains "Club" + "Tier" (index 5 at time of discovery); data rows follow it.
//     detectHeaderRow() finds it dynamically so a shifted summary block won't break us.
//   - Business name used for matching HubSpot companies is the "Club" column
//     (col 2). Note the sheet has TWO "Customer" headers: col 1 duplicates the
//     business name, col 10 (immediately before "Customer Email") is the human
//     contact name (e.g. "John Laaser"). Matching uses the business name only.
//   - Authoritative hardware-delivery-date column is "Hardware Delivery Date" (col 16) —
//     the Session 6 two-candidate ambiguity is resolved: there is one such column.
//   - "Progress Bar" is intentionally excluded (visual-only in the sheet).
// Never call any write/update/append Sheets API method from this file.
//
// Session 19B: the box Shipped/Delivered date cells carry NATIVE cell hyperlinks
// (Insert > Link — confirmed live: 218 such cells, all UPS tracking URLs; zero
// =HYPERLINK() formula cells, zero rich-text-run links). values.get returns cell
// VALUES only and cannot surface link metadata, so the read switched to a single
// spreadsheets.get grid call that returns both formattedValue (same display text
// values.get gave) AND the per-cell hyperlink. One call replaces one call — a
// quota wash at the same hourly + manual-refresh cadence. Link extraction is
// scoped to the 6 box columns (the only ones confirmed linked).

import { google } from "googleapis";
import { IntegrationPausedError, markRefreshed, recordCall, shouldAllowPoll, type PollTrigger } from "@/lib/api-health";

// Every meaningful per-row column on the DeploymentStatus tab, EXCEPT "Progress Bar".
export interface MrpRecord {
  club: string; // business/club name — the matching key against HubSpot company name
  customer: string | null; // human contact name (distinct from the business name)
  tier: string | null;
  courts: string | null;
  status: string | null;
  progress: string | null;
  appStatus: string | null;
  billingStatus: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  installer: string | null;
  installerPhone: string | null;
  installerEmail: string | null;
  hardwareDeliveryDate: string | null;
  daysRemaining: string | null;
  softOpening: string | null;
  grandOpening: string | null;
  dateEntered: string | null;
  origHardwareDeliveryRequest: string | null;
  ppHardwareBox1Shipped: string | null;
  ppHardwareBox1Delivered: string | null;
  ppHardwareBox2Shipped: string | null;
  ppHardwareBox2Delivered: string | null;
  ppHardwareBox3Shipped: string | null;
  ppHardwareBox3Delivered: string | null;
  // Native cell hyperlink (e.g. a UPS tracking URL) on the matching box date
  // cell, or null when that cell carries no link. Additive to the plain-value
  // fields above — a link can be added/removed in the sheet over time, so each
  // hourly/manual refresh re-derives these from the current grid.
  ppHardwareBox1ShippedUrl: string | null;
  ppHardwareBox1DeliveredUrl: string | null;
  ppHardwareBox2ShippedUrl: string | null;
  ppHardwareBox2DeliveredUrl: string | null;
  ppHardwareBox3ShippedUrl: string | null;
  ppHardwareBox3DeliveredUrl: string | null;
  dropship1Ordered: string | null;
  dropship1Delivered: string | null;
  dropship2Ordered: string | null;
  dropship2Delivered: string | null;
  installStart: string | null;
  installEnd: string | null;
  inventoryCheck: string | null;
}

const SHEET_TAB = process.env.MRP_SHEET_TAB || "DeploymentStatus";
const RANGE = `${SHEET_TAB}!A1:AZ`;

let cachedAuth: InstanceType<typeof google.auth.JWT> | null = null;
function getAuthClient(): InstanceType<typeof google.auth.JWT> | null {
  if (cachedAuth) return cachedAuth;
  const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const key = process.env.GOOGLE_SHEETS_PRIVATE_KEY;
  if (!email || !key) return null;
  cachedAuth = new google.auth.JWT({
    email,
    key: key.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return cachedAuth;
}

interface SheetsApiError {
  code?: number;
  status?: number;
  response?: { status?: number };
  message?: string;
}

// Grid read: cell display values plus per-cell native hyperlinks, positionally
// aligned (values[r][c] and links[r][c] describe the same cell). Trailing empty
// cells/rows are omitted by the API exactly as values.get omitted them, so the
// downstream index-based lookups (cell()/linkCell()) are unchanged.
interface SheetGrid {
  values: string[][];
  links: (string | null)[][];
}

async function fetchGrid(trigger: PollTrigger): Promise<SheetGrid> {
  const allowed = await shouldAllowPoll("mrp_sheets", trigger);
  if (!allowed) {
    throw new IntegrationPausedError("MRP sheet polling is currently paused by an admin.");
  }

  const empty: SheetGrid = { values: [], links: [] };
  const sheetId = process.env.MRP_SHEET_ID;
  const auth = getAuthClient();
  if (!sheetId || !auth) {
    await recordCall("mrp_sheets", {
      success: false,
      errorMessage: "MRP_SHEET_ID or Google Sheets service account credentials are not configured.",
    });
    return empty;
  }

  try {
    const sheets = google.sheets({ version: "v4", auth });
    // formattedValue = the same display string values.get returned; hyperlink =
    // the native cell link (null when absent). fields keeps the response lean.
    const res = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      ranges: [RANGE],
      fields: "sheets.data.rowData.values(formattedValue,hyperlink)",
    });
    await recordCall("mrp_sheets", { success: true });
    await markRefreshed("mrp_sheets");
    const rowData = res.data.sheets?.[0]?.data?.[0]?.rowData ?? [];
    const values = rowData.map((r) => (r.values ?? []).map((c) => c.formattedValue ?? ""));
    const links = rowData.map((r) => (r.values ?? []).map((c) => c.hyperlink ?? null));
    return { values, links };
  } catch (err) {
    const e = err as SheetsApiError;
    const status = e.code ?? e.status ?? e.response?.status;
    if (status === 403) {
      await recordCall("mrp_sheets", {
        success: false,
        statusCode: 403,
        errorMessage: "Viewer access not yet granted on the MRP sheet",
      });
    } else {
      await recordCall("mrp_sheets", {
        success: false,
        statusCode: typeof status === "number" ? status : undefined,
        errorMessage: e.message ?? "Unknown MRP sheet error",
      });
    }
    // Never throw — the rest of the app (sync chain, detail sheet) keeps
    // working with an empty result set on any Sheets API failure.
    return empty;
  }
}

function cell(row: string[], i: number): string | null {
  if (i < 0) return null;
  const v = row[i];
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

// Native hyperlink on a cell, or null. Empty string / whitespace URLs collapse
// to null so a stray link never produces a dead anchor downstream.
function linkCell(links: (string | null)[], i: number): string | null {
  if (i < 0) return null;
  const v = links[i];
  if (!v) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

// The real header row is not row 0 — the top of the sheet holds summary cells.
// Find the row that actually carries the per-row column headers ("Club" + "Tier").
function detectHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = rows[i].map((c) => c?.trim().toLowerCase());
    if (cells.includes("club") && cells.includes("tier")) return i;
  }
  return -1;
}

export async function getHardwareRecords(trigger: PollTrigger = "auto"): Promise<MrpRecord[]> {
  const { values: rows, links } = await fetchGrid(trigger);
  const headerRow = detectHeaderRow(rows);
  if (headerRow === -1) return [];

  const headers = rows[headerRow];
  // First occurrence of each header label.
  const idx = (label: string): number =>
    headers.findIndex((h) => h?.trim().toLowerCase() === label.toLowerCase());

  const clubCol = idx("club");
  if (clubCol === -1) return [];

  // "Customer" appears twice: the business-name copy (near the start) and the
  // human contact name directly before "Customer Email". Resolve the contact
  // column by its neighbor so the duplicate label doesn't collide.
  const customerEmailCol = idx("customer email");
  const customerCol = customerEmailCol > 0 ? customerEmailCol - 1 : -1;

  const col = {
    tier: idx("tier"),
    courts: idx("courts"),
    status: idx("status"),
    progress: idx("progress"),
    appStatus: idx("app status"),
    billingStatus: idx("billing status"),
    customerPhone: idx("customer phone"),
    installer: idx("installer"),
    installerPhone: idx("installer phone"),
    installerEmail: idx("installer email"),
    hardwareDeliveryDate: idx("hardware delivery date"),
    daysRemaining: idx("days remaining"),
    softOpening: idx("soft opening"),
    grandOpening: idx("grand opening"),
    dateEntered: idx("date entered"),
    origHardwareDeliveryRequest: idx("orig. hardware delivery request"),
    ppHardwareBox1Shipped: idx("pp hardware box 1 shipped"),
    ppHardwareBox1Delivered: idx("pp hardware box 1 delivered"),
    ppHardwareBox2Shipped: idx("pp hardware box 2 shipped"),
    ppHardwareBox2Delivered: idx("pp hardware box 2 delivered"),
    ppHardwareBox3Shipped: idx("pp hardware box 3 shipped"),
    ppHardwareBox3Delivered: idx("pp hardware box 3 delivered"),
    dropship1Ordered: idx("dropship 1 ordered"),
    dropship1Delivered: idx("dropship 1 delivered"),
    dropship2Ordered: idx("dropship 2 ordered"),
    dropship2Delivered: idx("dropship 2 delivered"),
    installStart: idx("install start"),
    installEnd: idx("install end"),
    inventoryCheck: idx("inventory check"),
  };

  // Zip each data row with its positionally-aligned link row so the box URL
  // lookups stay correct after the club-name filter drops empty rows.
  return rows
    .slice(headerRow + 1)
    .map((row, i) => ({ row, link: links[headerRow + 1 + i] ?? [] }))
    .filter(({ row }) => cell(row, clubCol))
    .map(({ row, link }) => ({
      club: cell(row, clubCol) as string,
      customer: cell(row, customerCol),
      tier: cell(row, col.tier),
      courts: cell(row, col.courts),
      status: cell(row, col.status),
      progress: cell(row, col.progress),
      appStatus: cell(row, col.appStatus),
      billingStatus: cell(row, col.billingStatus),
      customerEmail: cell(row, customerEmailCol),
      customerPhone: cell(row, col.customerPhone),
      installer: cell(row, col.installer),
      installerPhone: cell(row, col.installerPhone),
      installerEmail: cell(row, col.installerEmail),
      hardwareDeliveryDate: cell(row, col.hardwareDeliveryDate),
      daysRemaining: cell(row, col.daysRemaining),
      softOpening: cell(row, col.softOpening),
      grandOpening: cell(row, col.grandOpening),
      dateEntered: cell(row, col.dateEntered),
      origHardwareDeliveryRequest: cell(row, col.origHardwareDeliveryRequest),
      ppHardwareBox1Shipped: cell(row, col.ppHardwareBox1Shipped),
      ppHardwareBox1Delivered: cell(row, col.ppHardwareBox1Delivered),
      ppHardwareBox2Shipped: cell(row, col.ppHardwareBox2Shipped),
      ppHardwareBox2Delivered: cell(row, col.ppHardwareBox2Delivered),
      ppHardwareBox3Shipped: cell(row, col.ppHardwareBox3Shipped),
      ppHardwareBox3Delivered: cell(row, col.ppHardwareBox3Delivered),
      ppHardwareBox1ShippedUrl: linkCell(link, col.ppHardwareBox1Shipped),
      ppHardwareBox1DeliveredUrl: linkCell(link, col.ppHardwareBox1Delivered),
      ppHardwareBox2ShippedUrl: linkCell(link, col.ppHardwareBox2Shipped),
      ppHardwareBox2DeliveredUrl: linkCell(link, col.ppHardwareBox2Delivered),
      ppHardwareBox3ShippedUrl: linkCell(link, col.ppHardwareBox3Shipped),
      ppHardwareBox3DeliveredUrl: linkCell(link, col.ppHardwareBox3Delivered),
      dropship1Ordered: cell(row, col.dropship1Ordered),
      dropship1Delivered: cell(row, col.dropship1Delivered),
      dropship2Ordered: cell(row, col.dropship2Ordered),
      dropship2Delivered: cell(row, col.dropship2Delivered),
      installStart: cell(row, col.installStart),
      installEnd: cell(row, col.installEnd),
      inventoryCheck: cell(row, col.inventoryCheck),
    }));
}

// Business-name match. HubSpot company names carry the same business identity
// as the sheet's "Club" column ("Performance Pickleball RVA").
//
// Matching is token-based, NOT substring-based: a plain substring/containment
// test produces false positives — e.g. "Greystone Pickleball Club" literally
// contains the substring "onepickleballclub" (…greyst-ONE-PICKleball-club…),
// wrongly matching "One+ Pickleball Club". Instead we drop generic filler
// words ("pickleball", "club", "llc", …) and compare the DISTINCTIVE tokens.

const GENERIC_TOKENS = new Set(["pickleball", "club", "the", "llc", "inc", "co", "ltd", "and", "of"]);

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Distinctive tokens: lowercase alphanumeric words with generic filler removed.
// Empty if a name is ALL generic words.
function distinctiveTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !GENERIC_TOKENS.has(t));
}

// Sorted distinctive-token join, so word order doesn't matter.
function distinctiveKey(name: string): string {
  return distinctiveTokens(name).sort().join("|");
}

// The 3-tier algorithm below is name-source agnostic: each tier takes a name, a
// list of items, and a getName accessor. matchByCompanyNames wires it to
// MrpRecord.club; other callers (e.g. lib/tracker-link.ts linking against
// HubSpot onboarding names) reuse the SAME algorithm via matchNames + a getName
// so there is exactly one fuzzy-match implementation in the codebase.
// NOTE: scripts/verify-mrp-match.mjs mirrors this algorithm by hand — if the
// TIER LOGIC (not this plumbing) changes, update it too.

type NameGetter<T> = (item: T) => string | null | undefined;

// Tier 1 — exact normalized equality (fast, unambiguous).
function findExact<T>(name: string, items: T[], getName: NameGetter<T>): T | null {
  const target = normalize(name);
  if (!target) return null;
  return items.find((it) => normalize(getName(it) ?? "") === target) ?? null;
}

// Tier 2 — full distinctive-token-set equality. Tolerates trailing
// "Club"/"Pickleball" differences without substring false positives.
function findTokenSet<T>(name: string, items: T[], getName: NameGetter<T>): T | null {
  const key = distinctiveKey(name);
  if (!key) return null;
  return items.find((it) => distinctiveKey(getName(it) ?? "") === key) ?? null;
}

// Tier 3 — distinctive-token SUBSET/superset. Matches when one name's tokens
// are wholly contained in the other's — tolerates one side carrying an extra
// qualifier ("Casa Pickle" vs "Casa Pickle Space City") that neither system
// treats as generic. Guarded to a UNIQUE hit: an ambiguous name (e.g. bare
// "Casa Pickle" when the sheet has both Galleria AND Space City) returns null
// rather than guessing wrong. Token-subset ≠ raw substring, so it does NOT
// reintroduce the Session 9 "Greystone" ⊂ "One+ Pickleball Club" false
// positive ("greystone" and "one" share no token).
function findTokenSubset<T>(name: string, items: T[], getName: NameGetter<T>): T | null {
  const tokens = distinctiveTokens(name);
  if (tokens.length === 0) return null;
  const matches = items.filter((it) => {
    const rt = distinctiveTokens(getName(it) ?? "");
    if (rt.length === 0) return false;
    const [small, big] = tokens.length <= rt.length ? [tokens, rt] : [rt, tokens];
    const bigSet = new Set(big);
    return small.every((t) => bigSet.has(t));
  });
  return matches.length === 1 ? matches[0] : null;
}

const MATCH_TIERS = [findExact, findTokenSet, findTokenSubset];

// Generic matcher: tries a set of candidate names against a labeled list,
// tier-by-tier — every candidate is tried at the strictest tier before any
// candidate falls to a looser one, so a precise exact match on the specific
// name always beats a loose subset match on a less-specific candidate. Returns
// the first hit.
export function matchNames<T>(
  names: string | null | undefined | Array<string | null | undefined>,
  items: T[],
  getName: NameGetter<T>
): T | null {
  const candidates = (Array.isArray(names) ? names : [names]).filter(
    (n): n is string => Boolean(n && n.trim())
  );
  if (candidates.length === 0) return null;
  for (const tier of MATCH_TIERS) {
    for (const name of candidates) {
      const hit = tier(name, items, getName);
      if (hit) return hit;
    }
  }
  return null;
}

// Matches a set of candidate names (e.g. an onboarding's own name AND its
// parent company's name) against the MRP sheet's "Club" column.
export function matchByCompanyNames(
  names: string | null | undefined | Array<string | null | undefined>,
  records: MrpRecord[]
): MrpRecord | null {
  return matchNames(names, records, (r) => r.club);
}

export function matchByCompanyName(
  hubspotCompanyName: string | null | undefined,
  records: MrpRecord[]
): MrpRecord | null {
  return matchByCompanyNames(hubspotCompanyName, records);
}
