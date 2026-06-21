/*
  # Add DELETE policy for referee_sessions

  Allows public deletion of referee sessions without authentication.
  This is needed for the session management feature where creating a new session
  should delete all previous sessions for the competition.
*/

CREATE POLICY "Public can delete sessions"
  ON referee_sessions
  FOR DELETE
  TO public
  USING (true);