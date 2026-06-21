import { ref, get, set, update, remove, push } from "firebase/database";
import { firebaseDb } from "./firebase";
import type { DbRefereeSession, DbSignalHistory } from "./types";

export type DbCompetition = {
  id: string;
  name: string;
  mode: string;
  include_collars: boolean;
  started: boolean;
  active_group_name: string | null;
  current_lifter_id: string | null;
  current_lift: string;
  current_attempt_index: number;
  timer_phase: string;
  timer_ends_at: number | null;
  display_layout: string;
  display_theme: string;
  next_attempt_queue: unknown[];
  manual_order_by_stage?: Record<string, string[]> | null;
  created_at: string;
  updated_at: string;
};

export type DbGroup = {
  id: string;
  competition_id: string;
  name: string;
  current_lift: string;
  created_at: string;
};

export type DbLifter = {
  id: string;
  competition_id: string;
  name: string;
  sex: string;
  dob: string;
  bodyweight: number | null;
  weight_class: string;
  manual_weight_class: string;
  is_equipped: boolean;
  disqualified: boolean;
  category: string;
  group_name: string;
  group_names: unknown[];
  team: string;
  rack_height_squat: number | null;
  rack_height_bench: number | null;
  lot: number | null;
  squat_attempts: unknown[];
  bench_attempts: unknown[];
  deadlift_attempts: unknown[];
  created_at: string;
  updated_at: string;
};

export type DbRefereeSignal = {
  id: string;
  competition_id: string;
  position: number;
  signal: string | null;
  device_id: string;
  session_id: string | null;
  last_updated_by_device_id: string | null;
  submitted_at: string | null;
  updated_at: string;
};

export type DbRefereeDevice = {
  id: string;
  competition_id: string;
  device_id: string;
  position: number;
  last_seen_at: string;
};

function assertDb() {
  if (!firebaseDb) throw new Error("Firebase Realtime Database is not configured.");
  return firebaseDb;
}

function snapshotToArray<T>(val: Record<string, T> | null | undefined): T[] {
  if (!val || typeof val !== "object") return [];
  return Object.values(val);
}

