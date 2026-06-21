export type LiftType = "squat" | "bench" | "deadlift";
export type AttemptStatus = "PENDING" | "GOOD" | "NO" | "UNATTEMPTED";
export type TimerPhase = "IDLE" | "ATTEMPT" | "NEXT_ATTEMPT";
export type CompetitionMode = "FULL_GAME" | "BENCH_ONLY";
export type Attempt = { weight: number | ""; status: AttemptStatus };
export type RefSignal = "GOOD" | "NO" | null;
export type RefereeSlot = "left" | "center" | "right";
export type DisplayThemeKey = "black" | "white" | "royal" | "emerald" | "sepia" | "crimson" | "graphite";

/** Venue display typography preset (passed via ?font= on display URLs). */
export type DisplayFontFamilyKey = "system" | "condensed" | "mono" | "serif";

export type Group = { id: string; name: string; currentLift: LiftType };

export type NextAttemptEntry = { lifterId: string; lift: LiftType; attemptIndex: number };

export type Lifter = {
  id: string;
  name: string;
  sex: "Male" | "Female";
  dob: string;
  bodyweight: number | "";
  weightClass: string;
  manualWeightClass: string;
  isEquipped: boolean;
  disqualified: boolean;
  category: string;
  group: string | string[];
  team: string;
  rackHeightSquat: number | "";
  rackHeightBench: number | "";
  lot: number | "";
  squatAttempts: Attempt[];
  benchAttempts: Attempt[];
  deadliftAttempts: Attempt[];
};

export type CompetitionRecord = {
  id: string;
  name: string;
  createdAt: number;
  lifters: Lifter[];
  groups: Group[];
  currentLifterId: string | null;
  refereeSignals: RefSignal[];
  refereeInputLocked: boolean;
  currentLift: LiftType;
  currentAttemptIndex: number;
  competitionStarted: boolean;
  includeCollars: boolean;
  timerPhase: TimerPhase;
  timerEndsAt: number | null;
  competitionMode: CompetitionMode;
  activeCompetitionGroupName: string | null;
  nextAttemptQueue: NextAttemptEntry[];
  /** Per-stage manual lifter order (`"${lift}-${attemptIndex}"` → ordered ids). */
  manualOrderByStage: Record<string, string[]>;
};

export type PersistedState = {
  lifters: Lifter[];
  groups: Group[];
  currentLifterId: string | null;
  refereeSignals: RefSignal[];
  refereeInputLocked: boolean;
  currentLift: LiftType;
  currentAttemptIndex: number;
  competitionStarted: boolean;
  includeCollars: boolean;
  timerPhase: TimerPhase;
  timerEndsAt: number | null;
  competitionMode: CompetitionMode;
  activeCompetitionGroupName: string | null;
  nextAttemptQueue: NextAttemptEntry[];
  manualOrderByStage: Record<string, string[]>;
};

export type DbRefereeSession = {
  id: string;
  competition_id: string;
  created_at: string;
  expires_at: string;
  is_active: boolean;
  created_by: string;
};

export type DbSignalHistory = {
  id: string;
  session_id: string;
  competition_id: string;
  position: number;
  signal: "GOOD" | "NO";
  device_id: string;
  submitted_at: string;
  delivered_at: string | null;
  created_at: string;
};

export type RefereSessionData = {
  sessionId: string;
  competitionId: string;
  createdAt: Date;
  expiresAt: Date;
  isValid: boolean;
};

export type SignalState = "IDLE" | "CONNECTED" | "SUBMITTED" | "DELIVERED" | "ARCHIVED";

export type RefereSignalState = {
  position: number;
  signal: RefSignal;
  state: SignalState;
  connectedAt?: Date;
  submittedAt?: Date;
  deliveredAt?: Date;
};
