-- Local development previously used a trigger experiment. Remove it so local and remote behavior match.
DROP TRIGGER IF EXISTS reserve_ticket_inventory;