export const dbCompetitions = {
  async list(): Promise<DbCompetition[]> {
    const db = assertDb();
    const snap = await get(ref(db, "competitions"));
    if (!snap.exists()) return [];
    const data = snap.val() as Record<string, DbCompetition>;
    return Object.values(data).sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  },

  async getById(id: string): Promise<DbCompetition | null> {
    const db = assertDb();
    const snap = await get(ref(db, `competitions/${id}`));
    if (!snap.exists()) return null;
    return snap.val() as DbCompetition;
  },

  async create(comp: Omit<DbCompetition, "created_at" | "updated_at">): Promise<DbCompetition> {
    const db = assertDb();
    const now = new Date().toISOString();
    const full: DbCompetition = { ...comp, created_at: now, updated_at: now };
    await set(ref(db, `competitions/${comp.id}`), full);
    return full;
  },

  async upsert(comp: Omit<DbCompetition, "created_at" | "updated_at">): Promise<void> {
    const db = assertDb();
    const now = new Date().toISOString();
    const existing = await dbCompetitions.getById(comp.id);
    const full: DbCompetition = {
      ...comp,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    await set(ref(db, `competitions/${comp.id}`), full);
  },

  async update(id: string, patch: Partial<DbCompetition>): Promise<void> {
    const db = assertDb();
    const now = new Date().toISOString();
    await update(ref(db, `competitions/${id}`), { ...patch, updated_at: now });
  },

  async remove(id: string): Promise<void> {
    const db = assertDb();
    await remove(ref(db, `competitions/${id}`));
  },
};

export const dbGroups = {
  async listForCompetition(competitionId: string): Promise<DbGroup[]> {
    const db = assertDb();
    const snap = await get(ref(db, `groups/${competitionId}`));
    if (!snap.exists()) return [];
    const data = snap.val() as Record<string, DbGroup>;
    return Object.values(data).sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  },

  async upsertMany(competitionId: string, groups: Omit<DbGroup, "created_at">[]): Promise<void> {
    if (groups.length === 0) return;
    const db = assertDb();
    const now = new Date().toISOString();
    const updates: Record<string, DbGroup> = {};
    for (const g of groups) {
      const existing = await get(ref(db, `groups/${competitionId}/${g.id}`));
      const created_at = existing.exists() ? (existing.val() as DbGroup).created_at : now;
      updates[g.id] = { ...g, competition_id: competitionId, created_at };
    }
    await update(ref(db, `groups/${competitionId}`), updates);
  },

  async deleteByIds(competitionId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = assertDb();
    const updates: Record<string, null> = {};
    for (const id of ids) updates[id] = null;
    await update(ref(db, `groups/${competitionId}`), updates);
  },

  async upsertAll(competitionId: string, groups: Omit<DbGroup, "created_at">[]): Promise<void> {
    const db = assertDb();
    if (groups.length === 0) {
      await remove(ref(db, `groups/${competitionId}`));
      return;
    }
    await dbGroups.upsertMany(competitionId, groups);
    const existing = await dbGroups.listForCompetition(competitionId);
    const currentIds = new Set(groups.map((g) => g.id));
    const toDelete = existing.filter((g) => !currentIds.has(g.id)).map((g) => g.id);
    await dbGroups.deleteByIds(competitionId, toDelete);
  },
};

export const dbLifters = {
  async listForCompetition(competitionId: string): Promise<DbLifter[]> {
    const db = assertDb();
    const snap = await get(ref(db, `lifters/${competitionId}`));
    if (!snap.exists()) return [];
    const data = snap.val() as Record<string, DbLifter>;
    return Object.values(data).sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  },

  async upsertMany(
    competitionId: string,
    lifters: Omit<DbLifter, "created_at" | "updated_at">[],
  ): Promise<void> {
    if (lifters.length === 0) return;
    const db = assertDb();
    const now = new Date().toISOString();
    const snap = await get(ref(db, `lifters/${competitionId}`));
    const existing = snap.exists() ? (snap.val() as Record<string, DbLifter>) : {};

    const updates: Record<string, DbLifter> = {};
    for (const l of lifters) {
      const created_at = existing[l.id]?.created_at ?? now;
      updates[l.id] = { ...l, competition_id: competitionId, created_at, updated_at: now };
    }
    await update(ref(db, `lifters/${competitionId}`), updates);
  },

  async deleteByIds(competitionId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = assertDb();
    const updates: Record<string, null> = {};
    for (const id of ids) updates[id] = null;
    await update(ref(db, `lifters/${competitionId}`), updates);
  },

  async upsertAll(
    competitionId: string,
    lifters: Omit<DbLifter, "created_at" | "updated_at">[],
  ): Promise<void> {
    const db = assertDb();
    if (lifters.length === 0) {
      await remove(ref(db, `lifters/${competitionId}`));
      return;
    }
    await dbLifters.upsertMany(competitionId, lifters);
    const existing = await dbLifters.listForCompetition(competitionId);
    const currentIds = new Set(lifters.map((l) => l.id));
    const toDelete = existing.filter((l) => !currentIds.has(l.id)).map((l) => l.id);
    await dbLifters.deleteByIds(competitionId, toDelete);
  },
};

export const dbRefereeSignals = {
  async listForCompetition(competitionId: string): Promise<DbRefereeSignal[]> {
    const db = assertDb();
    const snap = await get(ref(db, `referee_signals/${competitionId}`));
    if (!snap.exists()) return [];
    const data = snap.val() as Record<string, DbRefereeSignal>;
    return Object.values(data).sort((a, b) => a.position - b.position);
  },

  async upsertSignal(
    competitionId: string,
    position: number,
    signal: string | null,
    deviceId: string,
    sessionId?: string | null,
  ): Promise<void> {
    const db = assertDb();
    const nowIso = new Date().toISOString();
    const payload: DbRefereeSignal = {
      id: `${competitionId}_${position}`,
      competition_id: competitionId,
      position,
      signal,
      device_id: deviceId,
      session_id: sessionId ?? null,
      last_updated_by_device_id: deviceId,
      submitted_at: signal ? nowIso : null,
      updated_at: nowIso,
    };
    await set(ref(db, `referee_signals/${competitionId}/${position}`), payload);
  },

  async clearAll(competitionId: string): Promise<void> {
    const db = assertDb();
    await remove(ref(db, `referee_signals/${competitionId}`));
  },
};

export const dbRefereeDevices = {
  async listForCompetition(competitionId: string): Promise<DbRefereeDevice[]> {
    const db = assertDb();
    const snap = await get(ref(db, `referee_devices/${competitionId}`));
    if (!snap.exists()) return [];
    return snapshotToArray(snap.val() as Record<string, DbRefereeDevice>);
  },

  async heartbeat(competitionId: string, position: number, deviceId: string): Promise<void> {
    const db = assertDb();
    const payload: DbRefereeDevice = {
      id: `${competitionId}_${position}`,
      competition_id: competitionId,
      device_id: deviceId,
      position,
      last_seen_at: new Date().toISOString(),
    };
    await set(ref(db, `referee_devices/${competitionId}/${position}`), payload);
  },

  async remove(competitionId: string, position: number): Promise<void> {
    const db = assertDb();
    await remove(ref(db, `referee_devices/${competitionId}/${position}`));
  },
};

// Sessions are stored nested: referee_sessions/{competitionId}/{sessionId}
// The QR link always carries both ?session=ID&cid=COMP_ID so validate() can build the exact path.
const LOG_SESSION_DB = "[Session:DB]";
const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const dbRefereeSessions = {
  async create(competitionId: string): Promise<DbRefereeSession> {
    const db = assertDb();
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS).toISOString();
    const now = new Date().toISOString();

    // Remove all old sessions for this competition before creating a new one.
    await dbRefereeSessions.invalidateAll(competitionId);

    const newRef = push(ref(db, `referee_sessions/${competitionId}`));
    const sessionId = newRef.key!;
    const session: DbRefereeSession = {
      id: sessionId,
      competition_id: competitionId,
      created_at: now,
      expires_at: expiresAt,
      is_active: true,
      created_by: "",
    };
    await set(newRef, session);
    console.log(LOG_SESSION_DB, "session created", {
      sessionId,
      path: `referee_sessions/${competitionId}/${sessionId}`,
      competitionId,
      expiresAt,
    });
    return session;
  },

  // competitionId is required — QR links always include ?cid=... so it is always available.
  async validate(sessionId: string, competitionId: string): Promise<DbRefereeSession | null> {
    const db = assertDb();
    const path = `referee_sessions/${competitionId}/${sessionId}`;
    console.log(LOG_SESSION_DB, "validating session", { sessionId, competitionId, path });
    const snap = await get(ref(db, path));
    if (!snap.exists()) {
      console.warn(LOG_SESSION_DB, "session not found in Firebase", { sessionId, competitionId, path });
      return null;
    }
    const data = snap.val() as DbRefereeSession;
    if (!data.is_active) {
      console.warn(LOG_SESSION_DB, "session is inactive", { sessionId });
      return null;
    }
    const now = new Date();
    const expiresAt = new Date(data.expires_at);
    if (now > expiresAt) {
      console.warn(LOG_SESSION_DB, "session expired", { sessionId, expiresAt: data.expires_at, now: now.toISOString() });
      return null;
    }
    console.log(LOG_SESSION_DB, "session valid", { sessionId, competitionId, expiresAt: data.expires_at });
    return data;
  },

  async getActiveForCompetition(competitionId: string): Promise<DbRefereeSession[]> {
    const db = assertDb();
    console.log(LOG_SESSION_DB, "listing sessions for competition", { competitionId });
    const snap = await get(ref(db, `referee_sessions/${competitionId}`));
    if (!snap.exists()) {
      console.log(LOG_SESSION_DB, "no sessions found for competition", { competitionId });
      return [];
    }
    const all = snapshotToArray(snap.val() as Record<string, DbRefereeSession>);
    const now = new Date();
    const active = all
      .filter((s) => s.is_active && new Date(s.expires_at) > now)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    console.log(LOG_SESSION_DB, "active sessions", { competitionId, total: all.length, active: active.length });
    return active;
  },

  async invalidateAll(competitionId: string): Promise<void> {
    const db = assertDb();
    await remove(ref(db, `referee_sessions/${competitionId}`));
    console.log(LOG_SESSION_DB, "invalidated all sessions for competition", { competitionId });
  },

  async invalidateSession(sessionId: string, competitionId: string): Promise<void> {
    const db = assertDb();
    await update(ref(db, `referee_sessions/${competitionId}/${sessionId}`), { is_active: false });
    console.log(LOG_SESSION_DB, "invalidated session", { sessionId, competitionId });
  },
};

