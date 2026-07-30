-- Ongoing HubSpot stage -> tracker status sync (Client Opening Tracker).
-- Stores the last HubSpot pipeline stage the sync acted on, so status is only
-- auto-changed when the stage actually changes in HubSpot. This preserves manual
-- status edits made between stage changes (manual override wins). Additive/nullable.
alter table locations add column if not exists hs_stage_seen text;
