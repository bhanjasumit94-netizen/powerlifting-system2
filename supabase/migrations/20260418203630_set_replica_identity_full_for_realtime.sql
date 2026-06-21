/*
  # Set REPLICA IDENTITY FULL on realtime tables

  Supabase Realtime postgres_changes sends WAL events for row changes.
  With the default REPLICA IDENTITY (only primary key), UPDATE and DELETE
  events do not include non-primary-key column values in the WAL stream.
  This means row-level filters like `competition_id=eq.xxx` fail to match
  on UPDATE events, so subscribers never receive them.

  Setting REPLICA IDENTITY FULL makes Postgres include ALL column values
  in the WAL for every change (INSERT/UPDATE/DELETE), which enables
  Realtime row-level filters to work correctly for all event types.

  Tables changed:
  - referee_signals: needed for signal delivery to main display
  - referee_devices: kept for backward compatibility (presence is now primary)
*/

ALTER TABLE referee_signals REPLICA IDENTITY FULL;
ALTER TABLE referee_devices REPLICA IDENTITY FULL;
