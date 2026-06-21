/*
  # Add support for multiple groups per lifter

  1. New Columns
    - `group_names` (jsonb array) - stores multiple group names for lifters with dual categories
  
  2. Data Migration
    - Migrate existing single group_name to group_names array
    - Maintain backward compatibility
  
  3. Updated Logic
    - When a lifter has a dual category, group_names will contain both groups
    - Single category lifters will have one group in the array
    - Results display queries will check group membership in the array
*/

-- Add new column for storing multiple groups as JSON array
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lifters' AND column_name = 'group_names'
  ) THEN
    ALTER TABLE lifters ADD COLUMN group_names jsonb DEFAULT '[]'::jsonb;
  END IF;
END $$;

-- Migrate existing data: convert single group_name to group_names array
UPDATE lifters 
SET group_names = 
  CASE 
    WHEN group_name IS NULL OR group_name = '' THEN '[]'::jsonb
    ELSE jsonb_build_array(group_name)
  END
WHERE group_names = '[]'::jsonb;
