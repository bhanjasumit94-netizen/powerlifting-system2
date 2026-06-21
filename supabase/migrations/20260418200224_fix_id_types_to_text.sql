/*
  # Fix ID column types from uuid to text

  The app generates IDs as text strings (e.g. "comp-1234567890", "lifter-1234567890")
  but the tables were created with uuid type. This migration changes all affected
  id and foreign key columns to text to match what the application sends.

  Changes:
  - competitions.id: uuid -> text
  - groups.id: uuid -> text
  - groups.competition_id: uuid -> text
  - lifters.id: uuid -> text
  - lifters.competition_id: uuid -> text
  - competitions.current_lifter_id: uuid -> text
  - referee_signals.competition_id: uuid -> text
  - referee_devices.competition_id: uuid -> text
*/

ALTER TABLE referee_signals DROP CONSTRAINT IF EXISTS referee_signals_competition_id_fkey;
ALTER TABLE referee_devices DROP CONSTRAINT IF EXISTS referee_devices_competition_id_fkey;
ALTER TABLE lifters DROP CONSTRAINT IF EXISTS lifters_competition_id_fkey;
ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_competition_id_fkey;

ALTER TABLE competitions ALTER COLUMN id SET DATA TYPE text;
ALTER TABLE competitions ALTER COLUMN current_lifter_id SET DATA TYPE text;

ALTER TABLE groups ALTER COLUMN id SET DATA TYPE text;
ALTER TABLE groups ALTER COLUMN competition_id SET DATA TYPE text;

ALTER TABLE lifters ALTER COLUMN id SET DATA TYPE text;
ALTER TABLE lifters ALTER COLUMN competition_id SET DATA TYPE text;

ALTER TABLE referee_signals ALTER COLUMN competition_id SET DATA TYPE text;
ALTER TABLE referee_devices ALTER COLUMN competition_id SET DATA TYPE text;

ALTER TABLE groups ADD CONSTRAINT groups_competition_id_fkey FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE;
ALTER TABLE lifters ADD CONSTRAINT lifters_competition_id_fkey FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE;
ALTER TABLE referee_signals ADD CONSTRAINT referee_signals_competition_id_fkey FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE;
ALTER TABLE referee_devices ADD CONSTRAINT referee_devices_competition_id_fkey FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE;
