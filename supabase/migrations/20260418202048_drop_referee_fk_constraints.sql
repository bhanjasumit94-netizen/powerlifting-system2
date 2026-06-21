/*
  # Drop FK constraints from referee_devices and referee_signals

  The app seeds the competition from a URL seed before the DB has it.
  Heartbeats and signals fire immediately from the referee device, which
  can arrive before the competition row exists in the competitions table.
  Removing the FK constraints lets heartbeats and signals be stored
  regardless of DB seeding order, eliminating the silent FK violations
  that caused the "Offline" status to persist.

  1. Changes
    - Drop competition_id FK on referee_devices
    - Drop competition_id FK on referee_signals
*/

ALTER TABLE referee_devices DROP CONSTRAINT IF EXISTS referee_devices_competition_id_fkey;
ALTER TABLE referee_signals DROP CONSTRAINT IF EXISTS referee_signals_competition_id_fkey;
