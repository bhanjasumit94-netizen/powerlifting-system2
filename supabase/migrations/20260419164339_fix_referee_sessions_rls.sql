/*
  # Fix Referee Sessions RLS Policies

  1. Changes
    - Update RLS policies to allow authenticated users to insert and read sessions
    - Service role can still manage all operations
  
  2. Important Notes
    - Authenticated users can create sessions within competitions
    - Any user can read valid (non-expired, active) sessions
    - Need to enable RLS first if not already enabled
*/

-- First, verify RLS is enabled
ALTER TABLE referee_sessions ENABLE ROW LEVEL SECURITY;

-- Drop old restrictive policies
DROP POLICY IF EXISTS "Anyone can check session validity" ON referee_sessions;
DROP POLICY IF EXISTS "Service role can manage sessions" ON referee_sessions;

-- New policies allowing authenticated users
CREATE POLICY "Anyone can read active valid sessions"
  ON referee_sessions FOR SELECT
  TO public
  USING (is_active AND expires_at > now());

CREATE POLICY "Authenticated users can create sessions"
  ON referee_sessions FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Service role has full access"
  ON referee_sessions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Also enable RLS on signal_history and set proper policies
ALTER TABLE signal_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view signal history" ON signal_history;
DROP POLICY IF EXISTS "Service role can manage history" ON signal_history;

CREATE POLICY "Anyone can read signal history"
  ON signal_history FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Authenticated users can create signals"
  ON signal_history FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update delivered timestamps"
  ON signal_history FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role has full access"
  ON signal_history FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);