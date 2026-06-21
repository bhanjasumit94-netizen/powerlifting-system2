/*
  # Create Signal History Table

  1. New Tables
    - `signal_history`
      - `id` (uuid, primary key) - Unique record identifier
      - `session_id` (uuid) - Reference to referee session
      - `competition_id` (text, not null) - Reference to competition
      - `position` (smallint) - Referee position: 0=left, 1=center, 2=right
      - `signal` (text) - Decision: "GOOD" or "NO"
      - `device_id` (text) - Identifier of referee device
      - `submitted_at` (timestamptz) - When signal was submitted by referee
      - `delivered_at` (timestamptz) - When signal was delivered to display
      - `created_at` (timestamptz) - Record creation timestamp

  2. Indexes
    - Index on (competition_id, submitted_at) for querying signals by competition
    - Index on (session_id) for session-based queries
    - Index on (delivered_at) for sorting recent deliveries

  3. Security
    - Enable RLS on `signal_history` table
    - Add policy for public read access (permanent audit trail)
    - Add policy for service role to insert/update

  4. Important Notes
    - This is the permanent audit trail of all referee signals
    - Signals are created when submitted and updated when delivered
    - All signals are kept indefinitely for historical analysis
    - Signals should never be deleted from this table
*/

CREATE TABLE IF NOT EXISTS signal_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES referee_sessions(id) ON DELETE CASCADE,
  competition_id text NOT NULL,
  position smallint NOT NULL,
  signal text NOT NULL CHECK (signal IN ('GOOD', 'NO')),
  device_id text NOT NULL,
  submitted_at timestamptz DEFAULT now(),
  delivered_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signal_history_competition_submitted
  ON signal_history(competition_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_history_session
  ON signal_history(session_id);

CREATE INDEX IF NOT EXISTS idx_signal_history_delivered
  ON signal_history(delivered_at DESC);

ALTER TABLE signal_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view signal history"
  ON signal_history FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Service role can manage history"
  ON signal_history FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);