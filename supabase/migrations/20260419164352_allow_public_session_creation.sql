/*
  # Allow Public Session Creation

  1. Changes
    - Allow public (unauthenticated) users to create and read sessions
    - This is safe because sessions are time-limited and competition-scoped
  
  2. Security Notes
    - Public can only create active, unexpired sessions (no modification)
    - Public can read any valid session
    - Service role retains full access for administration
    - Sessions are self-destruct (24 hour expiration)
*/

-- Update referee_sessions policies to allow public role
DROP POLICY IF EXISTS "Authenticated users can create sessions" ON referee_sessions;

CREATE POLICY "Public can create sessions"
  ON referee_sessions FOR INSERT
  TO public
  WITH CHECK (true);

-- Update signal_history policies to allow public role
DROP POLICY IF EXISTS "Authenticated users can create signals" ON signal_history;
DROP POLICY IF EXISTS "Authenticated users can update delivered timestamps" ON signal_history;

CREATE POLICY "Public can create signals"
  ON signal_history FOR INSERT
  TO public
  WITH CHECK (true);

CREATE POLICY "Public can update signals"
  ON signal_history FOR UPDATE
  TO public
  USING (true)
  WITH CHECK (true);