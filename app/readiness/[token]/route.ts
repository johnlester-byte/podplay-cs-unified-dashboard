import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: { token: string } }) {
  if (!UUID_RE.test(params.token)) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Is the viewer a signed-in PodPlay user? Customers open this via the token
  // link with no dashboard session. Used to gate internal-only controls (Clear).
  let isInternal = false;
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    isInternal = Boolean(user);
  } catch {
    isInternal = false;
  }

  // Look up the club tier (token -> readiness -> location). Basic tiers don't
  // require a QC call, so the form offers an "N/A" option for the QC date.
  let tier: string | null = null;
  try {
    const admin = createAdminClient();
    const rr = await admin.from("readiness").select("location_id").eq("token", params.token).maybeSingle();
    const locationId = (rr.data as { location_id?: string } | null)?.location_id;
    if (locationId) {
      const lr = await admin.from("locations").select("tier").eq("id", locationId).maybeSingle();
      tier = (lr.data as { tier?: string | null } | null)?.tier ?? null;
    }
  } catch {
    tier = null;
  }

  return new NextResponse(renderHtml(params.token, { tier, isInternal }), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function renderHtml(token: string, opts: { tier: string | null; isInternal: boolean }): string {
  const isBasic = (opts.tier ?? "").toLowerCase().includes("basic");
  const isInternal = opts.isInternal;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open Readiness</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; background: #f7f8fa; color: #1c2024;
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.wrap { max-width: 940px; margin: 0 auto; padding: 24px 20px 80px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 0; }
.sub { color: #5b6470; margin: 0 0 20px; font-size: 13.5px; }
.bar {
  position: sticky; top: 0; z-index: 20; background: #f7f8fa;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 12px 0; border-bottom: 1px solid #e3e6ea; margin-bottom: 18px;
}
.progress { flex: 1; min-width: 180px; height: 10px; background: #e3e6ea; border-radius: 6px; overflow: hidden; }
.progress > i { display: block; height: 100%; width: 0%; background: #2563eb; transition: width .25s; }
.pct { font-weight: 600; font-size: 14px; min-width: 96px; }
button {
  font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer;
  border: 1px solid #c7ccd2; background: #fff; color: #1c2024;
  border-radius: 7px; padding: 7px 13px;
}
button:hover { background: #eef0f3; }
button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
button.primary:hover { background: #1d4ed8; }
button.danger { color: #b4231f; border-color: #e0b6b4; }
button.danger:hover { background: #fceceb; }
.card { background: #fff; border: 1px solid #e3e6ea; border-radius: 12px; padding: 18px 20px; margin-bottom: 16px; }
.gate-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.gate-head .count { color: #5b6470; font-size: 13px; font-weight: 500; }
.gate-note { background: #f3f6ff; border-left: 3px solid #5573c9; padding: 9px 12px; border-radius: 6px; color: #2f3a52; font-size: 13.5px; margin: 12px 0; }
.gate-note.warn { background: #fff6ec; border-left-color: #d68a2e; color: #6b4a16; }
ul.items { list-style: none; padding: 0; margin: 14px 0 0; }
ul.items li { padding: 6px 0; border-top: 1px solid #f0f2f4; display: flex; gap: 10px; align-items: flex-start; }
ul.items li:first-child { border-top: none; }
ul.items input[type=checkbox] { margin-top: 3px; width: 17px; height: 17px; flex: none; cursor: pointer; }
ul.items label { cursor: pointer; }
.tag { font-size: 10.5px; font-weight: 700; letter-spacing: .03em; padding: 2px 6px; border-radius: 4px; margin-left: 6px; vertical-align: middle; white-space: nowrap; }
.tag.pulled { background: #e7eefc; color: #2f4d99; }
.tag.confirm { background: #ecfdf3; color: #067647; }
.tag.test { background: #fdeede; color: #9a6418; }
.tag.sign { background: #efe6f7; color: #6a3a99; }
.sub-list { list-style: disc; margin: 4px 0 2px 22px; padding: 0; color: #4a525c; font-size: 13.5px; }
.sub-list li { display: list-item; border: none; padding: 1px 0; }
.fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px,1fr)); gap: 12px 16px; margin-top: 6px; }
.field label { display: block; font-size: 12.5px; font-weight: 600; color: #5b6470; margin-bottom: 3px; }
.field input, .field select { width: 100%; padding: 7px 9px; border: 1px solid #c7ccd2; border-radius: 7px; font: inherit; font-size: 14px; background: #fff; }
.attest { margin-top: 14px; padding: 12px; background: #faf7fd; border: 1px solid #ece2f5; border-radius: 9px; }
.attest.warn { background: #fff6ec; border-color: #e3b26a; }
.attest .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.attest input[type=text] { flex: 1; min-width: 160px; padding: 6px 9px; border: 1px solid #c7ccd2; border-radius: 7px; font: inherit; }
.attest .chk { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.attest .chk input { width: 17px; height: 17px; }
.attest .stamp { color: #6a3a99; font-size: 12.5px; font-weight: 600; margin-top: 6px; min-height: 16px; }
table.matrix { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13.5px; }
table.matrix th, table.matrix td { border: 1px solid #e3e6ea; padding: 5px 7px; text-align: left; }
table.matrix th { background: #f3f4f6; font-size: 12.5px; }
table.matrix select { width: 100%; border: 1px solid #c7ccd2; border-radius: 6px; padding: 4px; font: inherit; font-size: 12.5px; }
table.matrix input[type=text] { width: 100%; border: 1px solid #d7dbe0; border-radius: 6px; padding: 4px 6px; font: inherit; font-size: 12.5px; }
.sel-pass { background: #eafaf0; }
.sel-fail { background: #fdeceb; }
.sel-na { background: #f1f2f4; }
.pathbox label.opt { display: flex; gap: 9px; align-items: flex-start; padding: 9px 0; border-top: 1px solid #f0f2f4; cursor: pointer; }
.pathbox label.opt:first-of-type { border-top: none; }
.pathbox input[type=radio] { margin-top: 3px; width: 17px; height: 17px; }
.pathbox .opt b { display: block; }
.pathbox .opt span { color: #4a525c; font-size: 13.5px; }
.muted { color: #5b6470; font-size: 13px; }
.save-status { font-size: 12px; color: #5b6470; }
input:disabled, select:disabled, textarea:disabled { background: #eef1f6; color: #94a3b8; cursor: not-allowed; }
.lock-note { display: none; background: #eff6ff; border: 1px solid #bfdbfe; color: #1d4ed8; padding: 10px 14px; border-radius: 9px; font-size: 13.5px; font-weight: 600; margin: 0 0 16px; }
.lock-note.on { display: block; }
@media print {
  body { background: #fff; }
  .bar, .no-print, .lock-note { display: none !important; }
  .card { break-inside: avoid; border-color: #ccc; }
  .wrap { max-width: none; padding: 0; }
  a[href]:after { content: ""; }
}
</style>
</head>
<body>
<div class="wrap">

  <div class="bar no-print">
    <div class="progress"><i id="barFill"></i></div>
    <span class="pct" id="barPct">0% ready</span>
    <span class="save-status" id="saveStatus"></span>
    <button class="primary" onclick="window.print()">Export PDF</button>
    ${isInternal ? '<button class="danger" onclick="clearAll()">Clear</button>' : ""}
  </div>

  <h1>Open Readiness</h1>
  <div class="lock-note" id="lockNote">This document is locked — the Club acknowledgment has been signed. Uncheck it below to make edits.</div>

  <!-- CONTEXT -->
  <div class="card">
    <div class="gate-head"><h2>Club context</h2></div>
    <div class="fields">
      <div class="field"><label>Club name</label><input data-k="club_name" type="text" oninput="saveNow()"></div>
      <div class="field"><label>Court / bay count</label><input data-k="courts" type="number" min="1" max="60" value="1" oninput="buildMatrix()"></div>
    </div>
  </div>

  <!-- DATES -->
  <div class="card">
    <div class="gate-head"><h2>Key dates</h2></div>
    <div class="fields">
      <div class="field"><label>Grand-opening date</label><input data-k="grand_open" type="date" oninput="checkDates()"></div>
      <div class="field"><label>Soft-opening date</label><input data-k="soft_open" type="date" oninput="checkDates()"></div>
      <div class="field"><label>QC call date</label><input data-k="qc_date" type="date" oninput="checkDates()">${isBasic ? '<label style="display:flex;gap:7px;align-items:center;margin-top:6px;font-size:13px;font-weight:500;color:#5b6470;cursor:pointer"><input type="checkbox" id="qcNa" style="width:16px;height:16px;flex:none;cursor:pointer" onchange="toggleQcNa()"> N/A — Basic tier (no QC call required)</label>' : ""}</div>
    </div>
    <div id="dateMsg" class="gate-note" style="display:none"></div>
    <p class="muted" style="margin:10px 0 0">Rule: the QC call must be at least 7 working days before the earliest customer-facing experience (grand or soft opening), and not on a Friday. Hardware must be installed before QC call.</p>
    <div id="shortTimeKeyDates" class="gate-note warn" style="display:none;margin-top:10px"><b>Not enough time.</b> The QC call is 7 or fewer working days before the soft-opening date, which leaves very little time to fix issues before Customers use the system. See the limited-time acknowledgment in the Agreement section at the bottom.</div>
  </div>

  <div id="gates"></div>

  <!-- SOFT OPENING MATRIX -->
  <div class="card">
    <div class="gate-head"><h2>Gate E — Soft-opening execution</h2><span class="count" id="matrixCount"></span></div>
    <p class="muted">Test every court and every function, not just scoreboards. Record a result for each function on each court / bay.</p>
    <div style="overflow-x:auto"><table class="matrix" id="matrix"></table></div>
    <ul class="items" id="gateF_extra"></ul>
    <div class="field" style="margin-top:12px"><label>Issues found during QC or independent testing (list exact issues)</label><textarea data-k="qc_issues" rows="3" style="width:100%;padding:7px 9px;border:1px solid #c7ccd2;border-radius:7px;font:inherit;font-size:14px" oninput="saveNow()"></textarea></div>
    <div class="attest" data-attest="F">
      <div class="chk"><input type="checkbox" data-ack="F"><label>I confirm the soft-opening tests above were performed and results recorded.</label></div>
      <div class="row"><input type="text" data-name="F" placeholder="Type your full name" oninput="stamp('F')"><input type="text" data-role="F" placeholder="Role" style="max-width:160px" oninput="stamp('F')"></div>
      <div class="stamp" data-stamp="F"></div>
    </div>
  </div>

  <!-- PATH -->
  <div class="card pathbox">
    <div class="gate-head"><h2>Agreement</h2></div>
    <p class="muted">Preferred path is <em>With PodPlay</em>. The typed name, role, and timestamp below are the acknowledgment of record for this document.</p>
    <label class="opt"><input type="radio" name="path" value="with" data-k="path" onchange="saveNow()"><span class="opt"><b>With PodPlay</b><span>The Club completes this process alongside PodPlay, and PodPlay verifies each gate together.</span></span></label>
    <label class="opt"><input type="radio" name="path" value="independent" data-k="path" onchange="saveNow()"><span class="opt"><b>Independent</b><span>The Club completes the process on its own and reports issues back; PodPlay confirms on receipt.</span></span></label>
    <label class="opt"><input type="radio" name="path" value="waive" data-k="path" onchange="saveNow()"><span class="opt"><b>Waive</b><span>The Club may open without completing the recommended process or soft opening. By selecting this, the Club acknowledges in writing that it proceeds at its own risk and that skipped checkpoints may surface problems at or after opening.</span></span></label>

    <div class="attest" data-attest="club" id="clubAttest" style="margin-top:16px">
      <div class="chk"><input type="checkbox" data-ack="club"><label id="clubAckLabel"><b>Club acknowledgment.</b> I confirm the path above and that the gates are complete or knowingly waived.</label></div>
      <div class="row"><input type="text" data-name="club" placeholder="Club representative full name" oninput="stamp('club')"><input type="text" data-role="club" placeholder="Role" style="max-width:160px" oninput="stamp('club')"></div>
      <div class="stamp" data-stamp="club"></div>
    </div>
    <div class="attest" data-attest="podplay">
      <div class="chk"><input type="checkbox" data-ack="podplay"><label><b>PodPlay acknowledgment.</b></label></div>
      <div class="row"><input type="text" data-name="podplay" placeholder="PodPlay representative full name" oninput="stamp('podplay')"><input type="text" data-role="podplay" placeholder="Role" style="max-width:160px" oninput="stamp('podplay')"></div>
      <div class="stamp" data-stamp="podplay"></div>
    </div>
  </div>


</div>

<script>
const TOKEN = ${JSON.stringify(token)};
const API_URL = "/api/readiness/" + TOKEN;

// Gate definitions (A-E, G). F is the matrix, handled separately.
const GATES = [
  { id:"A", title:"Gate A — Delivery & bill of materials",
    note:{t:"Missing or mismatched hardware caught here is cheap. Caught later, it delays opening.",k:"warn"},
    items:[
      {t:"All PodPlay hardware delivered to the Club", tag:"confirm"},
      {t:"Bill of materials matches what arrived — every line accounted for", tag:"confirm"},
      {t:"Any missing or short items logged", tag:"confirm", field:"missing_items", fieldPlaceholder:"List any missing or short items"}
    ]},
  { id:"B", title:"Gate B — Install complete & QC verification",
    note:{t:"The install is done per the installation guide and verified with PodPlay Ops.",k:""},
    items:[
      {t:"All required cables terminated and tested for continuity", tag:"confirm"},
      {t:"Cables dressed and secured; all hardware mounted per guide", tag:"confirm"},
      {t:"Credit card Terminal(s) configured and tested, if applicable", tag:"confirm"},
      {t:"Cameras installed and adjusted", tag:"confirm"},
      {t:"System confirmed fully operational, or note why it is not:", tag:"confirm", field:"sys_not_operational", fieldPlaceholder:"If not fully operational, explain why"}
    ] },
  { id:"C", title:"Gate C — Software & environment ready",
    items:[
      {t:"Stripe Express account linked; payment tested", tag:"confirm"},
      {t:"Pricing set and checked", tag:"confirm"},
      {t:"Membership structure + perks set and verified", tag:"confirm"},
      {t:"Coaching set-up confirmed: Coach tiers and splits (if applicable)", tag:"confirm"},
      {t:"iOS + Android Apps", tag:"test"},
      {t:"Liability Waiver shared and set on App", tag:"confirm"},
      {t:"MIGRATING: Customer CSV imported and verified with correct allocations", tag:"confirm", mig:true},
      {t:"MIGRATING: Confirmed whether imported Customers have ToS and Liability Waiver marked signed", tag:"confirm", mig:true},
      {t:"MIGRATING: Existing Reservations and Events rebuilt in PodPlay", tag:"confirm", mig:true},
      {t:"MIGRATING: Old-system shutoff scheduled and Customers notified of the new App", tag:"confirm", mig:true}
    ] },
  { id:"D", title:"Gate D — Staff readiness",
    note:{t:"Complete at least two weeks before opening.",k:""},
    items:[
      {t:"Every front-desk staff member completed the Manager and Staff PodPlay Academy course", tag:"confirm",
        sub:["Priority lessons: the Customer's Experience, the Overview Page, the Customer Page, Reviewing Purchases"]},
      {t:"Coach Management course completed by Coaches and Club GM, if applicable", tag:"confirm"}
    ] }
];

const GATE_G = { id:"G", title:"Gate F — Go / No-Go",
  note:{t:"These items clear before grand opening.",k:""},
  items:[
    {t:"Dates solidified (presale and open / go-live)", tag:"confirm"},
    {t:"Terminal (POS) working", tag:"test"},
    {t:"Signs, posters, and front desk QR codes printed and placed: Sign Waiver, iOS App, Android App", tag:"confirm"},
    {t:"Templates written for Events", tag:"confirm"},
    {t:"Website FAQ live with cancellation policy", tag:"confirm"}
  ], attest:true, attestText:"I confirm the items in this gate.", gonogo:true };

const FUNCTIONS = [
  ["reservation_app","Reservation + check-in"],
  ["openplay","Event sign-up + check-in"],
  ["scoreboard","Scoreboard — button + kiosk"],
  ["replay","Replay capture + playback"],
  ["security","Security camera access (auto+)"]
];

const GATE_F_EXTRA = [
  {t:"Customer check-in / entry / door access", tag:"confirm"}
];

const TAGS = { pulled:"Pulled", confirm:"Confirm", test:"Test", sign:"Sign" };
let state = {};
let saveTimer = null;

async function fetchState(){
  try {
    const res = await fetch(API_URL);
    if(!res.ok) return {};
    const json = await res.json();
    return json.data || {};
  } catch(e){ return {}; }
}

function setSaveStatus(text){
  const el = document.getElementById("saveStatus");
  if(el) el.textContent = text;
}

function persist(){
  clearTimeout(saveTimer);
  setSaveStatus("Saving…");
  saveTimer = setTimeout(async ()=>{
    const boxes=[...document.querySelectorAll('[data-item]')];
    const done=boxes.filter(b=>b.checked).length;
    const pct=boxes.length?Math.round(done/boxes.length*100):0;
    try {
      const res = await fetch(API_URL, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ data: state, pct })
      });
      setSaveStatus(res.ok ? "Saved" : "Failed to save");
    } catch(e) { setSaveStatus("Failed to save"); }
  }, 500);
}

function saveNow(){
  document.querySelectorAll("[data-k]").forEach(el=>{
    if(el.type==="radio"){ if(el.checked) state[el.dataset.k]=el.value; }
    else state[el.dataset.k]=el.value;
  });
  document.querySelectorAll("[data-item]").forEach(el=> state[el.dataset.item]=el.checked);
  document.querySelectorAll("[data-cell]").forEach(el=> state[el.dataset.cell]=el.value);
  document.querySelectorAll("[data-ack]").forEach(el=> state["ack_"+el.dataset.ack]=el.checked);
  document.querySelectorAll("[data-name]").forEach(el=> state["name_"+el.dataset.name]=el.value);
  document.querySelectorAll("[data-role]").forEach(el=> state["role_"+el.dataset.role]=el.value);
  updateProgress();
  persist();
}

function tagHtml(t){ return t ? '<span class="tag '+t+'">'+TAGS[t]+'</span>' : ""; }

function renderGate(g){
  const isMig = (state.migration||"new")==="migrating";
  let li = g.items.filter(it=> !it.mig || isMig).map(it=>{
    const key = "item_"+g.id+"_"+slug(it.t);
    let sub = it.sub ? '<ul class="sub-list">'+it.sub.map(s=>'<li>'+esc(s)+'</li>').join("")+'</ul>' : "";
    let fld = it.field ? '<input type="text" data-k="'+it.field+'" placeholder="'+esc(it.fieldPlaceholder||"")+'" style="display:block;margin-top:6px;width:100%;padding:6px 9px;border:1px solid #c7ccd2;border-radius:7px;font:inherit" oninput="saveNow()">' : "";
    let label = esc(it.t.replace(/^MIGRATING: /,""));
    return '<li><input type="checkbox" data-item="'+key+'" id="'+key+'" onchange="saveNow()"><label for="'+key+'">'+label+tagHtml(it.tag)+sub+'</label>'+fld+'</li>';
  }).join("");
  let note = g.note ? '<div class="gate-note '+(g.note.k||"")+'">'+esc(g.note.t)+'</div>' : "";
  let attest = g.attest ? attestHtml(g.id, g.attestText || "I confirm the items in this gate are complete and accurate.", g.gonogo) : "";
  return '<div class="card"><div class="gate-head"><h2>'+esc(g.title)+'</h2><span class="count" id="count_'+g.id+'"></span></div>'+note+'<ul class="items">'+li+'</ul>'+attest+'</div>';
}

function attestHtml(id, text, gonogo){
  const gg = gonogo ? '<select data-k="gonogo_decision" onchange="saveNow()" style="max-width:150px;padding:6px 9px;border:1px solid #c7ccd2;border-radius:7px;font:inherit"><option value="">Go / No-Go</option><option value="go">Go</option><option value="nogo">No-Go</option></select>' : "";
  return '<div class="attest" data-attest="'+id+'">'+
    '<div class="chk"><input type="checkbox" data-ack="'+id+'"><label>'+esc(text)+'</label></div>'+
    '<div class="row"><input type="text" data-name="'+id+'" placeholder="Type your full name" oninput="stamp(\\''+id+'\\')"><input type="text" data-role="'+id+'" placeholder="Role" style="max-width:160px" oninput="stamp(\\''+id+'\\')">'+gg+'</div>'+
    '<div class="stamp" data-stamp="'+id+'"></div></div>';
}

function buildMatrix(){
  const n = Math.max(1, Math.min(60, parseInt(getVal("courts"))||1));
  state.courts = String(n);
  let head = '<tr><th style="min-width:210px">Function</th>';
  for(let c=1;c<=n;c++) head += '<th>Court '+c+'</th>';
  head += '</tr>';
  let rows = FUNCTIONS.map(f=>{
    let tds = '';
    for(let c=1;c<=n;c++){
      const key = "cell_"+f[0]+"_"+c;
      tds += '<td><select data-cell="'+key+'" onchange="colorSel(this);saveNow()">'+
             '<option value="">—</option><option value="pass">Pass</option><option value="fail">Fail</option><option value="na">N/A</option></select></td>';
    }
    return '<tr><th>'+esc(f[1])+'</th>'+tds+'</tr>';
  }).join("");
  document.getElementById("matrix").innerHTML = head + rows;
  restore();
}

function renderExtras(){
  document.getElementById("gateF_extra").innerHTML = GATE_F_EXTRA.map(it=>{
    const key="item_F_"+slug(it.t);
    return '<li><input type="checkbox" data-item="'+key+'" id="'+key+'" onchange="saveNow()"><label for="'+key+'">'+esc(it.t)+tagHtml(it.tag)+'</label></li>';
  }).join("");
}

function colorSel(el){ el.classList.remove("sel-pass","sel-fail","sel-na"); if(el.value) el.classList.add("sel-"+el.value); }

function stamp(id){
  const nm=(getName(id)||"").trim();
  const st=document.querySelector('[data-stamp="'+id+'"]');
  if(st) st.textContent = nm ? ("Attested by "+nm+(getRole(id)?(" ("+getRole(id)+")"):"")+" — "+new Date().toLocaleString()) : "";
  saveNow();
}
function getName(id){ const e=document.querySelector('[data-name="'+id+'"]'); return e?e.value:""; }
function getRole(id){ const e=document.querySelector('[data-role="'+id+'"]'); return e?e.value:""; }
function getVal(k){ const e=document.querySelector('[data-k="'+k+'"]'); return e?e.value:""; }

function renderGates(){
  document.getElementById("gates").innerHTML = GATES.map(renderGate).join("");
}

function checkDates(){
  saveNow();
  const msg=document.getElementById("dateMsg");
  const naCb=document.getElementById("qcNa");
  if(naCb && naCb.checked){
    msg.className="gate-note";
    msg.innerHTML="QC call marked <b>N/A</b> — Basic tier does not require a QC call.";
    msg.style.display="block";
    updateShortTime("", getVal("soft_open"));
    return;
  }
  const qc=getVal("qc_date");
  const cand=[getVal("grand_open"),getVal("soft_open")].filter(Boolean).map(d=>new Date(d+"T00:00"));
  updateShortTime(qc, getVal("soft_open"));
  if(!qc || !cand.length){ msg.style.display="none"; return; }
  const earliest=new Date(Math.min.apply(null,cand));
  const qcDate=new Date(qc+"T00:00");
  let problems=[];
  if(qcDate.getDay()===5) problems.push("QC is on a Friday — move it earlier in the week.");
  const wd=workingDaysBetween(qcDate, earliest);
  if(wd<7) problems.push("Only "+wd+" working day(s) between QC and the earliest customer-facing date. Rule requires at least 7.");
  if(problems.length){ msg.className="gate-note warn"; msg.innerHTML="<b>QC scheduling issue:</b> "+problems.join(" "); msg.style.display="block"; }
  else { msg.className="gate-note"; msg.innerHTML="QC date clears the rule: "+wd+" working days before the earliest customer-facing date, and not a Friday."; msg.style.display="block"; }
}
function workingDaysBetween(a,b){
  if(b<=a) return 0; let d=new Date(a), n=0;
  while(d<b){ d.setDate(d.getDate()+1); const g=d.getDay(); if(g!==0&&g!==6) n++; }
  return n;
}
const CLUB_ACK_NORMAL = '<b>Club acknowledgment.</b> I confirm the path above and that the gates are complete or knowingly waived.';
const CLUB_ACK_LIMITED = '<b>Club acknowledgment.</b> I confirm the above and that there\\'s <b>limited-time</b>. By scheduling the QC call 6 or fewer working days before Customers walk in the Club, I confirm there is very little time to fix any issues found during this readiness check. PodPlay will work as quickly as possible to resolve issues, and I acknowledge and waive PodPlay\\'s responsibility to resolve issues found by any specific date, because the QC call was not scheduled with enough time before opening to Customers.';
function updateShortTime(qc, soft){
  const kd=document.getElementById("shortTimeKeyDates");
  const card=document.getElementById("clubAttest");
  const lbl=document.getElementById("clubAckLabel");
  let trigger=false;
  if(qc && soft){
    const wd=workingDaysBetween(new Date(qc+"T00:00"), new Date(soft+"T00:00"));
    if(wd<=6) trigger=true;
  }
  if(kd) kd.style.display = trigger ? "block" : "none";
  if(lbl) lbl.innerHTML = trigger ? CLUB_ACK_LIMITED : CLUB_ACK_NORMAL;
  if(card) card.classList.toggle("warn", trigger);
}

function updateProgress(){
  const boxes=[...document.querySelectorAll('[data-item]')];
  const done=boxes.filter(b=>b.checked).length;
  const pct=boxes.length?Math.round(done/boxes.length*100):0;
  document.getElementById("barFill").style.width=pct+"%";
  document.getElementById("barPct").textContent=pct+"% ready ("+done+"/"+boxes.length+")";
  GATES.concat([GATE_G]).forEach(g=>{
    const el=document.getElementById("count_"+g.id); if(!el) return;
    const gb=boxes.filter(b=>b.dataset.item.startsWith("item_"+g.id+"_"));
    el.textContent=gb.filter(b=>b.checked).length+"/"+gb.length;
  });
  const cells=[...document.querySelectorAll('[data-cell]')];
  const filled=cells.filter(c=>c.value).length;
  document.getElementById("matrixCount").textContent=filled+"/"+cells.length+" results recorded";
}

function restore(){
  document.querySelectorAll("[data-k]").forEach(el=>{
    if(el.dataset.k in state){ if(el.type==="radio"){ el.checked=(el.value===state[el.dataset.k]); } else el.value=state[el.dataset.k]; }
  });
  document.querySelectorAll("[data-item]").forEach(el=>{ if(el.dataset.item in state) el.checked=!!state[el.dataset.item]; });
  document.querySelectorAll("[data-cell]").forEach(el=>{ if(el.dataset.cell in state){ el.value=state[el.dataset.cell]; colorSel(el);} });
  document.querySelectorAll("[data-ack]").forEach(el=>{ const k="ack_"+el.dataset.ack; if(k in state) el.checked=!!state[k]; });
  document.querySelectorAll("[data-name]").forEach(el=>{ const k="name_"+el.dataset.name; if(k in state){ el.value=state[k]; stampSilent(el.dataset.name);} });
  document.querySelectorAll("[data-role]").forEach(el=>{ const k="role_"+el.dataset.role; if(k in state) el.value=state[k]; });
  const qn=document.getElementById("qcNa"); if(qn) qn.checked=!!state.qc_na;
}
function stampSilent(id){
  const nm=(getName(id)||"").trim();
  const st=document.querySelector('[data-stamp="'+id+'"]');
  if(st && nm) st.textContent = "Attested by "+nm+(getRole(id)?(" ("+getRole(id)+")"):"");
}

// QC-call "N/A" (Basic tier only). When on, the QC date is cleared/disabled and
// the scheduling rule is skipped. Re-enabling respects the club-ack lock.
function applyQcNa(){
  const cb=document.getElementById("qcNa"); if(!cb) return;
  const qc=document.querySelector('[data-k="qc_date"]');
  if(cb.checked){ if(qc){ qc.value=""; qc.disabled=true; } state.qc_date=""; }
  else if(qc && !isClubAcked()){ qc.disabled=false; }
}
function toggleQcNa(){
  const cb=document.getElementById("qcNa"); if(!cb) return;
  state.qc_na=cb.checked;
  applyQcNa();
  checkDates();
  saveNow();
}

function clearAll(){
  if(!confirm("Clear all entries and reset this document? This cannot be undone.")) return;
  state={};
  document.querySelectorAll("input,select").forEach(el=>{
    if(el.type==="checkbox"||el.type==="radio") el.checked=false;
    else if(el.dataset.k==="courts") el.value="1";
    else el.value="";
  });
  document.querySelectorAll(".stamp").forEach(s=>s.textContent="");
  document.getElementById("dateMsg").style.display="none";
  renderGates(); buildMatrix(); renderExtras(); restore(); applyQcNa(); updateProgress(); persist();
}

function slug(s){ return s.toLowerCase().replace(/[^a-z0-9]+/g,"_").slice(0,40); }
function esc(s){ return (s+"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

document.addEventListener("input", e=>{
  if(e.target.dataset && e.target.dataset.name!==undefined){
    const id=e.target.dataset.name;
    if(e.target.value.trim() && !state["ts_"+id]){ state["ts_"+id]=new Date().toLocaleString(); }
    if(!e.target.value.trim()) delete state["ts_"+id];
  }
});

function isClubAcked(){ const c=document.querySelector('[data-ack="club"]'); return !!(c && c.checked); }
function applyLock(){
  const locked = isClubAcked();
  document.querySelectorAll("input, select, textarea").forEach(el=>{
    if(el.closest(".attest")) return;
    el.disabled = locked;
  });
  document.querySelectorAll("button.danger").forEach(b=> b.disabled = locked);
  const note = document.getElementById("lockNote");
  if(note) note.classList.toggle("on", locked);
}

// INIT
(async function init(){
  state = await fetchState();
  renderGates();
  renderExtras();
  buildMatrix();
  (function placeG(){
    const holder=document.createElement("div");
    holder.innerHTML=renderGate(GATE_G);
    const pathCard=document.querySelector(".pathbox");
    pathCard.parentNode.insertBefore(holder.firstChild, pathCard);
  })();
  restore();
  updateProgress();
  checkDates();
  setSaveStatus("");
  const clubAck = document.querySelector('[data-ack="club"]');
  if(clubAck) clubAck.addEventListener("change", ()=>{ saveNow(); applyLock(); applyQcNa(); });
  applyLock();
  applyQcNa();
})();
</script>
</body>
</html>
`;
}
