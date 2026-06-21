import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const migrations: string[] = [
      `CREATE TABLE IF NOT EXISTS competitions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL DEFAULT '',
        mode text NOT NULL DEFAULT 'FULL_GAME',
        include_collars boolean NOT NULL DEFAULT true,
        started boolean NOT NULL DEFAULT false,
        active_group_name text DEFAULT NULL,
        current_lifter_id uuid DEFAULT NULL,
        current_lift text NOT NULL DEFAULT 'squat',
        current_attempt_index integer NOT NULL DEFAULT 0,
        timer_phase text NOT NULL DEFAULT 'IDLE',
        timer_ends_at bigint DEFAULT NULL,
        display_layout text NOT NULL DEFAULT 'signal_results_plate',
        display_theme text NOT NULL DEFAULT 'black',
        next_attempt_queue jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS groups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
        name text NOT NULL DEFAULT '',
        current_lift text NOT NULL DEFAULT 'squat',
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS lifters (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
        name text NOT NULL DEFAULT '',
        sex text NOT NULL DEFAULT 'Male',
        dob text NOT NULL DEFAULT '',
        bodyweight numeric DEFAULT NULL,
        weight_class text NOT NULL DEFAULT '',
        manual_weight_class text NOT NULL DEFAULT '',
        is_equipped boolean NOT NULL DEFAULT false,
        disqualified boolean NOT NULL DEFAULT false,
        category text NOT NULL DEFAULT 'Senior',
        group_name text NOT NULL DEFAULT '',
        team text NOT NULL DEFAULT '',
        rack_height_squat numeric DEFAULT NULL,
        rack_height_bench numeric DEFAULT NULL,
        lot integer DEFAULT NULL,
        squat_attempts jsonb NOT NULL DEFAULT '[{"weight":"","status":"PENDING"},{"weight":"","status":"PENDING"},{"weight":"","status":"PENDING"}]',
        bench_attempts jsonb NOT NULL DEFAULT '[{"weight":"","status":"PENDING"},{"weight":"","status":"PENDING"},{"weight":"","status":"PENDING"}]',
        deadlift_attempts jsonb NOT NULL DEFAULT '[{"weight":"","status":"PENDING"},{"weight":"","status":"PENDING"},{"weight":"","status":"PENDING"}]',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS referee_signals (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
        position integer NOT NULL,
        signal text DEFAULT NULL,
        device_id text NOT NULL DEFAULT '',
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(competition_id, position)
      )`,
      `CREATE TABLE IF NOT EXISTS referee_devices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
        device_id text NOT NULL DEFAULT '',
        position integer NOT NULL,
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(competition_id, position)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_groups_competition_id ON groups(competition_id)`,
      `CREATE INDEX IF NOT EXISTS idx_lifters_competition_id ON lifters(competition_id)`,
      `CREATE INDEX IF NOT EXISTS idx_referee_signals_competition_id ON referee_signals(competition_id)`,
      `CREATE INDEX IF NOT EXISTS idx_referee_devices_competition_id ON referee_devices(competition_id)`,
      `ALTER TABLE competitions ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE groups ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE lifters ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE referee_signals ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE referee_devices ENABLE ROW LEVEL SECURITY`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='competitions' AND policyname='competitions_select') THEN CREATE POLICY "competitions_select" ON competitions FOR SELECT TO anon, authenticated USING (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='competitions' AND policyname='competitions_insert') THEN CREATE POLICY "competitions_insert" ON competitions FOR INSERT TO anon, authenticated WITH CHECK (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='competitions' AND policyname='competitions_update') THEN CREATE POLICY "competitions_update" ON competitions FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='competitions' AND policyname='competitions_delete') THEN CREATE POLICY "competitions_delete" ON competitions FOR DELETE TO anon, authenticated USING (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='groups' AND policyname='groups_select') THEN CREATE POLICY "groups_select" ON groups FOR SELECT TO anon, authenticated USING (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='groups' AND policyname='groups_insert') THEN CREATE POLICY "groups_insert" ON groups FOR INSERT TO anon, authenticated WITH CHECK (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='groups' AND policyname='groups_update') THEN CREATE POLICY "groups_update" ON groups FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='groups' AND policyname='groups_delete') THEN CREATE POLICY "groups_delete" ON groups FOR DELETE TO anon, authenticated USING (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='lifters' AND policyname='lifters_select') THEN CREATE POLICY "lifters_select" ON lifters FOR SELECT TO anon, authenticated USING (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='lifters' AND policyname='lifters_insert') THEN CREATE POLICY "lifters_insert" ON lifters FOR INSERT TO anon, authenticated WITH CHECK (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='lifters' AND policyname='lifters_update') THEN CREATE POLICY "lifters_update" ON lifters FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='lifters' AND policyname='lifters_delete') THEN CREATE POLICY "lifters_delete" ON lifters FOR DELETE TO anon, authenticated USING (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='referee_signals' AND policyname='referee_signals_select') THEN CREATE POLICY "referee_signals_select" ON referee_signals FOR SELECT TO anon, authenticated USING (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='referee_signals' AND policyname='referee_signals_insert') THEN CREATE POLICY "referee_signals_insert" ON referee_signals FOR INSERT TO anon, authenticated WITH CHECK (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='referee_signals' AND policyname='referee_signals_update') THEN CREATE POLICY "referee_signals_update" ON referee_signals FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='referee_signals' AND policyname='referee_signals_delete') THEN CREATE POLICY "referee_signals_delete" ON referee_signals FOR DELETE TO anon, authenticated USING (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='referee_devices' AND policyname='referee_devices_select') THEN CREATE POLICY "referee_devices_select" ON referee_devices FOR SELECT TO anon, authenticated USING (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='referee_devices' AND policyname='referee_devices_insert') THEN CREATE POLICY "referee_devices_insert" ON referee_devices FOR INSERT TO anon, authenticated WITH CHECK (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='referee_devices' AND policyname='referee_devices_update') THEN CREATE POLICY "referee_devices_update" ON referee_devices FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true); END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='referee_devices' AND policyname='referee_devices_delete') THEN CREATE POLICY "referee_devices_delete" ON referee_devices FOR DELETE TO anon, authenticated USING (true); END IF; END $$`,
    ];

    const results: { sql: string; status: string; error?: string }[] = [];

    for (const sql of migrations) {
      try {
        const { error } = await supabase.rpc("exec_ddl", { ddl: sql });
        if (error) {
          results.push({ sql: sql.slice(0, 60), status: "error", error: error.message });
        } else {
          results.push({ sql: sql.slice(0, 60), status: "ok" });
        }
      } catch (e: unknown) {
        results.push({ sql: sql.slice(0, 60), status: "exception", error: String(e) });
      }
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
