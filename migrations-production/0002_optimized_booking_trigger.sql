CREATE TRIGGER IF NOT EXISTS reserve_ticket_inventory
BEFORE INSERT ON bookings
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM events WHERE id = NEW.event_id AND status = 'PUBLISHED'
        AND starts_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND tickets_sold + NEW.quantity <= capacity
    ) THEN RAISE(ABORT, 'EVENT_NOT_BOOKABLE_OR_SOLD_OUT')
  END;
  UPDATE events SET tickets_sold = tickets_sold + NEW.quantity,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.event_id;
END;
