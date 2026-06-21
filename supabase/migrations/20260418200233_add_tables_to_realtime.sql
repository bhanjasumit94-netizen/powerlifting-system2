/*
  # Add competitions, lifters, groups to realtime publication
  so all data changes sync across devices in real-time.
*/

ALTER PUBLICATION supabase_realtime ADD TABLE competitions;
ALTER PUBLICATION supabase_realtime ADD TABLE lifters;
ALTER PUBLICATION supabase_realtime ADD TABLE groups;
