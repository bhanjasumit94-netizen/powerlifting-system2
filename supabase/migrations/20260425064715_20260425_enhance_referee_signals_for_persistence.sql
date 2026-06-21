/*
  # Enhance Referee Signals Table for Persistence and Session Tracking

  1. Changes to `referee_signals` table
    - Add `session_id` column to link signals to their active referee session for context
    - Add `last_updated_by_device_id` column to track which device made the last update
    - Add `submitted_at` column to track when the signal was first submitted
    - Add index on `session_id` for faster lookups during session-scoped queries
    
  2. Purpose
    - Signals now persist across browser crashes by being immediately written to database
    - Session tracking allows recovery and audit trails per referee session
    - Device tracking helps identify which referee made each decision
    
  3. Important Notes
    - All new columns are nullable to maintain backward compatibility with existing data
    - Signals will be immediately upserted to this table when a referee makes a decision
    - Supabase RealtimeChannel will broadcast updates to all connected referee stations in real-time
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'referee_signals' AND column_name = 'session_id'
  ) THEN
    ALTER TABLE referee_signals ADD COLUMN session_id text;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'referee_signals' AND column_name = 'last_updated_by_device_id'
  ) THEN
    ALTER TABLE referee_signals ADD COLUMN last_updated_by_device_id text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'referee_signals' AND column_name = 'submitted_at'
  ) THEN
    ALTER TABLE referee_signals ADD COLUMN submitted_at timestamptz DEFAULT now();
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_referee_signals_session_id ON referee_signals(session_id);
CREATE INDEX IF NOT EXISTS idx_referee_signals_updated_at ON referee_signals(updated_at DESC);