export const dbSignalHistory = {
  async create(
    sessionId: string,
    competitionId: string,
    position: number,
    signal: "GOOD" | "NO",
    deviceId: string,
  ): Promise<DbSignalHistory> {
    const db = assertDb();
    const now = new Date().toISOString();
    const newRef = push(ref(db, `signal_history/${competitionId}`));
    const id = newRef.key!;
    const entry: DbSignalHistory = {
      id,
      session_id: sessionId,
      competition_id: competitionId,
      position,
      signal,
      device_id: deviceId,
      submitted_at: now,
      delivered_at: null,
      created_at: now,
    };
    await set(newRef, entry);
    return entry;
  },

  async markDelivered(historyId: string): Promise<void> {
    const db = assertDb();
    await update(ref(db, `signal_history_by_id/${historyId}`), {
      delivered_at: new Date().toISOString(),
    });
  },

  async listForCompetition(competitionId: string): Promise<DbSignalHistory[]> {
    const db = assertDb();
    const snap = await get(ref(db, `signal_history/${competitionId}`));
    if (!snap.exists()) return [];
    return snapshotToArray(snap.val() as Record<string, DbSignalHistory>).sort(
      (a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime(),
    );
  },

  async listRecentDeliveries(competitionId: string, limit = 10): Promise<DbSignalHistory[]> {
    const all = await dbSignalHistory.listForCompetition(competitionId);
    return all
      .filter((h) => h.delivered_at !== null)
      .sort((a, b) => new Date(b.delivered_at!).getTime() - new Date(a.delivered_at!).getTime())
      .slice(0, limit);
  },
};
