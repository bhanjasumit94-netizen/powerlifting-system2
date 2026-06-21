/*
  # Create Referee Sessions Table

  1. New Tables
    - `referee_sessions`
      - `id` (uuid, primary key) - Unique session identifier
      - `competition_id` (text, not null) - Reference to competition
      - `created_at` (timestamptz) - Session creation timestamp
      - `expires_at` (timestamptz) - Session expiration timestamp
      - `is_active` (boolean) - Session status flag
  
  2. Indexes
    - Index on (competition_id, is_active) for querying active sessions
    - Index on (created_at) for cleanup queries
  
  3. Security
    - Enable RLS on `referee_sessions` table
    - Add policy for public read access (anyone can check session validity)
    - Add policy for service role to create/update sessions

  4. Important Notes
    - Sessions are referenced by UUID tokens in referee URLs
    - Each competition can have multiple active sessions
    - Sessions automatically expire after 24 hours
*/

CREATE TABLE IF NOT EXISTS referee_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id text NOT NULL,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz DEFAULT (now() + interval '24 hours'),
  is_active boolean DEFAULT true,
  created_by text DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_referee_sessions_competition_active
  ON referee_sessions(competition_id, is_active);

CREATE INDEX IF NOT EXISTS idx_referee_sessions_expires_at
  ON referee_sessions(expires_at);

ALTER TABLE referee_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can check session validity"
  ON referee_sessions FOR SELECT
  TO public
  USING (is_active AND expires_at > now());

CREATE POLICY "Service role can manage sessions"
  ON referee_sessions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);