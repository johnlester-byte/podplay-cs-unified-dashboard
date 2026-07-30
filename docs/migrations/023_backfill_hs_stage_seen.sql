-- Session 20 — one-time backfill for locations.hs_stage_seen (022 added it null,
-- no backfill). Every already-linked location started with hs_stage_seen = null,
-- so the ongoing status-sync in lib/tracker-sync.ts saw `null !== stageId` for
-- the ENTIRE installed base and treated all of them as "changed" on first run,
-- flooding the shared per-tick write budget and starving genuine Completed/
-- Archived transitions (some records never moved — the reported symptom).
--
-- This seeds hs_stage_seen from the CURRENT snapshot (data_cache — same source
-- the sync reads, NO live HubSpot fetch) for every linked row still null, AND
-- applies the real Completed/Archived transition where the current stage is
-- terminal, so a record already sitting in a terminal HubSpot stage today is
-- caught up now (not left until some FUTURE stage change trips the detector).
--
-- Terminal stage IDs are the Completed (isClosed) and MIA/No Response stages from
-- lib/hubspot.ts PIPELINE_MAP (basic + pro). Kept in sync with that map; this is
-- a one-time catch-up against the current snapshot, so no drift risk.
--
-- IDEMPOTENT: only touches rows where hs_stage_seen IS NULL. A second run matches
-- no rows (all seeded), updates nothing, logs nothing. Non-terminal stages seed
-- the baseline only and leave status untouched (a manual on-track/at-risk/delayed
-- edit is preserved — same rule as the ongoing sync).

with snap as (
  select d->>'id' as deal_id,
         d->'properties'->>'hs_pipeline_stage' as stage
  from data_cache c, jsonb_array_elements(c.data->'deals') d
  where c.key in ('onboarding:basic', 'onboarding:pro')
),
target as (
  select l.id,
         l.status as old_status,
         s.stage,
         case
           -- Completed (isClosed) stages: basic 1176600470, pro de53e7d9-...
           when s.stage in ('1176600470', 'de53e7d9-6b57-4701-b576-92de01c9ed65') then 'completed'
           -- MIA/No Response stages: basic 1325386753, pro 1325393545
           when s.stage in ('1325386753', '1325393545') then 'archived'
           else null  -- non-terminal: seed baseline only, do not change status
         end as new_status
  from locations l
  join snap s on s.deal_id = l.hubspot_deal_id
  where l.hubspot_deal_id is not null
    and l.hs_stage_seen is null
    and s.stage is not null
),
upd as (
  update locations l
  set hs_stage_seen = t.stage,
      status = case
                 when t.new_status is not null and l.status <> t.new_status then t.new_status
                 else l.status
               end
  from target t
  where l.id = t.id
  returning l.name, t.old_status, l.status as final_status
)
insert into activity_log (user_email, action, entity, details)
select 'system@backfill',
       'updated',
       name,
       'Status set to "' || final_status || '" from HubSpot stage change (one-time backfill 023)'
from upd
where old_status <> final_status;
