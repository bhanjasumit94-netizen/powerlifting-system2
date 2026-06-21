/*
  # Fix Referee Session RLS to Allow Public/Anonymous Access

  1. Problem
    - Current RLS policy only allows authenticated users to read sessions
    - When a referee scans a QR code on their phone, they access as anonymous user
    - Anonymous users cannot read sessions, causing "invalid session" error

  2. Solution
    - Drop the restrictive "Anyone can read active valid sessions" policy
    - Create new policy that allows both authenticated AND anonymous users to read active sessions
    - Keep security: only active, non-expired sessions are readable
    - Keep ability to create and delete sessions publicly

  3. Security Notes
    - Sessions expire after 24 hours by default
    - Only active sessions with future expiration are readable
    - This is safe because sessions are ephemeral and competition-specific
*/

DROP POLICY IF EXISTS "Anyone can read active valid sessions" ON referee_sessions;

CREATE POLICY "Public can read active valid sessions"
  ON referee_sessions
  FOR SELECT
  TO public
  USING (is_active AND (expires_at > now()));
