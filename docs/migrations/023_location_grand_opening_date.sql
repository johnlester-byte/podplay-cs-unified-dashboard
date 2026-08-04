-- Store the confirmed Grand Opening date separately from the collapsed
-- opening_date (which is grand ?? anticipated). Lets the Client-Opening
-- reminders tell a real Grand Opening apart from an Anticipated guess:
--   • "Opening today" fires only when grand_opening_date = today
--   • "Heads-up" fires when grand_opening_date is null and the anticipated
--     opening (opening_date) is 2+ weeks past.
-- Synced one-way from HubSpot's grand_opening property. Additive/nullable.
alter table locations add column if not exists grand_opening_date date;
