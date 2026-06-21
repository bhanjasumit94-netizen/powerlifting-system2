import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  createContext,
  useContext,
  memo,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  HashRouter,
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut as firebaseSignOut, type User } from "firebase/auth";
import indiaStateDistrictData from "../node_modules/india-states-districts/state_discripts.json";
import { useSupabaseSync, type ConnectedRefereeSlots, type CompetitionSessionFromDb } from "./lib/useSupabaseSync";
import {
  type LiftType,
  type AttemptStatus,
  type TimerPhase,
  type CompetitionMode,
  type Attempt,
  type RefSignal,
  type RefereeSlot,
  type DisplayThemeKey,
  type DisplayFontFamilyKey,
  type Group,
  type NextAttemptEntry,
  type Lifter,
  type CompetitionRecord,
  type PersistedState,
} from "./lib/types";
import { initializeStateManager } from "./lib/stateManager";
import { isFirebaseConfigured, firebaseAuth } from "./lib/firebase";
import { useRefereSessionValidation } from "./hooks/useRefereSessionValidation";
import { InvalidSessionError } from "./components/InvalidSessionError";
import LiveScoreboard from "./components/LiveScoreboard";
import { dbRefereeSessions } from "./lib/db";

type AppContextValue = {
  competitions: CompetitionRecord[];
  activeCompetitionId: string | null;
  activeCompetitionName: string;
  createCompetition: (name: string) => { ok: boolean; message: string; competitionId?: string };
  switchCompetition: (competitionId: string) => void;
  updateCompetitionName: (competitionId: string, name: string) => { ok: boolean; message: string };
  deleteCompetition: (competitionId: string) => void;
  lifters: Lifter[];
  setLifters: (lifters: Lifter[]) => void;
  groups: Group[];
  setGroups: (groups: Group[]) => void;
  currentLifterId: string | null;
  setCurrentLifterId: (id: string | null) => void;
  refereeSignals: RefSignal[];
  setRefereeSignals: (signals: RefSignal[]) => void;
  refereeInputLocked: boolean;
  setRefereeInputLocked: (locked: boolean) => void;
  currentLift: LiftType;
  setCurrentLift: (lift: LiftType) => void;
  currentAttemptIndex: number;
  setCurrentAttemptIndex: (index: number) => void;
  competitionStarted: boolean;
  setCompetitionStarted: (started: boolean) => void;
  includeCollars: boolean;
  setIncludeCollars: (include: boolean) => void;
  competitionMode: CompetitionMode;
  setCompetitionMode: (mode: CompetitionMode) => void;
  /** When set, session order / platform flow is limited to this group name (from "Start competition" on Groups). */
  activeCompetitionGroupName: string | null;
  setActiveCompetitionGroupName: (name: string | null) => void;
  manualOrderByStage: Record<string, string[]>;
  setManualOrderByStage: Dispatch<SetStateAction<Record<string, string[]>>>;
  setNextAttemptQueue: (queue: NextAttemptEntry[]) => void;
  timerPhase: TimerPhase;
  timerEndsAt: number | null;
  setTimerState: (phase: TimerPhase, endsAt: number | null) => void;
  startAttemptClock: () => void;
  startNextAttemptClock: () => void;
  clearTimerState: () => void;
  nextAttemptQueue: NextAttemptEntry[];
  submitNextAttempt: (weight: number) => { ok: boolean; message: string };
  updateAttemptForLifter: (
    lifterId: string,
    lift: LiftType,
    attemptIndex: number,
    weight: number | "",
  ) => { ok: boolean; message: string };
  applyRefereeDecision: (overrideSignals?: RefSignal[]) => Promise<void>;
  resetSignals: () => Promise<void>;
  connectedRefereeSlots: ConnectedRefereeSlots;
  publishRefereeSignal: (position: number, signal: RefSignal) => Promise<void>;
  trackRefereePresence: (position: number) => Promise<void>;
  untrackRefereePresence: () => void;
  setCurrentRefereeSessionId: (sessionId: string | null) => void;
  persistSessionSnapshot: (snapshot: import("./lib/useSupabaseSync").SessionPersistSnapshot) => Promise<void>;
};


type StoredState = {
  competitions?: Partial<CompetitionRecord>[];
  activeCompetitionId?: string | null;
} & Partial<PersistedState>;

const SYNC_KEY = "powerliftinglive.sync";
const STORAGE_KEY = "powerliftinglive.state";
const STORAGE_MIGRATION_FLAG_KEY = "powerliftinglive.storage-migrated.v2";
const ONE_MINUTE_MS = 60_000;
const REFEREE_CONFIRM_DELAY_MS = 1000;
const RESULT_OVERLAY_DISPLAY_MS = 4000;
const BAR_WEIGHT_KG = 20;
const COLLAR_PER_SIDE_KG = 2.5;
const COLLAR_PAIR_KG = COLLAR_PER_SIDE_KG * 2;

const LOG_CONTROL = "[Powerlifting:Control]";
const LOG_DISPLAY = "[Powerlifting:Display]";
const LOG_SESSION = "[Powerlifting:SessionSync]";

const syncLogRole = () =>
  typeof window !== "undefined" && window.location.hash.startsWith("#/display/")
    ? "display"
    : window.location.hash.includes("/referee/")
      ? "referee"
      : "control";

function formatLifterRef(lifterId: string | null, lifters: { id: string; name: string }[]) {
  if (!lifterId) return null;
  const lifter = lifters.find((row) => row.id === lifterId);
  return lifter ? { id: lifterId, name: lifter.name } : { id: lifterId, name: "(not in lifters list)" };
}

/** Unified typography for scoreboard results tables, flight line, and related strips on the display screen */
const DISPLAY_RESULTS_BODY = "text-sm leading-snug";

const DISPLAY_THEME_ORDER: DisplayThemeKey[] = ["black", "white", "royal", "emerald", "sepia", "crimson", "graphite"];
const DISPLAY_THEME_CONFIG: Record<
  DisplayThemeKey,
  {
    label: string;
    tone: "dark" | "light";
    rootClass: string;
  }
> = {
  black: {
    label: "Black",
    tone: "dark",
    rootClass: "bg-[#050816] text-white",
  },
  white: {
    label: "White",
    tone: "light",
    rootClass: "bg-[#f4f4ef] text-black",
  },
  royal: {
    label: "Royal Blue",
    tone: "dark",
    rootClass: "bg-[#0f1f4d] text-white",
  },
  emerald: {
    label: "Emerald",
    tone: "dark",
    rootClass: "bg-[#042f2e] text-emerald-50",
  },
  sepia: {
    label: "Sepia",
    tone: "light",
    rootClass: "bg-[#f2ead8] text-[#2e261d]",
  },
  crimson: {
    label: "Crimson",
    tone: "dark",
    rootClass: "bg-[#2b0712] text-rose-50",
  },
  graphite: {
    label: "Graphite",
    tone: "dark",
    rootClass: "bg-[#15181d] text-slate-100",
  },
};

const DISPLAY_FONT_FAMILY_CONFIG: Record<DisplayFontFamilyKey, string> = {
  system: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  condensed: '"Arial Narrow", "Helvetica Neue Condensed", Arial, "Liberation Sans Narrow", sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  serif: 'Georgia, "Times New Roman", "Times", serif',
};

const DISPLAY_SCALE_OPTIONS: { value: string; label: string }[] = [
  { value: "0.75", label: "75%" },
  { value: "0.85", label: "85%" },
  { value: "1", label: "100% (default)" },
  { value: "1.15", label: "115%" },
  { value: "1.25", label: "125%" },
  { value: "1.5", label: "150%" },
  { value: "1.75", label: "175%" },
  { value: "2", label: "200%" },
];

function parseDisplayThemeFromSearch(themeParam: string | null): DisplayThemeKey | null {
  if (!themeParam) return null;
  return DISPLAY_THEME_ORDER.includes(themeParam as DisplayThemeKey) ? (themeParam as DisplayThemeKey) : null;
}

function parseDisplayScaleFromSearch(scaleParam: string | null): number {
  if (!scaleParam) return 1;
  const n = parseFloat(scaleParam);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(3, Math.max(0.5, n));
}

function parseDisplayFontFromSearch(fontParam: string | null): DisplayFontFamilyKey {
  if (
    fontParam === "system" ||
    fontParam === "condensed" ||
    fontParam === "mono" ||
    fontParam === "serif"
  ) {
    return fontParam;
  }
  return "system";
}

const LOT_NUMBER_OPTIONS = Array.from({ length: 40 }, (_, index) => index + 1);

const socket = {
  emit: (event: string, data: unknown) => {
    const payload = { event, data, ts: Date.now() };
    window.dispatchEvent(new CustomEvent(event, { detail: data }));
    localStorage.setItem(SYNC_KEY, JSON.stringify(payload));
  },
  on: (event: string, callback: (data: any) => void) => {
    const localHandler = (e: Event) => callback((e as CustomEvent).detail);
    const storageHandler = (e: Event) => {
      const storageEvent = e as StorageEvent;
      if (storageEvent.key !== SYNC_KEY || !storageEvent.newValue) return;
      const payload = JSON.parse(storageEvent.newValue);
      if (payload.event === event) callback(payload.data);
    };
    window.addEventListener(event, localHandler);
    window.addEventListener("storage", storageHandler);
    return { localHandler, storageHandler };
  },
  off: (event: string, handlers: { localHandler: EventListener; storageHandler: EventListener }) => {
    window.removeEventListener(event, handlers.localHandler);
    window.removeEventListener("storage", handlers.storageHandler);
  },
};

const defaultGroups: Group[] = [];

const isInGroup = (lifterGroup: string | string[], compareGroup: string): boolean => {
  if (Array.isArray(lifterGroup)) {
    return lifterGroup.includes(compareGroup);
  }
  return lifterGroup === compareGroup;
};

const getGroupArray = (group: string | string[]): string[] => {
  return Array.isArray(group) ? group : [group];
};

const getGroupSortOrder = (groupName: string): number => {
  const upper = groupName.toUpperCase();
  if (upper.includes("SUB") && upper.includes("JUNIOR")) return 0;
  if (upper.includes("JUNIOR")) return 1;
  if (upper.includes("SENIOR")) return 2;
  if (upper.includes("MASTER")) return 3;
  return 100;
};

// IPF Goodlift Points Coefficients (official formula May 2020)
// Source: https://www.ipfpointscalculator.com/
const GL_COEFFICIENTS: Record<
  string,
  { a: number; b: number; c: number }
> = {
  "Male Classic Raw": { a: 1199.72839, b: 1025.18162, c: 0.00921 },
  "Female Classic Raw": { a: 610.32796, b: 1045.59282, c: 0.03048 },
  "Male Equipped": { a: 1236.25115, b: 1449.21864, c: 0.01644 },
  "Female Equipped": { a: 758.63871, b: 949.31382, c: 0.02435 },
  "Male Classic Raw Bench": { a: 320.98041, b: 281.40258, c: 0.01008 },
  "Female Classic Raw Bench": { a: 142.40398, b: 442.52671, c: 0.04724 },
  "Male Equipped Bench": { a: 381.22073, b: 733.79378, c: 0.02398 },
  "Female Equipped Bench": { a: 221.09511, b: 596.24238, c: 0.04137 },
};

const getGLCoefficientSet = (
  sex: "Male" | "Female",
  equipped: boolean,
  benchOnly: boolean,
): { a: number; b: number; c: number } => {
  const eq = equipped ? "Equipped" : "Classic Raw";
  const lift = benchOnly ? " Bench" : "";
  const key = `${sex} ${eq}${lift}` as keyof typeof GL_COEFFICIENTS;
  return GL_COEFFICIENTS[key] ?? GL_COEFFICIENTS["Male Classic Raw"];
};

const calculateGoodliftPoints = (
  liftTotalKg: number,
  bodyweight: number | "",
  sex: "Male" | "Female",
  equipped: boolean,
  benchOnly: boolean,
): number => {
  if (!(typeof bodyweight === "number" && Number.isFinite(bodyweight) && bodyweight > 0)) return 0;
  if (!(Number.isFinite(liftTotalKg) && liftTotalKg > 0)) return 0;
  const { a, b, c } = getGLCoefficientSet(sex, equipped, benchOnly);
  const denominator = a - b * Math.exp(-c * bodyweight);
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return Number(((liftTotalKg * 100) / denominator).toFixed(2));
};

const REFEREE_SLOT_CONFIG: { key: RefereeSlot; label: string; index: number }[] = [
  { key: "left", label: "Left", index: 0 },
  { key: "center", label: "Center", index: 1 },
  { key: "right", label: "Right", index: 2 },
];

const getRefereeConfig = (slot: string | undefined) =>
  REFEREE_SLOT_CONFIG.find((entry) => entry.key === slot);

const REFEREE_PRESENCE_PREFIX = "powerliftinglive.refereePresence";
const REFEREE_HEARTBEAT_MS = 2000;
const REFEREE_PRESENCE_TTL_MS = 7000;

type RefereePresenceMap = Partial<Record<RefereeSlot, number>>;

const getRefereePresenceKey = (competitionId: string | null) =>
  `${REFEREE_PRESENCE_PREFIX}.${competitionId ?? "none"}`;

const readRefereePresence = (competitionId: string | null): RefereePresenceMap => {
  if (!competitionId) return {};
  try {
    const raw = localStorage.getItem(getRefereePresenceKey(competitionId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as RefereePresenceMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeRefereePresence = (competitionId: string | null, presence: RefereePresenceMap) => {
  if (!competitionId) return;
  localStorage.setItem(getRefereePresenceKey(competitionId), JSON.stringify(presence));
};

const countConnectedReferees = (competitionId: string | null) => {
  const now = Date.now();
  const presence = readRefereePresence(competitionId);
  return REFEREE_SLOT_CONFIG.filter((slot) => {
    const ts = presence[slot.key];
    return typeof ts === "number" && now - ts <= REFEREE_PRESENCE_TTL_MS;
  }).length;
};

const encodeUrlSeed = (value: unknown) => {
  try {
    const json = JSON.stringify(value);
    return btoa(unescape(encodeURIComponent(json)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  } catch {
    return "";
  }
};

const decodeUrlSeed = <T,>(raw: string): T | null => {
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padLength = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + "=".repeat(padLength);
    const decoded = decodeURIComponent(escape(atob(padded)));
    return JSON.parse(decoded) as T;
  } catch {
    return null;
  }
};

const getHashSearchParams = () => {
  const hash = window.location.hash;
  const queryIndex = hash.indexOf("?");
  if (queryIndex === -1) return new URLSearchParams();
  return new URLSearchParams(hash.slice(queryIndex + 1));
};

const getIsDisplayScreenFromHash = () => window.location.hash.startsWith("#/display/");

const createEmptyCompetitionState = (): PersistedState => ({
  lifters: [],
  groups: [],
  currentLifterId: null,
  refereeSignals: [null, null, null],
  refereeInputLocked: false,
  currentLift: "squat",
  currentAttemptIndex: 0,
  competitionStarted: false,
  includeCollars: false,
  timerPhase: "IDLE",
  timerEndsAt: null,
  competitionMode: "FULL_GAME",
  activeCompetitionGroupName: null,
  nextAttemptQueue: [],
  manualOrderByStage: {},
});

const normalizeCompetitionRecord = (raw: Partial<CompetitionRecord>): CompetitionRecord => {
  const base = createEmptyCompetitionState();
  const lifters = (raw.lifters ?? base.lifters).map((l) => normalizeLifter(l));
  return {
    id: raw.id ?? `comp-${Date.now()}`,
    name: raw.name?.trim() || "Untitled Competition",
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    lifters,
    groups: (raw.groups ?? base.groups).map((g) => normalizeGroup(g)),
    currentLifterId: raw.currentLifterId ?? lifters[0]?.id ?? null,
    refereeSignals: raw.refereeSignals ?? base.refereeSignals,
    refereeInputLocked:
      typeof raw.refereeInputLocked === "boolean" ? raw.refereeInputLocked : base.refereeInputLocked,
    currentLift: raw.currentLift ?? base.currentLift,
    currentAttemptIndex: typeof raw.currentAttemptIndex === "number" ? raw.currentAttemptIndex : base.currentAttemptIndex,
    competitionStarted: typeof raw.competitionStarted === "boolean" ? raw.competitionStarted : base.competitionStarted,
    includeCollars: typeof raw.includeCollars === "boolean" ? raw.includeCollars : base.includeCollars,
    timerPhase: raw.timerPhase ?? base.timerPhase,
    timerEndsAt: typeof raw.timerEndsAt === "number" || raw.timerEndsAt === null ? raw.timerEndsAt : base.timerEndsAt,
    competitionMode: raw.competitionMode ?? base.competitionMode,
    activeCompetitionGroupName:
      typeof raw.activeCompetitionGroupName === "string"
        ? raw.activeCompetitionGroupName
        : raw.activeCompetitionGroupName === null
          ? null
          : base.activeCompetitionGroupName,
    nextAttemptQueue: raw.nextAttemptQueue ?? base.nextAttemptQueue,
    manualOrderByStage:
      raw.manualOrderByStage && typeof raw.manualOrderByStage === "object" && !Array.isArray(raw.manualOrderByStage)
        ? (raw.manualOrderByStage as Record<string, string[]>)
        : base.manualOrderByStage,
  };
};

const emptyAttemptsFromFirst = (first: number | ""): Attempt[] => [
  { weight: first, status: first === "" ? "UNATTEMPTED" : "PENDING" },
  { weight: "", status: "UNATTEMPTED" },
  { weight: "", status: "UNATTEMPTED" },
];

const getIPFWeightClass = (sex: "Male" | "Female", bw: number | "") => {
  if (bw === "" || bw <= 0) return "";
  if (sex === "Male") {
    if (bw < 53) return "Under 53kg";
    if (bw <= 53) return "53kg";
    if (bw <= 59) return "59kg";
    if (bw <= 66) return "66kg";
    if (bw <= 74) return "74kg";
    if (bw <= 83) return "83kg";
    if (bw <= 93) return "93kg";
    if (bw <= 105) return "105kg";
    if (bw <= 120) return "120kg";
    return "120kg+";
  }
  if (bw <= 43) return "43kg (Sub/Jr)";
  if (bw <= 47) return "47kg";
  if (bw <= 52) return "52kg";
  if (bw <= 57) return "57kg";
  if (bw <= 63) return "63kg";
  if (bw <= 69) return "69kg";
  if (bw <= 76) return "76kg";
  if (bw <= 84) return "84kg";
  return "84kg+";
};

const resolveWeightClass = (sex: "Male" | "Female", bw: number | "", manualWeightClass: string) => {
  const manual = manualWeightClass.trim();
  if (manual) return manual;
  return getIPFWeightClass(sex, bw);
};

const getCategoryOptions = (sex: "Male" | "Female") => {
  const suffix = sex === "Male" ? "Men" : "Women";
  return [
    `Sub Junior ${suffix}`,
    `Junior ${suffix}`,
    `Senior ${suffix}`,
    `Master 1 ${suffix}`,
    `Master 2 ${suffix}`,
    `Master 3 ${suffix}`,
    `Master 4 ${suffix}`,
    `Sub Junior ${suffix} + Junior ${suffix}`,
    `Junior ${suffix} + Senior ${suffix}`,
    `Senior ${suffix} + Master 1 ${suffix}`,
  ];
};

const getDoubleCategoryOptions = (sex: "Male" | "Female") => {
  const suffix = sex === "Male" ? "Men" : "Women";
  return [
    `Sub Junior ${suffix} + Junior ${suffix}`,
    `Junior ${suffix} + Senior ${suffix}`,
    `Senior ${suffix} + Master 1 ${suffix}`,
  ];
};

const INDIA_LOCATIONS = [
  ...indiaStateDistrictData.states,
  ...indiaStateDistrictData.union_territories,
];

const INDIA_STATES = INDIA_LOCATIONS.map((entry) => entry.name).sort((a, b) => a.localeCompare(b));

const INDIA_DISTRICTS: Record<string, string[]> = INDIA_LOCATIONS.reduce<Record<string, string[]>>((acc, entry) => {
  acc[entry.name] = [...entry.districts].sort((a, b) => a.localeCompare(b));
  return acc;
}, {});

const MANUAL_WEIGHT_CLASSES = [
  "Under 53kg",
  "53kg",
  "59kg",
  "66kg",
  "74kg",
  "83kg",
  "93kg",
  "105kg",
  "120kg",
  "120kg+",
  "43kg",
  "47kg",
  "52kg",
  "57kg",
  "63kg",
  "69kg",
  "76kg",
  "84kg",
  "84kg+",
];

const normalizeAttempts = (attempts: Attempt[] | undefined) => {
  const base = attempts && attempts.length ? [...attempts] : [];
  const normalizeWeight = (value: unknown): number | "" => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return "";
  };

  return [0, 1, 2].map((i) => ({
    weight: normalizeWeight(base[i]?.weight),
    status: base[i]?.status ?? "UNATTEMPTED",
  })) as Attempt[];
};

const normalizeGroup = (group: Partial<Group>): Group => ({
  id: group.id ?? `group-${Date.now()}`,
  name: group.name ?? "A",
  currentLift: group.currentLift ?? "squat",
});

const normalizeLifter = (raw: Partial<Lifter>): Lifter => {
  const sex = raw.sex === "Female" ? "Female" : "Male";
  const parseNumberOrEmpty = (value: unknown): number | "" => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return "";
  };
  const bodyweight = parseNumberOrEmpty(raw.bodyweight);
  const manualWeightClass = raw.manualWeightClass ?? "";
  return {
    id: raw.id ?? Date.now().toString(),
    name: raw.name ?? "",
    sex,
    dob: raw.dob ?? "",
    bodyweight,
    weightClass: raw.weightClass ?? resolveWeightClass(sex, bodyweight, manualWeightClass),
    manualWeightClass,
    isEquipped: Boolean(raw.isEquipped),
    disqualified: Boolean(raw.disqualified),
    category: raw.category ?? getCategoryOptions(sex)[0],
    group: raw.group ?? "",
    team: raw.team ?? "",
    rackHeightSquat: parseNumberOrEmpty(raw.rackHeightSquat),
    rackHeightBench: parseNumberOrEmpty(raw.rackHeightBench),
    lot: parseNumberOrEmpty(raw.lot),
    squatAttempts: normalizeAttempts(raw.squatAttempts),
    benchAttempts: normalizeAttempts(raw.benchAttempts),
    deadliftAttempts: normalizeAttempts(raw.deadliftAttempts),
  };
};

const getAttempts = (lifter: Lifter, lift: LiftType) => {
  if (lift === "squat") return lifter.squatAttempts;
  if (lift === "bench") return lifter.benchAttempts;
  return lifter.deadliftAttempts;
};

const setAttempts = (lifter: Lifter, lift: LiftType, attempts: Attempt[]): Lifter => {
  if (lift === "squat") return { ...lifter, squatAttempts: attempts };
  if (lift === "bench") return { ...lifter, benchAttempts: attempts };
  return { ...lifter, deadliftAttempts: attempts };
};

const resolveStageForNextAttempt = (
  lift: LiftType,
  attemptIndex: number,
  competitionMode: CompetitionMode,
): { lift: LiftType; attemptIndex: number } | null => {
  if (competitionMode === "BENCH_ONLY") {
    if (attemptIndex < 2) return { lift: "bench", attemptIndex: attemptIndex + 1 };
    return null;
  }

  if (lift === "squat") {
    if (attemptIndex < 2) return { lift: "squat", attemptIndex: attemptIndex + 1 };
    return { lift: "bench", attemptIndex: 0 };
  }
  if (lift === "bench") {
    if (attemptIndex < 2) return { lift: "bench", attemptIndex: attemptIndex + 1 };
    return { lift: "deadlift", attemptIndex: 0 };
  }
  if (attemptIndex < 2) return { lift: "deadlift", attemptIndex: attemptIndex + 1 };
  return null;
};

const getAttemptValue = (lifter: Lifter, lift: LiftType, attemptIndex: number) => {
  const attempt = getAttempts(lifter, lift)[attemptIndex];
  if (typeof attempt?.weight === "number" && Number.isFinite(attempt.weight)) return attempt.weight;
  if (typeof attempt?.weight === "string" && attempt.weight.trim() !== "") {
    const parsed = Number(attempt.weight);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

/** Split display name into first token vs rest (for board-style FIRST LAST lines). */
const splitLifterNameParts = (fullName: string): { first: string; last: string } => {
  const t = fullName.trim();
  if (!t) return { first: "-", last: "" };
  const parts = t.split(/\s+/);
  if (parts.length === 1) return { first: parts[0] ?? "-", last: "" };
  return { first: parts[0] ?? "-", last: parts.slice(1).join(" ") };
};

/** Nearest ancestor that scrolls horizontally (for manual centering; scrollIntoView inline:center is unreliable in nested flex). */
const findHorizontalScrollParent = (start: HTMLElement | null): HTMLElement | null => {
  let el = start?.parentElement ?? null;
  while (el) {
    const ox = getComputedStyle(el).overflowX;
    if ((ox === "auto" || ox === "scroll" || ox === "overlay") && el.scrollWidth > el.clientWidth + 2) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
};

/** Center element horizontally inside its overflow-x scroll parent (uses geometry, not scrollIntoView). */
const centerLifterOrderNodeInScrollParent = (el: HTMLElement) => {
  const scrollParent = findHorizontalScrollParent(el);
  if (!scrollParent) return;
  const elRect = el.getBoundingClientRect();
  const parentRect = scrollParent.getBoundingClientRect();
  const relLeft = elRect.left - parentRect.left;
  const relMid = relLeft + elRect.width / 2;
  const viewMid = parentRect.width / 2;
  const error = relMid - viewMid;
  const maxScroll = Math.max(0, scrollParent.scrollWidth - scrollParent.clientWidth);
  const next = Math.max(0, Math.min(scrollParent.scrollLeft + error, maxScroll));
  scrollParent.scrollTo({ left: next, behavior: "auto" });
};

const getBodyweightValue = (lifter: Lifter) => {
  if (typeof lifter.bodyweight === "number" && Number.isFinite(lifter.bodyweight) && lifter.bodyweight > 0) {
    return lifter.bodyweight;
  }
  return Number.POSITIVE_INFINITY;
};

const orderLiftersByIPF = (lifters: Lifter[], lift: LiftType, attemptIndex: number) =>
  [...lifters]
    .filter((lifter) => !lifter.disqualified)
    .sort((a, b) => {
      const weightA = getAttemptValue(a, lift, attemptIndex);
      const weightB = getAttemptValue(b, lift, attemptIndex);
      const hasWeightA = weightA !== null;
      const hasWeightB = weightB !== null;

      if (hasWeightA && hasWeightB && weightA !== weightB) return Number(weightA) - Number(weightB);
      if (hasWeightA !== hasWeightB) return hasWeightA ? -1 : 1;

      const bodyweightA = getBodyweightValue(a);
      const bodyweightB = getBodyweightValue(b);
      if (bodyweightA !== bodyweightB) return bodyweightA - bodyweightB;

      const lotA = typeof a.lot === "number" ? a.lot : Number.POSITIVE_INFINITY;
      const lotB = typeof b.lot === "number" ? b.lot : Number.POSITIVE_INFINITY;
      if (lotA !== lotB) return lotA - lotB;
      return a.name.localeCompare(b.name);
    });

/** IPF stage pool (active lifters on this attempt if any, else full flight), then optional manual order for this lift/attempt. */
const orderLiftersForDisplayRound = (
  lifters: Lifter[],
  lift: LiftType,
  attemptIndex: number,
  manualOrderByStage: Record<string, string[]>,
): Lifter[] => {
  const ipfOrdered = orderLiftersByIPF(lifters, lift, attemptIndex);
  const activeStage = ipfOrdered.filter((lifter) => {
    const attempt = getAttempts(lifter, lift)[attemptIndex];
    return attempt?.status !== "GOOD" && attempt?.status !== "NO";
  });
  const stageOrderPool = activeStage.length > 0 ? activeStage : ipfOrdered;
  const stageKey = `${lift}-${attemptIndex}`;
  const manual = manualOrderByStage[stageKey];
  if (!manual || manual.length === 0) return stageOrderPool;

  const rank = new Map(manual.map((id, idx) => [id, idx]));
  return [...stageOrderPool].sort((a, b) => {
    const idxA = rank.get(a.id);
    const idxB = rank.get(b.id);
    if (typeof idxA === "number" && typeof idxB === "number") return idxA - idxB;
    if (typeof idxA === "number") return -1;
    if (typeof idxB === "number") return 1;
    return 0;
  });
};

/** Full flight for this lift/attempt (includes GOOD/NO). Same manual ordering as display round, but pool is always full IPF order — used so scoreboard flight lines do not drop finished lifters; highlight moves only. */
const orderLiftersForFlightLineStrip = (
  lifters: Lifter[],
  lift: LiftType,
  attemptIndex: number,
  manualOrderByStage: Record<string, string[]>,
): Lifter[] => {
  const ipfOrdered = orderLiftersByIPF(lifters, lift, attemptIndex);
  const stageKey = `${lift}-${attemptIndex}`;
  const manual = manualOrderByStage[stageKey];
  if (!manual || manual.length === 0) return ipfOrdered;

  const rank = new Map(manual.map((id, idx) => [id, idx]));
  return [...ipfOrdered].sort((a, b) => {
    const idxA = rank.get(a.id);
    const idxB = rank.get(b.id);
    if (typeof idxA === "number" && typeof idxB === "number") return idxA - idxB;
    if (typeof idxA === "number") return -1;
    if (typeof idxB === "number") return 1;
    return 0;
  });
};

const getStageSequence = (competitionMode: CompetitionMode): { lift: LiftType; attemptIndex: number }[] =>
  competitionMode === "BENCH_ONLY"
    ? [
        { lift: "bench", attemptIndex: 0 },
        { lift: "bench", attemptIndex: 1 },
        { lift: "bench", attemptIndex: 2 },
      ]
    : [
        { lift: "squat", attemptIndex: 0 },
        { lift: "squat", attemptIndex: 1 },
        { lift: "squat", attemptIndex: 2 },
        { lift: "bench", attemptIndex: 0 },
        { lift: "bench", attemptIndex: 1 },
        { lift: "bench", attemptIndex: 2 },
        { lift: "deadlift", attemptIndex: 0 },
        { lift: "deadlift", attemptIndex: 1 },
        { lift: "deadlift", attemptIndex: 2 },
      ];

/** Every non-DQ lifter has a final verdict on every scheduled attempt (SQ/BP/DL×3 or bench×3). UNATTEMPTED/PENDING count as incomplete. */
const isSessionFlightFullyResolved = (pool: Lifter[], competitionMode: CompetitionMode): boolean => {
  const stages = getStageSequence(competitionMode);
  const active = pool.filter((l) => !l.disqualified);
  if (active.length === 0) return false;
  for (const lifter of active) {
    for (const { lift, attemptIndex } of stages) {
      const attempt = getAttempts(lifter, lift)[attemptIndex];
      if (!attempt || (attempt.status !== "GOOD" && attempt.status !== "NO")) return false;
    }
  }
  return true;
};

const getStageRank = (entry: NextAttemptEntry, competitionMode: CompetitionMode) => {
  const sequence = getStageSequence(competitionMode);
  const idx = sequence.findIndex((stage) => stage.lift === entry.lift && stage.attemptIndex === entry.attemptIndex);
  return idx >= 0 ? idx : Number.POSITIVE_INFINITY;
};

const sortNextAttemptQueue = (
  entries: NextAttemptEntry[],
  lifters: Lifter[],
  competitionMode: CompetitionMode,
) => {
  const unique = new Map<string, NextAttemptEntry>();
  entries.forEach((entry) => {
    unique.set(`${entry.lifterId}-${entry.lift}-${entry.attemptIndex}`, entry);
  });
  return [...unique.values()].sort((a, b) => {
    const rankA = getStageRank(a, competitionMode);
    const rankB = getStageRank(b, competitionMode);
    if (rankA !== rankB) return rankA - rankB;

    const lifterA = lifters.find((lifter) => lifter.id === a.lifterId);
    const lifterB = lifters.find((lifter) => lifter.id === b.lifterId);
    if (!lifterA && !lifterB) return 0;
    if (!lifterA) return 1;
    if (!lifterB) return -1;

    const weightA = getAttemptValue(lifterA, a.lift, a.attemptIndex);
    const weightB = getAttemptValue(lifterB, b.lift, b.attemptIndex);
    const hasWeightA = weightA !== null;
    const hasWeightB = weightB !== null;
    if (hasWeightA && hasWeightB && Number(weightA) !== Number(weightB)) return Number(weightA) - Number(weightB);
    if (hasWeightA !== hasWeightB) return hasWeightA ? -1 : 1;

    const bodyweightA = getBodyweightValue(lifterA);
    const bodyweightB = getBodyweightValue(lifterB);
    if (bodyweightA !== bodyweightB) return bodyweightA - bodyweightB;

    const lotA = typeof lifterA.lot === "number" ? lifterA.lot : Number.POSITIVE_INFINITY;
    const lotB = typeof lifterB.lot === "number" ? lifterB.lot : Number.POSITIVE_INFINITY;
    if (lotA !== lotB) return lotA - lotB;
    return lifterA.name.localeCompare(lifterB.name);
  });
};

const derivePendingNextAttemptQueue = (lifters: Lifter[], competitionMode: CompetitionMode): NextAttemptEntry[] => {
  const sequence = getStageSequence(competitionMode);
  const pending: NextAttemptEntry[] = [];

  lifters.forEach((lifter) => {
    if (lifter.disqualified) return;
    for (let idx = 0; idx < sequence.length - 1; idx += 1) {
      const stage = sequence[idx];
      const nextStage = sequence[idx + 1];
      const stageAttempt = getAttempts(lifter, stage.lift)[stage.attemptIndex];
      const nextAttempt = getAttempts(lifter, nextStage.lift)[nextStage.attemptIndex];
      if (!stageAttempt || !nextAttempt) continue;
      const stageDone = stageAttempt.status === "GOOD" || stageAttempt.status === "NO";
      if (!stageDone) continue;
      if (nextAttempt.weight !== "") continue;
      pending.push({ lifterId: lifter.id, lift: nextStage.lift, attemptIndex: nextStage.attemptIndex });
    }
  });

  return sortNextAttemptQueue(pending, lifters, competitionMode);
};

const isPendingQueueEntry = (entry: NextAttemptEntry, lifters: Lifter[]) => {
  const lifter = lifters.find((row) => row.id === entry.lifterId);
  if (!lifter || lifter.disqualified) return false;
  const attempt = getAttempts(lifter, entry.lift)[entry.attemptIndex];
  if (!attempt) return false;
  return attempt.weight === "";
};

const resolveAttemptWeight = (lifter: Lifter, lift: LiftType, attemptIndex: number) => {
  const attempts = getAttempts(lifter, lift);
  const asNumber = (value: number | "" | string | undefined) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  };
  const selectedWeight = attempts[attemptIndex]?.weight;
  const selectedNumber = asNumber(selectedWeight as number | "" | string | undefined);
  if (selectedNumber !== null) return selectedNumber;

  for (let i = attemptIndex - 1; i >= 0; i -= 1) {
    const previousWeight = asNumber(attempts[i]?.weight as number | "" | string | undefined);
    if (previousWeight !== null) return previousWeight;
  }

  for (let i = attemptIndex + 1; i < attempts.length; i += 1) {
    const nextWeight = asNumber(attempts[i]?.weight as number | "" | string | undefined);
    if (nextWeight !== null) return nextWeight;
  }

  return 20;
};

const AppContext = createContext<AppContextValue | null>(null);

const useAppContext = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("App context unavailable");
  return ctx;
};

type AuthRole = "admin" | "user";

type AuthContextValue = {
  session: null;
  user: User | null;
  role: AuthRole;
  loading: boolean;
  isAuthenticated: boolean;
  signIn: (email: string, password: string) => Promise<{ ok: boolean; message: string }>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [role, setRole] = useState<AuthRole>("user");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isFirebaseConfigured || !firebaseAuth) {
      setFirebaseUser(null);
      setLoading(false);
      return;
    }

    const unsubscribe = onAuthStateChanged(firebaseAuth, async (fbUser) => {
      setFirebaseUser(fbUser);
      if (fbUser) {
        try {
          const tokenResult = await fbUser.getIdTokenResult();
          setRole(tokenResult.claims["role"] === "admin" ? "admin" : "user");
        } catch {
          setRole("user");
        }
      } else {
        setRole("user");
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const signIn = async (email: string, password: string) => {
    if (!isFirebaseConfigured || !firebaseAuth) {
      return { ok: false, message: "Firebase is not configured. Add your Firebase environment variables." };
    }
    try {
      await signInWithEmailAndPassword(firebaseAuth, email, password);
      return { ok: true, message: "Signed in." };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Sign in failed.";
      return { ok: false, message };
    }
  };

  const signOut = async () => {
    if (!isFirebaseConfigured || !firebaseAuth) return;
    await firebaseSignOut(firebaseAuth);
  };

  const value: AuthContextValue = {
    session: null,
    user: firebaseUser,
    role,
    loading,
    isAuthenticated: Boolean(firebaseUser),
    signIn,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("Auth context unavailable");
  return ctx;
};

const AppProvider = ({ children }: { children: React.ReactNode }) => {
  const { user, loading: authLoading } = useAuth();
  const isDisplayScreenRef = useRef(getIsDisplayScreenFromHash());
  const [isDisplayScreen, setIsDisplayScreen] = useState(() => getIsDisplayScreenFromHash());

  useEffect(() => {
    const syncDisplayRoute = () => {
      const onDisplay = getIsDisplayScreenFromHash();
      isDisplayScreenRef.current = onDisplay;
      setIsDisplayScreen(onDisplay);
    };
    syncDisplayRoute();
    window.addEventListener("hashchange", syncDisplayRoute);
    return () => window.removeEventListener("hashchange", syncDisplayRoute);
  }, []);

  /** Display may persist verdicts to Supabase; without Supabase it stays read-only. */
  const supabaseSyncReadOnly = isDisplayScreen && !isFirebaseConfigured;
  const userScopedStorageKey = `${STORAGE_KEY}.${user?.id ?? "anon"}`;

  useEffect(() => {
    const alreadyMigrated = localStorage.getItem(STORAGE_MIGRATION_FLAG_KEY) === "1";
    if (alreadyMigrated) return;

    // Legacy key was shared across all users on this browser.
    // Remove it once to avoid stale cross-user competition cache.
    localStorage.removeItem(STORAGE_KEY);
    localStorage.setItem(STORAGE_MIGRATION_FLAG_KEY, "1");
  }, []);
  const seedAppliedRef = useRef(false);
  const deviceIdRef = useRef(`device-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`);
  const [connectedRefereeSlots, setConnectedRefereeSlots] = useState<ConnectedRefereeSlots>({
    left: false,
    center: false,
    right: false,
  });
  const [competitions, setCompetitionsState] = useState<CompetitionRecord[]>([]);
  const [activeCompetitionId, setActiveCompetitionIdState] = useState<string | null>(null);
  const [lifters, setLiftersState] = useState<Lifter[]>([]);
  const [groups, setGroupsState] = useState<Group[]>(defaultGroups);
  const [currentLifterId, setCurrentLifterIdState] = useState<string | null>(null);
  const [refereeSignals, setRefereeSignalsState] = useState<RefSignal[]>([null, null, null]);
  const [refereeInputLocked, setRefereeInputLockedState] = useState(false);
  const [currentLift, setCurrentLiftState] = useState<LiftType>("squat");
  const [currentAttemptIndex, setCurrentAttemptIndexState] = useState(0);
  const [competitionStarted, setCompetitionStartedState] = useState(false);
  const [includeCollars, setIncludeCollarsState] = useState(false);
  const [timerPhase, setTimerPhaseState] = useState<TimerPhase>("IDLE");
  const [timerEndsAt, setTimerEndsAtState] = useState<number | null>(null);
  const [competitionMode, setCompetitionModeState] = useState<CompetitionMode>("FULL_GAME");
  const [nextAttemptQueue, setNextAttemptQueueState] = useState<NextAttemptEntry[]>([]);
  const [activeCompetitionGroupName, setActiveCompetitionGroupNameState] = useState<string | null>(null);
  const [manualOrderByStage, setManualOrderByStageState] = useState<Record<string, string[]>>({});
  const [, setCurrentRefereeSessionIdState] = useState<string | null>(null);
  const [currentRefreeSessionId, setCurrentRefreeSessionIdState] = useState<string | null>(null);
  const stageKeyRef = useRef<string>("");
  const activeCompetitionIdRef = useRef<string | null>(null);
  const verdictPersistInFlightRef = useRef(false);
  const autoApplyFingerprintRef = useRef<string | null>(null);

  useEffect(() => {
    activeCompetitionIdRef.current = activeCompetitionId;
  }, [activeCompetitionId]);

  const onCompetitionsLoaded = useCallback((loadedComps: CompetitionRecord[]) => {
    if (loadedComps.length === 0) return;
    const normalized = loadedComps.map((c) => normalizeCompetitionRecord(c));
    const urlCid = getHashSearchParams().get("cid")?.trim() || "";
    const prevActiveId = activeCompetitionIdRef.current;
    const onDisplayRoute = getIsDisplayScreenFromHash();

    const targetId =
      (onDisplayRoute && urlCid && normalized.some((competition) => competition.id === urlCid) ? urlCid : null) ??
      (prevActiveId && normalized.some((competition) => competition.id === prevActiveId) ? prevActiveId : null) ??
      (urlCid && normalized.some((competition) => competition.id === urlCid) ? urlCid : null) ??
      normalized[0]?.id ??
      null;
    const target = normalized.find((competition) => competition.id === targetId) ?? normalized[0];
    if (!target) return;

    setCompetitionsState(normalized);
    setActiveCompetitionIdState(target.id);
    setLiftersState(target.lifters);
    setGroupsState(target.groups);
    setCurrentLifterIdState(target.currentLifterId ?? target.lifters[0]?.id ?? null);
    setRefereeSignals([null, null, null]);
    setRefereeInputLockedState(target.refereeInputLocked);
    setCurrentLiftState(target.currentLift);
    setCurrentAttemptIndexState(target.currentAttemptIndex);
    setCompetitionStartedState(target.competitionStarted);
    setIncludeCollarsState(target.includeCollars);
    setTimerPhaseState(target.timerPhase);
    setTimerEndsAtState(target.timerEndsAt);
    setCompetitionModeState(target.competitionMode);
    setNextAttemptQueueState(target.nextAttemptQueue);
    setActiveCompetitionGroupNameState(target.activeCompetitionGroupName ?? null);
    setManualOrderByStageState(target.manualOrderByStage ?? {});
    console.log(LOG_SESSION, "initial competitions loaded from DB", {
      competitionCount: normalized.length,
      activeCompetitionId: target.id,
      activeName: target.name,
      currentLifter: formatLifterRef(target.currentLifterId ?? null, target.lifters),
    });
  }, []);

  const onCompetitionSessionFromDb = useCallback((session: CompetitionSessionFromDb) => {
    const normalizedLifters = session.lifters.map((l) => normalizeLifter(l));
    const normalizedGroups = session.groups.map((g) => normalizeGroup(g));
    const competitionId = activeCompetitionIdRef.current;
    const appliedName =
      session.lifters.find((l) => l.id === session.currentLifterId)?.name ?? "(unknown)";

    console.log(
      isDisplayScreenRef.current ? LOG_DISPLAY : LOG_CONTROL,
      "session applied from DB (Control/Display UI updated)",
      {
        role: syncLogRole(),
        competitionId,
        currentLifterId: session.currentLifterId,
        currentLifterName: appliedName,
        currentLift: session.currentLift,
        attempt: session.currentAttemptIndex + 1,
        lifterCount: normalizedLifters.length,
      },
    );

    setLiftersState(normalizedLifters);
    setGroupsState(normalizedGroups);
    setCurrentLifterIdState(session.currentLifterId);
    setCurrentLiftState(session.currentLift);
    setCurrentAttemptIndexState(session.currentAttemptIndex);
    setCompetitionStartedState(session.competitionStarted);
    setIncludeCollarsState(session.includeCollars);
    setTimerPhaseState(session.timerPhase);
    setTimerEndsAtState(session.timerEndsAt);
    setCompetitionModeState(session.competitionMode);
    setNextAttemptQueueState(session.nextAttemptQueue);
    setActiveCompetitionGroupNameState(session.activeCompetitionGroupName);
    setManualOrderByStageState(session.manualOrderByStage);

    if (!competitionId) return;

    setCompetitionsState((prev) =>
      prev.map((competition) =>
        competition.id === competitionId
          ? {
              ...competition,
              lifters: normalizedLifters,
              groups: normalizedGroups,
              currentLifterId: session.currentLifterId,
              currentLift: session.currentLift,
              currentAttemptIndex: session.currentAttemptIndex,
              competitionStarted: session.competitionStarted,
              includeCollars: session.includeCollars,
              timerPhase: session.timerPhase,
              timerEndsAt: session.timerEndsAt,
              competitionMode: session.competitionMode,
              nextAttemptQueue: session.nextAttemptQueue,
              activeCompetitionGroupName: session.activeCompetitionGroupName,
              manualOrderByStage: session.manualOrderByStage,
            }
          : competition,
      ),
    );
  }, []);

  const onRefereeSignalsChanged = useCallback((signals: RefSignal[]) => {
    setRefereeSignals(signals);
    if (!isDisplayScreenRef.current) {
      console.log(LOG_CONTROL, "referee signals from DB realtime", {
        competitionId: activeCompetitionIdRef.current,
        signals: { left: signals[0], center: signals[1], right: signals[2] },
        receivedCount: signals.filter((s) => s !== null).length,
      });
      socket.emit("SYNC_STATE", { refereeSignals: signals });
    }
  }, []);

  const onDevicesChanged = useCallback((devices: ConnectedRefereeSlots) => {
    setConnectedRefereeSlots(devices);
  }, []);

  const {
    publishSignal,
    clearSignals,
    createCompetitionInDb,
    deleteCompetitionFromDb,
    updateCompetitionNameInDb,
    trackPresence,
    untrackPresence,
    persistSessionSnapshot,
  } = useSupabaseSync(
    activeCompetitionId,
    competitions,
    lifters,
    groups,
    refereeSignals,
    { onCompetitionsLoaded, onRefereeSignalsChanged, onDevicesChanged, onCompetitionSessionFromDb },
    deviceIdRef.current,
    supabaseSyncReadOnly,
    currentRefreeSessionId,
    authLoading,
    user?.uid ?? null,
  );

  const broadcast = useCallback((next: Partial<AppContextValue>) => {
    if (isDisplayScreen) return;
    socket.emit("SYNC_STATE", next);
  }, [isDisplayScreen]);

  const setTimerState = useCallback((phase: TimerPhase, endsAt: number | null) => {
    setTimerPhaseState(phase);
    setTimerEndsAtState(endsAt);
    broadcast({ timerPhase: phase, timerEndsAt: endsAt });
  }, [broadcast]);

  const setActiveCompetitionGroupName = useCallback((name: string | null) => {
    setActiveCompetitionGroupNameState(name);
    broadcast({ activeCompetitionGroupName: name });
  }, [broadcast]);

  const setManualOrderByStage = useCallback((value: SetStateAction<Record<string, string[]>>) => {
    setManualOrderByStageState((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      broadcast({ manualOrderByStage: next });
      return next;
    });
  }, [broadcast]);

  const hydrateCompetition = (competition: CompetitionRecord | null) => {
    if (!competition) {
      const empty = createEmptyCompetitionState();
      setLiftersState(empty.lifters);
      setGroupsState(empty.groups);
      setCurrentLifterIdState(empty.currentLifterId);
      setRefereeSignals(empty.refereeSignals);
      setRefereeInputLockedState(empty.refereeInputLocked);
      setCurrentLiftState(empty.currentLift);
      setCurrentAttemptIndexState(empty.currentAttemptIndex);
      setCompetitionStartedState(empty.competitionStarted);
      setIncludeCollarsState(empty.includeCollars);
      setTimerPhaseState(empty.timerPhase);
      setTimerEndsAtState(empty.timerEndsAt);
      setCompetitionModeState(empty.competitionMode);
      setNextAttemptQueueState(empty.nextAttemptQueue);
      setActiveCompetitionGroupNameState(empty.activeCompetitionGroupName);
      setManualOrderByStageState(empty.manualOrderByStage);
      return;
    }

    setLiftersState(competition.lifters);
    setGroupsState(competition.groups);
    setCurrentLifterIdState(competition.currentLifterId ?? competition.lifters[0]?.id ?? null);
    setRefereeSignals([null, null, null]);
    setRefereeInputLockedState(competition.refereeInputLocked);
    setCurrentLiftState(competition.currentLift);
    setCurrentAttemptIndexState(competition.currentAttemptIndex);
    setCompetitionStartedState(competition.competitionStarted);
    setIncludeCollarsState(competition.includeCollars);
    setTimerPhaseState(competition.timerPhase);
    setTimerEndsAtState(competition.timerEndsAt);
    setCompetitionModeState(competition.competitionMode);
    setNextAttemptQueueState(competition.nextAttemptQueue);
    setActiveCompetitionGroupNameState(competition.activeCompetitionGroupName ?? null);
    setManualOrderByStageState(competition.manualOrderByStage ?? {});
  };

  const applyIncomingState = useCallback((data: Partial<AppContextValue>) => {
    if (Array.isArray((data as { competitions?: unknown }).competitions)) {
      const incomingCompetitions = (data as { competitions?: CompetitionRecord[] }).competitions ?? [];
      setCompetitionsState(incomingCompetitions.map((competition) => normalizeCompetitionRecord(competition)));
    }
    if (typeof (data as { activeCompetitionId?: string | null }).activeCompetitionId !== "undefined") {
      setActiveCompetitionIdState((data as { activeCompetitionId?: string | null }).activeCompetitionId ?? null);
    }
    // With Supabase: ignore full competitions[] snapshots from localStorage (stale). Still accept
    // partial platform patches from another tab (e.g. Control → Control) and all patches on display.
    const hasCompetitionsList = Array.isArray((data as { competitions?: unknown }).competitions);
    const hasPlatformPatch =
      Boolean(data.lifters) ||
      Boolean(data.groups) ||
      typeof (data as { currentLifterId?: unknown }).currentLifterId !== "undefined" ||
      typeof data.refereeInputLocked === "boolean" ||
      Array.isArray((data as { refereeSignals?: unknown }).refereeSignals) ||
      Boolean(data.currentLift) ||
      typeof data.currentAttemptIndex === "number" ||
      typeof data.competitionStarted === "boolean" ||
      typeof data.includeCollars === "boolean" ||
      Boolean(data.timerPhase) ||
      typeof data.timerEndsAt === "number" ||
      data.timerEndsAt === null ||
      data.competitionMode === "FULL_GAME" ||
      data.competitionMode === "BENCH_ONLY" ||
      Array.isArray((data as { nextAttemptQueue?: unknown }).nextAttemptQueue) ||
      typeof (data as { activeCompetitionGroupName?: unknown }).activeCompetitionGroupName === "string" ||
      (data as { activeCompetitionGroupName?: unknown }).activeCompetitionGroupName === null ||
      typeof (data as { manualOrderByStage?: unknown }).manualOrderByStage !== "undefined";
    const allowLocalPlatformSync =
      !isFirebaseConfigured ||
      isDisplayScreenRef.current ||
      (hasPlatformPatch && !hasCompetitionsList);
    if (!allowLocalPlatformSync) {
      if (typeof data.refereeInputLocked === "boolean") setRefereeInputLockedState(data.refereeInputLocked);
      return;
    }
    if (data.lifters) setLiftersState(data.lifters.map((l) => normalizeLifter(l)));
    if (data.groups) setGroupsState(data.groups.map((g) => normalizeGroup(g)));
    if (typeof data.currentLifterId !== "undefined") setCurrentLifterIdState(data.currentLifterId);
    if (typeof data.refereeInputLocked === "boolean") setRefereeInputLockedState(data.refereeInputLocked);
    if (Array.isArray((data as { refereeSignals?: unknown }).refereeSignals)) {
      setRefereeSignalsState((data as { refereeSignals?: RefSignal[] }).refereeSignals ?? [null, null, null]);
    }
    if (data.currentLift) setCurrentLiftState(data.currentLift);
    if (typeof data.currentAttemptIndex === "number") setCurrentAttemptIndexState(data.currentAttemptIndex);
    if (typeof data.competitionStarted === "boolean") setCompetitionStartedState(data.competitionStarted);
    if (typeof data.includeCollars === "boolean") setIncludeCollarsState(data.includeCollars);
    if (data.timerPhase) setTimerPhaseState(data.timerPhase);
    if (typeof data.timerEndsAt === "number" || data.timerEndsAt === null) setTimerEndsAtState(data.timerEndsAt);
    if (data.competitionMode === "FULL_GAME" || data.competitionMode === "BENCH_ONLY") {
      setCompetitionModeState(data.competitionMode);
    }
    if (Array.isArray((data as { nextAttemptQueue?: unknown }).nextAttemptQueue)) {
      setNextAttemptQueueState((data as { nextAttemptQueue?: NextAttemptEntry[] }).nextAttemptQueue ?? []);
    }
    const patchGroup = data as { activeCompetitionGroupName?: string | null };
    if (typeof patchGroup.activeCompetitionGroupName === "string" || patchGroup.activeCompetitionGroupName === null) {
      setActiveCompetitionGroupNameState(patchGroup.activeCompetitionGroupName);
    }
    if (typeof (data as { manualOrderByStage?: unknown }).manualOrderByStage !== "undefined") {
      const mo = (data as { manualOrderByStage?: Record<string, string[]> }).manualOrderByStage;
      if (mo && typeof mo === "object" && !Array.isArray(mo)) {
        setManualOrderByStageState(mo);
      }
    }
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(userScopedStorageKey);
    if (!saved) {
      hydrateCompetition(null);
      return;
    }

    const parsed = JSON.parse(saved) as StoredState;
    if (Array.isArray(parsed.competitions)) {
      const normalizedCompetitions = parsed.competitions.map((competition) =>
        normalizeCompetitionRecord(competition),
      );
      const urlCid = getHashSearchParams().get("cid")?.trim() || "";
      const urlCidValid =
        getIsDisplayScreenFromHash() &&
        urlCid &&
        normalizedCompetitions.some((competition) => competition.id === urlCid);
      const defaultActiveId = urlCidValid
        ? urlCid
        : parsed.activeCompetitionId && normalizedCompetitions.some((competition) => competition.id === parsed.activeCompetitionId)
          ? parsed.activeCompetitionId
          : normalizedCompetitions[0]?.id ?? null;

      setCompetitionsState(normalizedCompetitions);
      setActiveCompetitionIdState(defaultActiveId);
      if (!isFirebaseConfigured) {
        const activeCompetition =
          normalizedCompetitions.find((competition) => competition.id === defaultActiveId) ?? null;
        hydrateCompetition(activeCompetition);
      }
      return;
    }

    // Migration path for older single-competition state.
    const migrated = normalizeCompetitionRecord({
      id: `comp-${Date.now()}`,
      name: "Competition 1",
      createdAt: Date.now(),
      lifters: (parsed.lifters ?? []).map((lifter) => normalizeLifter(lifter)),
      groups: (parsed.groups ?? defaultGroups).map((group) => normalizeGroup(group)),
      currentLifterId: parsed.currentLifterId ?? null,
      refereeSignals: parsed.refereeSignals ?? [null, null, null],
      refereeInputLocked: parsed.refereeInputLocked ?? false,
      currentLift: parsed.currentLift ?? "squat",
      currentAttemptIndex: parsed.currentAttemptIndex ?? 0,
      competitionStarted: parsed.competitionStarted ?? false,
      includeCollars: parsed.includeCollars ?? false,
      timerPhase: parsed.timerPhase ?? "IDLE",
      timerEndsAt: parsed.timerEndsAt ?? null,
      competitionMode: parsed.competitionMode ?? "FULL_GAME",
      activeCompetitionGroupName: null,
      nextAttemptQueue: parsed.nextAttemptQueue ?? [],
    });
    setCompetitionsState([migrated]);
    setActiveCompetitionIdState(migrated.id);
    hydrateCompetition(migrated);
  }, [userScopedStorageKey]);

  useEffect(() => {
    if (seedAppliedRef.current) return;
    const params = getHashSearchParams();
    const rawSeed = params.get("seed");
    const requestedCid = params.get("cid")?.trim() || "";
    if (!rawSeed) {
      if (requestedCid) {
        const placeholder = normalizeCompetitionRecord({
          ...createEmptyCompetitionState(),
          id: requestedCid,
          name: "Linked Competition",
          createdAt: Date.now(),
        });
        setCompetitionsState((prev) => {
          if (prev.some((competition) => competition.id === requestedCid)) return prev;
          return [...prev, placeholder];
        });
        setActiveCompetitionIdState(requestedCid);
        hydrateCompetition(placeholder);
      }
      seedAppliedRef.current = true;
      return;
    }

    const decoded = decodeUrlSeed<Partial<CompetitionRecord>>(rawSeed);
    if (!decoded) {
      seedAppliedRef.current = true;
      return;
    }

    const seededCompetition = normalizeCompetitionRecord(decoded);
    setCompetitionsState((prev) => {
      const exists = prev.some((competition) => competition.id === seededCompetition.id);
      if (exists) {
        return prev.map((competition) =>
          competition.id === seededCompetition.id ? seededCompetition : competition,
        );
      }
      return [...prev, seededCompetition];
    });
    setActiveCompetitionIdState(seededCompetition.id);
    hydrateCompetition(seededCompetition);
    seedAppliedRef.current = true;
  }, []);

  useEffect(() => {
    if (!lifters.length) {
      if (currentLifterId !== null) setCurrentLifterIdState(null);
      return;
    }
    if (isFirebaseConfigured) {
      // Trust DB session sync for current lifter; only clear if the lifter was removed.
      if (currentLifterId && !lifters.some((l) => l.id === currentLifterId)) {
        setCurrentLifterIdState(null);
      }
      return;
    }
    const pool =
      activeCompetitionGroupName !== null
        ? lifters.filter((l) => isInGroup(l.group, activeCompetitionGroupName))
        : lifters;
    if (!pool.length) {
      if (currentLifterId !== null) setCurrentLifterIdState(null);
      return;
    }
    if (!currentLifterId || !pool.some((l) => l.id === currentLifterId)) {
      setCurrentLifterIdState(pool[0].id);
    }
  }, [lifters, currentLifterId, activeCompetitionGroupName]);

  useEffect(() => {
    if (!activeCompetitionId) return;
    setCompetitionsState((prev) =>
      prev.map((competition) =>
        competition.id === activeCompetitionId
          ? {
              ...competition,
              lifters,
              groups,
              currentLifterId,
              refereeSignals: [null, null, null],
              refereeInputLocked,
              currentLift,
              currentAttemptIndex,
              competitionStarted,
              includeCollars,
              timerPhase,
              timerEndsAt,
              competitionMode,
              activeCompetitionGroupName,
              nextAttemptQueue,
              manualOrderByStage,
            }
          : competition,
      ),
    );
  }, [
    activeCompetitionId,
    lifters,
    groups,
    currentLifterId,
    refereeInputLocked,
    currentLift,
    currentAttemptIndex,
    competitionStarted,
    includeCollars,
    timerPhase,
    timerEndsAt,
    competitionMode,
    activeCompetitionGroupName,
    nextAttemptQueue,
    manualOrderByStage,
  ]);

  useEffect(() => {
    localStorage.setItem(
      userScopedStorageKey,
      JSON.stringify({
        competitions,
        activeCompetitionId,
      }),
    );
  }, [competitions, activeCompetitionId, userScopedStorageKey]);

  useEffect(() => {
    const handler = socket.on("SYNC_STATE", (data: Partial<AppContextValue>) => {
      applyIncomingState(data);
    });
    return () => socket.off("SYNC_STATE", handler);
  }, [applyIncomingState]);

  useEffect(() => {
    // Only auto-stop the platform timer. Next-attempt timer can run past zero until next weight is selected.
    if (!timerEndsAt || timerPhase !== "ATTEMPT") return;
    const remainingMs = timerEndsAt - Date.now();
    const timeout = window.setTimeout(() => {
      setTimerState("IDLE", null);
    }, Math.max(0, remainingMs) + 60);

    return () => window.clearTimeout(timeout);
  }, [timerEndsAt, timerPhase, setTimerState]);

  useEffect(() => {
    const handleBootstrapMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; payload?: Partial<PersistedState> };
      if (data?.type !== "POWERLIFTING_BOOTSTRAP" || !data.payload) return;
      applyIncomingState(data.payload as Partial<AppContextValue>);
    };

    window.addEventListener("message", handleBootstrapMessage);
    return () => window.removeEventListener("message", handleBootstrapMessage);
  }, [applyIncomingState]);

  const setNextAttemptQueue = useCallback((queue: NextAttemptEntry[]) => {
    setNextAttemptQueueState(queue);
    broadcast({ nextAttemptQueue: queue });
  }, [broadcast]);

  useEffect(() => {
    initializeStateManager(broadcast);
  }, [broadcast]);

  const activeCompetition =
    competitions.find((competition) => competition.id === activeCompetitionId) ?? null;
  const activeCompetitionName = activeCompetition?.name ?? "No Competition Selected";

  const createCompetition = (name: string) => {
    const nextName = name.trim();
    if (!nextName) {
      return { ok: false, message: "Competition name is required." };
    }
    if (competitions.some((competition) => competition.name.toUpperCase() === nextName.toUpperCase())) {
      return { ok: false, message: "Competition name already exists." };
    }

    const created = normalizeCompetitionRecord({
      ...createEmptyCompetitionState(),
      id: `comp-${Date.now()}`,
      name: nextName,
      createdAt: Date.now(),
    });

    const updatedCompetitions = [...competitions, created];
    setCompetitionsState(updatedCompetitions);
    setActiveCompetitionIdState(created.id);
    hydrateCompetition(created);
    broadcast({
      competitions: updatedCompetitions,
      activeCompetitionId: created.id,
      ...created,
    });
    createCompetitionInDb(created);
    return { ok: true, message: "Competition created.", competitionId: created.id };
  };

  const switchCompetition = (competitionId: string) => {
    const target = competitions.find((competition) => competition.id === competitionId);
    if (!target) return;
    setActiveCompetitionIdState(target.id);
    if (isFirebaseConfigured) {
      // Session channel refetches from DB; avoid hydrating stale localStorage snapshot.
      console.log(LOG_CONTROL, "switch competition (Supabase — waiting for session refetch)", {
        competitionId: target.id,
        name: target.name,
        cachedCurrentLifter: formatLifterRef(target.currentLifterId ?? null, target.lifters),
      });
      broadcast({ activeCompetitionId: target.id });
      return;
    }
    hydrateCompetition(target);
    broadcast({
      activeCompetitionId: target.id,
      ...target,
    });
  };

  useEffect(() => {
    if (!isDisplayScreen) return;
    const requestedCid = getHashSearchParams().get("cid")?.trim() || "";
    if (!requestedCid || requestedCid === activeCompetitionId) return;
    if (!competitions.some((competition) => competition.id === requestedCid)) return;
    switchCompetition(requestedCid);
  }, [isDisplayScreen, activeCompetitionId, competitions, switchCompetition]);

  const updateCompetitionName = (competitionId: string, name: string) => {
    const nextName = name.trim();
    if (!nextName) {
      return { ok: false, message: "Competition name is required." };
    }
    if (
      competitions.some(
        (competition) =>
          competition.id !== competitionId &&
          competition.name.toUpperCase() === nextName.toUpperCase(),
      )
    ) {
      return { ok: false, message: "Competition name already exists." };
    }
    const updatedCompetitions = competitions.map((competition) =>
      competition.id === competitionId ? { ...competition, name: nextName } : competition,
    );
    setCompetitionsState(updatedCompetitions);
    broadcast({ competitions: updatedCompetitions });
    updateCompetitionNameInDb(competitionId, nextName);
    return { ok: true, message: "Competition name updated." };
  };

  const deleteCompetition = (competitionId: string) => {
    const updatedCompetitions = competitions.filter((competition) => competition.id !== competitionId);
    const nextActiveId =
      activeCompetitionId === competitionId ? updatedCompetitions[0]?.id ?? null : activeCompetitionId;
    setCompetitionsState(updatedCompetitions);
    setActiveCompetitionIdState(nextActiveId);
    const nextActiveCompetition =
      updatedCompetitions.find((competition) => competition.id === nextActiveId) ?? null;
    hydrateCompetition(nextActiveCompetition);
    broadcast({
      competitions: updatedCompetitions,
      activeCompetitionId: nextActiveId,
      ...(nextActiveCompetition ?? createEmptyCompetitionState()),
    });
    deleteCompetitionFromDb(competitionId);
  };

  const setLifters = (next: Lifter[]) => {
    const normalized = next.map((l) => normalizeLifter(l));
    setLiftersState(normalized);
    broadcast({ lifters: normalized });
  };

  const setGroups = (next: Group[]) => {
    const normalized = next.map((g) => normalizeGroup(g));
    setGroupsState(normalized);
    broadcast({ groups: normalized });
  };

  const setCurrentLifterId = (id: string | null) => {
    setCurrentLifterIdState(id);
    broadcast({ currentLifterId: id });
  };

  const setRefereeSignals = (signals: RefSignal[]) => {
    setRefereeSignalsState(signals);
    broadcast({ refereeSignals: signals });
  };

  const setRefereeInputLocked = (locked: boolean) => {
    setRefereeInputLockedState(locked);
    broadcast({ refereeInputLocked: locked });
  };

  const setCurrentLift = (lift: LiftType) => {
    setCurrentLiftState(lift);
    broadcast({ currentLift: lift });
  };

  const setCurrentAttemptIndex = (index: number) => {
    setCurrentAttemptIndexState(index);
    broadcast({ currentAttemptIndex: index });
  };

  const setCompetitionStarted = (started: boolean) => {
    setCompetitionStartedState(started);
    broadcast({ competitionStarted: started });
  };

  const setIncludeCollars = (include: boolean) => {
    setIncludeCollarsState(include);
    broadcast({ includeCollars: include });
  };

  const setCompetitionMode = (mode: CompetitionMode) => {
    setCompetitionModeState(mode);
    broadcast({ competitionMode: mode });
    if (mode === "BENCH_ONLY") {
      setCurrentLift("bench");
      setCurrentAttemptIndex(0);
    }
  };

  const setCurrentRefereeSessionId = (sessionId: string | null) => {
    setCurrentRefereeSessionIdState(sessionId);
  };

  const startAttemptClock = useCallback(() => {
    if (!competitionStarted) setCompetitionStarted(true);
    setTimerState("ATTEMPT", Date.now() + ONE_MINUTE_MS);
  }, [competitionStarted, setTimerState]);

  const startNextAttemptClock = useCallback(() => {
    setTimerState("NEXT_ATTEMPT", Date.now() + ONE_MINUTE_MS);
  }, [setTimerState]);

  const clearTimerState = useCallback(() => {
    setTimerState("IDLE", null);
  }, [setTimerState]);

  const resetSignals = useCallback(async () => {
    setRefereeSignals([null, null, null]);
    await clearSignals();
  }, [clearSignals, setRefereeSignals]);

  const submitNextAttempt = useCallback((weight: number) => {
    if (weight <= 0) return { ok: false, message: "Weight must be greater than 0." };
    if (Math.round(weight * 10) % 25 !== 0) return { ok: false, message: "Use 2.5kg increments." };
    const idx = lifters.findIndex((l) => l.id === currentLifterId);
    if (idx < 0) return { ok: false, message: "Select a lifter first." };

    const selected = lifters[idx];
    const attempts = [...getAttempts(selected, currentLift)];
    if (currentAttemptIndex > 0) {
      const previous = attempts[currentAttemptIndex - 1];
      if (typeof previous?.weight === "number" && weight < previous.weight) {
        return { ok: false, message: `Next attempt cannot be below ${previous.weight}kg.` };
      }
    }
    attempts[currentAttemptIndex] = { weight, status: "PENDING" };
    const updated = [...lifters];
    updated[idx] = setAttempts(selected, currentLift, attempts);
    setLifters(updated);
    if (timerPhase === "NEXT_ATTEMPT") clearTimerState();
    return { ok: true, message: "Attempt submitted." };
  }, [lifters, currentLifterId, currentLift, currentAttemptIndex, timerPhase, clearTimerState]);

  const updateAttemptForLifter = useCallback((lifterId: string, lift: LiftType, attemptIndex: number, weight: number | "") => {
    if (attemptIndex < 0 || attemptIndex > 2) return { ok: false, message: "Invalid attempt index." };
    if (weight !== "") {
      if (weight <= 0) return { ok: false, message: "Weight must be greater than 0." };
      if (Math.round(weight * 10) % 25 !== 0) return { ok: false, message: "Use 2.5kg increments." };
    }
    const idx = lifters.findIndex((l) => l.id === lifterId);
    if (idx < 0) return { ok: false, message: "Lifter not found." };

    const selected = lifters[idx];
    const attempts = [...getAttempts(selected, lift)];
    if (weight !== "" && attemptIndex > 0) {
      const previous = attempts[attemptIndex - 1];
      if (typeof previous?.weight === "number" && weight < previous.weight) {
        return { ok: false, message: `Next attempt cannot be below ${previous.weight}kg.` };
      }
    }

    const txId = `${lifterId}-${lift}-${attemptIndex}-${Date.now()}`;
    console.log(LOG_SESSION, "NEXT_ATTEMPT_REQUESTED", {
      txId,
      lifterId,
      lifterName: selected.name,
      lift,
      attemptNumber: attemptIndex + 1,
      weight,
      ts: Date.now(),
    });

    attempts[attemptIndex] = { weight, status: weight === "" ? "UNATTEMPTED" : "PENDING" };
    const updated = [...lifters];
    updated[idx] = setAttempts(selected, lift, attempts);
    setLifters(updated);

    const remainingQueue = nextAttemptQueue.filter(
      (entry) => !(entry.lifterId === lifterId && entry.lift === lift && entry.attemptIndex === attemptIndex),
    );
    const queueChanged = remainingQueue.length !== nextAttemptQueue.length;
    if (queueChanged) {
      setNextAttemptQueue(remainingQueue);
      if (timerPhase === "NEXT_ATTEMPT") {
        if (remainingQueue.length > 0) {
          startNextAttemptClock();
        } else {
          clearTimerState();
        }
      }
    }

    console.log(LOG_SESSION, "NEXT_ATTEMPT_SAVED", {
      txId,
      lifterId,
      lifterName: selected.name,
      lift,
      attemptNumber: attemptIndex + 1,
      weight,
      queueRemaining: remainingQueue.length,
      ts: Date.now(),
    });

    // Persist to Firebase immediately so that subsequent onValue deliveries don't
    // overwrite the declared weight with stale data and re-trigger the dialog.
    if (isFirebaseConfigured && !supabaseSyncReadOnly) {
      const nextTimerPhase: TimerPhase = queueChanged && timerPhase === "NEXT_ATTEMPT"
        ? (remainingQueue.length > 0 ? "NEXT_ATTEMPT" : "IDLE")
        : timerPhase;
      const nextTimerEndsAt = nextTimerPhase === "NEXT_ATTEMPT"
        ? (timerPhase === "NEXT_ATTEMPT" ? timerEndsAt : Date.now() + ONE_MINUTE_MS)
        : (nextTimerPhase === "IDLE" && queueChanged ? null : timerEndsAt);
      void persistSessionSnapshot({
        lifters: updated.map((l) => normalizeLifter(l)),
        groups,
        currentLifterId,
        currentLift,
        currentAttemptIndex,
        competitionStarted,
        includeCollars,
        timerPhase: nextTimerPhase,
        timerEndsAt: nextTimerEndsAt,
        competitionMode,
        activeCompetitionGroupName,
        nextAttemptQueue: remainingQueue,
        manualOrderByStage,
      }).then(() => {
        console.log(LOG_SESSION, "NEXT_ATTEMPT_PROCESSED", {
          txId,
          lifterId,
          lift,
          attemptNumber: attemptIndex + 1,
          weight,
          ts: Date.now(),
        });
      }).catch((err) => console.error(LOG_SESSION, "updateAttemptForLifter: Firebase persist failed", err));
    }

    return { ok: true, message: "Attempt updated." };
  }, [
    lifters, nextAttemptQueue, timerPhase, startNextAttemptClock, clearTimerState, setNextAttemptQueue,
    groups, currentLifterId, currentLift, currentAttemptIndex, competitionStarted, includeCollars,
    timerEndsAt, competitionMode, activeCompetitionGroupName, manualOrderByStage, persistSessionSnapshot,
    supabaseSyncReadOnly,
  ]);

  const applyRefereeDecision = useCallback(async (overrideSignals?: RefSignal[]) => {
    if (verdictPersistInFlightRef.current) {
      console.warn(LOG_SESSION, "applyRefereeDecision skipped — persist already in flight", {
        role: syncLogRole(),
        competitionId: activeCompetitionId,
      });
      return;
    }

    if (!currentLifterId) {
      console.warn(LOG_SESSION, "applyRefereeDecision skipped — no current lifter", {
        role: syncLogRole(),
        competitionId: activeCompetitionId,
      });
      return;
    }

    const idx = lifters.findIndex((l) => l.id === currentLifterId);
    if (idx < 0) {
      console.warn(LOG_SESSION, "applyRefereeDecision skipped — lifter not in list", {
        role: syncLogRole(),
        competitionId: activeCompetitionId,
        currentLifterId,
      });
      return;
    }

    const effectiveSignals = overrideSignals ?? refereeSignals;
    const completed = effectiveSignals.every((s) => s !== null);
    if (!completed) {
      console.warn(LOG_SESSION, "applyRefereeDecision skipped — signals incomplete", {
        role: syncLogRole(),
        signals: effectiveSignals,
      });
      return;
    }

    const noVotes = effectiveSignals.filter((s) => s === "NO").length;
    const status: AttemptStatus = noVotes >= 2 ? "NO" : "GOOD";
    const selected = lifters[idx];

    console.log(
      isDisplayScreenRef.current ? LOG_DISPLAY : LOG_CONTROL,
      "verdict applying",
      {
        role: syncLogRole(),
        competitionId: activeCompetitionId,
        lifter: selected.name,
        lifterId: currentLifterId,
        lift: currentLift,
        attempt: currentAttemptIndex + 1,
        status,
        signals: effectiveSignals,
      },
    );

    verdictPersistInFlightRef.current = true;
    const attempts = [...getAttempts(selected, currentLift)];
    const currentAttempt = attempts[currentAttemptIndex] ?? { weight: "", status: "UNATTEMPTED" as AttemptStatus };

    // Guard against duplicate processing (e.g. two tabs both fire applyRefereeDecision
    // simultaneously). If another tab already wrote the verdict to Firebase and the
    // onValue listener has already updated our local state, skip to avoid overwriting
    // the queue / next-lifter selection a second time.
    if (currentAttempt.status === "GOOD" || currentAttempt.status === "NO") {
      console.warn(
        isDisplayScreenRef.current ? LOG_DISPLAY : LOG_CONTROL,
        "applyRefereeDecision skipped — attempt already has final status",
        { status: currentAttempt.status, lifterId: currentLifterId, lift: currentLift, attempt: currentAttemptIndex + 1 },
      );
      verdictPersistInFlightRef.current = false;
      return;
    }

    attempts[currentAttemptIndex] = { ...currentAttempt, status };

    const updated = [...lifters];
    updated[idx] = setAttempts(selected, currentLift, attempts);

    const sessionLifters =
      activeCompetitionGroupName !== null
        ? updated.filter((l) => isInGroup(l.group, activeCompetitionGroupName))
        : updated;

    const queueForSession =
      activeCompetitionGroupName !== null
        ? nextAttemptQueue.filter((e) => {
            const row = updated.find((l) => l.id === e.lifterId);
            return row ? isInGroup(row.group, activeCompetitionGroupName) : false;
          })
        : nextAttemptQueue;

    const orderedFlight = orderLiftersForDisplayRound(sessionLifters, currentLift, currentAttemptIndex, manualOrderByStage);
    if (!orderedFlight.length) {
      verdictPersistInFlightRef.current = false;
      return;
    }

    let nextLift = currentLift;
    let nextAttemptIdx = currentAttemptIndex;
    let nextLifterId = currentLifterId ?? orderedFlight[0].id;

    // Always move platform to the lowest valid active attempt in the round.
    // This prevents highlight/platform from sticking to a higher-weight lifter.
    const activeCurrentRound = orderedFlight.filter((lifter) => {
      const attempt = getAttempts(lifter, currentLift)[currentAttemptIndex];
      return attempt?.status !== "GOOD" && attempt?.status !== "NO";
    });

    if (activeCurrentRound.length > 0) {
      nextLifterId = activeCurrentRound[0].id;
    } else {
      const nextStage = resolveStageForNextAttempt(currentLift, currentAttemptIndex, competitionMode);
      if (nextStage) {
        nextLift = nextStage.lift;
        nextAttemptIdx = nextStage.attemptIndex;
        const nextOrder = orderLiftersForDisplayRound(sessionLifters, nextLift, nextAttemptIdx, manualOrderByStage);
        const nextActive = nextOrder.find((lifter) => {
          const attempt = getAttempts(lifter, nextLift)[nextAttemptIdx];
          return attempt?.status !== "GOOD" && attempt?.status !== "NO";
        });
        nextLifterId = nextActive?.id ?? nextOrder[0]?.id ?? nextLifterId;
      }
    }

    const declarationStage = resolveStageForNextAttempt(currentLift, currentAttemptIndex, competitionMode);
    let queueAfter = queueForSession;
    if (declarationStage) {
      const declaredWeight = getAttemptValue(selected, declarationStage.lift, declarationStage.attemptIndex);
      if (declaredWeight === null) {
        const alreadyQueued = queueForSession.some(
          (entry) =>
            entry.lifterId === selected.id &&
            entry.lift === declarationStage.lift &&
            entry.attemptIndex === declarationStage.attemptIndex,
        );
        if (!alreadyQueued) {
          queueAfter = [
            ...queueForSession,
            { lifterId: selected.id, lift: declarationStage.lift, attemptIndex: declarationStage.attemptIndex },
          ];
          console.log(LOG_SESSION, "NEXT_ATTEMPT_CREATED", {
            lifterId: selected.id,
            lifterName: selected.name,
            lift: declarationStage.lift,
            attemptNumber: declarationStage.attemptIndex + 1,
            ts: Date.now(),
          });
        }
      }
    }

    // Prime the next platform attempt as PENDING only when focus actually moved (another lifter
    // and/or another lift or attempt). On the final attempt of the final lifter (bench-only BP3
    // or full meet DL3), there is no next stage — nextLifterId stays the current lifter and
    // nextLift/nextAttemptIdx are unchanged. Running the block below would overwrite the verdict
    // we just wrote (GOOD/NO) back to PENDING, so the last lift "does not save".
    const platformMoved =
      nextLifterId !== currentLifterId ||
      nextLift !== currentLift ||
      nextAttemptIdx !== currentAttemptIndex;

    const nextIdx = updated.findIndex((l) => l.id === nextLifterId);
    if (platformMoved && nextIdx >= 0) {
      const nextLifter = updated[nextIdx];
      const nextAttempts = [...getAttempts(nextLifter, nextLift)];
      const focusAttempt = nextAttempts[nextAttemptIdx];
      if (focusAttempt) {
        nextAttempts[nextAttemptIdx] = {
          ...focusAttempt,
          status: focusAttempt.weight === "" ? "UNATTEMPTED" : "PENDING",
        };
        updated[nextIdx] = setAttempts(nextLifter, nextLift, nextAttempts);
      }
    }

    const normalizedQueue = sortNextAttemptQueue(
      [...queueAfter, ...derivePendingNextAttemptQueue(sessionLifters, competitionMode)],
      updated,
      competitionMode,
    );
    const nextTimerPhase: TimerPhase = normalizedQueue.length > 0 ? "NEXT_ATTEMPT" : "IDLE";
    const nextTimerEndsAt = normalizedQueue.length > 0 ? Date.now() + ONE_MINUTE_MS : null;

    setLifters(updated);
    setCurrentLift(nextLift);
    setCurrentAttemptIndex(nextAttemptIdx);
    if (nextLifterId !== currentLifterId) {
      setCurrentLifterId(nextLifterId);
    }
    if (JSON.stringify(normalizedQueue) !== JSON.stringify(nextAttemptQueue)) {
      setNextAttemptQueueState(normalizedQueue);
      broadcast({ nextAttemptQueue: normalizedQueue });
    }
    // Decision ends platform time and starts the 1-minute next-attempt declaration time.
    if (normalizedQueue.length > 0) {
      startNextAttemptClock();
    } else {
      clearTimerState();
    }

    try {
      if (isFirebaseConfigured && !supabaseSyncReadOnly) {
        await persistSessionSnapshot({
          lifters: updated.map((l) => normalizeLifter(l)),
          groups,
          currentLifterId: nextLifterId,
          currentLift: nextLift,
          currentAttemptIndex: nextAttemptIdx,
          competitionStarted,
          includeCollars,
          timerPhase: nextTimerPhase,
          timerEndsAt: nextTimerEndsAt,
          competitionMode,
          activeCompetitionGroupName,
          nextAttemptQueue: normalizedQueue,
          manualOrderByStage,
        });
        console.log(
          isDisplayScreenRef.current ? LOG_DISPLAY : LOG_CONTROL,
          "verdict persisted to DB — clearing referee signals",
          {
            role: syncLogRole(),
            competitionId: activeCompetitionId,
            lifter: selected.name,
            status,
            nextLifterId,
            nextLift,
            nextAttempt: nextAttemptIdx + 1,
          },
        );
      }

      // Same-machine display popup: one full snapshot so the screen updates without waiting on Realtime.
      if (isFirebaseConfigured && !isDisplayScreen) {
        broadcast({
          lifters: updated.map((l) => normalizeLifter(l)),
          groups,
          currentLifterId: nextLifterId,
          currentLift: nextLift,
          currentAttemptIndex: nextAttemptIdx,
          competitionStarted,
          includeCollars,
          timerPhase: nextTimerPhase,
          timerEndsAt: nextTimerEndsAt,
          competitionMode,
          activeCompetitionGroupName,
          nextAttemptQueue: normalizedQueue,
          manualOrderByStage,
        });
      }

      // Clear referee lights only after the platform snapshot is in the database.
      await resetSignals();
    } catch (error) {
      console.error(LOG_SESSION, "applyRefereeDecision failed", {
        role: syncLogRole(),
        competitionId: activeCompetitionId,
        error,
      });
    } finally {
      verdictPersistInFlightRef.current = false;
    }
  }, [
    lifters,
    currentLifterId,
    refereeSignals,
    currentLift,
    currentAttemptIndex,
    activeCompetitionGroupName,
    nextAttemptQueue,
    competitionMode,
    manualOrderByStage,
    setLifters,
    setCurrentLift,
    setCurrentAttemptIndex,
    setCurrentLifterId,
    setNextAttemptQueueState,
    broadcast,
    startNextAttemptClock,
    clearTimerState,
    resetSignals,
    persistSessionSnapshot,
    groups,
    competitionStarted,
    includeCollars,
    activeCompetitionGroupName,
    supabaseSyncReadOnly,
    isDisplayScreen,
    activeCompetitionId,
  ]);

  useEffect(() => {
    const stageKey = `${currentLifterId ?? "none"}|${currentLift}|${currentAttemptIndex}`;
    if (!stageKeyRef.current) {
      stageKeyRef.current = stageKey;
      return;
    }
    if (stageKeyRef.current === stageKey) return;
    stageKeyRef.current = stageKey;
    if (refereeSignals.some((signal) => signal !== null)) {
      // Defensive clear for race conditions where previous-stage signals arrive late.
      void resetSignals().catch((error) => console.error(LOG_SESSION, "resetSignals failed", error));
    }
  }, [currentLifterId, currentLift, currentAttemptIndex, refereeSignals, resetSignals]);

  // Auto-apply verdict on ANY page (not just the display screen) when all 3 signals arrive.
  // Skip when running inside the display tab — DisplayFullPage owns verdict application there
  // to avoid two concurrent applyRefereeDecision calls from the same JS context.
  useEffect(() => {
    if (!isFirebaseConfigured) return;
    if (isDisplayScreenRef.current) return;
    if (!refereeSignals.every((s) => s !== null)) {
      autoApplyFingerprintRef.current = null;
      return;
    }
    if (!currentLifterId) return;
    const fingerprint = `${currentLifterId}|${currentLift}|${currentAttemptIndex}|${JSON.stringify(refereeSignals)}`;
    if (autoApplyFingerprintRef.current === fingerprint) return;
    const timer = window.setTimeout(() => {
      autoApplyFingerprintRef.current = fingerprint;
      console.log(LOG_SESSION, "AppContext: all 3 signals received — auto-applying verdict", {
        currentLifterId, currentLift, attempt: currentAttemptIndex + 1, signals: refereeSignals,
      });
      void applyRefereeDecision().catch((err) =>
        console.error(LOG_SESSION, "AppContext: auto-apply verdict failed", err),
      );
    }, 200);
    return () => window.clearTimeout(timer);
  }, [refereeSignals, currentLifterId, currentLift, currentAttemptIndex, applyRefereeDecision]);

  return (
    <AppContext.Provider
      value={{
        competitions,
        activeCompetitionId,
        activeCompetitionName,
        createCompetition,
        switchCompetition,
        updateCompetitionName,
        deleteCompetition,
        lifters,
        setLifters,
        groups,
        setGroups,
        currentLifterId,
        setCurrentLifterId,
        refereeSignals,
        setRefereeSignals,
        refereeInputLocked,
        setRefereeInputLocked,
        currentLift,
        setCurrentLift,
        currentAttemptIndex,
        setCurrentAttemptIndex,
        competitionStarted,
        setCompetitionStarted,
        includeCollars,
        setIncludeCollars,
        competitionMode,
        setCompetitionMode,
        activeCompetitionGroupName,
        setActiveCompetitionGroupName,
        manualOrderByStage,
        setManualOrderByStage,
        setNextAttemptQueue,
        timerPhase,
        timerEndsAt,
        setTimerState,
        startAttemptClock,
        startNextAttemptClock,
        clearTimerState,
        nextAttemptQueue,
        submitNextAttempt,
        updateAttemptForLifter,
        applyRefereeDecision,
        resetSignals,
        connectedRefereeSlots,
        publishRefereeSignal: publishSignal,
        trackRefereePresence: trackPresence,
        untrackRefereePresence: untrackPresence,
        setCurrentRefereeSessionId,
        persistSessionSnapshot,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

const navItems: { to: string; label: string; requiresCompetition?: boolean; adminOnly?: boolean }[] = [
  { to: "/admin/users", label: "Admin Users", adminOnly: true },
  { to: "/competitions", label: "Competitions" },
  { to: "/control", label: "Control Center" },
  { to: "/lifters", label: "Manage Lifters", requiresCompetition: true },
  { to: "/groups", label: "Groups", requiresCompetition: true },
  { to: "/signals", label: "Referee Signals" },
  { to: "/screen", label: "Display Screens" },
  { to: "/results", label: "Results", requiresCompetition: true },
  { to: "/settings", label: "Settings + Backup" },
];

const Field = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input
    {...props}
    className="h-11 w-full rounded-xl border border-white/20 bg-white/5 px-3 text-sm text-white outline-none ring-cyan-400 transition focus:ring"
  />
);

const SectionHeader = ({ title }: { title: string; path?: string }) => (
  <div className="mb-6">
    <h1 className="text-2xl font-semibold text-white md:text-3xl">{title}</h1>
  </div>
);

const DashboardLayout = () => {
  const { activeCompetitionId, activeCompetitionName } = useAppContext();
  const { user, role, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const visibleNavItems = navItems.filter((item) => !item.adminOnly || role === "admin");

  return (
    <div className="min-h-screen bg-[#05070f] text-white">
      <button
        onClick={() => setOpen((v) => !v)}
        className="fixed left-4 top-4 z-50 rounded-lg border border-white/20 bg-black/60 px-3 py-2 text-sm md:hidden"
      >
        Menu
      </button>

      <aside
        className={`fixed left-0 top-0 z-40 h-full w-72 border-r border-white/10 bg-black/60 p-6 backdrop-blur-xl transition-transform md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="mb-8 mt-10 md:mt-0">
          <h2 className="mt-2 text-2xl font-bold">Powerlifting Competition</h2>
          <p className="mt-2 text-xs text-slate-300">
            {activeCompetitionId ? `Active: ${activeCompetitionName}` : "Create/select a competition"}
          </p>
          <p className="mt-2 text-xs text-slate-400">{user?.email ?? "Not signed in"}</p>
          <div className="mt-3 flex items-center gap-2">
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                role === "admin" ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-200" : "border-white/20 bg-white/10 text-slate-200"
              }`}
            >
              {role}
            </span>
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-lg border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-slate-200 hover:bg-white/20"
            >
              Sign Out
            </button>
          </div>
        </div>
        <nav className="space-y-1">
          {visibleNavItems.map((item) => (
            <motion.div key={item.to} whileHover={{ x: 5 }} transition={{ duration: 0.2 }}>
              <NavLink
                to={item.to}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  `block rounded-lg px-3 py-3 text-sm transition ${
                    item.requiresCompetition && !activeCompetitionId ? "opacity-60 " : ""
                  }${
                    item.adminOnly
                      ? isActive
                        ? "bg-violet-500/30 text-violet-100 ring-1 ring-violet-300/40"
                        : "bg-violet-500/10 text-violet-200 hover:bg-violet-500/20"
                      : isActive
                        ? "bg-cyan-400/20 text-cyan-200"
                        : "text-slate-200 hover:bg-white/10"
                  }`
                }
              >
                {item.label}
              </NavLink>
            </motion.div>
          ))}
        </nav>
      </aside>

      <main className="px-4 pb-8 pt-20 md:ml-72 md:px-8 md:pt-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.24 }}
          >
            <Outlet />
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
};

const RequireAuth = ({ children }: { children: React.ReactNode }) => {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#05070f] text-white">
        <p className="text-sm text-slate-300">Checking session...</p>
      </div>
    );
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
};

const RequireAdmin = ({ children }: { children: React.ReactNode }) => {
  const { role, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#05070f] text-white">
        <p className="text-sm text-slate-300">Checking permissions...</p>
      </div>
    );
  }
  if (role !== "admin") {
    return (
      <section>
        <SectionHeader title="Admin Only" />
        <div className="rounded-2xl border border-white/15 bg-white/5 p-5 text-slate-200">
          <p className="text-sm">You need admin access for this page.</p>
        </div>
      </section>
    );
  }
  return <>{children}</>;
};

const LoginPage = () => {
  const { isAuthenticated, loading, signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  useEffect(() => {
    if (!loading && isAuthenticated) {
      navigate(from, { replace: true });
    }
  }, [loading, isAuthenticated, navigate, from]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    const result = await signIn(email.trim(), password);
    setNotice(result.message);
    setSubmitting(false);
    if (result.ok) {
      navigate(from, { replace: true });
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#05070f] px-4 text-white">
      <form onSubmit={handleSubmit} className="w-full max-w-md rounded-2xl border border-white/15 bg-white/5 p-6">
        <h1 className="text-2xl font-semibold">Admin Login</h1>
        <p className="mt-1 text-sm text-slate-400">Sign in with Firebase email and password.</p>
        {!isFirebaseConfigured && (
          <p className="mt-4 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            Firebase is not configured. Add your Firebase environment variables in `.env`.
          </p>
        )}
        <div className="mt-4 space-y-3">
          <Field
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            autoComplete="email"
            required
          />
          <Field
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            required
          />
        </div>
        {notice && <p className="mt-3 text-sm text-cyan-200">{notice}</p>}
        <button
          type="submit"
          disabled={submitting || !isFirebaseConfigured}
          className="mt-5 w-full rounded-xl bg-cyan-500 py-2 font-semibold text-black transition-opacity hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Signing in..." : "Sign In"}
        </button>
      </form>
    </div>
  );
};

type AdminUserRow = {
  id: string;
  email: string | null;
  disabled: boolean;
  role?: string;
  created_at?: string;
  last_sign_in_at?: string | null;
};

const AdminUsersPage = () => {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [notice, setNotice] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRole, setNewUserRole] = useState<AuthRole>("user");

  const loadUsers = useCallback(async () => {
    setNotice("Admin user management requires Firebase Admin SDK (Cloud Functions). Not available in client mode.");
    setUsers([]);
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const createUser = async () => {
    setNotice("User creation requires Firebase Admin SDK via Cloud Functions. Configure a callable function to enable this.");
  };

  const toggleUserActive = async (_user: AdminUserRow) => {
    setNotice("User management requires Firebase Admin SDK via Cloud Functions.");
  };

  return (
    <section>
      <SectionHeader title="Admin Users" path="/admin/users" />
      <div className="mb-4 rounded-2xl border border-white/15 bg-white/5 p-5">
        <p className="mb-3 text-xs uppercase tracking-[0.2em] text-cyan-300">Create User</p>
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_150px_auto]">
          <Field
            type="email"
            value={newUserEmail}
            onChange={(e) => setNewUserEmail(e.target.value)}
            placeholder="New user email"
          />
          <Field
            type="text"
            value={newUserPassword}
            onChange={(e) => setNewUserPassword(e.target.value)}
            placeholder="Temporary password"
          />
          <select
            value={newUserRole}
            onChange={(e) => setNewUserRole(e.target.value === "admin" ? "admin" : "user")}
            className="h-11 rounded-xl border border-white/20 bg-black/40 px-3 text-sm text-white"
          >
            <option value="user" className="bg-slate-900">User</option>
            <option value="admin" className="bg-slate-900">Admin</option>
          </select>
          <button
            type="button"
            onClick={() => void createUser()}
            disabled={creatingUser}
            className="rounded-xl bg-cyan-500 px-4 py-2 font-semibold text-black transition-opacity hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="inline-flex items-center gap-2">
              {creatingUser && <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/25 border-t-black" />}
              {creatingUser ? "Creating..." : "Add User"}
            </span>
          </button>
        </div>
      </div>

      {notice && <p className="mb-3 text-sm text-cyan-200">{notice}</p>}
      <div className="overflow-x-auto rounded-2xl border border-white/15 bg-black/20">
        <table className="min-w-[860px] text-sm">
          <thead className="bg-white/5 text-left text-slate-300">
            <tr>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Last Sign In</th>
              <th className="px-4 py-3">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-300">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/25 border-t-white" />
                    Loading users...
                  </span>
                </td>
              </tr>
            )}
            {users.map((user) => (
              <tr key={user.id} className="border-t border-white/10">
                <td className="px-4 py-3">{user.email ?? "-"}</td>
                <td className="px-4 py-3">{user.role ?? "user"}</td>
                <td className="px-4 py-3">{user.disabled ? "Disabled" : "Active"}</td>
                <td className="px-4 py-3">{user.created_at ? new Date(user.created_at).toLocaleString() : "-"}</td>
                <td className="px-4 py-3">{user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleString() : "-"}</td>
                <td className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => void toggleUserActive(user)}
                    className="rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/20"
                  >
                    {user.disabled ? "Activate" : "Deactivate"}
                  </button>
                </td>
              </tr>
            ))}
            {!loading && users.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  No users returned.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const CompetitionGate = ({ children }: { children: React.ReactNode }) => {
  const { activeCompetitionId } = useAppContext();

  if (activeCompetitionId) return <>{children}</>;

  return (
    <section>
      <SectionHeader title="Competition Required" />
      <div className="rounded-2xl border border-white/15 bg-white/5 p-5 text-slate-200">
        <p className="text-sm">Create or select a competition first to access this tab.</p>
        <Link
          to="/competitions"
          className="mt-4 inline-flex rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-black"
        >
          Open Competitions
        </Link>
      </div>
    </section>
  );
};

const CompetitionPage = () => {
  const {
    competitions,
    activeCompetitionId,
    createCompetition,
    switchCompetition,
    updateCompetitionName,
    deleteCompetition,
  } = useAppContext();
  const [nameInput, setNameInput] = useState("");
  const [notice, setNotice] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const handleCreate = () => {
    const result = createCompetition(nameInput);
    setNotice(result.message);
    if (result.ok) {
      setNameInput("");
      if (result.competitionId) switchCompetition(result.competitionId);
    }
  };

  const handleDelete = (competitionId: string, competitionName: string) => {
    if (!window.confirm(`Delete competition \"${competitionName}\"?`)) return;
    deleteCompetition(competitionId);
    setNotice("Competition deleted.");
  };

  const handleRename = () => {
    if (!editingId) return;
    const result = updateCompetitionName(editingId, editingName);
    setNotice(result.message);
    if (result.ok) {
      setEditingId(null);
      setEditingName("");
    }
  };

  return (
    <section>
      <SectionHeader title="Competitions" path="/competitions" />
      {notice && (
        <p className="mb-4 rounded-xl border border-cyan-300/30 bg-cyan-400/10 px-3 py-2 text-sm text-cyan-100">
          {notice}
        </p>
      )}

      <div className="mb-4 rounded-2xl border border-white/15 bg-white/5 p-5">
        <p className="mb-3 text-xs uppercase tracking-[0.2em] text-cyan-300">Create Competition</p>
        <div className="flex flex-wrap items-center gap-3">
          <Field
            placeholder="Competition name"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
          />
          <button
            onClick={handleCreate}
            className="h-11 rounded-xl bg-cyan-500 px-4 text-sm font-semibold text-black"
          >
            Create
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {competitions.map((competition) => {
          const isActive = competition.id === activeCompetitionId;
          return (
            <div
              key={competition.id}
              className={`rounded-2xl border p-4 ${
                isActive ? "border-cyan-400/70 bg-cyan-500/10" : "border-white/15 bg-white/5"
              }`}
            >
              {editingId === competition.id ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Field value={editingName} onChange={(e) => setEditingName(e.target.value)} />
                  <button onClick={handleRename} className="rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-black">
                    Save
                  </button>
                  <button
                    onClick={() => {
                      setEditingId(null);
                      setEditingName("");
                    }}
                    className="rounded-lg bg-white/10 px-3 py-2 text-sm"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-lg font-semibold text-white">{competition.name}</p>
                    <p className="text-xs text-slate-300">{competition.lifters.length} lifter(s)</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => switchCompetition(competition.id)}
                      className="rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-black"
                    >
                      {isActive ? "Selected" : "Select"}
                    </button>
                    <button
                      onClick={() => {
                        setEditingId(competition.id);
                        setEditingName(competition.name);
                      }}
                      className="rounded-lg bg-violet-500 px-3 py-2 text-sm font-semibold text-white"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(competition.id, competition.name)}
                      className="rounded-lg bg-rose-500 px-3 py-2 text-sm font-semibold text-white"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {competitions.length === 0 && (
          <div className="rounded-2xl border border-white/15 bg-white/5 p-4 text-sm text-slate-300">
            No competitions created yet.
          </div>
        )}
      </div>
    </section>
  );
};

const ControlPage = () => {
  const [searchParams] = useSearchParams();
  const {
    competitions,
    activeCompetitionId,
    activeCompetitionName,
    switchCompetition,
    lifters,
    setLifters,
    groups,
    currentLifterId,
    setCurrentLifterId,
    currentLift,
    setCurrentLift,
    currentAttemptIndex,
    setCurrentAttemptIndex,
    includeCollars,
    setIncludeCollars,
    competitionMode,
    setCompetitionMode,
    activeCompetitionGroupName,
    setActiveCompetitionGroupName,
    manualOrderByStage,
    setManualOrderByStage,
    timerPhase,
    timerEndsAt,
    startAttemptClock,
    clearTimerState,
    nextAttemptQueue,
    updateAttemptForLifter,
    applyRefereeDecision,
    resetSignals,
    refereeSignals,
  } = useAppContext();

  const controlDebugMountedRef = useRef(false);

  useEffect(() => {
    if (controlDebugMountedRef.current) return;
    controlDebugMountedRef.current = true;
    console.log(LOG_CONTROL, "Control Center mounted", {
      activeCompetitionId,
      urlCid: searchParams.get("cid")?.trim() || null,
      supabase: isFirebaseConfigured,
      competitionNames: competitions.map((c) => ({ id: c.id, name: c.name, isActive: c.id === activeCompetitionId })),
    });
  }, [activeCompetitionId, competitions, searchParams]);

  useEffect(() => {
    const requestedCompetitionId = searchParams.get("cid")?.trim() || "";
    if (requestedCompetitionId && requestedCompetitionId !== activeCompetitionId) {
      const exists = competitions.some((competition) => competition.id === requestedCompetitionId);
      console.log(LOG_CONTROL, "URL cid param", {
        requestedCompetitionId,
        activeCompetitionId,
        existsInList: exists,
        willSwitch: exists,
      });
      if (exists) {
        switchCompetition(requestedCompetitionId);
      }
    }
  }, [searchParams, activeCompetitionId, competitions, switchCompetition]);

  const sessionLifters = useMemo(
    () =>
      activeCompetitionGroupName !== null
        ? lifters.filter((l) => isInGroup(l.group, activeCompetitionGroupName))
        : lifters,
    [lifters, activeCompetitionGroupName],
  );
  const [showDecisionButtons, setShowDecisionButtons] = useState(true);
  const [quickWeightDraft, setQuickWeightDraft] = useState<Record<string, string>>({});
  const [actionNotice, setActionNotice] = useState("");
  const [editingOrderLifterId, setEditingOrderLifterId] = useState<string | null>(null);
  const [orderEditAttempt, setOrderEditAttempt] = useState("");
  const [orderEditBodyweight, setOrderEditBodyweight] = useState("");
  const [orderEditLot, setOrderEditLot] = useState("");
  const [ipfOrderSearchTerm, setIpfOrderSearchTerm] = useState("");
  const [updatedOrderLifterId, setUpdatedOrderLifterId] = useState<string | null>(null);
  const [draggingOrderIndex, setDraggingOrderIndex] = useState<number | null>(null);
  const [queueTimerStarts, setQueueTimerStarts] = useState<Record<string, number>>({});
  const previousOrderWeightMapRef = useRef<Record<string, number | null>>({});
  const didInitOrderWeightRef = useRef(false);

  const ipfOrderedLifters = useMemo(
    () => orderLiftersByIPF(sessionLifters, currentLift, currentAttemptIndex),
    [sessionLifters, currentLift, currentAttemptIndex],
  );

  const activeStageLifters = useMemo(
    () =>
      ipfOrderedLifters.filter((lifter) => {
        const attempt = getAttempts(lifter, currentLift)[currentAttemptIndex];
        return attempt?.status !== "GOOD" && attempt?.status !== "NO";
      }),
    [ipfOrderedLifters, currentLift, currentAttemptIndex],
  );

  const stageKey = `${currentLift}-${currentAttemptIndex}`;
  const stageOrderPoolBase = activeStageLifters.length > 0 ? activeStageLifters : ipfOrderedLifters;
  const controlOrderLifters = useMemo(
    () => orderLiftersForDisplayRound(sessionLifters, currentLift, currentAttemptIndex, manualOrderByStage),
    [sessionLifters, currentLift, currentAttemptIndex, manualOrderByStage],
  );

  useEffect(() => {
    setManualOrderByStage((prev) => {
      const current = prev[stageKey];
      if (!current || current.length === 0) return prev;
      const validIds = new Set(stageOrderPoolBase.map((lifter) => lifter.id));
      const cleaned = current.filter((id) => validIds.has(id));
      const missing = stageOrderPoolBase.map((lifter) => lifter.id).filter((id) => !cleaned.includes(id));
      const merged = [...cleaned, ...missing];
      if (JSON.stringify(merged) === JSON.stringify(current)) return prev;
      return { ...prev, [stageKey]: merged };
    });
  }, [stageKey, stageOrderPoolBase, setManualOrderByStage]);

  useEffect(() => {
    const nextMap: Record<string, number | null> = {};
    let changedLifterId: string | null = null;
    controlOrderLifters.forEach((lifter) => {
      const weight = getAttemptValue(lifter, currentLift, currentAttemptIndex);
      nextMap[lifter.id] = weight;
      if (previousOrderWeightMapRef.current[lifter.id] !== weight) {
        changedLifterId = lifter.id;
      }
    });
    if (!didInitOrderWeightRef.current) {
      previousOrderWeightMapRef.current = nextMap;
      didInitOrderWeightRef.current = true;
      return;
    }
    previousOrderWeightMapRef.current = nextMap;
    if (changedLifterId) {
      // If attempts changed, revert this stage to strict IPF order.
      setManualOrderByStage((prev) => {
        if (!prev[stageKey]) return prev;
        const next = { ...prev };
        delete next[stageKey];
        return next;
      });
      setUpdatedOrderLifterId(changedLifterId);
    }
  }, [controlOrderLifters, currentLift, currentAttemptIndex, stageKey]);

  useEffect(() => {
    if (!updatedOrderLifterId) return;
    const timer = window.setTimeout(() => setUpdatedOrderLifterId(null), 1500);
    return () => window.clearTimeout(timer);
  }, [updatedOrderLifterId]);

  const visibleOrderLifters = useMemo(() => {
    const query = ipfOrderSearchTerm.trim().toLowerCase();
    if (!query) return controlOrderLifters;
    return controlOrderLifters.filter((lifter) => {
      const haystack = `${lifter.name} ${lifter.team} ${lifter.group} ${lifter.weightClass} ${lifter.category}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [controlOrderLifters, ipfOrderSearchTerm]);

  const sessionFlightComplete = useMemo(
    () => isSessionFlightFullyResolved(sessionLifters, competitionMode),
    [sessionLifters, competitionMode],
  );

  const currentLifter = lifters.find((l) => l.id === currentLifterId) ?? null;

  const controlPlatformSnapshotRef = useRef("");
  useEffect(() => {
    const attempt = currentLifter
      ? getAttempts(currentLifter, currentLift)[currentAttemptIndex]
      : null;
    const snapshot = JSON.stringify({
      activeCompetitionId,
      currentLifterId,
      currentLift,
      currentAttemptIndex,
      attemptStatus: attempt?.status ?? null,
      lifterName: currentLifter?.name ?? null,
    });
    if (snapshot === controlPlatformSnapshotRef.current) return;
    controlPlatformSnapshotRef.current = snapshot;
    console.log(LOG_CONTROL, "platform UI state changed", {
      activeCompetitionId,
      currentLifter: formatLifterRef(currentLifterId, lifters),
      currentLift,
      attempt: currentAttemptIndex + 1,
      attemptStatus: attempt?.status ?? "n/a",
      activeGroup: activeCompetitionGroupName,
      sessionLifterCount: sessionLifters.length,
    });
  }, [
    activeCompetitionId,
    currentLifterId,
    currentLifter,
    currentLift,
    currentAttemptIndex,
    lifters,
    activeCompetitionGroupName,
    sessionLifters.length,
  ]);

  const controlSignalsSnapshotRef = useRef("");
  useEffect(() => {
    const snapshot = JSON.stringify(refereeSignals);
    if (snapshot === controlSignalsSnapshotRef.current) return;
    controlSignalsSnapshotRef.current = snapshot;
    console.log(LOG_CONTROL, "referee signals in React state", {
      left: refereeSignals[0],
      center: refereeSignals[1],
      right: refereeSignals[2],
      allIn: refereeSignals.every((s) => s !== null),
    });
  }, [refereeSignals]);

  useEffect(() => {
    if (activeCompetitionGroupName) return;
    if (!currentLifter) return;
    if (competitionMode === "BENCH_ONLY") return;

    const linkedGroup = groups.find((group) => group.name === currentLifter.group);
    if (!linkedGroup) return;

    const targetLift = linkedGroup.currentLift;
    if (targetLift === currentLift) return;

    const groupLifters = lifters.filter((lifter) => isInGroup(lifter.group, linkedGroup.name));
    let targetAttemptIndex = 0;
    for (let idx = 0; idx < 3; idx += 1) {
      const hasIncompleteInRound = groupLifters.some((lifter) => {
        const attempt = getAttempts(lifter, targetLift)[idx];
        return attempt?.status !== "GOOD" && attempt?.status !== "NO";
      });
      if (hasIncompleteInRound) {
        targetAttemptIndex = idx;
        break;
      }
    }

    setCurrentLift(targetLift);
    setCurrentAttemptIndex(targetAttemptIndex);
    setActionNotice(`Group stage applied: ${targetLift.toUpperCase()} A${targetAttemptIndex + 1}`);
  }, [activeCompetitionGroupName, competitionMode, currentLifter, currentLift, groups, lifters, setCurrentAttemptIndex, setCurrentLift]);

  // Offline-only: auto-advance to first incomplete lifter in the round. With Supabase, current lifter comes from DB realtime.
  useEffect(() => {
    if (isFirebaseConfigured) return;
    if (timerPhase === "NEXT_ATTEMPT") return;
    if (!activeStageLifters.length) return;

    const activeIds = activeStageLifters.map((lifter) => lifter.id);
    const currentAttempt = currentLifter ? getAttempts(currentLifter, currentLift)[currentAttemptIndex] : null;
    const currentDone = currentAttempt?.status === "GOOD" || currentAttempt?.status === "NO";

    if (!currentLifterId || !activeIds.includes(currentLifterId) || currentDone) {
      setCurrentLifterId(activeStageLifters[0].id);
    }
  }, [activeStageLifters, currentLifterId, currentLifter, currentLift, currentAttemptIndex, timerPhase, setCurrentLifterId]);

  const currentDisplayWeight = currentLifter ? resolveAttemptWeight(currentLifter, currentLift, currentAttemptIndex) : 20;
  const loadingDisplayWeight = currentDisplayWeight;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!timerEndsAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [timerEndsAt]);

  const timerRemainingSeconds = timerEndsAt ? Math.max(0, Math.ceil((timerEndsAt - now) / 1000)) : 0;

  const formatSignedTimer = (seconds: number) => {
    const sign = seconds < 0 ? "-" : "";
    const abs = Math.abs(seconds);
    const mins = Math.floor(abs / 60);
    const secs = String(abs % 60).padStart(2, "0");
    return `${sign}${mins}:${secs}`;
  };

  useEffect(() => {
    if (competitionMode === "BENCH_ONLY" && currentLift !== "bench") {
      setCurrentLift("bench");
      setCurrentAttemptIndex(0);
    }
  }, [competitionMode, currentLift, setCurrentLift, setCurrentAttemptIndex]);

  // Build a complete pending declaration list (SQ/BP/DL, A1/A2/A3) for all athletes.
  const pendingQueueEntries = useMemo(() => {
    const queueBase =
      activeCompetitionGroupName !== null
        ? nextAttemptQueue.filter((e) => sessionLifters.some((l) => l.id === e.lifterId))
        : nextAttemptQueue;
    return sortNextAttemptQueue(
      [...queueBase, ...derivePendingNextAttemptQueue(sessionLifters, competitionMode)],
      lifters,
      competitionMode,
    ).filter((entry) => isPendingQueueEntry(entry, lifters));
  }, [nextAttemptQueue, lifters, sessionLifters, competitionMode, activeCompetitionGroupName]);

  const queuedAttemptRows = useMemo(
    () =>
      pendingQueueEntries
        .map((entry) => ({
          entry,
          lifter: lifters.find((item) => item.id === entry.lifterId) ?? null,
        }))
        .filter((row): row is { entry: NextAttemptEntry; lifter: Lifter } => Boolean(row.lifter)),
    [pendingQueueEntries, lifters],
  );

  useEffect(() => {
    if (!queuedAttemptRows.length) {
      setQueueTimerStarts({});
      return;
    }

    setQueueTimerStarts((prev) => {
      const next: Record<string, number> = {};
      queuedAttemptRows.forEach(({ entry }) => {
        const key = `${entry.lifterId}-${entry.lift}-${entry.attemptIndex}`;
        next[key] = prev[key] ?? Date.now();
      });
      return next;
    });
  }, [queuedAttemptRows]);

  useEffect(() => {
    if (!queuedAttemptRows.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [queuedAttemptRows.length]);

  const declarationStage = resolveStageForNextAttempt(currentLift, currentAttemptIndex, competitionMode);

  // Keep blue highlight aligned to the currently expected declaration stage
  // (for example SQ A2 -> declare SQ A3), even when the queue shows all pending stages.
  const activeNextAttempt =
    (declarationStage
      ? queuedAttemptRows.find(
          (row) =>
            row.entry.lift === declarationStage.lift &&
            row.entry.attemptIndex === declarationStage.attemptIndex &&
            getAttempts(row.lifter, row.entry.lift)[row.entry.attemptIndex]?.weight === "",
        )?.entry
      : null) ??
    queuedAttemptRows.find((row) => getAttempts(row.lifter, row.entry.lift)[row.entry.attemptIndex]?.weight === "")?.entry ??
    queuedAttemptRows[0]?.entry ??
    null;

  // Highlight: first visible row after search, else first in stage pool (IPF base order).
  const highlightedOrderLifterId = visibleOrderLifters[0]?.id ?? stageOrderPoolBase[0]?.id ?? currentLifterId;

  const resetControlOrderToIPF = () => {
    setManualOrderByStage((prev) => {
      if (!prev[stageKey]) return prev;
      const next = { ...prev };
      delete next[stageKey];
      return next;
    });
    if (stageOrderPoolBase.length === 0) {
      setActionNotice("No lifters available for ordering.");
      return;
    }
    if (stageOrderPoolBase[0]?.id) {
      setCurrentLifterId(stageOrderPoolBase[0].id);
    }
    setActionNotice("IPF order auto-sorted by attempt, bodyweight, and lot.");
  };

  const reorderCurrentStage = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    const ids = controlOrderLifters.map((lifter) => lifter.id);
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= ids.length || toIndex >= ids.length) return;
    const nextIds = [...ids];
    const [moved] = nextIds.splice(fromIndex, 1);
    nextIds.splice(toIndex, 0, moved);
    setManualOrderByStage((prev) => ({ ...prev, [stageKey]: nextIds }));
    setActionNotice("Manual order updated for this stage.");
  };

  const markLifterDisqualified = (lifterId: string) => {
    const target = lifters.find((row) => row.id === lifterId);
    if (!target) return;
    const confirmed = window.confirm(`Disqualify ${target.name}? This removes the lifter from active order.`);
    if (!confirmed) return;
    const updated = lifters.map((row) => (row.id === lifterId ? { ...row, disqualified: true } : row));
    setLifters(updated);
    setActionNotice(`${target.name} marked as disqualified.`);
  };

  const buildQuickWeights = (baseWeight: number, floorWeight: number) => {
    const start = Math.max(20, floorWeight, Math.round((baseWeight - 10) / 2.5) * 2.5);
    return Array.from({ length: 10 }, (_, i) => Number((start + i * 2.5).toFixed(1)));
  };

  const openOrderEdit = (lifter: Lifter) => {
    const currentAttemptWeight = getAttemptValue(lifter, currentLift, currentAttemptIndex);
    setEditingOrderLifterId(lifter.id);
    setOrderEditAttempt(currentAttemptWeight === null ? "" : String(currentAttemptWeight));
    setOrderEditBodyweight(typeof lifter.bodyweight === "number" ? String(lifter.bodyweight) : "");
    setOrderEditLot(typeof lifter.lot === "number" ? String(lifter.lot) : "");
  };

  const cancelOrderEdit = () => {
    setEditingOrderLifterId(null);
    setOrderEditAttempt("");
    setOrderEditBodyweight("");
    setOrderEditLot("");
  };

  const saveOrderEdit = (lifter: Lifter) => {
    const attemptText = orderEditAttempt.trim();
    const bodyweightText = orderEditBodyweight.trim();
    const lotText = orderEditLot.trim();

    let attemptValue: number | "" = "";
    if (attemptText !== "") {
      const parsed = Number(attemptText);
      if (!Number.isFinite(parsed)) {
        setActionNotice("Attempt must be a valid number.");
        return;
      }
      if (Math.round(parsed * 10) % 25 !== 0) {
        setActionNotice("Use 2.5kg increments.");
        return;
      }
      attemptValue = Number(parsed.toFixed(1));
    }

    let bodyweightValue: number | "" = "";
    if (bodyweightText !== "") {
      const parsed = Number(bodyweightText);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setActionNotice("Bodyweight must be greater than 0.");
        return;
      }
      bodyweightValue = Number(parsed.toFixed(2));
    }

    let lotValue: number | "" = "";
    if (lotText !== "") {
      const parsed = Number(lotText);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 40) {
        setActionNotice("Lot must be between 1 and 40.");
        return;
      }
      lotValue = Math.floor(parsed);
    }

    const selected = lifters.find((row) => row.id === lifter.id);
    if (!selected) {
      setActionNotice("Lifter not found.");
      return;
    }
    if (attemptValue !== "" && currentAttemptIndex > 0) {
      const previous = getAttempts(selected, currentLift)[currentAttemptIndex - 1];
      if (typeof previous?.weight === "number" && attemptValue < previous.weight) {
        setActionNotice(`Next attempt cannot be below ${previous.weight}kg.`);
        return;
      }
    }

    // Apply attempt/bodyweight/lot in one state update so IPF ordering stays stable.
    const merged = lifters.map((row) => {
      if (row.id !== lifter.id) return row;
      const attempts = getAttempts(row, currentLift);
      attempts[currentAttemptIndex] = { weight: attemptValue, status: attemptValue === "" ? "UNATTEMPTED" : "PENDING" };
      const withAttempt = setAttempts(row, currentLift, attempts);
      const updatedRow = { ...withAttempt, bodyweight: bodyweightValue, lot: lotValue };
      return {
        ...updatedRow,
        weightClass: resolveWeightClass(updatedRow.sex, updatedRow.bodyweight, updatedRow.manualWeightClass),
      };
    });
    setLifters(merged);

    // Keep platform highlight pinned to the top IPF row after editing attempts
    // from this panel so it never stays on a higher weight by mistake.
    const orderPool =
      activeCompetitionGroupName !== null
        ? merged.filter((l) => isInGroup(l.group, activeCompetitionGroupName))
        : merged;
    const nextActive = orderLiftersForDisplayRound(orderPool, currentLift, currentAttemptIndex, manualOrderByStage).find((row) => {
      const attempt = getAttempts(row, currentLift)[currentAttemptIndex];
      return attempt?.status !== "GOOD" && attempt?.status !== "NO";
    });
    setCurrentLifterId(
      nextActive?.id ??
        orderLiftersForDisplayRound(orderPool, currentLift, currentAttemptIndex, manualOrderByStage)[0]?.id ??
        null,
    );

    setActionNotice("Lifter updated. Control, Results, and Display are synced.");
    cancelOrderEdit();
  };


  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col overflow-hidden text-white"
      style={{ background: "#0d1117", fontFamily: "system-ui, -apple-system, sans-serif" }}
    >
      {/* ═══ TOP NAVBAR ═══ */}
      <header
        className="flex flex-shrink-0 items-center justify-between px-5 py-3"
        style={{ background: "#161b22", borderBottom: "1px solid #30363d" }}
      >
        {/* Left: Logo + Competition */}
        <div className="flex items-center gap-3">
          <span className="text-2xl">🏆</span>
          <div>
            <p className="text-base font-black leading-tight text-white">{activeCompetitionName}</p>
            <p className="text-[11px]" style={{ color: "#8b949e" }}>Powerlifting Meet Platform</p>
          </div>
        </div>
        {/* Center: Group + Lift */}
        <div className="flex items-center gap-5">
          <div className="flex flex-col items-center rounded px-3 py-1" style={{ background: "#21262d" }}>
            <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "#8b949e" }}>GROUP</span>
            <span className="text-xl font-black text-white leading-none">{activeCompetitionGroupName || "ALL"}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-lg">🏃</span>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "#8b949e" }}>CURRENT LIFT</p>
              <p className="text-sm font-black text-white">{currentLift.toUpperCase()}</p>
            </div>
          </div>
        </div>
        {/* Right: Timer + Connection */}
        <div className="flex items-center gap-5">
          <div className="text-right">
            <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "#8b949e" }}>TIME REMAINING</p>
            <p
              className="text-2xl font-black tabular-nums leading-tight"
              style={{ color: "#ffd700", fontFamily: "monospace" }}
            >
              {String(Math.floor(timerRemainingSeconds / 60)).padStart(2, "0")}:{String(timerRemainingSeconds % 60).padStart(2, "0")}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest mb-1" style={{ color: "#8b949e" }}>CONNECTION</p>
            <span
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold"
              style={{ background: "#0a2a15", color: "#00e676" }}
            >
              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: "#00e676" }} />
              CONNECTED
            </span>
          </div>
        </div>
      </header>

      {/* ═══ BODY: sidebar + center + right ═══ */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── LEFT SIDEBAR ── */}
        <aside
          className="flex w-60 flex-shrink-0 flex-col overflow-y-auto"
          style={{ background: "#161b22", borderRight: "1px solid #30363d" }}
        >
          <nav className="flex-1 space-y-0.5 p-3 pt-4">
            {[
              { to: "/control", label: "Control Center", icon: "⚡" },
              { to: "/competitions", label: "Competitions", icon: "🏆" },
              { to: "/lifters", label: "Lifters", icon: "👤" },
              { to: "/groups", label: "Groups", icon: "👥" },
              { to: "/signals", label: "Referee Signals", icon: "🏴" },
              { to: "/screen", label: "Display Screens", icon: "🖥" },
              { to: "/results", label: "Results", icon: "📊" },
              { to: "/settings", label: "Settings & Backup", icon: "⚙️" },
            ].map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${isActive ? "text-white" : "hover:bg-white/5"}`
                }
                style={({ isActive }) =>
                  isActive
                    ? { background: "#1d6fe8", color: "#ffffff", borderRadius: "6px" }
                    : { color: "#8b949e" }
                }
              >
                <span className="text-base">{item.icon}</span>
                <span>{item.label}</span>
              </NavLink>
            ))}
          </nav>

          {/* Meet Status */}
          <div className="flex-shrink-0 p-4" style={{ borderTop: "1px solid #30363d" }}>
            <p className="mb-3 text-[10px] font-bold uppercase tracking-widest" style={{ color: "#8b949e" }}>
              MEET STATUS
            </p>
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs" style={{ color: "#8b949e" }}>Active Group</span>
                <span className="text-xs font-bold" style={{ color: "#00e676" }}>
                  {activeCompetitionGroupName || "All Groups"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs" style={{ color: "#8b949e" }}>Lifters Remaining</span>
                <span className="text-xs font-bold text-white">{activeStageLifters.length} / {sessionLifters.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs" style={{ color: "#8b949e" }}>Platform</span>
                <span className="text-xs font-bold text-white">1</span>
              </div>
              {activeCompetitionGroupName && (
                <button
                  onClick={() => setActiveCompetitionGroupName(null)}
                  className="mt-1 w-full text-left text-xs font-semibold"
                  style={{ color: "#1d6fe8" }}
                >
                  ← Show All Groups
                </button>
              )}
            </div>
          </div>

          {/* Competition Mode */}
          <div className="flex-shrink-0 p-4" style={{ borderTop: "1px solid #30363d" }}>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest" style={{ color: "#8b949e" }}>
              COMPETITION MODE
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setCompetitionMode("FULL_GAME")}
                className="flex-1 rounded py-1.5 text-xs font-bold"
                style={
                  competitionMode === "FULL_GAME"
                    ? { background: "#1d6fe8", color: "#fff" }
                    : { background: "#21262d", color: "#8b949e", border: "1px solid #30363d" }
                }
              >
                Full Game
              </button>
              <button
                onClick={() => setCompetitionMode("BENCH_ONLY")}
                className="flex-1 rounded py-1.5 text-xs font-bold"
                style={
                  competitionMode === "BENCH_ONLY"
                    ? { background: "#7c3aed", color: "#fff" }
                    : { background: "#21262d", color: "#8b949e", border: "1px solid #30363d" }
                }
              >
                Bench Only
              </button>
            </div>
          </div>

          {/* Version */}
          <div className="flex-shrink-0 px-4 py-3">
            <p className="text-[10px]" style={{ color: "#8b949e" }}>POWERLIFTING MEET CONSOLE v2.0.0</p>
          </div>
        </aside>

        {/* ── CENTER MAIN PANEL ── */}
        <main className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">

          {/* Current Lifter Card */}
          <div
            className="flex-shrink-0 rounded-lg p-6 text-center"
            style={{ background: "#161b22", border: "1px solid #30363d" }}
          >
            <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.3em]" style={{ color: "#00e676" }}>
              CURRENT LIFTER
            </p>
            <h2 className="text-6xl font-black uppercase leading-none tracking-tight text-white">
              {currentLifter?.name || "NO LIFTER"}
            </h2>
            <div className="mt-3 flex items-center justify-center gap-4 text-sm" style={{ color: "#8b949e" }}>
              <div className="h-px w-16 flex-shrink-0" style={{ background: "#00e676" }} />
              BW {currentLifter?.bodyweight ?? "—"} KG &nbsp;|&nbsp; LOT {currentLifter?.lot || "—"}
              <div className="h-px w-16 flex-shrink-0" style={{ background: "#00e676" }} />
            </div>
            <p className="mt-4 text-8xl font-black leading-none tabular-nums" style={{ color: "#00e676" }}>
              {currentDisplayWeight.toFixed(1)}<span className="ml-2 text-4xl font-bold">KG</span>
            </p>
            <div className="mt-3 flex items-center justify-center gap-2">
              <span className="text-lg">🏃</span>
              <span className="text-xl font-black text-white">{currentLift.toUpperCase()}</span>
              <span className="mx-1 text-lg" style={{ color: "#30363d" }}>•</span>
              <span className="text-xl font-black" style={{ color: "#1d6fe8" }}>ATTEMPT {currentAttemptIndex + 1}</span>
            </div>

            {/* Bar Status Pill */}
            <div className="mt-4 flex justify-center">
              <div
                className="inline-flex items-center gap-3 rounded-full px-6 py-2 text-sm"
                style={{ background: "#0d1117", border: "1px solid #30363d" }}
              >
                <span className="text-xs font-bold uppercase tracking-widest" style={{ color: "#8b949e" }}>BAR STATUS</span>
                <span className="font-bold" style={{ color: "#00e676" }}>✅ BAR LOADED</span>
              </div>
            </div>

            {/* Good / No Lift */}
            {showDecisionButtons && (
              <div className="mt-4 flex gap-3">
                <button
                  onClick={() => {
                    void applyRefereeDecision(["GOOD", "GOOD", "GOOD"])
                      .then(() => setActionNotice("Good lift saved."))
                      .catch((error) => {
                        console.error(LOG_CONTROL, "Good lift persist failed", error);
                        setActionNotice("Good lift save failed — check console.");
                      });
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onContextMenu={(event) => event.preventDefault()}
                  draggable={false}
                  style={{ WebkitUserSelect: "none", userSelect: "none", background: "#00e676", borderRadius: "6px" }}
                  className="flex flex-1 select-none touch-manipulation items-center justify-center gap-2 py-4 text-lg font-black text-black"
                >
                  ✓ GOOD LIFT
                </button>
                <button
                  onClick={() => {
                    void applyRefereeDecision(["NO", "NO", "NO"])
                      .then(() => setActionNotice("No lift saved."))
                      .catch((error) => {
                        console.error(LOG_CONTROL, "No lift persist failed", error);
                        setActionNotice("No lift save failed — check console.");
                      });
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onContextMenu={(event) => event.preventDefault()}
                  draggable={false}
                  style={{ WebkitUserSelect: "none", userSelect: "none", background: "#f44336", borderRadius: "6px" }}
                  className="flex flex-1 select-none touch-manipulation items-center justify-center gap-2 py-4 text-lg font-black text-white"
                >
                  ✗ NO LIFT
                </button>
              </div>
            )}
            {!showDecisionButtons && (
              <button
                onClick={() => setShowDecisionButtons(true)}
                className="mt-4 rounded-lg px-5 py-2 text-sm font-semibold text-white"
                style={{ background: "#21262d", border: "1px solid #30363d" }}
              >
                Show Decision Buttons
              </button>
            )}
            {showDecisionButtons && (
              <button
                onClick={() => setShowDecisionButtons(false)}
                className="mt-2 rounded px-3 py-1 text-xs"
                style={{ color: "#8b949e" }}
              >
                Hide buttons
              </button>
            )}

            {/* Bar Loaded + Reset + Collar */}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <button
                onClick={() => {
                  if (!currentLifter) {
                    setActionNotice("Add/select a lifter first.");
                    return;
                  }
                  startAttemptClock();
                  setActionNotice("Bar loaded. 1:00 platform timer started.");
                }}
                className="rounded-lg px-5 py-2.5 text-sm font-bold text-white"
                style={{ background: "#21262d", border: "1px solid #30363d" }}
              >
                🔔 Bar Loaded
              </button>
              <button
                onClick={() => {
                  void resetSignals().then(() => {
                    clearTimerState();
                    setActionNotice("Signals and platform timer reset.");
                  });
                }}
                className="rounded-lg px-5 py-2.5 text-sm font-bold text-white"
                style={{ background: "#21262d", border: "1px solid #30363d" }}
              >
                ↺ Reset
              </button>
              <label
                className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-xs"
                style={{ background: "#21262d", border: "1px solid #30363d", color: "#8b949e" }}
              >
                <input
                  type="checkbox"
                  checked={includeCollars}
                  onChange={(e) => setIncludeCollars(e.target.checked)}
                />
                Collars ({COLLAR_PER_SIDE_KG} kg ea.)
              </label>
            </div>
            {actionNotice && (
              <p className="mt-3 text-xs font-semibold" style={{ color: "#00e676" }}>{actionNotice}</p>
            )}

            {/* Referee Signals */}
            <div className="mt-5">
              <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.3em]" style={{ color: "#8b949e" }}>
                REFEREE SIGNALS
              </p>
              <div className="flex items-center justify-center gap-8">
                {refereeSignals.map((sig, i) => (
                  <div
                    key={i}
                    className="flex h-14 w-14 items-center justify-center rounded-full text-xl font-black"
                    style={{
                      border: `2px solid ${sig === "GOOD" ? "#00e676" : sig === "NO" ? "#f44336" : "#ffffff"}`,
                      background: sig === "GOOD" ? "#0a1f12" : sig === "NO" ? "#2a0a0a" : "transparent",
                      color: sig === "GOOD" ? "#00e676" : sig === "NO" ? "#f44336" : "transparent",
                    }}
                  >
                    {sig === "GOOD" ? "✓" : sig === "NO" ? "✗" : ""}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Lift History */}
          {currentLifter && (() => {
            const attempts = getAttempts(currentLifter, currentLift);
            let bestWeight: number | null = null;
            attempts.forEach((a) => {
              if (a.status === "GOOD" && typeof a.weight === "number") {
                if (bestWeight === null || a.weight > bestWeight) bestWeight = a.weight;
              }
            });
            return (
              <div
                className="flex-shrink-0 rounded-lg p-4"
                style={{ background: "#161b22", border: "1px solid #30363d" }}
              >
                <p className="mb-3 text-xs font-bold uppercase tracking-widest text-white">
                  {currentLifter.name} – {currentLift.toUpperCase()} HISTORY
                </p>
                <div className="grid grid-cols-4 gap-2">
                  {["ATTEMPT 1", "ATTEMPT 2", "ATTEMPT 3"].map((label, i) => {
                    const attempt = attempts[i];
                    return (
                      <div key={label} className="rounded-lg p-3 text-center" style={{ background: "#0d1117", border: "1px solid #30363d" }}>
                        <p className="mb-2 text-[10px] font-bold uppercase tracking-widest" style={{ color: "#8b949e" }}>{label}</p>
                        <p
                          className="text-base font-black"
                          style={{ color: attempt?.status === "GOOD" ? "#00e676" : attempt?.status === "NO" ? "#f44336" : "#8b949e" }}
                        >
                          {typeof attempt?.weight === "number" ? `${attempt.weight.toFixed(1)} KG` : "—"}
                        </p>
                        <p
                          className="mt-1 text-[10px] font-semibold uppercase"
                          style={{ color: attempt?.status === "GOOD" ? "#00e676" : attempt?.status === "NO" ? "#f44336" : "#8b949e" }}
                        >
                          {attempt?.status === "UNATTEMPTED" ? "PENDING" : (attempt?.status ?? "PENDING")}
                        </p>
                      </div>
                    );
                  })}
                  <div
                    className="rounded-lg p-3 text-center"
                    style={{ background: "#0d1117", border: `1px solid ${bestWeight !== null ? "#ffd700" : "#30363d"}` }}
                  >
                    <p className="mb-2 text-[10px] font-bold uppercase tracking-widest" style={{ color: "#ffd700" }}>🏆 BEST</p>
                    <p className="text-base font-black" style={{ color: "#00e676" }}>
                      {bestWeight !== null ? `${bestWeight.toFixed(1)} KG` : "—"}
                    </p>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Next Attempt Queue */}
          <div
            className="flex-shrink-0 rounded-lg p-4"
            style={{ background: "#161b22", border: "1px solid #30363d" }}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#8b949e" }}>
                NEXT ATTEMPT QUEUE ({queuedAttemptRows.length})
              </p>
              <button
                onClick={resetSignals}
                className="rounded px-3 py-1 text-xs font-semibold"
                style={{ background: "#21262d", border: "1px solid #30363d", color: "#8b949e" }}
              >
                Reset Signals
              </button>
            </div>
            <div className="space-y-3">
              {queuedAttemptRows.map(({ entry, lifter }, queueIndex) => {
                const queueLift = entry.lift;
                const queueAttemptIndex = entry.attemptIndex;
                const attempt = getAttempts(lifter, queueLift)[queueAttemptIndex];
                const previousAttempt = queueAttemptIndex > 0 ? getAttempts(lifter, queueLift)[queueAttemptIndex - 1] : null;
                const minQuickWeight = typeof previousAttempt?.weight === "number" ? previousAttempt.weight : 20;
                const baseWeight =
                  typeof attempt?.weight === "number" ? attempt.weight : resolveAttemptWeight(lifter, queueLift, queueAttemptIndex);
                const quickWeights = buildQuickWeights(baseWeight, minQuickWeight);
                const draftKey = `${lifter.id}-${queueLift}-${queueAttemptIndex}`;
                const draft = quickWeightDraft[draftKey] ?? "";
                const queueKey = `${entry.lifterId}-${entry.lift}-${entry.attemptIndex}`;
                const startedAt = queueTimerStarts[queueKey] ?? now;
                const perLifterSignedSeconds = Math.ceil((startedAt + ONE_MINUTE_MS - now) / 1000);

                const applyWeight = (nextWeight: number) => {
                  const result = updateAttemptForLifter(lifter.id, queueLift, queueAttemptIndex, nextWeight);
                  if (result.ok) {
                    setQuickWeightDraft((prev) => ({ ...prev, [draftKey]: String(nextWeight) }));
                  }
                  setActionNotice(result.message);
                };

                return (
                  <div
                    key={`${lifter.id}-${queueLift}-${queueAttemptIndex}`}
                    className="rounded-lg p-3"
                    style={{
                      background: "#0d1117",
                      border: `1px solid ${queueIndex === 0 ? "#1d6fe8" : "#30363d"}`,
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-bold text-white">{lifter.lot || "—"} — {lifter.name}</p>
                        <p className="mt-0.5 text-xs" style={{ color: "#8b949e" }}>
                          {queueLift.toUpperCase()} ATTEMPT {queueAttemptIndex + 1}
                        </p>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-2">
                        {queueIndex === 0 && (
                          <span
                            className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
                            style={{ background: "#0a1829", color: "#1d6fe8", border: "1px solid #1d6fe8" }}
                          >
                            CURRENT NEXT
                          </span>
                        )}
                        <span
                          className="rounded px-2 py-1 text-sm font-bold tabular-nums"
                          style={{ background: "#21262d", color: perLifterSignedSeconds < 0 ? "#f44336" : "#8b949e", border: "1px solid #30363d" }}
                        >
                          {formatSignedTimer(perLifterSignedSeconds)}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-5 gap-1.5">
                      {quickWeights.map((w) => (
                        <button
                          key={`${lifter.id}-${w}`}
                          onClick={() => applyWeight(w)}
                          className="rounded py-1.5 text-sm font-bold"
                          style={{
                            background: attempt?.weight === w ? "#1d6fe8" : "#21262d",
                            color: "#ffffff",
                            border: `1px solid ${attempt?.weight === w ? "#1d6fe8" : "#30363d"}`,
                          }}
                        >
                          {w}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <input
                        value={draft}
                        onChange={(e) => setQuickWeightDraft((prev) => ({ ...prev, [draftKey]: e.target.value }))}
                        placeholder="Custom kg"
                        className="h-9 flex-1 rounded border px-2 text-sm text-white"
                        style={{ background: "#161b22", borderColor: "#30363d" }}
                      />
                      <button
                        onClick={() => {
                          const currentValue = Number(draft || 0);
                          const nextValue = Number.isFinite(currentValue) && currentValue > 0 ? currentValue + 2.5 : baseWeight + 2.5;
                          applyWeight(Number(nextValue.toFixed(1)));
                        }}
                        className="h-9 w-10 rounded text-lg font-bold text-white"
                        style={{ background: "#21262d", border: "1px solid #30363d" }}
                      >
                        +
                      </button>
                      <button
                        onClick={() => {
                          const result = updateAttemptForLifter(lifter.id, queueLift, queueAttemptIndex, "");
                          setActionNotice(result.message);
                        }}
                        className="h-9 rounded px-3 text-sm font-bold"
                        style={{ background: "#21262d", border: "1px solid #30363d", color: "#8b949e" }}
                      >
                        Pass
                      </button>
                    </div>
                  </div>
                );
              })}
              {queuedAttemptRows.length === 0 && (
                <p className="py-3 text-center text-sm" style={{ color: "#8b949e" }}>
                  No pending next attempt declaration.
                </p>
              )}
            </div>
          </div>

          {/* IPF Lifter Order */}
          <div
            className="flex-shrink-0 rounded-lg p-4"
            style={{ background: "#161b22", border: "1px solid #30363d" }}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#8b949e" }}>
                IPF ORDER — {currentLift.toUpperCase()} A{currentAttemptIndex + 1}
              </p>
              <button
                onClick={resetControlOrderToIPF}
                className="rounded px-3 py-1.5 text-xs font-bold text-black"
                style={{ background: "#00e676" }}
              >
                Reset to IPF Order
              </button>
            </div>
            <input
              value={ipfOrderSearchTerm}
              onChange={(e) => setIpfOrderSearchTerm(e.target.value)}
              placeholder="Search lifter..."
              className="mb-3 h-9 w-full rounded border px-3 text-sm text-white"
              style={{ background: "#0d1117", borderColor: "#30363d" }}
            />
            {sessionFlightComplete && (
              <div
                className="mb-3 rounded-lg px-4 py-3 text-center"
                style={{ background: "#0a1f12", border: "1px solid #00e676" }}
              >
                <p className="text-sm font-bold uppercase tracking-widest" style={{ color: "#00e676" }}>
                  All lifters complete
                </p>
                <p className="mt-1 text-xs" style={{ color: "#8b949e" }}>
                  Everyone in this session has finished their scheduled attempts
                  ({competitionMode === "BENCH_ONLY" ? "bench press only" : "squat, bench, deadlift"}).
                </p>
              </div>
            )}
            <div className="space-y-1.5">
              {visibleOrderLifters.map((lifter, index) => {
                const orderIndex = controlOrderLifters.findIndex((row) => row.id === lifter.id);
                return (
                  <div
                    key={lifter.id}
                    draggable={editingOrderLifterId !== lifter.id}
                    onDragStart={() => setDraggingOrderIndex(orderIndex)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (draggingOrderIndex === null) return;
                      reorderCurrentStage(draggingOrderIndex, orderIndex);
                      setDraggingOrderIndex(null);
                    }}
                    onDragEnd={() => setDraggingOrderIndex(null)}
                    className="rounded-lg px-3 py-2"
                    style={{
                      background:
                        lifter.id === highlightedOrderLifterId
                          ? "#0a1829"
                          : lifter.id === updatedOrderLifterId
                            ? "#1a1a0a"
                            : "#21262d",
                      border: `1px solid ${
                        lifter.id === highlightedOrderLifterId
                          ? "#1d6fe8"
                          : lifter.id === updatedOrderLifterId
                            ? "#ffd700"
                            : "#30363d"
                      }`,
                    }}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-white">
                          {index + 1}. {lifter.name}
                        </p>
                        {editingOrderLifterId === lifter.id ? (
                          <div className="mt-2 grid grid-cols-3 gap-2">
                            <input
                              type="number"
                              step="2.5"
                              value={orderEditAttempt}
                              onChange={(e) => setOrderEditAttempt(e.target.value)}
                              placeholder={`${currentLift.toUpperCase()} A${currentAttemptIndex + 1}`}
                              className="h-8 rounded border px-2 text-xs text-white"
                              style={{ background: "#0d1117", borderColor: "#30363d" }}
                            />
                            <input
                              type="number"
                              value={orderEditBodyweight}
                              onChange={(e) => setOrderEditBodyweight(e.target.value)}
                              placeholder="Bodyweight"
                              className="h-8 rounded border px-2 text-xs text-white"
                              style={{ background: "#0d1117", borderColor: "#30363d" }}
                            />
                            <select
                              value={orderEditLot}
                              onChange={(e) => setOrderEditLot(e.target.value)}
                              className="h-8 rounded border px-2 text-xs text-white"
                              style={{ background: "#0d1117", borderColor: "#30363d" }}
                            >
                              <option value="" style={{ background: "#0d1117" }}>Lot</option>
                              {LOT_NUMBER_OPTIONS.map((lotNo) => (
                                <option key={lotNo} value={lotNo} style={{ background: "#0d1117" }}>{lotNo}</option>
                              ))}
                            </select>
                          </div>
                        ) : (
                          <p className="text-xs" style={{ color: "#8b949e" }}>
                            Next: {getAttemptValue(lifter, currentLift, currentAttemptIndex) ?? "—"} kg | BW{" "}
                            {typeof lifter.bodyweight === "number" ? lifter.bodyweight : "—"} | Lot {lifter.lot || "—"}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-shrink-0 flex-wrap items-center gap-1">
                        {editingOrderLifterId === lifter.id ? (
                          <>
                            <button
                              onClick={() => saveOrderEdit(lifter)}
                              className="rounded px-2 py-1 text-xs font-bold text-black"
                              style={{ background: "#00e676" }}
                            >
                              Save
                            </button>
                            <button
                              onClick={cancelOrderEdit}
                              className="rounded px-2 py-1 text-xs font-bold text-white"
                              style={{ background: "#30363d" }}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => reorderCurrentStage(orderIndex, Math.max(0, orderIndex - 1))}
                              disabled={orderIndex <= 0}
                              className="rounded px-2 py-1 text-xs font-bold text-white disabled:opacity-30"
                              style={{ background: "#30363d" }}
                            >
                              ↑
                            </button>
                            <button
                              onClick={() =>
                                reorderCurrentStage(orderIndex, Math.min(controlOrderLifters.length - 1, orderIndex + 1))
                              }
                              disabled={orderIndex === -1 || orderIndex >= controlOrderLifters.length - 1}
                              className="rounded px-2 py-1 text-xs font-bold text-white disabled:opacity-30"
                              style={{ background: "#30363d" }}
                            >
                              ↓
                            </button>
                            <button
                              onClick={() => openOrderEdit(lifter)}
                              className="rounded px-2 py-1 text-xs font-bold text-white"
                              style={{ background: "#7c3aed" }}
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => markLifterDisqualified(lifter.id)}
                              className="rounded px-2 py-1 text-xs font-bold text-white"
                              style={{ background: "#7f1d1d" }}
                            >
                              DQ
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => {
                            if (orderIndex > 0) {
                              reorderCurrentStage(orderIndex, 0);
                            }
                            setCurrentLifterId(lifter.id);
                            setCurrentLift(currentLift);
                            setCurrentAttemptIndex(currentAttemptIndex);
                            setActionNotice(
                              orderIndex > 0
                                ? `Current lifter set: ${lifter.name} — moved to top of order.`
                                : `Current lifter set: ${lifter.name}`,
                            );
                          }}
                          className="rounded px-2 py-1 text-xs font-bold text-white"
                          style={{ background: "#1d6fe8" }}
                        >
                          Set ✓
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {visibleOrderLifters.length === 0 && (
                <p className="py-3 text-center text-sm" style={{ color: "#8b949e" }}>
                  No lifters found for this stage.
                </p>
              )}
            </div>
          </div>
        </main>

        {/* ── RIGHT PANEL ── */}
        <aside
          className="flex w-80 flex-shrink-0 flex-col gap-4 overflow-y-auto p-4"
          style={{ borderLeft: "1px solid #30363d" }}
        >
          {/* Next Lifters */}
          <div className="rounded-lg p-4" style={{ background: "#161b22", border: "1px solid #30363d" }}>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#8b949e" }}>NEXT LIFTERS</p>
              <span className="text-xs font-semibold" style={{ color: "#1d6fe8" }}>View All</span>
            </div>
            <div className="space-y-2">
              {controlOrderLifters.slice(0, 5).map((lifter, i) => {
                const nextWeight = getAttemptValue(lifter, currentLift, currentAttemptIndex);
                return (
                  <div
                    key={lifter.id}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5"
                    style={{
                      background: lifter.id === currentLifterId ? "#0a1829" : "#21262d",
                      border: `1px solid ${lifter.id === currentLifterId ? "#1d6fe8" : "#30363d"}`,
                    }}
                    onClick={() => {
                      const orderIndex = controlOrderLifters.findIndex((row) => row.id === lifter.id);
                      if (orderIndex > 0) reorderCurrentStage(orderIndex, 0);
                      setCurrentLifterId(lifter.id);
                      setActionNotice(`Current lifter set: ${lifter.name}`);
                    }}
                  >
                    <span
                      className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-xs font-black"
                      style={{ background: "#30363d", color: "#8b949e" }}
                    >
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-white">{lifter.name}</p>
                      <p className="text-[10px]" style={{ color: "#8b949e" }}>
                        BW {typeof lifter.bodyweight === "number" ? lifter.bodyweight : "—"} &nbsp;|&nbsp; LOT {lifter.lot || "—"}
                      </p>
                    </div>
                    {nextWeight !== null && (
                      <span className="flex-shrink-0 text-sm font-black tabular-nums" style={{ color: "#1d6fe8" }}>
                        {nextWeight.toFixed(1)} kg
                      </span>
                    )}
                  </div>
                );
              })}
              {controlOrderLifters.length === 0 && (
                <p className="py-4 text-center text-sm" style={{ color: "#8b949e" }}>No lifters in order.</p>
              )}
            </div>
          </div>

          {/* Attempt Selection */}
          {(() => {
            const firstQueue = queuedAttemptRows[0];
            if (!firstQueue) {
              return (
                <div className="rounded-lg p-4" style={{ background: "#161b22", border: "1px solid #30363d" }}>
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-widest" style={{ color: "#8b949e" }}>
                    ATTEMPT SELECTION
                  </p>
                  <p className="py-4 text-center text-sm" style={{ color: "#8b949e" }}>No pending declarations.</p>
                </div>
              );
            }
            const { entry, lifter } = firstQueue;
            const attempt = getAttempts(lifter, entry.lift)[entry.attemptIndex];
            const previousAttempt = entry.attemptIndex > 0 ? getAttempts(lifter, entry.lift)[entry.attemptIndex - 1] : null;
            const minQuickWeight = typeof previousAttempt?.weight === "number" ? previousAttempt.weight : 20;
            const baseWeight =
              typeof attempt?.weight === "number"
                ? attempt.weight
                : resolveAttemptWeight(lifter, entry.lift, entry.attemptIndex);
            const quickWeights = buildQuickWeights(baseWeight, minQuickWeight);
            const draftKey = `${lifter.id}-${entry.lift}-${entry.attemptIndex}`;
            const draft = quickWeightDraft[draftKey] ?? "";

            const applyQueueWeight = (nextWeight: number) => {
              const result = updateAttemptForLifter(lifter.id, entry.lift, entry.attemptIndex, nextWeight);
              if (result.ok) {
                setQuickWeightDraft((prev) => ({ ...prev, [draftKey]: String(nextWeight) }));
              }
              setActionNotice(result.message);
            };

            return (
              <div className="rounded-lg p-4" style={{ background: "#161b22", border: "1px solid #30363d" }}>
                <p className="mb-1 text-[10px] font-bold uppercase tracking-widest" style={{ color: "#8b949e" }}>
                  ATTEMPT SELECTION
                </p>
                <p className="mb-3 text-xs font-semibold" style={{ color: "#1d6fe8" }}>
                  {lifter.name} — {entry.lift.toUpperCase()} A{entry.attemptIndex + 1}
                </p>
                <div className="grid grid-cols-3 gap-1.5">
                  {quickWeights.slice(0, 9).map((w) => (
                    <button
                      key={w}
                      onClick={() => applyQueueWeight(w)}
                      className="rounded py-2.5 text-sm font-bold"
                      style={{
                        background: attempt?.weight === w ? "#1d6fe8" : "#21262d",
                        color: "#ffffff",
                        border: `1px solid ${attempt?.weight === w ? "#1d6fe8" : "#30363d"}`,
                      }}
                    >
                      {w}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    value={draft}
                    onChange={(e) => setQuickWeightDraft((prev) => ({ ...prev, [draftKey]: e.target.value }))}
                    placeholder="Enter weight..."
                    className="h-10 flex-1 rounded border px-3 text-sm text-white"
                    style={{ background: "#0d1117", borderColor: "#30363d" }}
                  />
                  <span className="flex items-center px-1 text-base" style={{ color: "#8b949e" }}>⌨</span>
                </div>
                <button
                  onClick={() => {
                    const customVal = Number(draft);
                    if (Number.isFinite(customVal) && customVal > 0) {
                      applyQueueWeight(customVal);
                    }
                  }}
                  className="mt-2 w-full rounded py-2.5 text-sm font-bold text-white"
                  style={{ background: "#21262d", border: "1px solid #30363d" }}
                >
                  ENTER CUSTOM WEIGHT ⌨
                </button>
              </div>
            );
          })()}

          {/* Meet Information */}
          <div className="rounded-lg p-4" style={{ background: "#161b22", border: "1px solid #30363d" }}>
            <p className="mb-3 text-[10px] font-bold uppercase tracking-widest" style={{ color: "#8b949e" }}>
              MEET INFORMATION
            </p>
            <div className="space-y-2.5">
              {[
                { label: "Event", value: competitionMode === "BENCH_ONLY" ? "Bench Press Only" : "Full Powerlifting" },
                { label: "Competition", value: activeCompetitionName },
                { label: "Current Lift", value: `${currentLift.toUpperCase()} — Attempt ${currentAttemptIndex + 1}` },
                { label: "Mode", value: competitionMode === "BENCH_ONLY" ? "Bench Only" : "Full Game" },
                { label: "Lifters", value: `${sessionLifters.length} in session` },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-start justify-between gap-2">
                  <span className="flex-shrink-0 text-xs" style={{ color: "#8b949e" }}>{label}</span>
                  <span className="text-right text-xs font-semibold text-white">{value}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

      {/* ═══ BOTTOM STATUS BAR ═══ */}
      <footer
        className="flex flex-shrink-0 items-center justify-between px-5 py-2"
        style={{ background: "#161b22", borderTop: "1px solid #30363d" }}
      >
        <div className="flex items-center gap-2">
          <span className="inline-block animate-spin text-sm" style={{ color: "#00e676" }}>⟳</span>
          <span className="text-xs font-bold uppercase tracking-widest" style={{ color: "#00e676" }}>
            READY FOR NEXT ATTEMPT
          </span>
        </div>
        <span className="text-xs" style={{ color: "#8b949e" }}>
          LAST UPDATED: {new Date().toLocaleTimeString()}
        </span>
      </footer>
    </div>
  );
};

const LifterManagementPage = () => {
  const { lifters, setLifters, currentLifterId, setCurrentLifterId, groups, competitionMode } = useAppContext();
  const [notice, setNotice] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [lifterViewFilter, setLifterViewFilter] = useState<"ALL" | "ACTIVE" | "DISQUALIFIED">("ALL");
  const [customTeams, setCustomTeams] = useState<string[]>([]);
  const [teamState, setTeamState] = useState(INDIA_STATES[0] ?? "");
  const [teamDistrict, setTeamDistrict] = useState((INDIA_DISTRICTS[INDIA_STATES[0] ?? ""] ?? [""])[0]);
  const [customTeamName, setCustomTeamName] = useState("");
  const [form, setForm] = useState({
    name: "",
    sex: "Male" as "Male" | "Female",
    dob: "",
    bodyweight: "" as number | "",
    manualWeightClass: "",
    category: "Sub Junior Men",
    group: "",
    team: "",
    rackHeightSquat: "" as number | "",
    rackHeightBench: "" as number | "",
    lot: "" as number | "",
    squat1: "" as number | "",
    bench1: "" as number | "",
    deadlift1: "" as number | "",
    isEquipped: false,
    disqualified: false,
  });

  const categoryOptions = getCategoryOptions(form.sex);
  const selectedStateDistricts = INDIA_DISTRICTS[teamState] ?? [];
  const resolvedWeightClass = resolveWeightClass(form.sex, form.bodyweight, form.manualWeightClass);
  const visibleLifters = useMemo(() => {
    if (lifterViewFilter === "ACTIVE") return lifters.filter((lifter) => !lifter.disqualified);
    if (lifterViewFilter === "DISQUALIFIED") return lifters.filter((lifter) => lifter.disqualified);
    return lifters;
  }, [lifters, lifterViewFilter]);

  const resetForm = () => {
    setEditingId(null);
    setForm({
      name: "",
      sex: "Male",
      dob: "",
      bodyweight: "",
      manualWeightClass: "",
      category: "Sub Junior Men",
      group: "",
      team: "",
      rackHeightSquat: "",
      rackHeightBench: "",
      lot: "",
      squat1: "",
      bench1: "",
      deadlift1: "",
      isEquipped: false,
      disqualified: false,
    });
  };

  const applyStateDistrictTeam = () => {
    if (!teamState || !teamDistrict) return;
    setForm((prev) => ({ ...prev, team: `India - ${teamState} - ${teamDistrict}` }));
  };

  const createCustomTeam = () => {
    const next = customTeamName.trim();
    if (!next) return;
    if (!customTeams.includes(next)) {
      setCustomTeams((prev) => [...prev, next]);
    }
    setForm((prev) => ({ ...prev, team: next }));
    setCustomTeamName("");
  };

  const keepAttemptWithFirstWeight = (attempts: Attempt[], firstWeight: number | "") => {
    const next = [...attempts];
    const existingStatus = next[0]?.status;
    const status: AttemptStatus =
      firstWeight === ""
        ? "UNATTEMPTED"
        : existingStatus === "GOOD" || existingStatus === "NO"
          ? existingStatus
          : "PENDING";
    next[0] = { weight: firstWeight, status };
    if (!next[1]) next[1] = { weight: "", status: "UNATTEMPTED" };
    if (!next[2]) next[2] = { weight: "", status: "UNATTEMPTED" };
    return next;
  };

  const saveLifter = () => {
    if (!form.name.trim()) {
      setNotice("Lifter name is required.");
      return;
    }
    if (!editingId && lifters.length >= 500) {
      setNotice("Maximum 500 lifters allowed per competition.");
      return;
    }
    const category = categoryOptions.includes(form.category) ? form.category : categoryOptions[0];
    const payload = {
      name: form.name.trim(),
      sex: form.sex,
      dob: form.dob,
      bodyweight: form.bodyweight,
      manualWeightClass: form.manualWeightClass.trim(),
      weightClass: resolveWeightClass(form.sex, form.bodyweight, form.manualWeightClass),
      category,
      group: form.group,
      team: form.team || "Independent",
      rackHeightSquat: form.rackHeightSquat,
      rackHeightBench: form.rackHeightBench,
      lot: form.lot,
      isEquipped: form.isEquipped,
      disqualified: form.disqualified,
    };

    if (editingId) {
      const updated = lifters.map((l) =>
        l.id === editingId
          ? {
              ...l,
              ...payload,
              squatAttempts: keepAttemptWithFirstWeight(l.squatAttempts, form.squat1),
              benchAttempts: keepAttemptWithFirstWeight(l.benchAttempts, form.bench1),
              deadliftAttempts: keepAttemptWithFirstWeight(l.deadliftAttempts, form.deadlift1),
            }
          : l,
      );
      setLifters(updated);
      setNotice("Lifter updated.");
      resetForm();
      return;
    }

    const lifterToAdd: Lifter = {
      id: Date.now().toString(),
      ...payload,
      squatAttempts: emptyAttemptsFromFirst(form.squat1),
      benchAttempts: emptyAttemptsFromFirst(form.bench1),
      deadliftAttempts: emptyAttemptsFromFirst(form.deadlift1),
    };
    const updated = [...lifters, lifterToAdd];
    setLifters(updated);
    if (!currentLifterId) {
      const firstInOrder = orderLiftersByIPF(updated, "squat", 0)[0]?.id ?? lifterToAdd.id;
      setCurrentLifterId(firstInOrder);
    }
    setNotice("Lifter created.");
    resetForm();
  };

  const editLifter = (lifter: Lifter) => {
    setEditingId(lifter.id);
    setForm({
      name: lifter.name,
      sex: lifter.sex,
      dob: lifter.dob,
      bodyweight: lifter.bodyweight,
      manualWeightClass: lifter.manualWeightClass,
      category: lifter.category,
      group: lifter.group,
      team: lifter.team,
      rackHeightSquat: lifter.rackHeightSquat,
      rackHeightBench: lifter.rackHeightBench,
      lot: lifter.lot,
      squat1: lifter.squatAttempts[0]?.weight ?? "",
      bench1: lifter.benchAttempts[0]?.weight ?? "",
      deadlift1: lifter.deadliftAttempts[0]?.weight ?? "",
      isEquipped: lifter.isEquipped,
      disqualified: lifter.disqualified,
    });

    const teamParts = lifter.team.split(" - ");
    if (teamParts.length >= 3 && teamParts[0] === "India") {
      const state = teamParts[1];
      const district = teamParts[2];
      if (INDIA_STATES.includes(state)) {
        setTeamState(state);
        if ((INDIA_DISTRICTS[state] ?? []).includes(district)) {
          setTeamDistrict(district);
        }
      }
    }
  };

  const deleteLifter = (lifter: Lifter) => {
    const confirmed = window.confirm(`Delete lifter ${lifter.name}?`);
    if (!confirmed) return;
    const updated = lifters.filter((l) => l.id !== lifter.id);
    setLifters(updated);
    if (updated.length === 0) setCurrentLifterId(null);
    if (editingId === lifter.id) resetForm();
    setNotice(`Deleted ${lifter.name}.`);
  };

  const restoreLifter = (lifter: Lifter) => {
    if (!lifter.disqualified) return;
    const updated = lifters.map((row) => (row.id === lifter.id ? { ...row, disqualified: false } : row));
    setLifters(updated);
    if (!currentLifterId) {
      const firstInOrder = orderLiftersByIPF(updated, "squat", 0)[0]?.id ?? null;
      setCurrentLifterId(firstInOrder);
    }
    setNotice(`${lifter.name} restored to active lifters.`);
  };

  useEffect(() => {
    if (!selectedStateDistricts.length) {
      setTeamDistrict("");
      return;
    }
    if (!selectedStateDistricts.includes(teamDistrict)) {
      setTeamDistrict(selectedStateDistricts[0]);
    }
  }, [teamState, teamDistrict, selectedStateDistricts]);

  useEffect(() => {
    if (!groups.length) {
      setForm((prev) => ({ ...prev, group: "" }));
      return;
    }
    if (form.group && !groups.some((g) => g.name === form.group)) {
      setForm((prev) => ({ ...prev, group: "" }));
    }
  }, [groups, form.group]);

  return (
    <section>
      <SectionHeader title="Manage Lifters" path="/lifters" />
      {notice && <p className="mb-4 rounded-xl border border-cyan-300/30 bg-cyan-400/10 px-3 py-2 text-sm text-cyan-100">{notice}</p>}

      {!editingId ? (
        <div className="rounded-2xl border border-white/15 bg-white/5 p-5">
          <p className="mb-3 text-xs uppercase tracking-[0.2em] text-cyan-300">Add Lifter</p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Field placeholder="Lifter Name" value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} />
          <select
            value={form.sex}
            onChange={(e) => {
              const nextSex = e.target.value as "Male" | "Female";
              const nextOptions = getCategoryOptions(nextSex);
              setForm((prev) => ({
                ...prev,
                sex: nextSex,
                category: nextOptions.includes(prev.category) ? prev.category : nextOptions[0],
              }));
            }}
            className="h-11 rounded-xl border border-white/20 bg-black/40 px-3"
          >
            <option value="Male" className="bg-slate-900">Male</option>
            <option value="Female" className="bg-slate-900">Female</option>
          </select>
          <Field type="date" value={form.dob} onChange={(e) => setForm((prev) => ({ ...prev, dob: e.target.value }))} />
          <div className="md:col-span-2 xl:col-span-3 rounded-xl border border-white/10 bg-black/25 p-4">
            <p className="mb-3 text-xs uppercase tracking-[0.18em] text-cyan-300">Body weight &amp; weight class</p>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label htmlFor="add-lifter-bodyweight" className="mb-1 block text-xs font-medium text-slate-400">
                  Body weight (kg)
                </label>
                <Field
                  id="add-lifter-bodyweight"
                  type="number"
                  step="0.05"
                  min={0}
                  placeholder="Exact scale weight, e.g. 82.45"
                  value={form.bodyweight}
                  onChange={(e) => setForm((prev) => ({ ...prev, bodyweight: e.target.value === "" ? "" : Number(e.target.value) }))}
                />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-slate-400">Weight class</p>
                <div
                  className="flex h-11 items-center rounded-xl border border-cyan-300/40 bg-cyan-500/10 px-3 text-sm font-semibold text-cyan-100"
                  aria-live="polite"
                >
                  {resolvedWeightClass || "—"}
                </div>
                <p className="mt-1 text-[11px] leading-snug text-slate-500">
                  Computed from body weight unless you override below (manual class).
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div>
                <label htmlFor="add-lifter-manual-wc-select" className="mb-1 block text-xs font-medium text-slate-400">
                  Manual weight class (optional)
                </label>
                <select
                  id="add-lifter-manual-wc-select"
                  value={MANUAL_WEIGHT_CLASSES.includes(form.manualWeightClass) ? form.manualWeightClass : ""}
                  onChange={(e) => setForm((prev) => ({ ...prev, manualWeightClass: e.target.value }))}
                  className="h-11 w-full rounded-xl border border-white/20 bg-black/40 px-3 text-white"
                >
                  <option value="" className="bg-slate-900">
                    Auto from body weight
                  </option>
                  {MANUAL_WEIGHT_CLASSES.map((wc) => (
                    <option key={wc} value={wc} className="bg-slate-900">
                      {wc}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="add-lifter-manual-wc-custom" className="mb-1 block text-xs font-medium text-slate-400">
                  Custom class text (optional)
                </label>
                <Field
                  id="add-lifter-manual-wc-custom"
                  placeholder="Overrides dropdown when filled"
                  value={MANUAL_WEIGHT_CLASSES.includes(form.manualWeightClass) ? "" : form.manualWeightClass}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, manualWeightClass: e.target.value }))
                  }
                />
              </div>
            </div>
          </div>
          <select
            value={form.category}
            onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
            className="h-11 rounded-xl border border-white/20 bg-black/40 px-3"
          >
            {categoryOptions.map((c) => (
              <option key={c} value={c} className="bg-slate-900">
                {c}
              </option>
            ))}
          </select>
          <select
            value={form.group}
            onChange={(e) => setForm((prev) => ({ ...prev, group: e.target.value }))}
            className="h-11 rounded-xl border border-white/20 bg-black/40 px-3"
          >
            <option value="" className="bg-slate-900">
              No group
            </option>
            {groups.map((g) => (
              <option key={g.id} value={g.name} className="bg-slate-900">
                {g.name}
              </option>
            ))}
          </select>
          <Field
            type="number"
            placeholder="Squat Rack Height"
            value={form.rackHeightSquat}
            onChange={(e) => setForm((prev) => ({ ...prev, rackHeightSquat: e.target.value === "" ? "" : Number(e.target.value) }))}
          />
          <Field
            type="number"
            placeholder="Bench Rack Height"
            value={form.rackHeightBench}
            onChange={(e) => setForm((prev) => ({ ...prev, rackHeightBench: e.target.value === "" ? "" : Number(e.target.value) }))}
          />
          <select
            value={form.lot}
            onChange={(e) => setForm((prev) => ({ ...prev, lot: e.target.value === "" ? "" : Number(e.target.value) }))}
            className="h-11 rounded-xl border border-white/20 bg-black/40 px-3"
          >
            <option value="" className="bg-slate-900">
              Lot Number
            </option>
            {LOT_NUMBER_OPTIONS.map((lotNo) => (
              <option key={lotNo} value={lotNo} className="bg-slate-900">
                {lotNo}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4">
          <p className="mb-3 text-xs uppercase tracking-[0.18em] text-cyan-300">Team (India State to District)</p>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <select
              value={teamState}
              onChange={(e) => setTeamState(e.target.value)}
              className="h-11 rounded-xl border border-white/20 bg-black/40 px-3"
            >
              {INDIA_STATES.map((state) => (
                <option key={state} value={state} className="bg-slate-900">
                  {state}
                </option>
              ))}
            </select>
            <select
              value={teamDistrict}
              onChange={(e) => setTeamDistrict(e.target.value)}
              className="h-11 rounded-xl border border-white/20 bg-black/40 px-3"
            >
              {selectedStateDistricts.map((district) => (
                <option key={district} value={district} className="bg-slate-900">
                  {district}
                </option>
              ))}
            </select>
            <button onClick={applyStateDistrictTeam} className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-black">
              Use State/District Team
            </button>
            <Field placeholder="Selected Team" value={form.team} onChange={(e) => setForm((prev) => ({ ...prev, team: e.target.value }))} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Field
              placeholder="Create New Team"
              value={customTeamName}
              onChange={(e) => setCustomTeamName(e.target.value)}
            />
            <button onClick={createCustomTeam} className="rounded-xl bg-purple-500 px-4 py-2 text-sm font-semibold">
              Create Team
            </button>
            {customTeams.length > 0 && (
              <select
                value={form.team}
                onChange={(e) => setForm((prev) => ({ ...prev, team: e.target.value }))}
                className="h-11 min-w-60 rounded-xl border border-white/20 bg-black/40 px-3"
              >
                <option value="" className="bg-slate-900">
                  Select Created Team
                </option>
                {customTeams.map((team) => (
                  <option key={team} value={team} className="bg-slate-900">
                    {team}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4">
          <p className="mb-3 text-xs uppercase tracking-[0.18em] text-cyan-300">
            1st Attempts {competitionMode === "BENCH_ONLY" ? "(BP)" : "(SQ / BP / DL)"}
          </p>
          <div className={`grid gap-3 ${competitionMode === "BENCH_ONLY" ? "max-w-xs" : "md:grid-cols-3"}`}>
            {competitionMode !== "BENCH_ONLY" && (
              <Field
                type="number"
                placeholder="SQ 1"
                value={form.squat1}
                onChange={(e) => setForm((prev) => ({ ...prev, squat1: e.target.value === "" ? "" : Number(e.target.value) }))}
              />
            )}
            <Field
              type="number"
              placeholder="BP 1"
              value={form.bench1}
              onChange={(e) => setForm((prev) => ({ ...prev, bench1: e.target.value === "" ? "" : Number(e.target.value) }))}
            />
            {competitionMode !== "BENCH_ONLY" && (
              <Field
                type="number"
                placeholder="DL 1"
                value={form.deadlift1}
                onChange={(e) => setForm((prev) => ({ ...prev, deadlift1: e.target.value === "" ? "" : Number(e.target.value) }))}
              />
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={form.isEquipped}
              onChange={(e) => setForm((prev) => ({ ...prev, isEquipped: e.target.checked }))}
            />
            Equipped
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={form.disqualified}
              onChange={(e) => setForm((prev) => ({ ...prev, disqualified: e.target.checked }))}
            />
            Disqualified
          </label>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={saveLifter} className="rounded-xl bg-cyan-500 px-4 py-2 font-semibold text-black">
            Add Lifter
          </button>
        </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-cyan-300/20 bg-cyan-500/5 p-4 text-sm text-cyan-100">
          Editing is active in lifter list. Save or cancel the row edit to continue adding new lifters.
        </div>
      )}

      <div className="mt-5 overflow-x-auto rounded-2xl border border-white/15 bg-black/20">
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-3">
          <p className="text-xs uppercase tracking-[0.2em] text-cyan-300">Lifter View</p>
          <button
            onClick={() => setLifterViewFilter("ALL")}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
              lifterViewFilter === "ALL" ? "bg-cyan-500 text-black" : "bg-white/10 text-slate-100"
            }`}
          >
            All ({lifters.length})
          </button>
          <button
            onClick={() => setLifterViewFilter("ACTIVE")}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
              lifterViewFilter === "ACTIVE" ? "bg-cyan-500 text-black" : "bg-white/10 text-slate-100"
            }`}
          >
            Active ({lifters.filter((lifter) => !lifter.disqualified).length})
          </button>
          <button
            onClick={() => setLifterViewFilter("DISQUALIFIED")}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
              lifterViewFilter === "DISQUALIFIED" ? "bg-rose-500 text-white" : "bg-white/10 text-slate-100"
            }`}
          >
            Disqualified ({lifters.filter((lifter) => lifter.disqualified).length})
          </button>
        </div>
        <table className="min-w-full text-sm">
          <thead className="bg-white/5 text-left text-slate-300">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Sex</th>
              <th className="px-4 py-3">DOB</th>
              <th className="px-4 py-3">Body wt (kg)</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Weight class</th>
              <th className="px-4 py-3">Group</th>
              <th className="px-4 py-3">Team</th>
              <th className="px-4 py-3">Lot</th>
              <th className="px-4 py-3">Rack S/B</th>
              <th className="px-4 py-3">{competitionMode === "BENCH_ONLY" ? "BP 1" : "SQ/BP/DL 1"}</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleLifters.map((l) => {
              const isEditing = editingId === l.id;
              return (
                <tr key={l.id} className="border-t border-white/10">
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <input
                        value={form.name}
                        onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                        className="h-9 w-32 rounded-lg border border-white/20 bg-black/40 px-2 text-sm"
                      />
                    ) : (
                      l.name
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <select
                        value={form.sex}
                        onChange={(e) => {
                          const nextSex = e.target.value as "Male" | "Female";
                          const nextOptions = getCategoryOptions(nextSex);
                          setForm((prev) => ({
                            ...prev,
                            sex: nextSex,
                            category: nextOptions.includes(prev.category) ? prev.category : nextOptions[0],
                          }));
                        }}
                        className="h-9 rounded-lg border border-white/20 bg-black/40 px-2 text-sm"
                      >
                        <option value="Male" className="bg-slate-900">Male</option>
                        <option value="Female" className="bg-slate-900">Female</option>
                      </select>
                    ) : (
                      l.sex
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <input
                        type="date"
                        value={form.dob}
                        onChange={(e) => setForm((prev) => ({ ...prev, dob: e.target.value }))}
                        className="h-9 rounded-lg border border-white/20 bg-black/40 px-2 text-sm"
                      />
                    ) : (
                      l.dob || "-"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <input
                        type="number"
                        step="0.05"
                        min={0}
                        value={form.bodyweight}
                        onChange={(e) => setForm((prev) => ({ ...prev, bodyweight: e.target.value === "" ? "" : Number(e.target.value) }))}
                        placeholder="kg"
                        title="Body weight (kg)"
                        className="h-9 w-24 rounded-lg border border-white/20 bg-black/40 px-2 text-sm"
                      />
                    ) : typeof l.bodyweight === "number" ? (
                      l.bodyweight
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <select
                        value={form.category}
                        onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
                        className="h-9 rounded-lg border border-white/20 bg-black/40 px-2 text-sm"
                      >
                        {getCategoryOptions(form.sex).map((category) => (
                          <option key={category} value={category} className="bg-slate-900">
                            {category}
                          </option>
                        ))}
                      </select>
                    ) : (
                      l.category || "-"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <div className="flex min-w-[14rem] flex-col gap-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-cyan-300/90">
                          {resolvedWeightClass || "—"}
                        </span>
                        <select
                          value={MANUAL_WEIGHT_CLASSES.includes(form.manualWeightClass) ? form.manualWeightClass : ""}
                          onChange={(e) => setForm((prev) => ({ ...prev, manualWeightClass: e.target.value }))}
                          className="h-9 rounded-lg border border-white/20 bg-black/40 px-2 text-sm"
                        >
                          <option value="" className="bg-slate-900">
                            Auto from body weight
                          </option>
                          {MANUAL_WEIGHT_CLASSES.map((wc) => (
                            <option key={wc} value={wc} className="bg-slate-900">
                              {wc}
                            </option>
                          ))}
                        </select>
                        <input
                          value={MANUAL_WEIGHT_CLASSES.includes(form.manualWeightClass) ? "" : form.manualWeightClass}
                          onChange={(e) => setForm((prev) => ({ ...prev, manualWeightClass: e.target.value }))}
                          placeholder="Custom class"
                          className="h-9 rounded-lg border border-white/20 bg-black/40 px-2 text-sm"
                        />
                      </div>
                    ) : (
                      l.weightClass || "-"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <select
                        value={form.group}
                        onChange={(e) => setForm((prev) => ({ ...prev, group: e.target.value }))}
                        className="h-9 rounded-lg border border-white/20 bg-black/40 px-2 text-sm"
                      >
                        <option value="" className="bg-slate-900">No Group</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.name} className="bg-slate-900">
                            {g.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      l.group || "-"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <input
                        value={form.team}
                        onChange={(e) => setForm((prev) => ({ ...prev, team: e.target.value }))}
                        className="h-9 min-w-40 rounded-lg border border-white/20 bg-black/40 px-2 text-sm"
                      />
                    ) : (
                      l.team || "-"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <select
                        value={form.lot}
                        onChange={(e) => setForm((prev) => ({ ...prev, lot: e.target.value === "" ? "" : Number(e.target.value) }))}
                        className="h-9 rounded-lg border border-white/20 bg-black/40 px-2 text-sm"
                      >
                        <option value="" className="bg-slate-900">
                          Lot
                        </option>
                        {LOT_NUMBER_OPTIONS.map((lotNo) => (
                          <option key={lotNo} value={lotNo} className="bg-slate-900">
                            {lotNo}
                          </option>
                        ))}
                      </select>
                    ) : (
                      l.lot || "-"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <div className="flex gap-2">
                        <input
                          type="number"
                          value={form.rackHeightSquat}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, rackHeightSquat: e.target.value === "" ? "" : Number(e.target.value) }))
                          }
                          placeholder="S"
                          className="h-9 w-14 rounded-lg border border-white/20 bg-black/40 px-2 text-sm"
                        />
                        <input
                          type="number"
                          value={form.rackHeightBench}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, rackHeightBench: e.target.value === "" ? "" : Number(e.target.value) }))
                          }
                          placeholder="B"
                          className="h-9 w-14 rounded-lg border border-white/20 bg-black/40 px-2 text-sm"
                        />
                      </div>
                    ) : (
                      <>{l.rackHeightSquat || "-"} / {l.rackHeightBench || "-"}</>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <div className="flex min-w-52 gap-2">
                        {competitionMode !== "BENCH_ONLY" && (
                          <input
                            type="number"
                            value={form.squat1}
                            onChange={(e) => setForm((prev) => ({ ...prev, squat1: e.target.value === "" ? "" : Number(e.target.value) }))}
                            placeholder="SQ"
                            className="h-9 w-16 rounded-lg border border-white/20 bg-black/40 px-2 text-sm"
                          />
                        )}
                        <input
                          type="number"
                          value={form.bench1}
                          onChange={(e) => setForm((prev) => ({ ...prev, bench1: e.target.value === "" ? "" : Number(e.target.value) }))}
                          placeholder="BP"
                          className="h-9 w-16 rounded-lg border border-white/20 bg-black/40 px-2 text-sm"
                        />
                        {competitionMode !== "BENCH_ONLY" && (
                          <input
                            type="number"
                            value={form.deadlift1}
                            onChange={(e) =>
                              setForm((prev) => ({ ...prev, deadlift1: e.target.value === "" ? "" : Number(e.target.value) }))
                            }
                            placeholder="DL"
                            className="h-9 w-16 rounded-lg border border-white/20 bg-black/40 px-2 text-sm"
                          />
                        )}
                      </div>
                    ) : (
                      <>
                        {competitionMode === "BENCH_ONLY"
                          ? (l.benchAttempts[0]?.weight || "-")
                          : `${l.squatAttempts[0]?.weight || "-"} / ${l.benchAttempts[0]?.weight || "-"} / ${l.deadliftAttempts[0]?.weight || "-"}`
                        }
                      </>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      {isEditing ? (
                        <>
                          <button onClick={saveLifter} className="rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-black">
                            Save
                          </button>
                          <button onClick={resetForm} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold">
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button onClick={() => editLifter(l)} className="rounded-lg bg-purple-500 px-3 py-1.5 text-xs font-semibold">
                          Edit
                        </button>
                      )}
                      {l.disqualified && !isEditing && (
                        <button
                          onClick={() => restoreLifter(l)}
                          className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-black"
                        >
                          Restore
                        </button>
                      )}
                      <button onClick={() => deleteLifter(l)} className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold">
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {visibleLifters.length === 0 && (
              <tr>
                <td colSpan={12} className="px-4 py-5 text-center text-slate-300">
                  No lifters in this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const LIFT_STAGE_OPTIONS: { value: LiftType; label: string }[] = [
  { value: "squat", label: "Squat" },
  { value: "bench", label: "Bench" },
  { value: "deadlift", label: "Deadlift" },
];

const LIFT_STAGE_COLORS: Record<LiftType, string> = {
  squat: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  bench: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  deadlift: "bg-rose-500/20 text-rose-300 border-rose-500/30",
};

type GroupLiftProgress = "PENDING" | "IN_PROGRESS" | "DONE";

const isAttemptConfigured = (attempt: Attempt | undefined): boolean =>
  typeof attempt?.weight === "number" ||
  (typeof attempt?.weight === "string" && attempt.weight.trim() !== "");

const resolveGroupLiftProgress = (groupLifters: Lifter[], lift: LiftType): GroupLiftProgress => {
  if (groupLifters.length === 0) return "PENDING";

  let hasConfiguredAttempt = false;
  let hasUnresolvedConfiguredAttempt = false;

  for (const lifter of groupLifters) {
    const attempts = getAttempts(lifter, lift);
    for (const attempt of attempts) {
      if (!isAttemptConfigured(attempt)) continue;
      hasConfiguredAttempt = true;
      if (attempt.status !== "GOOD" && attempt.status !== "NO") {
        hasUnresolvedConfiguredAttempt = true;
      }
    }
  }

  if (!hasConfiguredAttempt) return "PENDING";
  if (hasUnresolvedConfiguredAttempt) return "IN_PROGRESS";
  return "DONE";
};

const GROUP_LIFT_PROGRESS_STYLE: Record<GroupLiftProgress, string> = {
  PENDING: "bg-white/10 text-slate-300 border-white/20",
  IN_PROGRESS: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  DONE: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
};

const GroupManagementPage = () => {
  const {
    groups,
    setGroups,
    lifters,
    setLifters,
    setCompetitionStarted,
    currentLift,
    setCurrentLift,
    currentAttemptIndex,
    setCurrentAttemptIndex,
    currentLifterId,
    setCurrentLifterId,
    setCompetitionMode,
    competitionMode,
    competitionStarted,
    timerPhase,
    timerEndsAt,
    activeCompetitionGroupName,
    setActiveCompetitionGroupName,
    nextAttemptQueue,
    setNextAttemptQueue,
    persistSessionSnapshot,
    includeCollars,
    manualOrderByStage,
    setManualOrderByStage,
  } = useAppContext();

  const [groupName, setGroupName] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [activeGroupFilter, setActiveGroupFilter] = useState("");
  const [groupNotice, setGroupNotice] = useState<{ text: string; type: "info" | "success" | "error" } | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [confirmDeleteGroupId, setConfirmDeleteGroupId] = useState<string | null>(null);

  const [editingLifterId, setEditingLifterId] = useState<string | null>(null);
  const [editingLifterDraft, setEditingLifterDraft] = useState<{
    name: string;
    sex: "Male" | "Female";
    bodyweight: number | "";
    team: string;
    group: string;
    category: string;
  } | null>(null);

  const [checkedLifterIds, setCheckedLifterIds] = useState<string[]>([]);
  const [bulkTargetGroupName, setBulkTargetGroupName] = useState(groups[0]?.name ?? "");
  const [doubleCategoryType, setDoubleCategoryType] = useState<"SUBJR_JR" | "JR_SR" | "SR_M1">("JR_SR");
  const [startCompGroupId, setStartCompGroupId] = useState<string | null>(null);
  const [compLifts, setCompLifts] = useState<Record<LiftType, boolean>>({ squat: true, bench: true, deadlift: true });

  const [showAddLifterPanel, setShowAddLifterPanel] = useState(false);
  const [showGroupsList, setShowGroupsList] = useState(false);
  const [selectedLifterId, setSelectedLifterId] = useState(lifters[0]?.id ?? "");
  const [selectedGroupName, setSelectedGroupName] = useState(groups[0]?.name ?? "");
  const [lifterSearchTerm, setLifterSearchTerm] = useState("");
  const [selectedWeightClassFilter, setSelectedWeightClassFilter] = useState("");

  const showNotice = (text: string, type: "info" | "success" | "error" = "success") => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    setGroupNotice({ text, type });
    noticeTimerRef.current = window.setTimeout(() => setGroupNotice(null), 3500);
  };

  useEffect(() => () => { if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current); }, []);

  const filteredGroups = useMemo(() => {
    const query = searchTerm.trim().toUpperCase();
    if (!query) return groups;
    return groups.filter((g) => g.name.toUpperCase().includes(query));
  }, [groups, searchTerm]);

  const visibleLifters = useMemo(() => {
    let filtered = lifters;

    if (activeGroupFilter) {
      filtered = filtered.filter((l) => isInGroup(l.group, activeGroupFilter));
    }

    if (lifterSearchTerm.trim()) {
      const query = lifterSearchTerm.trim().toUpperCase();
      filtered = filtered.filter((l) => l.name.toUpperCase().includes(query));
    }

    if (selectedWeightClassFilter) {
      filtered = filtered.filter((l) => l.weightClass === selectedWeightClassFilter);
    }

    return filtered;
  }, [lifters, activeGroupFilter, lifterSearchTerm, selectedWeightClassFilter]);

  const availableWeightClasses = useMemo(() => {
    const classes = new Set<string>();
    visibleLifters.forEach((l) => {
      if (l.weightClass) classes.add(l.weightClass);
    });
    return Array.from(classes).sort((a, b) => {
      const aNum = parseFloat(a);
      const bNum = parseFloat(b);
      return aNum - bNum;
    });
  }, [visibleLifters]);

  useEffect(() => {
    if (!lifters.length) { setSelectedLifterId(""); return; }
    if (!selectedLifterId || !lifters.some((l) => l.id === selectedLifterId)) {
      setSelectedLifterId(lifters[0].id);
    }
  }, [lifters, selectedLifterId]);

  useEffect(() => {
    if (!groups.length) { setSelectedGroupName(""); setBulkTargetGroupName(""); return; }
    const firstGroupName = groups[0]?.name ?? "";
    if (!selectedGroupName || !groups.some((g) => g.name === selectedGroupName)) setSelectedGroupName(firstGroupName);
    if (!bulkTargetGroupName || !groups.some((g) => g.name === bulkTargetGroupName)) setBulkTargetGroupName(firstGroupName);
  }, [groups, selectedGroupName, bulkTargetGroupName]);

  useEffect(() => {
    setCheckedLifterIds((prev) => prev.filter((id) => visibleLifters.some((l) => l.id === id)));
  }, [visibleLifters]);

  useEffect(() => {
    if (!activeGroupFilter) return;
    if (!groups.some((g) => g.name === activeGroupFilter)) setActiveGroupFilter("");
  }, [groups, activeGroupFilter]);

  const createGroup = () => {
    const nextName = groupName.trim().toUpperCase();
    if (!nextName) return;
    if (groups.some((g) => g.name.toUpperCase() === nextName)) {
      showNotice("A group with this name already exists.", "error");
      return;
    }
    setGroups([...groups, { id: `group-${Date.now()}`, name: nextName, currentLift: "squat" }]);
    setSelectedGroupName(nextName);
    setActiveGroupFilter(nextName);
    setGroupName("");
    showNotice(`Group "${nextName}" created.`);
  };

  const assignLifter = () => {
    if (!selectedLifterId || !selectedGroupName) return;
    const lifter = lifters.find((l) => l.id === selectedLifterId);
    setLifters(lifters.map((l) => (l.id === selectedLifterId ? { ...l, group: selectedGroupName } : l)));
    showNotice(`${lifter?.name ?? "Lifter"} moved to Group ${selectedGroupName}.`);
    setShowAddLifterPanel(false);
  };

  const setGroupLiftStage = (groupId: string, lift: LiftType) => {
    setGroups(groups.map((g) => (g.id === groupId ? { ...g, currentLift: lift } : g)));
  };

  const handleStartGroupCompetition = async (group: Group) => {
    const enabledLifts = (Object.entries(compLifts) as [LiftType, boolean][]).filter(([, v]) => v).map(([k]) => k);
    if (enabledLifts.length === 0) { showNotice("Select at least one lift to start.", "error"); return; }
    const firstLift: LiftType = enabledLifts.includes("squat") ? "squat" : enabledLifts.includes("bench") ? "bench" : "deadlift";
    const groupLifters = lifters.filter((l) => isInGroup(l.group, group.name) && !l.disqualified);
    if (groupLifters.length === 0) { showNotice("No active lifters in this group.", "error"); return; }
    const newMode: CompetitionMode = enabledLifts.length === 1 && enabledLifts[0] === "bench" ? "BENCH_ONLY" : "FULL_GAME";

    const orderedGroupLifters = orderLiftersByIPF(groupLifters, firstLift, 0);
    const firstLifterId = orderedGroupLifters[0]?.id ?? null;
    const updatedGroups = groups.map((g) => (g.id === group.id ? { ...g, currentLift: firstLift } : g));

    console.log(LOG_CONTROL, "handleStartGroupCompetition", {
      group: group.name,
      enabledLifts,
      firstLift,
      newMode,
      firstLifterId,
      lifterCount: groupLifters.length,
    });

    // Update local React state (broadcasts to same-machine display via BroadcastChannel).
    setGroups(updatedGroups);
    setNextAttemptQueue([]);
    setActiveCompetitionGroupName(group.name);
    setCompetitionMode(newMode);
    setCurrentLift(firstLift);
    setCurrentAttemptIndex(0);
    if (firstLifterId) setCurrentLifterId(firstLifterId);
    setCompetitionStarted(true);
    setStartCompGroupId(null);

    // Persist the full new state to Firebase IMMEDIATELY so the onValue listener
    // doesn't race-overwrite currentLift/competitionMode with stale DB values.
    try {
      await persistSessionSnapshot({
        lifters,
        groups: updatedGroups,
        currentLifterId: firstLifterId,
        currentLift: firstLift,
        currentAttemptIndex: 0,
        competitionStarted: true,
        includeCollars,
        timerPhase: "IDLE",
        timerEndsAt: null,
        competitionMode: newMode,
        activeCompetitionGroupName: group.name,
        nextAttemptQueue: [],
        manualOrderByStage,
      });
      console.log(LOG_CONTROL, "competition start persisted to Firebase", {
        group: group.name, firstLift, newMode, firstLifterId,
      });
    } catch (err) {
      console.error(LOG_CONTROL, "failed to persist competition start to Firebase", err);
    }

    showNotice(`Competition started for Group ${group.name}.`);
  };

  const startEditGroup = (group: Group) => {
    setEditingGroupId(group.id);
    setEditingGroupName(group.name);
  };

  const saveEditGroup = () => {
    if (!editingGroupId) return;
    const nextName = editingGroupName.trim().toUpperCase();
    if (!nextName) return;
    const currentGroup = groups.find((g) => g.id === editingGroupId);
    if (!currentGroup) return;
    if (groups.some((g) => g.id !== editingGroupId && g.name.toUpperCase() === nextName)) {
      showNotice("That group name is already taken.", "error");
      return;
    }
    setGroups(groups.map((g) => (g.id === editingGroupId ? { ...g, name: nextName } : g)));
    setLifters(lifters.map((l) => {
      const groupArray = getGroupArray(l.group);
      const updatedGroups = groupArray.map((g) => (g === currentGroup.name ? nextName : g));
      return updatedGroups.length === 1 ? { ...l, group: updatedGroups[0] } : { ...l, group: updatedGroups };
    }));
    if (selectedGroupName === currentGroup.name) setSelectedGroupName(nextName);
    setEditingGroupId(null);
    setEditingGroupName("");
    showNotice(`Group renamed to "${nextName}".`);
  };

  const deleteGroup = (group: Group) => {
    const fallbackGroup = groups.find((g) => g.id !== group.id);
    const updatedGroups = groups.filter((g) => g.id !== group.id);
    const updatedLifters = lifters.map((l) => {
      const groupArray = getGroupArray(l.group);
      const filtered = groupArray.filter((g) => g !== group.name);
      if (filtered.length === 0) return { ...l, group: fallbackGroup?.name ?? "" };
      return filtered.length === 1 ? { ...l, group: filtered[0] } : { ...l, group: filtered };
    });
    setGroups(updatedGroups);
    setLifters(updatedLifters);
    if (selectedGroupName === group.name) setSelectedGroupName(fallbackGroup?.name ?? "");
    if (activeGroupFilter === group.name) setActiveGroupFilter(fallbackGroup?.name ?? "");
    if (editingGroupId === group.id) { setEditingGroupId(null); setEditingGroupName(""); }
    setConfirmDeleteGroupId(null);
    showNotice(`Group "${group.name}" deleted.`);
  };

  const resetGroupLifterData = (group: Group) => {
    const targetLifters = lifters.filter((l) => isInGroup(l.group, group.name));
    if (targetLifters.length === 0) {
      showNotice(`No lifters found in Group ${group.name}.`, "error");
      return;
    }
    const confirmed = window.confirm(
      `Reset all lifting data for ${targetLifters.length} lifter(s) in Group ${group.name}?\n\nThis will:\n• Clear all squat / bench / deadlift attempts\n• Reset to Round 1 (Attempt 1)\n• Recalculate IPF lifter order from declarations`,
    );
    if (!confirmed) return;

    const isActiveGroup = activeCompetitionGroupName === group.name;

    // Determine the correct starting lift for the competition mode.
    const firstLift: LiftType = competitionMode === "BENCH_ONLY" ? "bench" : "squat";

    // --- LOG BEFORE ---
    console.log(LOG_CONTROL, "resetGroupLifterData BEFORE", {
      groupId: group.id,
      groupName: group.name,
      isActiveGroup,
      currentLift: isActiveGroup ? currentLift : group.currentLift,
      currentAttemptIndex: isActiveGroup ? currentAttemptIndex : "(inactive)",
      displayedAttemptNumber: isActiveGroup ? currentAttemptIndex + 1 : "(inactive)",
      benchRound: isActiveGroup && currentLift === "bench" ? `A${currentAttemptIndex + 1}` : "n/a",
    });

    // 1. Reset lifter attempt data.
    const resetLifters = lifters.map((l) =>
      isInGroup(l.group, group.name)
        ? {
            ...l,
            disqualified: false,
            squatAttempts: emptyAttemptsFromFirst(""),
            benchAttempts: emptyAttemptsFromFirst(""),
            deadliftAttempts: emptyAttemptsFromFirst(""),
          }
        : l,
    );

    // 2. Reset group.currentLift to the starting lift.
    const resetGroups = groups.map((g) =>
      g.id === group.id ? { ...g, currentLift: firstLift } : g,
    );

    // 3. Strip this group's lifters from manualOrderByStage (stale A2+ orderings).
    const groupLifterIds = new Set(targetLifters.map((l) => l.id));
    const resetManualOrder: Record<string, string[]> = {};
    for (const [key, ids] of Object.entries(manualOrderByStage)) {
      const filtered = ids.filter((id) => !groupLifterIds.has(id));
      if (filtered.length > 0) resetManualOrder[key] = filtered;
    }

    // 4. Clear nextAttemptQueue entries that belong to this group's lifters.
    const resetQueue = nextAttemptQueue.filter((e) => !groupLifterIds.has(e.lifterId));

    // 5. Recalculate IPF order for first lift / first attempt.
    const groupLiftersReset = resetLifters.filter((l) => isInGroup(l.group, group.name) && !l.disqualified);
    const orderedGroupLifters = orderLiftersByIPF(groupLiftersReset, firstLift, 0);
    const firstLifterId = orderedGroupLifters[0]?.id ?? null;

    // 6. Apply React state updates.
    setLifters(resetLifters);
    setGroups(resetGroups);
    setManualOrderByStage(resetManualOrder);
    setNextAttemptQueue(resetQueue);

    if (isActiveGroup) {
      setCurrentLift(firstLift);
      setCurrentAttemptIndex(0);
      if (firstLifterId) setCurrentLifterId(firstLifterId);
    }

    // --- LOG AFTER ---
    console.log(LOG_CONTROL, "resetGroupLifterData AFTER", {
      groupId: group.id,
      groupName: group.name,
      isActiveGroup,
      currentLift: firstLift,
      currentAttemptIndex: 0,
      displayedAttemptNumber: 1,
      benchRound: firstLift === "bench" ? "A1" : "n/a",
      firstLifterId,
    });

    // 7. Persist to Firebase so all devices sync immediately.
    const snapshotCurrentLifterId = isActiveGroup ? (firstLifterId ?? currentLifterId) : currentLifterId;
    const snapshotCurrentLift = isActiveGroup ? firstLift : currentLift;
    const snapshotAttemptIndex = isActiveGroup ? 0 : currentAttemptIndex;
    void persistSessionSnapshot({
      lifters: resetLifters,
      groups: resetGroups,
      currentLifterId: snapshotCurrentLifterId,
      currentLift: snapshotCurrentLift,
      currentAttemptIndex: snapshotAttemptIndex,
      competitionStarted,
      includeCollars,
      timerPhase: isActiveGroup ? "IDLE" : timerPhase,
      timerEndsAt: isActiveGroup ? null : timerEndsAt,
      competitionMode,
      activeCompetitionGroupName,
      nextAttemptQueue: resetQueue,
      manualOrderByStage: resetManualOrder,
    }).catch((err) => console.error(LOG_CONTROL, "resetGroupLifterData persist failed", err));

    showNotice(`Group "${group.name}" reset to ${firstLift === "bench" ? "Bench" : "Squat"} A1.`);
  };

  const startEditLifter = (lifter: Lifter) => {
    setEditingLifterId(lifter.id);
    setEditingLifterDraft({ name: lifter.name, sex: lifter.sex, bodyweight: lifter.bodyweight, team: lifter.team, group: lifter.group, category: lifter.category });
  };

  const cancelEditLifter = () => { setEditingLifterId(null); setEditingLifterDraft(null); };

  const saveEditLifter = () => {
    if (!editingLifterId || !editingLifterDraft) return;
    if (!editingLifterDraft.name.trim()) { showNotice("Lifter name is required.", "error"); return; }
    setLifters(lifters.map((l) => {
      if (l.id !== editingLifterId) return l;
      return { ...l, name: editingLifterDraft.name.trim(), sex: editingLifterDraft.sex, bodyweight: editingLifterDraft.bodyweight, group: editingLifterDraft.group, team: editingLifterDraft.team, category: editingLifterDraft.category, weightClass: resolveWeightClass(editingLifterDraft.sex, editingLifterDraft.bodyweight, l.manualWeightClass) };
    }));
    showNotice("Lifter updated.");
    cancelEditLifter();
  };

  const moveCheckedLiftersToGroup = () => {
    if (!bulkTargetGroupName) { showNotice("Select a target group first.", "error"); return; }
    if (checkedLifterIds.length === 0) { showNotice("Select at least one lifter.", "error"); return; }
    setLifters(lifters.map((l) => checkedLifterIds.includes(l.id) ? { ...l, group: bulkTargetGroupName } : l));
    showNotice(`Moved ${checkedLifterIds.length} lifter(s) to Group ${bulkTargetGroupName}.`);
    setCheckedLifterIds([]);
  };

  const categoryToGroupNames = (weightClass: string, categoryParts: string[]): string[] => {
    const groupIds: string[] = [];

    categoryParts.forEach((categoryPart) => {
      const categoryUpper = categoryPart.toUpperCase().split(" ")[0];
      const matchingGroup = groups.find((g) => {
        const groupNameUpper = g.name.toUpperCase();
        return groupNameUpper.startsWith(weightClass) && groupNameUpper.includes(categoryUpper);
      });
      if (matchingGroup) {
        groupIds.push(matchingGroup.name);
      }
    });

    return groupIds;
  };

  const markCheckedAsDoubleCategory = () => {
    if (checkedLifterIds.length === 0) { showNotice("Select at least one lifter.", "error"); return; }
    const getTargetCategory = (sex: "Male" | "Female") => {
      const options = getDoubleCategoryOptions(sex);
      if (doubleCategoryType === "SUBJR_JR") return options[0];
      if (doubleCategoryType === "JR_SR") return options[1];
      return options[2];
    };
    setLifters(lifters.map((l) => {
      if (!checkedLifterIds.includes(l.id)) return l;
      const newCategory = getTargetCategory(l.sex);
      const categoryParts = newCategory.split(" + ").map((p) => p.trim());
      const groupNames = categoryToGroupNames(l.weightClass, categoryParts);
      return { ...l, category: newCategory, group: groupNames.length > 0 ? (groupNames.length === 1 ? groupNames[0] : groupNames) : categoryParts[0] };
    }));
    showNotice(`Dual category applied to ${checkedLifterIds.length} lifter(s).`);
  };

  const allVisibleChecked = visibleLifters.length > 0 && visibleLifters.every((l) => checkedLifterIds.includes(l.id));

  return (
    <section className="space-y-5">
      <SectionHeader title="Groups" path="/groups" />

      <AnimatePresence>
        {groupNotice && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm ${
              groupNotice.type === "error"
                ? "border-red-400/30 bg-red-400/10 text-red-200"
                : "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
            }`}
          >
            <span className={`h-2 w-2 rounded-full flex-shrink-0 ${groupNotice.type === "error" ? "bg-red-400" : "bg-emerald-400"}`} />
            {groupNotice.text}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <p className="mb-4 text-xs font-semibold uppercase tracking-widest text-cyan-400">Create New Group</p>
          <div className="flex gap-2">
            <Field
              value={groupName}
              placeholder="e.g. A, B, Morning..."
              onChange={(e) => setGroupName(e.target.value)}
              onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter") createGroup(); }}
            />
            <button
              onClick={createGroup}
              disabled={!groupName.trim()}
              className="rounded-xl bg-cyan-500 px-5 text-sm font-semibold text-black transition-opacity disabled:cursor-not-allowed disabled:opacity-40 hover:bg-cyan-400"
            >
              Create
            </button>
          </div>

          {groups.length > 0 && (
            <div className="mt-4 space-y-2">
              <button
                onClick={() => setShowGroupsList(!showGroupsList)}
                className="w-full rounded-lg border border-white/15 bg-white/5 p-2.5 text-left transition-colors hover:bg-white/10"
              >
                <p className="text-xs font-semibold text-slate-300">
                  {showGroupsList ? "▼ Hide Groups" : "▶ Show Groups"} ({groups.length})
                </p>
              </button>
              {showGroupsList && (
                <div className="space-y-1.5">
                  {groups.map((g) => {
                    const count = lifters.filter((l) => isInGroup(l.group, g.name)).length;
                    return (
                      <div key={g.id} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2">
                        <span className="text-sm font-medium text-white">{g.name}</span>
                        <span className="text-xs text-slate-400">{count} lifter{count !== 1 ? "s" : ""}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {groups.length === 0 && (
            <p className="mt-4 text-sm text-slate-500">No groups yet. Create one above or suggest by weight class.</p>
          )}
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-widest text-cyan-400">Quick Assign Lifter</p>
            <button
              onClick={() => setShowAddLifterPanel((v) => !v)}
              className="rounded-lg bg-white/10 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:bg-white/15"
            >
              {showAddLifterPanel ? "Collapse" : "Expand"}
            </button>
          </div>
          <AnimatePresence initial={false}>
            {showAddLifterPanel && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="space-y-3 pb-1">
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">Lifter</label>
                    <select
                      value={selectedLifterId}
                      onChange={(e) => setSelectedLifterId(e.target.value)}
                      className="h-10 w-full rounded-xl border border-white/15 bg-black/40 px-3 text-sm text-white focus:border-cyan-400/60 focus:outline-none"
                    >
                      {lifters.length === 0 && <option value="">No lifters added yet</option>}
                      {lifters.map((l) => (
                        <option key={l.id} value={l.id} className="bg-slate-900">
                          {l.name}{l.group ? ` (Group ${l.group})` : " (Ungrouped)"}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">Target Group</label>
                    <select
                      value={selectedGroupName}
                      onChange={(e) => setSelectedGroupName(e.target.value)}
                      className="h-10 w-full rounded-xl border border-white/15 bg-black/40 px-3 text-sm text-white focus:border-cyan-400/60 focus:outline-none"
                    >
                      {groups.length === 0 && <option value="">No groups yet</option>}
                      {groups.map((g) => (
                        <option key={g.id} value={g.name} className="bg-slate-900">{g.name}</option>
                      ))}
                    </select>
                  </div>
                  <button
                    onClick={assignLifter}
                    disabled={groups.length === 0 || lifters.length === 0}
                    className="w-full rounded-xl bg-cyan-500 py-2 text-sm font-semibold text-black transition-opacity disabled:cursor-not-allowed disabled:opacity-40 hover:bg-cyan-400"
                  >
                    Assign to Group
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {!showAddLifterPanel && (
            <p className="text-sm text-slate-500">Click Expand to assign a lifter to a group.</p>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-cyan-400">Manage Groups</p>
          <div className="ml-auto w-full sm:w-64">
            <Field
              value={searchTerm}
              placeholder="Search groups..."
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>

        {filteredGroups.length === 0 && (
          <p className="text-sm text-slate-500">{searchTerm ? "No groups match your search." : "No groups created yet."}</p>
        )}

        <div className="space-y-3">
          {filteredGroups.map((group) => {
            const groupLifterCount = lifters.filter((l) => isInGroup(l.group, group.name)).length;
            const groupActiveLifters = lifters.filter((l) => isInGroup(l.group, group.name) && !l.disqualified);
            const liftProgress = {
              squat: resolveGroupLiftProgress(groupActiveLifters, "squat"),
              bench: resolveGroupLiftProgress(groupActiveLifters, "bench"),
              deadlift: resolveGroupLiftProgress(groupActiveLifters, "deadlift"),
            };
            const isEditingThis = editingGroupId === group.id;
            const isStartingComp = startCompGroupId === group.id;
            const isConfirmingDelete = confirmDeleteGroupId === group.id;
            const isActive = activeGroupFilter === group.name;
            const isRunningGroup = activeCompetitionGroupName === group.name;

            return (
              <div
                key={group.id}
                className={`rounded-2xl border transition-colors ${isActive ? "border-cyan-500/40 bg-cyan-900/10" : "border-white/10 bg-white/[0.02]"}`}
              >
                <div className="flex flex-wrap items-center gap-3 p-4">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-white/10 text-sm font-bold text-white">
                      {(group.name || "?").charAt(0)}
                    </div>
                    <div className="min-w-0">
                      {isEditingThis ? (
                        <input
                          autoFocus
                          value={editingGroupName}
                          onChange={(e) => setEditingGroupName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") saveEditGroup(); if (e.key === "Escape") { setEditingGroupId(null); setEditingGroupName(""); } }}
                          className="h-8 w-40 rounded-lg border border-cyan-400/60 bg-black/40 px-2 text-sm font-semibold text-white focus:outline-none"
                        />
                      ) : (
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-white">{group.name}</p>
                          {isRunningGroup && (
                            <span className="rounded-full border border-emerald-400/40 bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-200">
                              Running
                            </span>
                          )}
                        </div>
                      )}
                      <p className="text-xs text-slate-400">{groupLifterCount} lifter{groupLifterCount !== 1 ? "s" : ""}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {LIFT_STAGE_OPTIONS.map((opt) => (
                          <span
                            key={`${group.id}-${opt.value}-progress`}
                            className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${GROUP_LIFT_PROGRESS_STYLE[liftProgress[opt.value]]}`}
                          >
                            {opt.label}: {liftProgress[opt.value].replace("_", " ")}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex overflow-hidden rounded-lg border border-white/10">
                      {LIFT_STAGE_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => setGroupLiftStage(group.id, opt.value)}
                          className={`px-3 py-1.5 text-xs font-medium transition-colors ${group.currentLift === opt.value ? LIFT_STAGE_COLORS[opt.value] : "text-slate-400 hover:text-white"}`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>

                    <button
                      onClick={() => setActiveGroupFilter(isActive ? "" : group.name)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${isActive ? "bg-cyan-500/20 text-cyan-300" : "bg-white/8 text-slate-300 hover:bg-white/15"}`}
                    >
                      {isActive ? "Viewing" : "View Lifters"}
                    </button>

                    {isEditingThis ? (
                      <>
                        <button onClick={saveEditGroup} className="rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-cyan-400">Save</button>
                        <button onClick={() => { setEditingGroupId(null); setEditingGroupName(""); }} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/15">Cancel</button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => {
                            if (!isStartingComp) {
                              // Pre-select lifts based on the current competition mode so
                              // BENCH_ONLY competitions don't accidentally start with Squat.
                              setCompLifts(
                                competitionMode === "BENCH_ONLY"
                                  ? { squat: false, bench: true, deadlift: false }
                                  : { squat: true, bench: true, deadlift: true }
                              );
                            }
                            setStartCompGroupId(isStartingComp ? null : group.id);
                            setConfirmDeleteGroupId(null);
                          }}
                          className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/30"
                        >
                          Start Comp
                        </button>
                        <button
                          onClick={() => { startEditGroup(group); setStartCompGroupId(null); setConfirmDeleteGroupId(null); }}
                          className="rounded-lg bg-white/8 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-white/15"
                        >
                          Rename
                        </button>
                        <button
                          onClick={() => { setConfirmDeleteGroupId(isConfirmingDelete ? null : group.id); setStartCompGroupId(null); }}
                          className="rounded-lg bg-red-500/15 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/25"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => resetGroupLifterData(group)}
                          className="rounded-lg bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-500/25"
                        >
                          Reset Group
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <AnimatePresence initial={false}>
                  {isConfirmingDelete && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden"
                    >
                      <div className="mx-4 mb-4 rounded-xl border border-red-500/30 bg-red-900/20 p-4">
                        <p className="mb-3 text-sm text-red-200">
                          Delete Group <strong>{group.name}</strong>?{" "}
                          {(() => {
                            const fallback = groups.find((g) => g.id !== group.id);
                            return fallback
                              ? `${groupLifterCount} lifter(s) will be moved to Group ${fallback.name}.`
                              : `${groupLifterCount} lifter(s) will become ungrouped.`;
                          })()}
                        </p>
                        <div className="flex gap-2">
                          <button onClick={() => deleteGroup(group)} className="rounded-lg bg-red-500 px-4 py-2 text-xs font-semibold text-white hover:bg-red-400">Confirm Delete</button>
                          <button onClick={() => setConfirmDeleteGroupId(null)} className="rounded-lg bg-white/10 px-4 py-2 text-xs text-slate-300 hover:bg-white/15">Cancel</button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <AnimatePresence initial={false}>
                  {isStartingComp && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden"
                    >
                      <div className="mx-4 mb-4 rounded-xl border border-emerald-500/30 bg-emerald-900/15 p-4">
                        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-emerald-400">Lifts to include</p>
                        <div className="mb-4 flex flex-wrap gap-3">
                          {(["squat", "bench", "deadlift"] as LiftType[]).map((lift) => (
                            <label key={lift} className="flex cursor-pointer items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition-colors hover:bg-white/10">
                              <input
                                type="checkbox"
                                checked={compLifts[lift]}
                                onChange={(e) => setCompLifts((prev) => ({ ...prev, [lift]: e.target.checked }))}
                                className="h-4 w-4 accent-emerald-400"
                              />
                              {lift === "squat" ? "Squat" : lift === "bench" ? "Bench Press" : "Deadlift"}
                            </label>
                          ))}
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => handleStartGroupCompetition(group)} className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-bold text-black hover:bg-emerald-400">
                            Start Competition
                          </button>
                          <button onClick={() => setStartCompGroupId(null)} className="rounded-lg bg-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/15">Cancel</button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-cyan-400">Lifters</p>
          <p className="mt-0.5 mb-4 text-xs text-slate-500">
            {activeGroupFilter ? `Showing Group ${activeGroupFilter}` : "Showing all lifters"} — {visibleLifters.length} total
          </p>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="w-full sm:w-64">
            <Field
              value={lifterSearchTerm}
              placeholder="Search lifter names..."
              onChange={(e) => setLifterSearchTerm(e.target.value)}
            />
          </div>
          {groups.length > 0 && (
            <select
              value={activeGroupFilter}
              onChange={(e) => setActiveGroupFilter(e.target.value)}
              className="h-10 rounded-xl border border-white/15 bg-black/40 px-3 text-sm text-white focus:border-cyan-400/60 focus:outline-none"
            >
              <option value="">All Groups</option>
              {groups.map((g) => (
                <option key={g.id} value={g.name} className="bg-slate-900">
                  {g.name}
                </option>
              ))}
            </select>
          )}
          {availableWeightClasses.length > 0 && (
            <select
              value={selectedWeightClassFilter}
              onChange={(e) => setSelectedWeightClassFilter(e.target.value)}
              className="h-10 rounded-xl border border-white/15 bg-black/40 px-3 text-sm text-white focus:border-cyan-400/60 focus:outline-none"
            >
              <option value="">All Weight Classes</option>
              {availableWeightClasses.map((wc) => (
                <option key={wc} value={wc} className="bg-slate-900">
                  {wc}
                </option>
              ))}
            </select>
          )}
        </div>

        {checkedLifterIds.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-cyan-500/20 bg-cyan-900/10 p-3">
            <span className="text-xs font-semibold text-cyan-300">{checkedLifterIds.length} selected</span>
            <div className="flex flex-wrap gap-2">
              <select
                value={bulkTargetGroupName}
                onChange={(e) => setBulkTargetGroupName(e.target.value)}
                className="h-8 rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white focus:outline-none"
              >
                <option value="">Select group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.name} className="bg-slate-900">{g.name}</option>
                ))}
              </select>
              <button onClick={moveCheckedLiftersToGroup} className="rounded-lg bg-cyan-500 px-3 py-1 text-xs font-semibold text-black hover:bg-cyan-400">
                Move to Group
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <select
                value={doubleCategoryType}
                onChange={(e) => setDoubleCategoryType(e.target.value as "SUBJR_JR" | "JR_SR" | "SR_M1")}
                className="h-8 rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white focus:outline-none"
              >
                <option value="SUBJR_JR" className="bg-slate-900">Sub Junior + Junior</option>
                <option value="JR_SR" className="bg-slate-900">Junior + Senior</option>
                <option value="SR_M1" className="bg-slate-900">Senior + Master</option>
              </select>
              <button onClick={markCheckedAsDoubleCategory} className="rounded-lg bg-white/10 px-3 py-1 text-xs text-slate-200 hover:bg-white/15">
                Set Dual Category
              </button>
            </div>
            <button onClick={() => setCheckedLifterIds([])} className="ml-auto rounded-lg bg-white/8 px-3 py-1 text-xs text-slate-400 hover:bg-white/12">
              Clear
            </button>
          </div>
        )}

        <div className="overflow-x-auto rounded-xl border border-white/8">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-white/8 bg-white/[0.03]">
                <th className="px-4 py-3 text-left">
                  <input
                    type="checkbox"
                    checked={allVisibleChecked}
                    onChange={(e) => setCheckedLifterIds(e.target.checked ? visibleLifters.map((l) => l.id) : [])}
                    className="h-4 w-4 accent-cyan-400"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">Lifter</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">Group</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">Category</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">Wt Class</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">Team</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleLifters.map((l, idx) => {
                const isEditing = editingLifterId === l.id && editingLifterDraft;
                const isChecked = checkedLifterIds.includes(l.id);
                return (
                  <tr
                    key={l.id}
                    className={`border-b border-white/5 transition-colors last:border-0 ${isChecked ? "bg-cyan-900/10" : idx % 2 === 0 ? "bg-transparent" : "bg-white/[0.015]"} ${isEditing ? "bg-white/[0.04]" : ""}`}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) => setCheckedLifterIds((prev) => e.target.checked ? [...prev.filter((id) => id !== l.id), l.id] : prev.filter((id) => id !== l.id))}
                        className="h-4 w-4 accent-cyan-400"
                      />
                    </td>
                    <td className="px-4 py-3 font-medium text-white">
                      {isEditing ? (
                        <input
                          autoFocus
                          value={editingLifterDraft.name}
                          onChange={(e) => setEditingLifterDraft((prev) => prev ? { ...prev, name: e.target.value } : prev)}
                          className="h-9 w-full min-w-36 rounded-lg border border-white/20 bg-black/40 px-2 text-sm focus:outline-none focus:border-cyan-400/60"
                        />
                      ) : l.name}
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {isEditing ? (
                        <select
                          value={editingLifterDraft.group}
                          onChange={(e) => setEditingLifterDraft((prev) => prev ? { ...prev, group: e.target.value } : prev)}
                          className="h-9 min-w-28 rounded-lg border border-white/20 bg-black/40 px-2 text-sm focus:outline-none"
                        >
                          <option value="" className="bg-slate-900">Ungrouped</option>
                          {groups.map((g) => <option key={g.id} value={g.name} className="bg-slate-900">{g.name}</option>)}
                        </select>
                      ) : (
                        <span className={`rounded-md px-2 py-0.5 text-xs ${l.group ? "bg-white/8 text-slate-200" : "text-slate-500"}`}>
                          {l.group || "Ungrouped"}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {isEditing ? (
                        <select
                          value={editingLifterDraft.category}
                          onChange={(e) => setEditingLifterDraft((prev) => prev ? { ...prev, category: e.target.value } : prev)}
                          className="h-9 min-w-40 rounded-lg border border-white/20 bg-black/40 px-2 text-sm focus:outline-none"
                        >
                          {getCategoryOptions(editingLifterDraft.sex).map((cat) => <option key={cat} value={cat} className="bg-slate-900">{cat}</option>)}
                        </select>
                      ) : <span className="text-xs">{l.category}</span>}
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {isEditing ? getIPFWeightClass(editingLifterDraft.sex, editingLifterDraft.bodyweight) || "—" : l.weightClass || "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {isEditing ? (
                        <input
                          value={editingLifterDraft.team}
                          onChange={(e) => setEditingLifterDraft((prev) => prev ? { ...prev, team: e.target.value } : prev)}
                          className="h-9 w-full min-w-24 rounded-lg border border-white/20 bg-black/40 px-2 text-sm focus:outline-none"
                        />
                      ) : <span className="text-xs">{l.team || "—"}</span>}
                    </td>
                    <td className="px-4 py-3">
                      {isEditing ? (
                        <div className="flex flex-wrap gap-2">
                          <select
                            value={editingLifterDraft.sex}
                            onChange={(e) => setEditingLifterDraft((prev) => prev ? { ...prev, sex: e.target.value as "Male" | "Female" } : prev)}
                            className="h-9 rounded-lg border border-white/20 bg-black/40 px-2 text-sm focus:outline-none"
                          >
                            <option value="Male" className="bg-slate-900">Male</option>
                            <option value="Female" className="bg-slate-900">Female</option>
                          </select>
                          <input
                            type="number"
                            value={editingLifterDraft.bodyweight}
                            onChange={(e) => setEditingLifterDraft((prev) => prev ? { ...prev, bodyweight: e.target.value === "" ? "" : Number(e.target.value) } : prev)}
                            placeholder="BW kg"
                            className="h-9 w-20 rounded-lg border border-white/20 bg-black/40 px-2 text-sm focus:outline-none"
                          />
                          <button onClick={saveEditLifter} className="rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-cyan-400">Save</button>
                          <button onClick={cancelEditLifter} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/15">Cancel</button>
                        </div>
                      ) : (
                        <button onClick={() => startEditLifter(l)} className="rounded-lg bg-white/8 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-white/15">
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {visibleLifters.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-500">
                    {activeGroupFilter ? `No lifters in Group ${activeGroupFilter}.` : "No lifters added yet."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};


const RefereePanelTab = () => {
  const { refereeSignals, setRefereeSignals, resetSignals, connectedRefereeSlots } = useAppContext();

  const setSlotSignal = (slotIndex: number, signal: RefSignal) => {
    const next = [...refereeSignals];
    next[slotIndex] = signal;
    setRefereeSignals(next);
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {REFEREE_SLOT_CONFIG.map((slot) => {
          const signal = refereeSignals[slot.index];
          const isConnected = connectedRefereeSlots[slot.key];
          return (
            <div key={slot.key} className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="mb-4 flex items-center justify-between">
                <p className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-200">{slot.label}</p>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${
                    isConnected ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-500/20 text-slate-400"
                  }`}
                >
                  {isConnected ? "Connected" : "Offline"}
                </span>
              </div>

              <div className="mb-4 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-center">
                <p className="text-[10px] uppercase tracking-widest text-slate-400">Current Signal</p>
                <p className="mt-1 text-base font-black uppercase">
                  {signal === "GOOD" ? "GOOD" : signal === "NO" ? "NO" : "PENDING"}
                </p>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setSlotSignal(slot.index, "GOOD")}
                  className="rounded-lg bg-emerald-500/20 px-2 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/30"
                >
                  GOOD
                </button>
                <button
                  type="button"
                  onClick={() => setSlotSignal(slot.index, "NO")}
                  className="rounded-lg bg-rose-500/20 px-2 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-500/30"
                >
                  NO
                </button>
                <button
                  type="button"
                  onClick={() => setSlotSignal(slot.index, null)}
                  className="rounded-lg bg-white/10 px-2 py-2 text-xs font-semibold text-slate-200 hover:bg-white/15"
                >
                  CLEAR
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void resetSignals()}
          className="rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold text-slate-100 hover:bg-white/15"
        >
          Reset Signals
        </button>
      </div>
    </div>
  );
};

const RefereePage = () => {
  const [searchParams] = useSearchParams();
  const [view, setView] = useState<"panel" | "qr">("panel");
  const { competitions, activeCompetitionId, switchCompetition, connectedRefereeSlots } = useAppContext();
  const [qrModal, setQrModal] = useState<{ slot: RefereeSlot; title: string; url: string; sessionId: string } | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [activeSession, setActiveSession] = useState<{ id: string; expires_at: string } | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [sessionNotice, setSessionNotice] = useState("");

  useEffect(() => {
    const requestedCompetitionId = searchParams.get("cid");
    if (requestedCompetitionId && requestedCompetitionId !== activeCompetitionId) {
      const exists = competitions.some((competition) => competition.id === requestedCompetitionId);
      if (exists) {
        switchCompetition(requestedCompetitionId);
      }
    }
  }, [searchParams, activeCompetitionId, competitions, switchCompetition]);

  useEffect(() => {
    if (!activeCompetitionId) {
      setLoadingSession(false);
      setActiveSession(null);
      return;
    }

    const loadActiveSession = async () => {
      setLoadingSession(true);
      try {
        const sessions = await dbRefereeSessions.getActiveForCompetition(activeCompetitionId);
        setActiveSession(sessions[0] || null);
      } catch (error) {
        console.error("Failed to load active session:", error);
        setActiveSession(null);
      } finally {
        setLoadingSession(false);
      }
    };

    loadActiveSession();
  }, [activeCompetitionId]);

  useEffect(() => {
    if (!qrModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setQrModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [qrModal]);

  const buildRefereeLink = (slot: RefereeSlot, sessionId?: string) => {
    const params = new URLSearchParams();
    if (activeCompetitionId) params.set("cid", activeCompetitionId);
    if (sessionId) params.set("session", sessionId);
    const queryString = params.toString();
    const url = `${window.location.origin}${window.location.pathname}#/signals/${slot}${queryString ? `?${queryString}` : ""}`;
    return url;
  };

  const refreshRefereeSession = async () => {
    if (!activeCompetitionId) {
      setSessionNotice("Select a competition first.");
      return;
    }
    if (!isFirebaseConfigured) {
      setSessionNotice("Firebase is not configured. Session-based QR links are unavailable.");
      return;
    }
    setSessionNotice("Creating referee session (30-day expiry)...");
    console.log(LOG_SESSION, "refreshRefereeSession called", { activeCompetitionId });
    try {
      const session = await dbRefereeSessions.create(activeCompetitionId);
      setActiveSession(session);
      const expiryStr = new Date(session.expires_at).toLocaleString();
      console.log(LOG_SESSION, "referee session created", { sessionId: session.id, competitionId: activeCompetitionId, expiresAt: session.expires_at });
      setSessionNotice(`Session ready — ID: ${session.id.slice(-8)} (valid until ${expiryStr}).`);
    } catch (error) {
      console.error(LOG_SESSION, "failed to create referee session", error);
      setSessionNotice("Failed to create referee session. Please try again.");
    }
  };

  const openQrForSlot = async (slot: RefereeSlot, title: string) => {
    setLinkCopied(false);
    if (!activeCompetitionId) {
      setSessionNotice("Select a competition first.");
      return;
    }
    if (!isFirebaseConfigured) {
      setSessionNotice("Firebase is not configured. Session-based QR links are unavailable.");
      return;
    }
    if (!activeSession) {
      setSessionNotice("Create a referee session first.");
      return;
    }
    const url = buildRefereeLink(slot, activeSession.id);
    setQrModal({ slot, title, url, sessionId: activeSession.id });
  };

  const copyRefereeLink = async () => {
    if (!qrModal) return;
    try {
      await navigator.clipboard.writeText(qrModal.url);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      setLinkCopied(false);
    }
  };

  return (
    <section className="space-y-8">
      <div className="flex items-center justify-between mb-6">
        <SectionHeader title="Referee Signals" path="/signals" />
        <div className="flex gap-2">
          <button
            onClick={() => setView("panel")}
            className={`px-4 py-2 rounded-lg font-semibold transition-colors ${
              view === "panel"
                ? "bg-cyan-600 text-white"
                : "bg-slate-700 text-slate-300 hover:bg-slate-600"
            }`}
          >
            Test Panel
          </button>
          <button
            onClick={() => setView("qr")}
            className={`px-4 py-2 rounded-lg font-semibold transition-colors ${
              view === "qr"
                ? "bg-cyan-600 text-white"
                : "bg-slate-700 text-slate-300 hover:bg-slate-600"
            }`}
          >
            QR Mode
          </button>
        </div>
      </div>

      {view === "panel" ? (
        <RefereePanelTab />
      ) : (
        <div className="space-y-5">
          <div className="rounded-2xl border border-white/15 bg-white/5 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-56">
                <p className="text-xs uppercase tracking-[0.2em] text-cyan-300">Referee Session</p>
                {loadingSession ? (
                  <p className="mt-2 text-sm text-slate-400">Checking active session...</p>
                ) : activeSession ? (
                  <>
                    <p className="mt-2 text-sm text-emerald-200">Active session: {activeSession.id}</p>
                    <p className="text-xs text-emerald-300/80">Valid until {new Date(activeSession.expires_at).toLocaleString()}</p>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-amber-200">No active session. Create one before generating QR links.</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => void refreshRefereeSession()}
                disabled={!activeCompetitionId || !isFirebaseConfigured}
                className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-black transition-opacity hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {activeSession ? "Refresh Session (24h)" : "Create Session (24h)"}
              </button>
            </div>
            {sessionNotice && <p className="mt-3 text-sm text-cyan-200">{sessionNotice}</p>}
          </div>

          <motion.div
            className="grid grid-cols-1 gap-6 lg:grid-cols-3"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            {REFEREE_SLOT_CONFIG.map((slot, idx) => {
              const isConnected = connectedRefereeSlots[slot.key];

              return (
                <motion.button
                  key={slot.key}
                  type="button"
                  onClick={() => openQrForSlot(slot.key, slot.label)}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.1, duration: 0.4 }}
                  whileHover={{ y: -4, transition: { duration: 0.2 } }}
                  disabled={!activeSession}
                  className={`group relative overflow-hidden rounded-2xl border backdrop-blur-sm transition-all duration-300 ${
                    !activeSession
                      ? "cursor-not-allowed border-slate-700/40 bg-slate-900/30 opacity-60"
                      : isConnected
                        ? `border-emerald-400/40 bg-gradient-to-br from-emerald-500/15 to-emerald-600/5 hover:border-emerald-300/60 hover:from-emerald-500/25 hover:to-emerald-600/15`
                        : `border-slate-600/40 bg-gradient-to-br from-slate-700/10 to-slate-800/10 hover:border-slate-500/60 hover:from-slate-700/20 hover:to-slate-800/20`
                  }`}
                >
                  <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

                  <div className="relative p-8 space-y-6">
                    <div>
                      <p className="text-4xl font-bold bg-gradient-to-r from-white to-slate-200 bg-clip-text text-transparent">
                        {slot.label}
                      </p>
                      <p className="mt-2 text-xs uppercase tracking-[0.15em] text-slate-400 font-medium">Referee Station</p>
                    </div>

                    <div className="flex items-center gap-2">
                      <motion.div
                        animate={{ scale: isConnected ? [1, 1.2, 1] : 1 }}
                        transition={{ repeat: isConnected ? Infinity : 0, duration: 2 }}
                        className={`h-2.5 w-2.5 rounded-full ${
                          isConnected ? "bg-emerald-400 shadow-lg shadow-emerald-400/50" : "bg-slate-500"
                        }`}
                      />
                      <span className={`text-xs font-semibold ${
                        isConnected ? "text-emerald-300" : "text-slate-400"
                      }`}>
                        {isConnected ? "Connected" : "Offline"}
                      </span>
                    </div>

                    <div className="pt-2 border-t border-white/5">
                      <p className="text-xs uppercase tracking-wider text-slate-400">
                        {activeSession ? "Tap for QR code" : "Create session first"}
                      </p>
                    </div>
                  </div>
                </motion.button>
              );
            })}
          </motion.div>
        </div>
      )}

      {qrModal ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="referee-qr-title"
          onClick={() => setQrModal(null)}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="w-full max-w-md rounded-3xl border border-slate-600/30 bg-gradient-to-br from-slate-900/90 to-slate-800/90 backdrop-blur-xl p-8 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-center mb-6">
              <h2 id="referee-qr-title" className="text-2xl font-bold text-white">
                {qrModal.title} Referee
              </h2>
              <p className="mt-2 text-sm text-slate-400">Scan with a phone to connect this station</p>
            </div>

            <motion.div
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              className="flex justify-center rounded-2xl bg-white p-6 mb-6"
            >
              <QRCodeSVG value={qrModal.url} size={240} level="M" includeMargin />
            </motion.div>

            <div className="flex flex-col gap-3">
              <motion.button
                type="button"
                onClick={() => void copyRefereeLink()}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className="rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 hover:from-cyan-400 hover:to-cyan-500 py-3 text-sm font-semibold text-black transition-all duration-200"
              >
                {linkCopied ? "✓ Link Copied" : "Copy Link"}
              </motion.button>

              <motion.button
                type="button"
                onClick={() => setQrModal(null)}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className="rounded-xl py-2 text-sm font-medium text-slate-400 hover:text-white transition-colors duration-200"
              >
                Close
              </motion.button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </section>
  );
};

const RefereeStationPage = () => {
  const { station } = useParams();
  const [searchParams] = useSearchParams();
  const { sessionId, isValid, isLoading, error } = useRefereSessionValidation();
  const config = getRefereeConfig(station);
  const {
    competitions,
    activeCompetitionId,
    switchCompetition,
    refereeSignals,
    setRefereeSignals,
    publishRefereeSignal,
    trackRefereePresence,
    untrackRefereePresence,
    setCurrentRefereeSessionId,
    lifters,
    currentLifterId,
    currentLift,
    currentAttemptIndex,
  } = useAppContext();
  const [decisionEndsAt, setDecisionEndsAt] = useState<number | null>(null);
  const [pendingDecision, setPendingDecision] = useState<Exclude<RefSignal, null> | null>(null);
  const [now, setNow] = useState(Date.now());
  const holdTimeoutRef = useRef<number | null>(null);
  const commitTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const requestedCompetitionId = searchParams.get("cid");
    if (requestedCompetitionId && requestedCompetitionId !== activeCompetitionId) {
      const exists = competitions.some((competition) => competition.id === requestedCompetitionId);
      if (exists) {
        switchCompetition(requestedCompetitionId);
      }
      return;
    }

    if (!activeCompetitionId && competitions.length > 0) {
      switchCompetition(competitions[0].id);
    }
  }, [searchParams, activeCompetitionId, competitions, switchCompetition]);

  useEffect(() => {
    setCurrentRefereeSessionId(sessionId);
  }, [sessionId, setCurrentRefereeSessionId]);

  useEffect(() => {
    if (!decisionEndsAt) return;
    const ticker = window.setInterval(() => setNow(Date.now()), 80);
    return () => window.clearInterval(ticker);
  }, [decisionEndsAt]);

  useEffect(() => {
    return () => {
      if (holdTimeoutRef.current) {
        window.clearTimeout(holdTimeoutRef.current);
      }
      if (commitTimeoutRef.current) {
        window.clearTimeout(commitTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!config || !activeCompetitionId) return;
    const timer = window.setTimeout(() => {
      trackRefereePresence(config.index);
    }, 500);
    return () => {
      window.clearTimeout(timer);
      untrackRefereePresence();
    };
  }, [activeCompetitionId, config, trackRefereePresence, untrackRefereePresence]);

  useEffect(() => {
    if (!config || !activeCompetitionId) return;

    const retrack = () => {
      if (document.visibilityState === "visible") {
        trackRefereePresence(config.index);
      }
    };

    const handleOnline = () => {
      trackRefereePresence(config.index);
    };

    document.addEventListener("visibilitychange", retrack);
    window.addEventListener("focus", retrack);
    window.addEventListener("online", handleOnline);

    return () => {
      document.removeEventListener("visibilitychange", retrack);
      window.removeEventListener("focus", retrack);
      window.removeEventListener("online", handleOnline);
    };
  }, [activeCompetitionId, config, trackRefereePresence]);

  useEffect(() => {
    if (!config || !activeCompetitionId) return;

    const heartbeat = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        trackRefereePresence(config.index);
      }
    }, 20000);

    return () => {
      window.clearInterval(heartbeat);
    };
  }, [activeCompetitionId, config, trackRefereePresence]);

  // Referee phones only publish signals to Supabase. Verdict + DB persist run on the display screen.

  if (isLoading) {
    return <InvalidSessionError error="Validating session..." isLoading={true} />;
  }

  if (!isValid || error) {
    return <InvalidSessionError error={error || "Invalid or expired session."} />;
  }

  if (!config) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#05070f] text-white">
        <p className="text-slate-400">Invalid referee station.</p>
      </div>
    );
  }

  const cancelPendingDecision = () => {
    if (holdTimeoutRef.current) {
      window.clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }
    if (commitTimeoutRef.current) {
      window.clearTimeout(commitTimeoutRef.current);
      commitTimeoutRef.current = null;
    }
    setPendingDecision(null);
    setDecisionEndsAt(null);
  };

  const startDecisionHold = (decision: Exclude<RefSignal, null>, event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (pendingDecision) return;
    const commitAt = Date.now() + REFEREE_CONFIRM_DELAY_MS;
    setPendingDecision(decision);
    setDecisionEndsAt(commitAt);
    holdTimeoutRef.current = window.setTimeout(() => {
      if (navigator.vibrate) navigator.vibrate(80);
      const nextSignals = refereeSignals.map((signal, idx) => (idx === config.index ? decision : signal));
      publishRefereeSignal(config.index, decision);
      // Optimistic local update is only needed when we're not syncing via Supabase.
      // In Supabase mode, we rely on realtime `refereeSignals` updates to avoid
      // races where a reset happens before this delayed local write runs.
      if (!isFirebaseConfigured) {
        commitTimeoutRef.current = window.setTimeout(() => {
          setRefereeSignals(nextSignals);
          commitTimeoutRef.current = null;
        }, 90);
      } else {
        commitTimeoutRef.current = null;
      }
      holdTimeoutRef.current = null;
      setPendingDecision(null);
      setDecisionEndsAt(null);
    }, REFEREE_CONFIRM_DELAY_MS);
  };

  const countdown = decisionEndsAt ? Math.max(0, (decisionEndsAt - now) / 1000) : 0;
  const currentSignal = refereeSignals[config.index];

  const signalColor =
    currentSignal === "GOOD"
      ? "text-emerald-400"
      : currentSignal === "NO"
      ? "text-red-400"
      : "text-slate-400";

  const progressPercentage = decisionEndsAt ? ((REFEREE_CONFIRM_DELAY_MS - (decisionEndsAt - now)) / REFEREE_CONFIRM_DELAY_MS) * 100 : 0;

  const currentLifter = lifters.find((l) => l.id === currentLifterId) ?? null;
  const currentAttempt = currentLifter ? (getAttempts(currentLifter, currentLift)[currentAttemptIndex] ?? null) : null;
  const liftLabel = currentLift === "squat" ? "Squat" : currentLift === "bench" ? "Bench Press" : "Deadlift";
  const attemptLabel = currentAttemptIndex === 0 ? "1st" : currentAttemptIndex === 1 ? "2nd" : "3rd";
  const weightDisplay = currentAttempt && currentAttempt.weight !== "" ? String(currentAttempt.weight) : "—";

  return (
    <div className="flex min-h-screen flex-col bg-[#05070f] text-white select-none overflow-hidden">

      {/* ── Top bar ── */}
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 shrink-0">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-slate-500">Referee Station</p>
          <p className="text-base font-bold text-white">{config.label}</p>
        </div>
        <motion.div
          initial={{ opacity: 0.7 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, repeat: Infinity, repeatType: "reverse" }}
          className="flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-300"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          LIVE
        </motion.div>
      </div>

      {/* ── Current Attempt info ── */}
      <div className="shrink-0 border-b border-white/10 px-4 pt-4 pb-5">
        <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.25em] text-slate-500">
          Current Attempt
        </p>

        {currentLifter ? (
          <AnimatePresence mode="wait">
            <motion.div
              key={`${currentLifterId}-${currentLift}-${currentAttemptIndex}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.22 }}
            >
              {/* Weight — very large */}
              <div className="flex flex-col items-center pb-1">
                <span className="text-[80px] font-black leading-none tabular-nums tracking-tighter text-white">
                  {weightDisplay}
                </span>
                <span className="mt-1 text-sm font-bold uppercase tracking-[0.3em] text-slate-400">kg</span>
              </div>

              {/* Lift type + attempt number */}
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <span className="rounded-full bg-cyan-500/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-cyan-300">
                  {liftLabel}
                </span>
                <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-slate-300">
                  {attemptLabel} attempt
                </span>
              </div>

              {/* Lifter card */}
              <div className="mt-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center">
                <p className="text-base font-bold text-white">{currentLifter.name}</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {[
                    currentLifter.team || null,
                    typeof currentLifter.bodyweight === "number" ? `${currentLifter.bodyweight} kg BW` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </p>
              </div>
            </motion.div>
          </AnimatePresence>
        ) : (
          <p className="py-4 text-center text-sm text-slate-500">Waiting for competition to start…</p>
        )}
      </div>

      {/* ── Decision area ── */}
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-4 py-5">

        {/* Signal status / countdown */}
        {pendingDecision ? (
          <motion.div
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="text-center"
          >
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-amber-300">
              Hold {pendingDecision}…
            </p>
            <motion.p
              key={Math.floor(countdown * 10)}
              initial={{ scale: 1.3, opacity: 0.5 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.12 }}
              className="mt-1 text-3xl font-bold tabular-nums text-amber-200"
            >
              {countdown.toFixed(1)}s
            </motion.p>
          </motion.div>
        ) : (
          <div className="text-center">
            <p className="text-[10px] uppercase tracking-widest text-slate-500">Your Signal</p>
            <AnimatePresence mode="wait">
              <motion.p
                key={currentSignal ?? "none"}
                initial={{ y: 8, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -8, opacity: 0 }}
                transition={{ duration: 0.18 }}
                className={`mt-1 text-xl font-bold ${signalColor}`}
              >
                {currentSignal ?? "—"}
              </motion.p>
            </AnimatePresence>
          </div>
        )}

        {/* GOOD LIFT / NO LIFT buttons */}
        <div className="grid w-full max-w-sm gap-4">
          <div className="relative">
            <button
              onPointerDown={(event) => startDecisionHold("GOOD", event)}
              onPointerUp={cancelPendingDecision}
              onPointerLeave={cancelPendingDecision}
              onPointerCancel={cancelPendingDecision}
              className="h-28 w-full touch-manipulation rounded-2xl bg-emerald-500 text-2xl font-extrabold text-black shadow-lg shadow-emerald-500/20 active:scale-95 transition-transform overflow-hidden relative"
            >
              {pendingDecision === "GOOD" && (
                <motion.div
                  className="absolute inset-0 bg-emerald-600 rounded-2xl"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: progressPercentage / 100 }}
                  transition={{ duration: 0.05 }}
                  style={{ transformOrigin: "left" }}
                />
              )}
              <span className="relative z-10">GOOD LIFT</span>
            </button>
          </div>
          <div className="relative">
            <button
              onPointerDown={(event) => startDecisionHold("NO", event)}
              onPointerUp={cancelPendingDecision}
              onPointerLeave={cancelPendingDecision}
              onPointerCancel={cancelPendingDecision}
              className="h-28 w-full touch-manipulation rounded-2xl bg-red-500 text-2xl font-extrabold text-white shadow-lg shadow-red-500/20 active:scale-95 transition-transform overflow-hidden relative"
            >
              {pendingDecision === "NO" && (
                <motion.div
                  className="absolute inset-0 bg-red-600 rounded-2xl"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: progressPercentage / 100 }}
                  transition={{ duration: 0.05 }}
                  style={{ transformOrigin: "left" }}
                />
              )}
              <span className="relative z-10">NO LIFT</span>
            </button>
          </div>
        </div>

        <motion.p
          initial={{ opacity: 0.5 }}
          animate={{ opacity: pendingDecision ? 0 : 1 }}
          transition={{ duration: 0.2 }}
          className="text-center text-xs text-slate-600"
        >
          Hold button to confirm your decision
        </motion.p>
      </div>
    </div>
  );
};

const ScreenPage = () => {
  const {
    lifters,
    groups,
    currentLifterId,
    refereeInputLocked,
    currentLift,
    currentAttemptIndex,
    competitionStarted,
    includeCollars,
    competitionMode,
    timerPhase,
    timerEndsAt,
    nextAttemptQueue,
    activeCompetitionGroupName,
    competitions,
    activeCompetitionId,
    manualOrderByStage,
  } = useAppContext();
  const [screenType, setScreenType] = useState("signal_results_plate");
  const [displayVenueTheme, setDisplayVenueTheme] = useState<DisplayThemeKey>("black");
  const [displayVenueScale, setDisplayVenueScale] = useState("1");
  const [displayVenueFont, setDisplayVenueFont] = useState<DisplayFontFamilyKey>("system");

  const openDisplayScreen = () => {
    const activeCompetitionName =
      competitions.find((c) => c.id === activeCompetitionId)?.name ?? "Competition";
    // Live display reads referee signals from Supabase realtime / relay — do not embed
    // the opener's current `refereeSignals` in the URL seed or postMessage bootstrap.
    // Otherwise a tab opened while the controller still had old lights re-applies them
    // after the DB has cleared `referee_signals`, so the result screen shows stale votes.
    const seededCompetition = normalizeCompetitionRecord({
      id: activeCompetitionId ?? `comp-${Date.now()}`,
      name: activeCompetitionName,
      createdAt: Date.now(),
      lifters,
      groups,
      currentLifterId,
      refereeSignals: [null, null, null],
      refereeInputLocked,
      currentLift,
      currentAttemptIndex,
      competitionStarted,
      includeCollars,
      competitionMode,
      nextAttemptQueue,
      timerPhase,
      timerEndsAt,
      activeCompetitionGroupName,
      manualOrderByStage,
    });
    const seedValue = encodeUrlSeed(seededCompetition);
    const seedParam = seedValue ? `&seed=${encodeURIComponent(seedValue)}` : "";
    const cidParam = activeCompetitionId ? `&cid=${encodeURIComponent(activeCompetitionId)}` : "";
    const venueParams = `&theme=${encodeURIComponent(displayVenueTheme)}&scale=${encodeURIComponent(displayVenueScale)}&font=${encodeURIComponent(displayVenueFont)}`;
    const url = `${window.location.origin}${window.location.pathname}#/display/full?layout=${screenType}&live=1${cidParam}${seedParam}${venueParams}`;
    const popup = window.open(url, "_blank", "width=1280,height=720");

    if (!popup) return;

    const bootstrapPayload: PersistedState = {
      lifters,
      groups,
      currentLifterId,
      refereeSignals: [null, null, null],
      refereeInputLocked,
      currentLift,
      currentAttemptIndex,
      competitionStarted,
      includeCollars,
      competitionMode,
      nextAttemptQueue,
      timerPhase,
      timerEndsAt,
      activeCompetitionGroupName,
      manualOrderByStage,
    };

    // Retry a few times so the new tab receives state even if it boots slowly on mobile webviews.
    let tries = 0;
    const postBootstrap = () => {
      if (popup.closed || tries >= 8) return;
      popup.postMessage({ type: "POWERLIFTING_BOOTSTRAP", payload: bootstrapPayload }, window.location.origin);
      tries += 1;
      window.setTimeout(postBootstrap, 250);
    };

    postBootstrap();
  };

  return (
    <section>
      <SectionHeader title="Display Screens" path="/screen" />
      <div className="rounded-2xl border border-white/15 bg-white/5 p-5">
        <label className="mb-2 block text-sm text-slate-300">Screen Template</label>
        <select
          value={screenType}
          onChange={(e) => setScreenType(e.target.value)}
          className="h-11 w-full rounded-xl border border-white/20 bg-black/40 px-3 md:w-auto"
        >
          <option value="signal_results_plate" className="bg-slate-900">1. Referee Signal + Results + IPF Plate</option>
          <option value="signal_results" className="bg-slate-900">2. Live Scoreboard (Results)</option>
          <option value="order_attempts" className="bg-slate-900">3. Lifter Order With Attempts</option>
          <option value="results_all" className="bg-slate-900">4. Results All</option>
          <option value="ipf_plate" className="bg-slate-900">5. IPF Plate Only</option>
          <option value="next_attempt_queue" className="bg-slate-900">6. Next Attempt Queue</option>
          <option value="bar_loading_tables" className="bg-slate-900">7. Bar Loading + Lifter Tables</option>
        </select>

        <p className="mt-6 text-xs font-semibold uppercase tracking-widest text-slate-500">Venue screen (projector / LED)</p>
        <p className="mt-1 text-xs text-slate-400">
          Applied when the display opens. Use larger text % for far viewing; theme matches the on-screen color preset.
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div>
            <label className="mb-2 block text-sm text-slate-300">Color theme</label>
            <select
              value={displayVenueTheme}
              onChange={(e) => setDisplayVenueTheme(e.target.value as DisplayThemeKey)}
              className="h-11 w-full rounded-xl border border-white/20 bg-black/40 px-3 text-sm"
            >
              {DISPLAY_THEME_ORDER.map((key) => (
                <option key={key} value={key} className="bg-slate-900">
                  {DISPLAY_THEME_CONFIG[key].label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-2 block text-sm text-slate-300">Text size</label>
            <select
              value={displayVenueScale}
              onChange={(e) => setDisplayVenueScale(e.target.value)}
              className="h-11 w-full rounded-xl border border-white/20 bg-black/40 px-3 text-sm"
            >
              {DISPLAY_SCALE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value} className="bg-slate-900">
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-2 block text-sm text-slate-300">Font</label>
            <select
              value={displayVenueFont}
              onChange={(e) => setDisplayVenueFont(e.target.value as DisplayFontFamilyKey)}
              className="h-11 w-full rounded-xl border border-white/20 bg-black/40 px-3 text-sm"
            >
              <option value="system" className="bg-slate-900">
                System UI
              </option>
              <option value="condensed" className="bg-slate-900">
                Condensed (narrow)
              </option>
              <option value="mono" className="bg-slate-900">
                Monospace
              </option>
              <option value="serif" className="bg-slate-900">
                Serif
              </option>
            </select>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            onClick={openDisplayScreen}
            className="rounded-xl bg-cyan-500 px-4 py-2 font-semibold text-black"
          >
            Open Live Screen
          </button>
        </div>
      </div>
    </section>
  );
};

const bestLift = (attempts: Attempt[]) =>
  attempts.reduce((best, cur) => {
    if (cur.status !== "GOOD" || cur.weight === "") return best;
    return cur.weight > best ? cur.weight : best;
  }, 0);

const IPF_PLATES = [25, 20, 15, 10, 5, 2.5, 1.25, 0.5];

const PLATE_COLORS: Record<string, string> = {
  "25": "#dc2626",
  "20": "#2563eb",
  "15": "#eab308",
  "10": "#16a34a",
  "5": "#f8fafc",
  "2.5": "#111827",
  "1.25": "#6b7280",
  "0.5": "#94a3b8",
};

const PLATE_HEIGHT: Record<string, number> = {
  "25": 140,
  "20": 132,
  "15": 124,
  "10": 116,
  "5": 98,
  "2.5": 88,
  "1.25": 78,
  "0.5": 70,
};

const PLATE_WIDTH: Record<string, number> = {
  "25": 24,
  "20": 22,
  "15": 20,
  "10": 18,
  "5": 16,
  "2.5": 14,
  "1.25": 12,
  "0.5": 10,
};

const buildPlateBreakdown = (weight: number, includeCollars: boolean) => {
  const collarWeight = includeCollars ? COLLAR_PAIR_KG : 0;
  if (!Number.isFinite(weight) || weight < BAR_WEIGHT_KG + collarWeight) return [] as number[];
  let perSide = (weight - BAR_WEIGHT_KG - collarWeight) / 2;
  if (perSide <= 0) return [] as number[];
  const loaded: number[] = [];
  for (const plate of IPF_PLATES) {
    while (perSide + 0.0001 >= plate) {
      loaded.push(plate);
      perSide -= plate;
    }
  }
  return loaded;
};

const formatKg = (v: number): string => {
  const rounded = Math.round(v * 100) / 100;
  return parseFloat(rounded.toFixed(2)).toString();
};

const computePlateChanges = (cur: number[], nxt: number[]): { toRemove: number[]; toAdd: number[] } => {
  const curCount: Record<string, number> = {};
  const nxtCount: Record<string, number> = {};
  for (const p of cur) curCount[String(p)] = (curCount[String(p)] || 0) + 1;
  for (const p of nxt) nxtCount[String(p)] = (nxtCount[String(p)] || 0) + 1;
  const toRemove: number[] = [];
  const toAdd: number[] = [];
  const allPlates = new Set([...Object.keys(curCount), ...Object.keys(nxtCount)]);
  for (const ps of allPlates) {
    const p = Number(ps);
    const c = curCount[ps] || 0;
    const n = nxtCount[ps] || 0;
    for (let i = 0; i < c - n; i++) toRemove.push(p);
    for (let i = 0; i < n - c; i++) toAdd.push(p);
  }
  toRemove.sort((a, b) => b - a);
  toAdd.sort((a, b) => b - a);
  return { toRemove, toAdd };
};

const formatPerSideLoading = (plates: number[], includeCollars: boolean) => {
  const parts = plates.map((plate) => `${plate}`);
  if (includeCollars) parts.push("collar");
  return parts.length ? parts.join(" + ") : includeCollars ? "collar" : "bar only";
};

const formatAttemptWeight = (attempt: Attempt) => (attempt.weight === "" ? "-" : `${attempt.weight}`);

const AttemptDisplayCell = ({ attempt, isDarkTheme }: { attempt: Attempt; isDarkTheme: boolean }) => {
  const isNoLift = attempt.status === "NO";
  const isGood = attempt.status === "GOOD";
  const isPending = attempt.status === "PENDING";
  const tone = isDarkTheme
    ? {
        good: "bg-green-500/20 text-green-100",
        no: "bg-red-500/20 text-red-100",
        pending: "bg-amber-500/20 text-amber-100",
        default: "bg-white/5 text-slate-300",
      }
    : {
        good: "bg-emerald-600/15 text-emerald-900",
        no: "bg-red-500/20 text-red-900",
        pending: "bg-amber-500/20 text-amber-950",
        default: "bg-slate-100 text-slate-700",
      };
  const cell =
    isGood ? tone.good : isNoLift ? tone.no : isPending ? tone.pending : tone.default;
  return (
    <td
      className={`align-top whitespace-normal break-words px-2 py-2 text-center text-sm font-semibold tabular-nums ${cell}`}
    >
      <span className={`inline-block max-w-full ${isNoLift ? "line-through decoration-2" : ""}`}>
        {formatAttemptWeight(attempt)}
      </span>
    </td>
  );
};

const PlateStack = ({ weight, includeCollars }: { weight: number; includeCollars: boolean }) => {
  const perSide = buildPlateBreakdown(weight, includeCollars);
  const leftSide = [...perSide].reverse();

  const renderPlate = (plate: number, index: number, side: "left" | "right") => {
    const color = PLATE_COLORS[String(plate)] || "#64748b";
    const textIsDark = plate === 15 || plate === 5;
    return (
      <div
        key={`${side}-${plate}-${index}`}
        className="relative flex items-start justify-center rounded-sm border border-black/30"
        style={{
          width: `${PLATE_WIDTH[String(plate)]}px`,
          height: `${PLATE_HEIGHT[String(plate)]}px`,
          backgroundColor: color,
          boxShadow: "inset 0 0 10px rgba(255,255,255,0.28)",
        }}
      >
        <span className={`pt-1 text-xs font-bold leading-none ${textIsDark ? "text-black" : "text-white"}`}>{plate}</span>
      </div>
    );
  };

  const collarNode = (side: "left" | "right") => (
    <div
      key={`collar-${side}`}
      className="flex h-[66px] w-[12px] items-center justify-center rounded-sm border border-black/40 bg-slate-500"
      style={{ boxShadow: "inset 0 0 8px rgba(255,255,255,0.35)" }}
    />
  );

  return (
    <div className="w-full rounded-2xl border border-black/15 bg-white/90 p-4 text-black">
      <p className="text-sm font-semibold tracking-wide">
        BAR LOADING: {weight.toFixed(1)} kg {includeCollars ? "(with collar)" : "(without collar)"}
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <div className="flex items-end gap-[2px]">
          {includeCollars && collarNode("left")}
          {leftSide.map((plate, index) => renderPlate(plate, index, "left"))}
        </div>
        <div className="relative h-4 w-[200px] rounded-full bg-gradient-to-r from-slate-700 via-slate-500 to-slate-700">
          <div className="absolute right-0 top-1/2 h-6 w-3 -translate-y-1/2 rounded bg-slate-400" />
          <div className="absolute left-0 top-1/2 h-6 w-3 -translate-y-1/2 rounded bg-slate-400" />
        </div>
        <div className="flex items-end gap-[2px]">
          {perSide.map((plate, index) => renderPlate(plate, index, "right"))}
          {includeCollars && collarNode("right")}
        </div>
      </div>
      <p className="mt-4 text-center font-serif text-2xl font-bold md:text-5xl">{formatPerSideLoading(perSide, includeCollars)}</p>
    </div>
  );
};

const ResultsPage = () => {
  const { lifters, setLifters, competitionMode, groups, activeCompetitionGroupName } = useAppContext();
  const [searchTerm, setSearchTerm] = useState("");
  const [notice, setNotice] = useState("");
  const [attemptDrafts, setAttemptDrafts] = useState<Record<string, string>>({});
  const isBenchOnly = competitionMode === "BENCH_ONLY";

  const groupScopedLifters = useMemo(
    () =>
      activeCompetitionGroupName !== null
        ? lifters.filter((l) => isInGroup(l.group, activeCompetitionGroupName))
        : lifters,
    [lifters, activeCompetitionGroupName],
  );

  const updateAttemptCell = (
    lifterId: string,
    lift: LiftType,
    attemptIndex: number,
    patch: Partial<Attempt>,
  ): { ok: boolean; message: string } => {
    const lifterIndex = lifters.findIndex((l) => l.id === lifterId);
    if (lifterIndex < 0) return { ok: false, message: "Lifter not found." };
    const source = lifters[lifterIndex];
    const attempts = [...getAttempts(source, lift)];
    const baseAttempt = attempts[attemptIndex] ?? { weight: "", status: "UNATTEMPTED" as AttemptStatus };
    const nextAttempt = { ...baseAttempt, ...patch };

    if (nextAttempt.weight !== "" && Math.round(Number(nextAttempt.weight) * 10) % 25 !== 0) {
      return { ok: false, message: "Use 2.5kg increments for attempt weight." };
    }

    if (nextAttempt.weight === "" && (nextAttempt.status === "GOOD" || nextAttempt.status === "NO")) {
      return { ok: false, message: "Set a weight before marking Good or No." };
    }

    attempts[attemptIndex] = nextAttempt;
    const updated = [...lifters];
    updated[lifterIndex] = setAttempts(source, lift, attempts);
    setLifters(updated);
    return { ok: true, message: "Attempt updated." };
  };

  const getDraftKey = (lifterId: string, lift: LiftType, attemptIndex: number) => `${lifterId}-${lift}-${attemptIndex}`;

  const commitAttemptWeight = (lifterId: string, lift: LiftType, attemptIndex: number, fallbackWeight: number | "") => {
    const key = getDraftKey(lifterId, lift, attemptIndex);
    const rawDraft = attemptDrafts[key];
    if (typeof rawDraft === "undefined") return;

    const normalized = rawDraft.trim();
    const nextWeight: number | "" = normalized === "" ? "" : Number(normalized);
    if (normalized !== "" && !Number.isFinite(nextWeight)) {
      setNotice("Enter a valid number.");
      return;
    }

    const result = updateAttemptCell(lifterId, lift, attemptIndex, {
      weight: normalized === "" ? "" : Number(Number(nextWeight).toFixed(1)),
    });
    setNotice(result.message);
    if (!result.ok) return;

    const fallbackValue = fallbackWeight === "" ? "" : String(fallbackWeight);
    if (normalized === fallbackValue) {
      setAttemptDrafts((prev) => {
        const { [key]: _ignored, ...rest } = prev;
        return rest;
      });
      return;
    }

    setAttemptDrafts((prev) => {
      const { [key]: _ignored, ...rest } = prev;
      return rest;
    });
  };

  const filteredLifters = useMemo(() => {
    const eligible = groupScopedLifters.filter((lifter) => !lifter.disqualified);
    const query = searchTerm.trim().toLowerCase();
    if (!query) return eligible;
    return eligible.filter((lifter) => {
      const haystack = `${lifter.name} ${lifter.team} ${lifter.group} ${lifter.weightClass}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [groupScopedLifters, searchTerm]);

  const ranking = useMemo(
    () =>
      [...groupScopedLifters]
        .filter((l) => !l.disqualified)
        .map((l) => {
          const squat = bestLift(l.squatAttempts);
          const bench = bestLift(l.benchAttempts);
          const deadlift = bestLift(l.deadliftAttempts);
          const total = isBenchOnly ? bench : squat + bench + deadlift;
          const glPoints = calculateGoodliftPoints(total, l.bodyweight, l.sex, l.isEquipped, competitionMode === "BENCH_ONLY");
          return { ...l, squat, bench, deadlift, total, glPoints };
        })
        .sort((a, b) => b.glPoints - a.glPoints),
    [groupScopedLifters, competitionMode, isBenchOnly],
  );

  return (
    <section>
      <SectionHeader title="Results (GL Points)" path="/results" />
      {groups.length === 0 ? (
        <div className="rounded-2xl border border-white/15 bg-black/20 px-5 py-10 text-center">
          <p className="text-sm text-slate-300">
            No groups configured for this competition. Add groups under the Groups tab to show results tables.
          </p>
        </div>
      ) : (
        <>
      <div className="mb-4 flex flex-wrap gap-3">
        <input
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search lifter, team, group"
          className="h-11 w-full max-w-sm rounded-xl border border-white/20 bg-white/5 px-3 text-sm text-white outline-none ring-cyan-400 transition focus:ring"
        />
      </div>
      {notice && <p className="mb-3 text-sm text-amber-200">{notice}</p>}
      <div className="overflow-x-auto rounded-2xl border border-white/15 bg-black/20">
        <table className="min-w-[1600px] text-sm">
          <thead className="bg-white/5 text-left text-slate-300">
            <tr>
              <th className="px-4 py-3">Rank</th>
              <th className="px-4 py-3">Lifter</th>
              <th className="px-4 py-3">Group</th>
              <th className="px-4 py-3">Team</th>
              <th className="px-4 py-3">Body weight</th>
              {!isBenchOnly && (
                <>
                  <th className="px-4 py-3">SQ1</th>
                  <th className="px-4 py-3">SQ2</th>
                  <th className="px-4 py-3">SQ3</th>
                </>
              )}
              <th className="px-4 py-3">BP1</th>
              <th className="px-4 py-3">BP2</th>
              <th className="px-4 py-3">BP3</th>
              {!isBenchOnly && (
                <>
                  <th className="px-4 py-3">DL1</th>
                  <th className="px-4 py-3">DL2</th>
                  <th className="px-4 py-3">DL3</th>
                </>
              )}
              <th className="px-4 py-3">Total</th>
              <th className="px-4 py-3">GL</th>
            </tr>
          </thead>
          <tbody>
            {ranking
              .filter((ranked) => filteredLifters.some((row) => row.id === ranked.id))
              .map((r, idx) => {
                const renderEditor = (lift: LiftType, attemptIndex: number) => {
                  const attempt = getAttempts(r, lift)[attemptIndex] ?? { weight: "", status: "UNATTEMPTED" as AttemptStatus };
                  const statusClass =
                    attempt.status === "GOOD"
                      ? "bg-green-500/20"
                      : attempt.status === "NO"
                        ? "bg-red-500/20"
                        : attempt.status === "PENDING"
                          ? "bg-amber-500/20"
                          : "bg-white/5";
                  return (
                    <td key={`${r.id}-${lift}-${attemptIndex}`} className="px-2 py-2 align-top">
                      <div className={`rounded-lg border border-white/10 p-2 ${statusClass}`}>
                        <input
                          type="number"
                          step="2.5"
                          value={attemptDrafts[getDraftKey(r.id, lift, attemptIndex)] ?? (attempt.weight === "" ? "" : attempt.weight)}
                          onChange={(e) =>
                            setAttemptDrafts((prev) => ({
                              ...prev,
                              [getDraftKey(r.id, lift, attemptIndex)]: e.target.value,
                            }))
                          }
                          onBlur={() => commitAttemptWeight(r.id, lift, attemptIndex, attempt.weight)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.currentTarget.blur();
                            }
                          }}
                          className={`h-8 w-full rounded border border-white/20 bg-black/30 px-2 text-xs text-white ${
                            attempt.status === "NO" ? "line-through" : ""
                          }`}
                        />
                        <select
                          value={attempt.status}
                          onChange={(e) => {
                            const result = updateAttemptCell(r.id, lift, attemptIndex, {
                              status: e.target.value as AttemptStatus,
                            });
                            setNotice(result.message);
                          }}
                          className="mt-1 h-8 w-full rounded border border-white/20 bg-black/40 px-1 text-xs text-white"
                        >
                          <option value="UNATTEMPTED" className="bg-slate-900">UNATTEMPTED</option>
                          <option value="PENDING" className="bg-slate-900">PENDING</option>
                          <option value="GOOD" className="bg-slate-900">GOOD</option>
                          <option value="NO" className="bg-slate-900">NO</option>
                        </select>
                      </div>
                    </td>
                  );
                };

                return (
                  <tr key={r.id} className="border-t border-white/10">
                    <td className="px-4 py-3">{idx + 1}</td>
                    <td className="px-4 py-3 font-semibold">{r.name}</td>
                    <td className="px-4 py-3">{r.group || "-"}</td>
                    <td className="px-4 py-3">{r.team || "-"}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-300">
                      {typeof r.bodyweight === "number" ? `${r.bodyweight} kg` : "-"}
                    </td>
                    {!isBenchOnly && (
                      <>
                        {renderEditor("squat", 0)}
                        {renderEditor("squat", 1)}
                        {renderEditor("squat", 2)}
                      </>
                    )}
                    {renderEditor("bench", 0)}
                    {renderEditor("bench", 1)}
                    {renderEditor("bench", 2)}
                    {!isBenchOnly && (
                      <>
                        {renderEditor("deadlift", 0)}
                        {renderEditor("deadlift", 1)}
                        {renderEditor("deadlift", 2)}
                      </>
                    )}
                    <td className="px-4 py-3 font-semibold">{r.total} kg</td>
                    <td className="px-4 py-3">{r.glPoints}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
        </>
      )}
    </section>
  );
};

const SettingsPage = () => {
  const { lifters, setLifters } = useAppContext();

  return (
    <section>
      <SectionHeader title="Settings & Backup" path="/settings" />
      <div className="rounded-2xl border border-white/15 bg-white/5 p-5">
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => {
              const blob = new Blob([JSON.stringify(lifters, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "lifters-backup.json";
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="rounded-xl bg-cyan-500 px-4 py-2 font-semibold text-black"
          >
            Export Backup
          </button>
          <label className="rounded-xl bg-white/10 px-4 py-2 text-sm">
            Import Backup
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const text = await file.text();
                setLifters(JSON.parse(text));
              }}
            />
          </label>
        </div>
      </div>
    </section>
  );
};

type RankedLifter = Lifter & { total: number; points: number };

const ResultsTable = memo(({
  rankingByGroup,
  ungroupedRanking,
  currentLifterId,
  isDarkTheme,
  competitionMode,
}: {
  rankingByGroup: { groupName: string; members: RankedLifter[] }[];
  ungroupedRanking: RankedLifter[];
  currentLifterId: string | null;
  isDarkTheme: boolean;
  competitionMode: CompetitionMode;
}) => {
  const isBenchOnly = competitionMode === "BENCH_ONLY";
  /** Fixed layout; Lifter & Team get extra width; names wrap instead of truncating. */
  const resultColCount = isBenchOnly ? 10 : 16;
  const LIFTER_COL_INDEX = 1;
  const TEAM_COL_INDEX = 3;
  const lifterColWeight = 2.15;
  const teamColWeight = 1.65;
  const defaultColWeight = 1;
  const colWeights = Array.from({ length: resultColCount }, (_, i) => {
    if (i === LIFTER_COL_INDEX) return lifterColWeight;
    if (i === TEAM_COL_INDEX) return teamColWeight;
    return defaultColWeight;
  });
  const weightSum = colWeights.reduce((a, b) => a + b, 0);
  const resultsColgroup = (
    <colgroup>
      {colWeights.map((w, i) => (
        <col key={i} style={{ width: `${(w / weightSum) * 100}%` }} />
      ))}
    </colgroup>
  );
  const isDualCategory = (category: string) => category.includes(" + ");

  const getDualCategoryParts = (category: string): [string, string] => {
    const idx = category.indexOf(" + ");
    return [category.slice(0, idx).trim(), category.slice(idx + 3).trim()];
  };

  const categoryFromClassName = (className?: string) => {
    if (!className) return "";
    const trimmed = className.trim();
    return trimmed.replace(/\s+\d+(\.\d+)?\s*KG$/i, "").trim();
  };

  const matchesCategoryToClass = (categoryPart: string, classCategory: string) => {
    const part = categoryPart.toLowerCase().trim();
    const cls = classCategory.toLowerCase().trim();
    if (!part || !cls) return false;
    if (part === cls || part.includes(cls) || cls.includes(part)) return true;
    const tokens = part.split(/\s+/).filter((token) => token.length > 2);
    return tokens.some((token) => cls.includes(token));
  };

  const renderLifterRow = (lifter: RankedLifter, idx: number, groupName?: string) => {
    const isDual = isDualCategory(lifter.category);

    let displayCategory = lifter.category || "-";
    if (isDual && groupName !== undefined) {
      const [firstPart, secondPart] = getDualCategoryParts(lifter.category);
      const classCategory = categoryFromClassName(groupName).toLowerCase();
      const firstMatch = matchesCategoryToClass(firstPart, classCategory);
      const secondMatch = matchesCategoryToClass(secondPart, classCategory);

      if (!firstMatch && secondMatch) {
        displayCategory = secondPart;
      } else if (firstMatch && secondMatch) {
        displayCategory = secondPart;
      } else {
        displayCategory = firstPart;
      }
    }

    return (
      <tr
        key={`${lifter.id}-${groupName ?? "ungrouped"}`}
        className={`border-t ${isDarkTheme ? "border-white/8" : "border-black/[0.08]"} ${
          lifter.id === currentLifterId ? "bg-cyan-500/10" : idx % 2 === 0 ? "" : isDarkTheme ? "bg-white/[0.015]" : "bg-black/[0.03]"
        }`}
      >
        <td className={`align-top whitespace-normal break-words px-2 py-2 tabular-nums ${isDarkTheme ? "text-slate-400" : "text-slate-600"}`}>
          {idx + 1}
        </td>
        <td className={`align-top whitespace-normal break-words px-2 py-2 font-semibold ${isDarkTheme ? "text-white" : "text-slate-900"}`}>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 break-words">
            <span>{lifter.name || "-"}</span>
            {isDual && (
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold ${
                  isDarkTheme ? "bg-amber-500/20 text-amber-300" : "bg-amber-400/30 text-amber-950"
                }`}
              >
                DUAL
              </span>
            )}
          </div>
        </td>
        <td
          className={`align-top whitespace-normal break-words px-2 py-2 hidden md:table-cell ${isDarkTheme ? "text-slate-400" : "text-slate-600"}`}
        >
          {displayCategory}
        </td>
        <td
          className={`align-top whitespace-normal break-words px-2 py-2 hidden md:table-cell ${isDarkTheme ? "text-slate-400" : "text-slate-600"}`}
        >
          {lifter.team || "-"}
        </td>
        <td
          className={`align-top whitespace-normal break-words px-2 py-2 hidden tabular-nums md:table-cell ${isDarkTheme ? "text-slate-400" : "text-slate-600"}`}
        >
          {typeof lifter.bodyweight === "number" ? `${lifter.bodyweight} kg` : "-"}
        </td>
        {!isBenchOnly && (
          <>
            <AttemptDisplayCell attempt={lifter.squatAttempts[0]} isDarkTheme={isDarkTheme} />
            <AttemptDisplayCell attempt={lifter.squatAttempts[1]} isDarkTheme={isDarkTheme} />
            <AttemptDisplayCell attempt={lifter.squatAttempts[2]} isDarkTheme={isDarkTheme} />
          </>
        )}
        <AttemptDisplayCell attempt={lifter.benchAttempts[0]} isDarkTheme={isDarkTheme} />
        <AttemptDisplayCell attempt={lifter.benchAttempts[1]} isDarkTheme={isDarkTheme} />
        <AttemptDisplayCell attempt={lifter.benchAttempts[2]} isDarkTheme={isDarkTheme} />
        {!isBenchOnly && (
          <>
            <AttemptDisplayCell attempt={lifter.deadliftAttempts[0]} isDarkTheme={isDarkTheme} />
            <AttemptDisplayCell attempt={lifter.deadliftAttempts[1]} isDarkTheme={isDarkTheme} />
            <AttemptDisplayCell attempt={lifter.deadliftAttempts[2]} isDarkTheme={isDarkTheme} />
          </>
        )}
        <td
          className={`align-top whitespace-normal break-words px-2 py-2 font-semibold tabular-nums ${isDarkTheme ? "text-white" : "text-slate-900"}`}
        >
          {lifter.total > 0 ? `${lifter.total} kg` : "-"}
        </td>
        <td
          className={`align-top whitespace-normal break-words px-2 py-2 hidden tabular-nums md:table-cell ${isDarkTheme ? "text-slate-400" : "text-slate-600"}`}
        >
          {lifter.points || "-"}
        </td>
      </tr>
    );
  };

  const tableHead = (
    <thead
      className={`text-left text-sm font-semibold ${isDarkTheme ? "text-slate-300 bg-white/[0.03]" : "text-slate-700 bg-slate-100/90"}`}
    >
      <tr>
        <th className="align-bottom whitespace-normal break-words px-2 py-2">#</th>
        <th className="align-bottom whitespace-normal break-words px-2 py-2">Lifter</th>
        <th className="align-bottom whitespace-normal break-words px-2 py-2 hidden md:table-cell">Category</th>
        <th className="align-bottom whitespace-normal break-words px-2 py-2 hidden md:table-cell">Team</th>
        <th className="align-bottom whitespace-normal break-words px-2 py-2 hidden md:table-cell">Body weight</th>
        {!isBenchOnly && (
          <>
            <th className="align-bottom whitespace-normal break-words px-2 py-2 text-center">SQ1</th>
            <th className="align-bottom whitespace-normal break-words px-2 py-2 text-center">SQ2</th>
            <th className="align-bottom whitespace-normal break-words px-2 py-2 text-center">SQ3</th>
          </>
        )}
        <th className="align-bottom whitespace-normal break-words px-2 py-2 text-center">BP1</th>
        <th className="align-bottom whitespace-normal break-words px-2 py-2 text-center">BP2</th>
        <th className="align-bottom whitespace-normal break-words px-2 py-2 text-center">BP3</th>
        {!isBenchOnly && (
          <>
            <th className="align-bottom whitespace-normal break-words px-2 py-2 text-center">DL1</th>
            <th className="align-bottom whitespace-normal break-words px-2 py-2 text-center">DL2</th>
            <th className="align-bottom whitespace-normal break-words px-2 py-2 text-center">DL3</th>
          </>
        )}
        <th className="align-bottom whitespace-normal break-words px-2 py-2 font-semibold">Total</th>
        <th className="align-bottom whitespace-normal break-words px-2 py-2 hidden text-center md:table-cell">GL</th>
      </tr>
    </thead>
  );

  return (
    <div className={`h-full space-y-3 overflow-y-auto ${DISPLAY_RESULTS_BODY}`}>
      {rankingByGroup.map(({ groupName, members }) => (
        <div
          key={groupName || "default"}
          className={`overflow-hidden rounded-xl border ${
            isDarkTheme
              ? "border-cyan-400/40 bg-black/30"
              : "border-cyan-700/25 bg-white shadow-md ring-1 ring-black/5"
          }`}
        >
          <div
            className={`flex w-full items-center gap-3 border-b-2 px-4 py-4 ${
              isDarkTheme
                ? "border-cyan-400/50 bg-gradient-to-r from-cyan-900/30 to-cyan-900/10"
                : "border-cyan-700/30 bg-gradient-to-r from-cyan-100/95 to-cyan-50/80"
            }`}
          >
            <div className={`h-3.5 w-1.5 rounded-full ${isDarkTheme ? "bg-cyan-400" : "bg-cyan-600"}`} />
            <div className="flex-1">
              <p
                className={`text-sm font-black uppercase leading-tight tracking-[0.24em] ${
                  isDarkTheme ? "text-cyan-100" : "text-cyan-950"
                }`}
              >
                {groupName || "Unassigned"}
              </p>
              <p
                className={`mt-0.5 text-xs font-semibold normal-case tracking-normal ${
                  isDarkTheme ? "text-cyan-300/70" : "text-cyan-800/85"
                }`}
              >
                {members.length} lifter{members.length !== 1 ? "s" : ""}
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className={`table-fixed w-full ${DISPLAY_RESULTS_BODY}`}>
              {resultsColgroup}
              {tableHead}
              <tbody>
                {members.length === 0 && (
                  <tr>
                    <td
                      colSpan={isBenchOnly ? 10 : 16}
                      className={`whitespace-normal break-words px-3 py-4 text-center text-sm ${isDarkTheme ? "text-slate-500" : "text-slate-600"}`}
                    >
                      No lifters in this group.
                    </td>
                  </tr>
                )}
                {members.map((lifter, idx) => renderLifterRow(lifter, idx, groupName))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {ungroupedRanking.length > 0 && (
        <div
          className={`overflow-hidden rounded-xl border ${
            isDarkTheme ? "border-slate-500/30 bg-black/20" : "border-slate-300 bg-white shadow-md ring-1 ring-black/5"
          }`}
        >
          {rankingByGroup.length > 0 && (
            <div
              className={`flex w-full items-center gap-3 border-b-2 px-4 py-4 ${
                isDarkTheme
                  ? "border-slate-500/40 bg-gradient-to-r from-slate-900/25 to-slate-900/10"
                  : "border-slate-300 bg-gradient-to-r from-slate-100 to-slate-50"
              }`}
            >
              <div className={`h-3.5 w-1.5 rounded-full ${isDarkTheme ? "bg-slate-400" : "bg-slate-600"}`} />
              <div className="flex-1">
                <p
                  className={`text-sm font-black uppercase leading-tight tracking-[0.24em] ${
                    isDarkTheme ? "text-slate-200" : "text-slate-900"
                  }`}
                >
                  Ungrouped
                </p>
                <p
                  className={`mt-0.5 text-xs font-semibold normal-case tracking-normal ${
                    isDarkTheme ? "text-slate-400/70" : "text-slate-600"
                  }`}
                >
                  {ungroupedRanking.length} lifter{ungroupedRanking.length !== 1 ? "s" : ""}
                </p>
              </div>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className={`table-fixed w-full ${DISPLAY_RESULTS_BODY}`}>
              {resultsColgroup}
              {tableHead}
              <tbody>
                {ungroupedRanking.map((lifter, idx) => renderLifterRow(lifter, idx))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {rankingByGroup.length === 0 && ungroupedRanking.length === 0 && (
        <div
          className={`flex h-32 items-center justify-center rounded-xl border ${
            isDarkTheme ? "border-white/10 bg-black/20" : "border-slate-200 bg-slate-100"
          }`}
        >
          <p className={`text-sm ${isDarkTheme ? "text-slate-500" : "text-slate-600"}`}>No lifters in results yet.</p>
        </div>
      )}
    </div>
  );
});

const NextAttemptQueueDisplay = ({
  forceLive,
  displayRootStyle,
}: {
  forceLive: boolean;
  displayRootStyle: React.CSSProperties;
}) => {
  const {
    lifters,
    currentLift,
    currentAttemptIndex,
    competitionMode,
    competitionStarted,
    activeCompetitionGroupName,
    nextAttemptQueue,
    updateAttemptForLifter,
    resetSignals,
  } = useAppContext();

  const sessionLifters = useMemo(
    () =>
      activeCompetitionGroupName !== null
        ? lifters.filter((l) => isInGroup(l.group, activeCompetitionGroupName))
        : lifters,
    [lifters, activeCompetitionGroupName],
  );

  const pendingQueueEntries = useMemo(() => {
    const queueBase =
      activeCompetitionGroupName !== null
        ? nextAttemptQueue.filter((e) => sessionLifters.some((l) => l.id === e.lifterId))
        : nextAttemptQueue;
    return sortNextAttemptQueue(
      [...queueBase, ...derivePendingNextAttemptQueue(sessionLifters, competitionMode)],
      lifters,
      competitionMode,
    ).filter((entry) => isPendingQueueEntry(entry, lifters));
  }, [nextAttemptQueue, lifters, sessionLifters, competitionMode, activeCompetitionGroupName]);

  const queuedAttemptRows = useMemo(
    () =>
      pendingQueueEntries
        .map((entry) => ({ entry, lifter: lifters.find((item) => item.id === entry.lifterId) ?? null }))
        .filter((row): row is { entry: NextAttemptEntry; lifter: Lifter } => Boolean(row.lifter)),
    [pendingQueueEntries, lifters],
  );

  const [now, setNow] = useState(Date.now);
  const [queueTimerStarts, setQueueTimerStarts] = useState<Record<string, number>>({});
  const [quickWeightDraft, setQuickWeightDraft] = useState<Record<string, string>>({});
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  useEffect(() => {
    setQueueTimerStarts((prev) => {
      const next: Record<string, number> = {};
      queuedAttemptRows.forEach(({ entry }) => {
        const key = `${entry.lifterId}-${entry.lift}-${entry.attemptIndex}`;
        next[key] = prev[key] ?? Date.now();
      });
      return next;
    });
  }, [queuedAttemptRows]);

  useEffect(() => {
    if (!queuedAttemptRows.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [queuedAttemptRows.length]);

  const buildQuickWeights = (baseWeight: number, floorWeight: number) => {
    const start = Math.max(20, floorWeight, Math.round((baseWeight - 10) / 2.5) * 2.5);
    return Array.from({ length: 10 }, (_, i) => Number((start + i * 2.5).toFixed(1)));
  };

  const formatTimer = (seconds: number) => {
    const abs = Math.abs(seconds);
    const mm = Math.floor(abs / 60);
    const ss = String(abs % 60).padStart(2, "0");
    return seconds < 0 ? `-${mm}:${ss}` : `${mm}:${ss}`;
  };

  return (
    <div
      className="w-full min-h-screen overflow-y-auto text-white"
      style={{ ...displayRootStyle, background: "#0d0d0d" }}
    >
      {!competitionStarted && !forceLive && (
        <div className="bg-amber-500/20 border-b border-amber-400/30 px-4 py-1 text-center">
          <span className="text-xs font-semibold uppercase tracking-widest text-amber-300">
            Preview mode — competition not started
          </span>
        </div>
      )}

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        {/* Header */}
        <p className="text-center text-sm font-semibold uppercase tracking-[0.24em] text-violet-300">
          NEXT ATTEMPT QUEUE ({queuedAttemptRows.length})
        </p>
        <hr className="border-white/15" />

        {/* Queue rows */}
        {queuedAttemptRows.map(({ entry, lifter }, queueIndex) => {
          const queueLift = entry.lift;
          const queueAttemptIndex = entry.attemptIndex;
          const attempt = getAttempts(lifter, queueLift)[queueAttemptIndex];
          const previousAttempt =
            queueAttemptIndex > 0 ? getAttempts(lifter, queueLift)[queueAttemptIndex - 1] : null;
          const minQuickWeight =
            typeof previousAttempt?.weight === "number" ? previousAttempt.weight : 20;
          const baseWeight =
            typeof attempt?.weight === "number"
              ? attempt.weight
              : resolveAttemptWeight(lifter, queueLift, queueAttemptIndex);
          const quickWeights = buildQuickWeights(baseWeight, minQuickWeight);
          const draftKey = `${lifter.id}-${queueLift}-${queueAttemptIndex}`;
          const draft = quickWeightDraft[draftKey] ?? "";
          const queueKey = `${entry.lifterId}-${entry.lift}-${entry.attemptIndex}`;
          const startedAt = queueTimerStarts[queueKey] ?? now;
          const perLifterSignedSeconds = Math.ceil((startedAt + ONE_MINUTE_MS - now) / 1000);

          const applyWeight = (nextWeight: number) => {
            const result = updateAttemptForLifter(lifter.id, queueLift, queueAttemptIndex, nextWeight);
            if (result.ok) {
              setQuickWeightDraft((prev) => ({ ...prev, [draftKey]: String(nextWeight) }));
            }
            setActionNotice(result.message);
          };

          return (
            <div
              key={`${lifter.id}-${queueLift}-${queueAttemptIndex}`}
              className="border-t border-white/10 pt-4 text-center first:border-t-0 first:pt-0"
            >
              <div className="flex items-center justify-center gap-3">
                <h3 className="font-serif text-4xl font-bold uppercase">
                  {lifter.lot ? `- ` : ""}{lifter.name}
                </h3>
                <span className="rounded-lg border border-violet-300/40 bg-violet-500/15 px-3 py-1 text-base font-semibold text-violet-100 md:text-lg">
                  {formatTimer(perLifterSignedSeconds)}
                </span>
              </div>
              <p className="mt-1 text-sm uppercase tracking-[0.2em] text-violet-200">
                {queueLift} attempt {queueAttemptIndex + 1}
              </p>
              {queueIndex === 0 ? (
                <p className="mt-1 text-xs uppercase tracking-[0.15em] text-cyan-200">Current next attempt</p>
              ) : (
                <p className="mt-1 text-xs uppercase tracking-[0.15em] text-slate-400">Waiting in next-attempt list</p>
              )}

              {/* Quick weight grid */}
              <div className="mx-auto mt-3 grid max-w-lg grid-cols-3 gap-2 sm:grid-cols-5">
                {quickWeights.map((w) => (
                  <button
                    key={`${lifter.id}-${w}`}
                    onClick={() => applyWeight(w)}
                    className="rounded border border-white/20 bg-white/10 py-2 text-2xl hover:bg-white/20 active:bg-white/30 touch-manipulation select-none"
                  >
                    {w}
                  </button>
                ))}
              </div>

              {/* Manual input + + button + Pass */}
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  value={draft}
                  onChange={(e) =>
                    setQuickWeightDraft((prev) => ({ ...prev, [draftKey]: e.target.value }))
                  }
                  placeholder=""
                  className="h-12 w-28 rounded border border-white/20 bg-white/10 px-2 text-center text-2xl text-white"
                />
                <button
                  onClick={() => {
                    const cur = Number(draft || 0);
                    const next = Number.isFinite(cur) && cur > 0 ? cur + 2.5 : baseWeight + 2.5;
                    applyWeight(Number(next.toFixed(1)));
                  }}
                  className="h-12 w-14 rounded border border-white/20 bg-white/10 text-4xl leading-none hover:bg-white/20 touch-manipulation select-none"
                >
                  +
                </button>
                <button
                  onClick={() => {
                    const result = updateAttemptForLifter(lifter.id, queueLift, queueAttemptIndex, "");
                    setActionNotice(result.message);
                  }}
                  className="h-12 rounded border border-white/20 bg-white/10 px-4 font-serif text-4xl leading-none hover:bg-white/20 touch-manipulation select-none"
                >
                  Pass
                </button>
              </div>
              {actionNotice && (
                <p className="mt-2 text-sm text-cyan-300">{actionNotice}</p>
              )}
            </div>
          );
        })}

        {queuedAttemptRows.length === 0 && (
          <p className="text-center text-sm text-slate-400">No pending next attempt declarations.</p>
        )}

        {/* Reset Signals */}
        <div className="flex justify-center pt-4 border-t border-white/10">
          <button
            onClick={() => {
              void resetSignals();
              setActionNotice("Signals reset.");
            }}
            className="h-11 rounded border border-white/20 bg-white/10 px-6 text-white hover:bg-white/20 touch-manipulation"
          >
            Reset Signals
          </button>
        </div>
      </div>
    </div>
  );
};

const DisplayFullPage = () => {
  const {
    lifters,
    currentLifterId,
    setCurrentLifterId,
    refereeSignals,
    resetSignals,
    applyRefereeDecision,
    currentLift,
    currentAttemptIndex,
    competitionStarted,
    includeCollars,
    timerPhase,
    timerEndsAt,
    activeCompetitionGroupName,
    competitionMode,
    groups,
    manualOrderByStage,
    competitions,
    activeCompetitionId,
    switchCompetition,
  } = useAppContext();
  const isBenchOnlyMode = competitionMode === "BENCH_ONLY";
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const requestedCompetitionId = searchParams.get("cid")?.trim() || "";
    if (!requestedCompetitionId || requestedCompetitionId === activeCompetitionId) return;
    if (!competitions.some((competition) => competition.id === requestedCompetitionId)) return;
    switchCompetition(requestedCompetitionId);
  }, [searchParams, activeCompetitionId, competitions, switchCompetition]);
  const rawLayout = searchParams.get("layout") || "signal_results_plate";
  const displayMode =
    rawLayout === "full" || rawLayout === "bar_loading"
      ? "signal_results_plate"
      : rawLayout === "results"
        ? "results_all"
        : rawLayout;
  const forceLive = searchParams.get("live") === "1";
  const displayTheme = parseDisplayThemeFromSearch(searchParams.get("theme")) ?? "black";
  const displayFontScale = parseDisplayScaleFromSearch(searchParams.get("scale"));
  const displayFontKey = parseDisplayFontFromSearch(searchParams.get("font"));
  const [showSignalOverlay, setShowSignalOverlay] = useState(false);
  const [displaySignals, setDisplaySignals] = useState<RefSignal[]>([null, null, null]);
  const [overlayPhase, setOverlayPhase] = useState<"circles" | "lift" | "no-lift" | null>(null);
  const [isFinalVerdictAnimating, setIsFinalVerdictAnimating] = useState(false);
  const prevSignalsRef = useRef<string>("");
  /** Set synchronously when verdict timers start; Supabase may clear rows before `isFinalVerdictAnimating` commits. */
  const verdictPlaybackRef = useRef(false);
  const overlayHideTimeoutRef = useRef<number | null>(null);
  const overlayPhaseTimeoutRef = useRef<number | null>(null);
  const prevLiveRefereeCountRef = useRef(-1);
  const displayVerdictFingerprintRef = useRef<string | null>(null);

  // With Supabase: display records the official verdict (Control only drives platform via DB realtime).
  useEffect(() => {
    if (!isFirebaseConfigured) return;
    if (!refereeSignals.every((signal) => signal !== null)) {
      displayVerdictFingerprintRef.current = null;
      return;
    }
    if (!currentLifterId) return;

    const fingerprint = `${currentLifterId}|${currentLift}|${currentAttemptIndex}|${JSON.stringify(refereeSignals)}`;
    if (displayVerdictFingerprintRef.current === fingerprint) return;

    const timer = window.setTimeout(() => {
      displayVerdictFingerprintRef.current = fingerprint;
      console.log(LOG_DISPLAY, "3/3 signals — applying official verdict", {
        currentLifterId,
        currentLift,
        attempt: currentAttemptIndex + 1,
        signals: refereeSignals,
      });
      void applyRefereeDecision().catch((error) =>
        console.error(LOG_DISPLAY, "verdict apply failed", error),
      );
    }, 240);

    return () => window.clearTimeout(timer);
  }, [refereeSignals, currentLifterId, currentLift, currentAttemptIndex, applyRefereeDecision]);

  const activeTheme = DISPLAY_THEME_CONFIG[displayTheme];
  const isDarkTheme = activeTheme.tone === "dark";
  const displayRootClass = `relative min-h-screen px-3 py-4 md:px-6 ${activeTheme.rootClass}`;
  const displayRootStyle: CSSProperties = useMemo(
    () => ({
      textRendering: "optimizeLegibility",
      WebkitFontSmoothing: "antialiased",
      MozOsxFontSmoothing: "grayscale",
      fontVariantNumeric: "tabular-nums",
      fontFamily: DISPLAY_FONT_FAMILY_CONFIG[displayFontKey],
    }),
    [displayFontKey],
  );

  useEffect(() => {
    const prev = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = `${16 * displayFontScale}px`;
    return () => {
      document.documentElement.style.fontSize = prev;
    };
  }, [displayFontScale]);
  const sortedLifters = useMemo(
    () =>
      [...lifters].sort((a, b) => {
        const lotA = typeof a.lot === "number" ? a.lot : Number.POSITIVE_INFINITY;
        const lotB = typeof b.lot === "number" ? b.lot : Number.POSITIVE_INFINITY;
        if (lotA !== lotB) return lotA - lotB;
        return a.name.localeCompare(b.name);
      }),
    [lifters],
  );
  const currentLifter = lifters.find((l) => l.id === currentLifterId) ?? sortedLifters[0] ?? null;
  const currentWeight = currentLifter ? resolveAttemptWeight(currentLifter, currentLift, currentAttemptIndex) : 20;
  const loadingWeight = currentWeight;
  const receivedSignalCount = displaySignals.filter((signal) => signal !== null).length;
  const liveReceivedSignalCount = refereeSignals.filter((signal) => signal !== null).length;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!timerEndsAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [timerEndsAt]);

  const [clockTime, setClockTime] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setClockTime(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const displayTimerSeconds = timerEndsAt ? Math.max(0, Math.ceil((timerEndsAt - now) / 1000)) : 0;

  const platformTimerChip =
    timerPhase === "ATTEMPT" && timerEndsAt ? (
      <div
        className={`pointer-events-none fixed left-4 bottom-10 z-[45] max-w-[min(96vw,22rem)] rounded-2xl border-2 px-6 py-5 shadow-xl backdrop-blur-md ${
          isDarkTheme
            ? "border-amber-400/40 bg-black/55 text-amber-100"
            : "border-amber-600/35 bg-white/90 text-amber-950"
        }`}
      >
        <p
          className={`text-sm font-semibold uppercase tracking-[0.18em] ${isDarkTheme ? "text-white/70" : "text-slate-600"}`}
        >
          Platform timer
        </p>
        <p
          className={`mt-2 text-[clamp(2rem,6.5vw,3.75rem)] font-black tabular-nums leading-none ${
            isDarkTheme ? "text-amber-300" : "text-amber-800"
          }`}
        >
          {Math.floor(displayTimerSeconds / 60)}:{String(displayTimerSeconds % 60).padStart(2, "0")}
        </p>
      </div>
    ) : null;

  useEffect(() => {
    if (!currentLifterId && currentLifter) {
      setCurrentLifterId(currentLifter.id);
    }
  }, [currentLifterId, currentLifter, setCurrentLifterId]);

  useEffect(() => {
    const count = refereeSignals.filter((s) => s !== null).length;
    if (count === prevLiveRefereeCountRef.current) return;
    prevLiveRefereeCountRef.current = count;
    const slots = { left: refereeSignals[0], center: refereeSignals[1], right: refereeSignals[2] };
    if (count === 1) {
      console.log("[Results screen] Referee signals received: 1 / 3", slots);
    } else if (count === 2) {
      console.log("[Results screen] Referee signals received: 2 / 3", slots);
    } else if (count === 3) {
      console.log("[Results screen] Referee signals received: 3 / 3 (all in)", slots);
    }
  }, [refereeSignals]);

  useEffect(() => {
    const signalsStr = JSON.stringify(refereeSignals);
    if (signalsStr === prevSignalsRef.current) return;
    prevSignalsRef.current = signalsStr;

    const hasAnySignal = refereeSignals.some((signal) => signal !== null);
    const allSignalsReceived = refereeSignals.every((signal) => signal !== null);

    if (!hasAnySignal) {
      // Controller often clears `referee_signals` immediately after all 3 votes (same moment as
      // verdict). Do not tear down verdict timers/phase until `completeAnimation` runs — otherwise
      // the result overlay never appears.
      if (verdictPlaybackRef.current) {
        setShowSignalOverlay(false);
        return undefined;
      }
      // Context cleared (e.g. DB delete / reset) — drop local overlay copy.
      setDisplaySignals([null, null, null]);
      setShowSignalOverlay(false);
      setOverlayPhase(null);
      setIsFinalVerdictAnimating(false);
      if (overlayHideTimeoutRef.current) {
        window.clearTimeout(overlayHideTimeoutRef.current);
        overlayHideTimeoutRef.current = null;
      }
      if (overlayPhaseTimeoutRef.current) {
        window.clearTimeout(overlayPhaseTimeoutRef.current);
        overlayPhaseTimeoutRef.current = null;
      }
      return undefined;
    }

    setDisplaySignals(refereeSignals);

    if (!allSignalsReceived) {
      if (isFinalVerdictAnimating) return undefined;
      setOverlayPhase(null);
      setShowSignalOverlay(true);
    } else {
      verdictPlaybackRef.current = true;
      setIsFinalVerdictAnimating(true);
      setShowSignalOverlay(false);
      /** Same rule as applyRefereeDecision: ≥2 NO → no lift; otherwise good lift (e.g. 2 GOOD + 1 NO). */
      const noVotes = refereeSignals.filter((s) => s === "NO").length;
      const verdictIsGood = noVotes < 2;

      if (overlayPhaseTimeoutRef.current) window.clearTimeout(overlayPhaseTimeoutRef.current);
      if (overlayHideTimeoutRef.current) window.clearTimeout(overlayHideTimeoutRef.current);

      const completeAnimation = async () => {
        verdictPlaybackRef.current = false;
        setOverlayPhase(null);
        setShowSignalOverlay(false);
        setDisplaySignals([null, null, null]);

        // applyRefereeDecision already clears signals when Supabase is on; keep for offline display.
        if (!isFirebaseConfigured) {
          void resetSignals();
        }
        setIsFinalVerdictAnimating(false);
      };

      if (verdictIsGood) {
        setOverlayPhase("circles");
        overlayPhaseTimeoutRef.current = window.setTimeout(() => setOverlayPhase("lift"), 2000);
        overlayHideTimeoutRef.current = window.setTimeout(() => {
          completeAnimation().catch(console.error);
        }, RESULT_OVERLAY_DISPLAY_MS);
      } else {
        setOverlayPhase("no-lift");
        overlayHideTimeoutRef.current = window.setTimeout(() => {
          completeAnimation().catch(console.error);
        }, RESULT_OVERLAY_DISPLAY_MS);
      }
    }
    return undefined;
  }, [refereeSignals, isFinalVerdictAnimating, resetSignals]);

  useEffect(() => {
    return () => {
      if (overlayHideTimeoutRef.current) {
        window.clearTimeout(overlayHideTimeoutRef.current);
      }
      if (overlayPhaseTimeoutRef.current) {
        window.clearTimeout(overlayPhaseTimeoutRef.current);
      }
    };
  }, []);

  const competitionScopedLifters = useMemo(
    () =>
      activeCompetitionGroupName !== null
        ? lifters.filter((l) => isInGroup(l.group, activeCompetitionGroupName))
        : lifters,
    [lifters, activeCompetitionGroupName],
  );

  const rankingSourceLifters = competitionScopedLifters;

  const ranking = useMemo(
    () =>
      [...rankingSourceLifters]
        .filter((l) => !l.disqualified)
        .map((l) => {
          const squat = bestLift(l.squatAttempts);
          const bench = bestLift(l.benchAttempts);
          const deadlift = bestLift(l.deadliftAttempts);
          const isBenchOnlyMode = competitionMode === "BENCH_ONLY";
          const total = isBenchOnlyMode ? bench : squat + bench + deadlift;
          const points = calculateGoodliftPoints(total, l.bodyweight, l.sex, l.isEquipped, competitionMode === "BENCH_ONLY");
          return { ...l, total, points };
        })
        .sort((a, b) => b.points - a.points),
    [rankingSourceLifters, competitionMode],
  );

  const isDualCategory = (category: string) => category.includes(" + ");

  const getDualCategoryParts = (category: string): [string, string] => {
    const idx = category.indexOf(" + ");
    return [category.slice(0, idx).trim(), category.slice(idx + 3).trim()];
  };

  /** Strip trailing kg so we never render "59 KG KG" when weightClass already includes units. */
  const normalizeWeightClassForBoard = (wc: string) => wc.replace(/\s*(kg|KG)\s*$/i, "").trim();

  const getScoreboardClasses = (lifter: RankedLifter): string[] => {
    const category = (lifter.category || "").trim();
    const wcBase = normalizeWeightClassForBoard((lifter.weightClass || "").trim());
    if (!category) {
      return wcBase ? [`Unclassified ${wcBase} KG`] : ["Unclassified"];
    }

    const categories = isDualCategory(category) ? getDualCategoryParts(category) : [category];
    return categories.map((part) => (wcBase ? `${part} ${wcBase} KG` : part));
  };

  const allGroupNames = useMemo(() => {
    const seen = new Set<string>();
    ranking.forEach((lifter) => {
      getScoreboardClasses(lifter).forEach((className) => seen.add(className));
    });
    return Array.from(seen).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [ranking]);

  const rankingByGroup = useMemo(() => {
    return allGroupNames.map((groupName) => {
      const members = ranking.filter((lifter) => getScoreboardClasses(lifter).includes(groupName));
      const sorted = [...members].sort((a, b) => b.points - a.points);
      return { groupName, members: sorted };
    });
  }, [ranking, allGroupNames]);

  const ungroupedRanking = useMemo(
    () => ranking.filter((l) => !l.group),
    [ranking],
  );

  const displaySessionLifters = competitionScopedLifters;

  /** Active lifters only (not yet GOOD/NO on this attempt) — used for “Next” on plates. */
  const activeStageOrdered = useMemo(
    () => orderLiftersForDisplayRound(displaySessionLifters, currentLift, currentAttemptIndex, manualOrderByStage),
    [displaySessionLifters, currentLift, currentAttemptIndex, manualOrderByStage],
  );

  /** Full flight including finished attempts — flight line never drops lifters; only highlight moves. */
  const flightLineOrdered = useMemo(
    () => orderLiftersForFlightLineStrip(displaySessionLifters, currentLift, currentAttemptIndex, manualOrderByStage),
    [displaySessionLifters, currentLift, currentAttemptIndex, manualOrderByStage],
  );

  /** Resolved lifter shown as “current” on this display (same as header / plates — includes fallback when context id is unset). */
  const flightOrderHighlightId = currentLifter?.id ?? currentLifterId ?? null;

  const activeStageIds = useMemo(() => new Set(activeStageOrdered.map((l) => l.id)), [activeStageOrdered]);

  /** Next **active** lifter after current in full flight order (skips completed names in between). */
  const nextLifter = useMemo(() => {
    if (flightLineOrdered.length === 0) return null;
    const curId = flightOrderHighlightId;
    if (!curId) {
      return flightLineOrdered.find((l) => activeStageIds.has(l.id)) ?? null;
    }
    const pos = flightLineOrdered.findIndex((l) => l.id === curId);
    const start = pos >= 0 ? pos + 1 : 0;
    for (let i = start; i < flightLineOrdered.length; i++) {
      if (activeStageIds.has(flightLineOrdered[i].id)) return flightLineOrdered[i];
    }
    return null;
  }, [flightLineOrdered, activeStageIds, flightOrderHighlightId]);

  const nextLoadingWeight =
    nextLifter ? resolveAttemptWeight(nextLifter, currentLift, currentAttemptIndex) : null;

  /** Scroll horizontal lifting-order strips so the active lifter stays visually centered (manual scrollLeft — scrollIntoView is flaky in flex + overflow). */
  useLayoutEffect(() => {
    if (!flightOrderHighlightId || flightLineOrdered.length <= 1) return;
    const idAttr =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(flightOrderHighlightId)
        : flightOrderHighlightId;
    let alive = true;
    const run = () => {
      if (!alive) return;
      const nodes = document.querySelectorAll<HTMLElement>(`[data-display-order-lifter="${idAttr}"]`);
      nodes.forEach((node) => centerLifterOrderNodeInScrollParent(node));
    };
    const raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!alive) return;
        run();
        window.setTimeout(() => {
          if (alive) run();
        }, 120);
      });
    });
    return () => {
      alive = false;
      cancelAnimationFrame(raf1);
    };
  }, [flightOrderHighlightId, flightLineOrdered, displayMode, currentLift, currentAttemptIndex]);

  /** Pipe-separated flight order — shown between two plate diagrams on Signal+Results+Plate; not on Order Attempts layout. */
  const showResultsInlineLiftingOrder = displayMode !== "order_attempts" && flightLineOrdered.length > 0;
  const resultsInlineLiftingOrderRow = showResultsInlineLiftingOrder ? (
    <div
      className={`shrink-0 overflow-x-auto rounded-xl border px-3 py-2 ${
        isDarkTheme ? "border-white/15 bg-black/35" : "border-slate-200 bg-slate-50"
      }`}
    >
      <p
        className={`whitespace-nowrap pl-[max(0.5rem,calc(50%-6rem))] pr-[max(0.5rem,calc(50%-6rem))] text-sm font-black uppercase leading-relaxed tracking-wide ${
          isDarkTheme ? "text-cyan-100" : "text-cyan-950"
        }`}
      >
        {flightLineOrdered.map((lifter, idx) => {
          const w = getAttemptValue(lifter, currentLift, currentAttemptIndex);
          const { first, last } = splitLifterNameParts(lifter.name || "");
          const namePart = last ? `${first} ${last}` : first;
          const isCurrent = flightOrderHighlightId !== null && lifter.id === flightOrderHighlightId;
          const segmentHighlight =
            isCurrent &&
            (isDarkTheme
              ? "border-2 border-cyan-300 bg-cyan-500/35 shadow-[0_0_20px_rgba(34,211,238,0.35)] ring-2 ring-cyan-300/70"
              : "border-2 border-cyan-500 bg-amber-50 shadow-md ring-2 ring-cyan-400/60");
          return (
            <span key={`results-order-inline-${lifter.id}`} className="inline-block scroll-m-1">
              {idx > 0 ? (
                <span className={`mx-1.5 sm:mx-2.5 ${isDarkTheme ? "text-slate-500" : "text-slate-400"}`}>|</span>
              ) : null}
              <span
                data-display-order-lifter={lifter.id}
                className={`inline-block rounded-md px-2 py-0.5 align-baseline transition-colors ${segmentHighlight || ""}`}
              >
                <span className={`tabular-nums ${isDarkTheme ? "text-cyan-300" : "text-cyan-800"}`}>#{idx + 1}</span>{" "}
                <span className={!isDarkTheme ? "text-slate-900" : undefined}>{namePart.toUpperCase()}</span>{" "}
                <span className={isDarkTheme ? "text-slate-500" : isCurrent ? "text-slate-500" : "text-slate-400"}>*</span>{" "}
                <span
                  className={`tabular-nums ${isDarkTheme ? "text-amber-200" : isCurrent ? "text-amber-700" : "text-amber-700"}`}
                >
                  {w === null ? "—" : `${w.toFixed(1)} KG`}
                </span>
              </span>
            </span>
          );
        })}
      </p>
    </div>
  ) : null;

  if (displayMode === "ipf_plate") {
    const curPlates = buildPlateBreakdown(loadingWeight, includeCollars);
    const nxtPlates = nextLoadingWeight !== null ? buildPlateBreakdown(nextLoadingWeight, includeCollars) : [];
    const curPerSideTotal = curPlates.reduce((s, p) => s + p, 0) + (includeCollars ? COLLAR_PAIR_KG / 2 : 0);
    const nxtPerSideTotal = nxtPlates.reduce((s, p) => s + p, 0) + (includeCollars ? COLLAR_PAIR_KG / 2 : 0);

    const renderIPFBarbell = (plates: number[], ic: boolean) => {
      const left = [...plates].reverse();
      const right = plates;
      const renderPl = (plate: number, idx: number, side: "l" | "r") => {
        const col = PLATE_COLORS[String(plate)] || "#64748b";
        const h = PLATE_HEIGHT[String(plate)] ?? 80;
        const w = PLATE_WIDTH[String(plate)] ?? 16;
        const dark = plate === 15 || plate === 5;
        return (
          <div
            key={`${side}-${idx}`}
            className="relative flex items-start justify-center rounded-sm"
            style={{ width: `${w + 6}px`, height: `${h}px`, backgroundColor: col, border: "1.5px solid rgba(0,0,0,0.55)", boxShadow: "inset 0 0 10px rgba(255,255,255,0.22)" }}
          >
            <span className={`pt-0.5 text-[10px] font-black leading-none ${dark ? "text-black" : "text-white"}`}>{plate}</span>
          </div>
        );
      };
      const collar = (k: string) => (
        <div key={k} className="flex h-[70px] w-[13px] items-center justify-center rounded-sm bg-slate-500" style={{ border: "1px solid rgba(0,0,0,0.4)", boxShadow: "inset 0 0 8px rgba(255,255,255,0.3)" }} />
      );
      return (
        <div className="flex items-center justify-center w-full">
          <div className="flex items-end gap-[2px]">
            {ic && collar("cl")}
            {left.map((p, i) => renderPl(p, i, "l"))}
          </div>
          <div className="relative h-[18px] w-[140px] shrink-0 rounded-full bg-gradient-to-r from-slate-700 via-slate-400 to-slate-700" style={{ boxShadow: "0 2px 10px rgba(0,0,0,0.7)" }}>
            <div className="absolute right-0 top-1/2 h-7 w-3 -translate-y-1/2 rounded bg-slate-400" />
            <div className="absolute left-0 top-1/2 h-7 w-3 -translate-y-1/2 rounded bg-slate-400" />
          </div>
          <div className="flex items-end gap-[2px]">
            {right.map((p, i) => renderPl(p, i, "r"))}
            {ic && collar("cr")}
          </div>
        </div>
      );
    };

    const renderPlateText = (plates: number[]) => {
      if (plates.length === 0) return <span className="text-slate-500 text-xl font-semibold">bar only</span>;
      return (
        <div className="flex items-center justify-center gap-2 flex-wrap">
          {plates.map((plate, i) => {
            const raw = PLATE_COLORS[String(plate)] || "#94a3b8";
            const displayCol = raw === "#111827" ? "#9ca3af" : raw;
            return (
              <span key={i} className="inline-flex items-center gap-2">
                {i > 0 && <span className="text-white font-bold" style={{ fontSize: "clamp(1rem,2.5vw,1.75rem)" }}>+</span>}
                <span className="font-black tabular-nums" style={{ color: displayCol, fontSize: "clamp(1rem,2.5vw,1.75rem)" }}>{plate}</span>
              </span>
            );
          })}
        </div>
      );
    };

    const upcomingRow = flightLineOrdered.slice(0, 10);

    return (
      <div
        className="w-full overflow-hidden flex flex-col text-white"
        style={{ ...displayRootStyle, height: "100vh", background: "#0a0a0a" }}
      >
        {!competitionStarted && !forceLive && (
          <div className="shrink-0 bg-amber-500/20 border-b border-amber-400/30 px-4 py-1 text-center">
            <span className="text-xs font-semibold uppercase tracking-widest text-amber-300">Preview mode — competition not started</span>
          </div>
        )}

        {/* ── HEADER ── */}
        <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-2 border-b border-slate-700/70" style={{ background: "#111111" }}>
          <div className="shrink-0 w-[190px]">
            <p className="text-[clamp(0.7rem,1.4vw,1rem)] font-black uppercase leading-tight text-white tracking-wide">POWERLIFTING<br />COMPETITION</p>
            <p className="text-[9px] font-semibold uppercase tracking-[0.25em] text-cyan-400 mt-0.5">DESIGN BY SUMIT BHANJA</p>
          </div>
          <div className="flex-1 text-center min-w-0">
            <p className="text-[9px] font-semibold uppercase tracking-[0.35em] text-cyan-400">CURRENT LIFTER</p>
            <p className="font-black uppercase leading-none truncate" style={{ fontSize: "clamp(1.6rem,5vw,3.2rem)" }}>{currentLifter?.name || "NO LIFTER"}</p>
          </div>
          <div className="shrink-0 flex items-stretch gap-2 w-[380px] justify-end">
            <div className="flex flex-col items-center justify-center px-3 py-1 border border-slate-600 rounded">
              <p className="text-[8px] font-semibold uppercase tracking-[0.25em] text-slate-400">GROUP</p>
              <p className="text-sm font-black text-white">{activeCompetitionGroupName || "—"}</p>
            </div>
            <div className="flex flex-col items-center justify-center px-3 py-1 rounded border border-cyan-500/60" style={{ background: "rgba(6,182,212,0.08)" }}>
              <p className="text-[8px] font-semibold uppercase tracking-[0.2em] text-cyan-400 flex items-center gap-1">⏱ PLATFORM TIMER</p>
              <p className="text-base font-black tabular-nums text-cyan-300 leading-none">
                {timerPhase === "ATTEMPT" && timerEndsAt
                  ? `${String(Math.floor(displayTimerSeconds / 60)).padStart(2, "0")}:${String(displayTimerSeconds % 60).padStart(2, "0")}`
                  : "00:00"}
              </p>
            </div>
            <div className="flex flex-col items-center justify-center px-3 py-1 border border-cyan-400/80 rounded">
              <p className="text-[8px] font-semibold uppercase tracking-[0.25em] text-slate-400">MODE</p>
              <p className="text-sm font-black text-cyan-300">{competitionMode === "BENCH_ONLY" ? "BENCH ONLY" : "FULL MEET"}</p>
            </div>
          </div>
        </div>

        {/* ── INFO ROW ── */}
        <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-2 border-b border-slate-700/60" style={{ background: "#0f0f0f" }}>
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-8 h-8 rounded flex items-center justify-center text-lg bg-slate-700 shrink-0">🏋️</div>
            <div>
              <p className="text-[8px] font-semibold uppercase tracking-[0.25em] text-slate-400">LIFT</p>
              <p className="font-black uppercase text-white leading-none" style={{ fontSize: "clamp(0.75rem,1.8vw,1.1rem)" }}>{currentLift.toUpperCase()}</p>
            </div>
          </div>
          <div className="text-center shrink-0">
            <p className="text-[8px] font-semibold uppercase tracking-[0.25em] text-slate-400">ATTEMPT</p>
            <p className="font-black text-white tabular-nums" style={{ fontSize: "clamp(1.1rem,2.5vw,1.8rem)" }}>{currentAttemptIndex + 1}</p>
          </div>
          <div className="text-center">
            <p className="text-[8px] font-semibold uppercase tracking-[0.25em] text-slate-400">WEIGHT</p>
            <p className="font-black tabular-nums text-white leading-none" style={{ fontSize: "clamp(1.4rem,3.5vw,2.4rem)" }}>
              {loadingWeight.toFixed(1)} <span style={{ fontSize: "clamp(0.9rem,2vw,1.4rem)" }}>KG</span>
            </p>
          </div>
          <div className="text-center shrink-0">
            <p className="text-[8px] font-semibold uppercase tracking-[0.25em] text-slate-400">BODYWEIGHT</p>
            <p className="font-black tabular-nums text-white" style={{ fontSize: "clamp(0.85rem,2vw,1.3rem)" }}>
              {typeof currentLifter?.bodyweight === "number" ? `${currentLifter.bodyweight.toFixed(1)} KG` : "—"}
            </p>
          </div>
          <div className="text-center shrink-0">
            <p className="text-[8px] font-semibold uppercase tracking-[0.25em] text-slate-400">LOT NUMBER</p>
            <p className="font-black text-white" style={{ fontSize: "clamp(0.85rem,2vw,1.3rem)" }}>{currentLifter?.lot || "—"}</p>
          </div>
        </div>

        {/* ── MAIN PANEL (Current + Plate Change + Next Bar Loading) ── */}
        <div className="flex flex-1 gap-3 px-3 py-3 min-h-0">
          {/* Current */}
          <div className="flex-1 flex flex-col rounded-lg overflow-hidden min-w-0" style={{ border: "2px solid rgba(34,197,94,0.6)", background: "#0d0d0d" }}>
            <div className="shrink-0 px-3 py-2 text-center border-b" style={{ borderColor: "rgba(34,197,94,0.35)", background: "rgba(34,197,94,0.1)" }}>
              <p className="text-[clamp(0.6rem,1.3vw,0.85rem)] font-black uppercase tracking-[0.22em] text-green-400">CURRENT BAR LOADING</p>
              <p className="text-[9px] font-semibold text-slate-400 truncate mt-0.5">{currentLifter?.name || "—"}</p>
            </div>
            <div className="flex-1 flex flex-col items-center justify-between px-3 py-2 min-h-0">
              <div className="text-center shrink-0">
                <p className="font-black tabular-nums text-green-400 leading-none" style={{ fontSize: "clamp(1.6rem,4.5vw,3rem)" }}>{loadingWeight.toFixed(1)} KG</p>
                <p className="text-[10px] text-slate-400 mt-0.5">({includeCollars ? "With Collar" : "Without Collar"})</p>
              </div>
              <div className="flex-1 flex items-center justify-center w-full py-1 min-h-0 overflow-hidden">
                {renderIPFBarbell(curPlates, includeCollars)}
              </div>
              <div className="text-center w-full shrink-0">
                {renderPlateText(curPlates)}
                <p className="text-[8px] font-semibold uppercase tracking-[0.3em] text-slate-400 mt-1">TOTAL PER SIDE</p>
                <p className="font-black tabular-nums text-green-400 leading-none" style={{ fontSize: "clamp(1rem,2.8vw,1.8rem)" }}>{formatKg(curPerSideTotal)} KG</p>
              </div>
            </div>
            <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-t border-slate-700/60">
              <span className="text-[9px] font-semibold uppercase tracking-widest text-slate-400">COLLAR</span>
              <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${includeCollars ? "bg-cyan-500 text-black" : "bg-slate-600 text-slate-300"}`}>
                {includeCollars ? "ON" : "OFF"}
              </span>
              {includeCollars && <span className="text-[9px] text-slate-400">| COLLAR WEIGHT: 2.5 KG PER SIDE</span>}
            </div>
          </div>

          {/* ── PLATE CHANGE INSTRUCTIONS ── */}
          {(() => {
            const GREEN = "#39ff14";
            const RED = "#ff3b30";

            if (!nextLifter || nextLoadingWeight === null) {
              return (
                <div
                  className="w-[220px] shrink-0 flex flex-col rounded-2xl overflow-hidden"
                  style={{ border: `2px solid #334155`, background: "#0a0a0a" }}
                >
                  <div className="px-3 pt-4 pb-2 text-center">
                    <p className="font-black uppercase leading-tight" style={{ fontSize: "clamp(0.85rem,1.6vw,1.1rem)", color: "#334155" }}>PLATE CHANGE</p>
                    <p className="font-black uppercase text-slate-600" style={{ fontSize: "clamp(0.75rem,1.3vw,0.9rem)" }}>INSTRUCTIONS</p>
                  </div>
                  <div className="flex-1 flex items-center justify-center px-4 py-6">
                    <p className="text-slate-600 text-sm font-black uppercase text-center tracking-widest">NO NEXT<br />LIFTER</p>
                  </div>
                  <div className="border-t border-slate-800 px-3 py-2 flex items-center gap-2">
                    <span className="text-slate-600 text-sm">ℹ</span>
                    <p className="text-[9px] font-black uppercase tracking-wider text-slate-600">MAKE SURE COLLARS ARE TIGHT</p>
                  </div>
                </div>
              );
            }

            const { toRemove, toAdd } = computePlateChanges(curPlates, nxtPlates);
            const noChange = toRemove.length === 0 && toAdd.length === 0;

            const renderStep = (plates: number[], isAdd: boolean) => {
              const color = isAdd ? GREEN : RED;
              const symbol = isAdd ? "+" : "−";
              return plates.map((plate, i) => (
                <div key={`${isAdd ? "add" : "rem"}-${i}`} className="flex flex-col items-center w-full">
                  {/* Circle icon + weight */}
                  <div className="flex items-center justify-center gap-2 mt-3">
                    <div
                      className="flex items-center justify-center rounded-full shrink-0"
                      style={{
                        width: "clamp(36px,5vw,52px)",
                        height: "clamp(36px,5vw,52px)",
                        border: `3px solid ${color}`,
                        color,
                        fontSize: "clamp(1.1rem,2.2vw,1.6rem)",
                        fontWeight: 900,
                        lineHeight: 1,
                      }}
                    >
                      {symbol}
                    </div>
                    <p
                      className="font-black tabular-nums leading-none"
                      style={{ color, fontSize: "clamp(1.4rem,3.5vw,2.4rem)" }}
                    >
                      {symbol}{plate} <span style={{ fontSize: "clamp(0.7rem,1.5vw,1rem)", color: "#ffffff" }}>KG</span>
                    </p>
                  </div>
                  {/* Instruction text */}
                  <div className="mt-2 text-center">
                    <p className="font-black uppercase leading-tight" style={{ fontSize: "clamp(0.7rem,1.4vw,0.95rem)", color }}>
                      {isAdd ? "ADD" : "REMOVE"} {plate} KG PLATES
                    </p>
                    <p className="font-black uppercase text-white leading-tight" style={{ fontSize: "clamp(0.7rem,1.4vw,0.95rem)" }}>
                      TO BOTH SIDES
                    </p>
                  </div>
                  {i < plates.length - 1 && <div className="w-full mt-3 border-t" style={{ borderColor: "rgba(255,255,255,0.08)" }} />}
                </div>
              ));
            };

            return (
              <div
                className="w-[220px] shrink-0 flex flex-col rounded-2xl overflow-hidden"
                style={{ border: `2px solid ${noChange ? "#22c55e" : (toRemove.length > 0 && toAdd.length > 0 ? "#f59e0b" : toAdd.length > 0 ? GREEN : RED)}`, background: "#0a0a0a" }}
              >
                {/* Header */}
                <div className="px-3 pt-4 pb-1 text-center">
                  <p className="font-black uppercase leading-tight" style={{ fontSize: "clamp(0.85rem,1.6vw,1.15rem)", color: GREEN }}>
                    PLATE CHANGE
                  </p>
                  <p className="font-black uppercase text-white leading-tight" style={{ fontSize: "clamp(0.8rem,1.4vw,1rem)" }}>
                    INSTRUCTIONS
                  </p>
                </div>

                {/* Body */}
                <div className="flex-1 flex flex-col items-center justify-center px-4 pb-3 min-h-0">
                  {noChange ? (
                    <div className="flex flex-col items-center gap-2 py-4">
                      <div
                        className="flex items-center justify-center rounded-full"
                        style={{ width: "52px", height: "52px", border: `3px solid ${GREEN}`, color: GREEN, fontSize: "1.8rem", fontWeight: 900 }}
                      >
                        ✓
                      </div>
                      <p className="font-black uppercase text-center mt-1" style={{ fontSize: "clamp(0.75rem,1.4vw,0.95rem)", color: GREEN }}>
                        NO CHANGE
                      </p>
                      <p className="font-black uppercase text-white text-center" style={{ fontSize: "clamp(0.7rem,1.3vw,0.88rem)" }}>
                        SAME LOADING
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center w-full">
                      {toRemove.length > 0 && renderStep(toRemove, false)}
                      {toRemove.length > 0 && toAdd.length > 0 && (
                        <div className="w-full mt-3 border-t" style={{ borderColor: "rgba(255,255,255,0.12)" }} />
                      )}
                      {toAdd.length > 0 && renderStep(toAdd, true)}
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div className="border-t px-3 py-2 flex items-center gap-2" style={{ borderColor: "rgba(255,255,255,0.1)" }}>
                  <span style={{ color: GREEN, fontSize: "0.85rem", fontWeight: 900 }}>ℹ</span>
                  <p className="text-[8px] font-black uppercase tracking-wider text-white">MAKE SURE COLLARS ARE TIGHT</p>
                </div>
              </div>
            );
          })()}

          {/* Next */}
          <div className="flex-1 flex flex-col rounded-lg overflow-hidden min-w-0" style={{ border: "2px solid rgba(6,182,212,0.6)", background: "#0d0d0d" }}>
            <div className="shrink-0 px-3 py-2 text-center border-b" style={{ borderColor: "rgba(6,182,212,0.35)", background: "rgba(6,182,212,0.08)" }}>
              <p className="text-[clamp(0.6rem,1.3vw,0.85rem)] font-black uppercase tracking-[0.22em] text-cyan-400">NEXT BAR LOADING</p>
              <p className="text-[9px] font-semibold text-slate-400 truncate mt-0.5">{nextLifter?.name || "—"}</p>
            </div>
            {nextLifter && nextLoadingWeight !== null ? (
              <>
                <div className="flex-1 flex flex-col items-center justify-between px-3 py-2 min-h-0">
                  <div className="text-center shrink-0">
                    <p className="font-black tabular-nums text-cyan-400 leading-none" style={{ fontSize: "clamp(1.6rem,4.5vw,3rem)" }}>{nextLoadingWeight.toFixed(1)} KG</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">({includeCollars ? "With Collar" : "Without Collar"})</p>
                  </div>
                  <div className="flex-1 flex items-center justify-center w-full py-1 min-h-0 overflow-hidden">
                    {renderIPFBarbell(nxtPlates, includeCollars)}
                  </div>
                  <div className="text-center w-full shrink-0">
                    {renderPlateText(nxtPlates)}
                    <p className="text-[8px] font-semibold uppercase tracking-[0.3em] text-slate-400 mt-1">TOTAL PER SIDE</p>
                    <p className="font-black tabular-nums text-cyan-400 leading-none" style={{ fontSize: "clamp(1rem,2.8vw,1.8rem)" }}>{formatKg(nxtPerSideTotal)} KG</p>
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-t border-slate-700/60">
                  <span className="text-[9px] font-semibold uppercase tracking-widest text-slate-400">COLLAR</span>
                  <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${includeCollars ? "bg-cyan-500 text-black" : "bg-slate-600 text-slate-300"}`}>
                    {includeCollars ? "ON" : "OFF"}
                  </span>
                  {includeCollars && <span className="text-[9px] text-slate-400">| COLLAR WEIGHT: 2.5 KG PER SIDE</span>}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-slate-500 text-sm font-semibold uppercase tracking-wide">No next lifter</p>
              </div>
            )}
          </div>
        </div>

        {/* ── UPCOMING LIFTERS ── */}
        <div className="shrink-0 flex border-t border-slate-700" style={{ height: "86px", background: "#0d0d0d" }}>
          <div className="flex items-center justify-center px-2 border-r border-slate-700 shrink-0 w-[52px]">
            <p className="text-[8px] font-black uppercase text-cyan-400 tracking-[0.25em] text-center leading-snug" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
              UPCOMING{"\n"}LIFTERS
            </p>
          </div>
          <div className="flex-1 flex overflow-x-auto overflow-y-hidden">
            {upcomingRow.map((lifter, idx) => {
              const w = getAttemptValue(lifter, currentLift, currentAttemptIndex);
              const isCur = lifter.id === flightOrderHighlightId;
              return (
                <div
                  key={lifter.id}
                  data-display-order-lifter={lifter.id}
                  className={`flex flex-col items-center justify-center px-2 shrink-0 border-r border-slate-700/50 text-center transition-colors ${
                    isCur ? "bg-green-500/12" : ""
                  }`}
                  style={{
                    minWidth: "80px",
                    borderLeft: isCur ? "2px solid #22c55e" : undefined,
                  }}
                >
                  <p className={`text-base font-black tabular-nums leading-none ${isCur ? "text-green-400" : "text-slate-400"}`}>{idx + 1}</p>
                  <p className={`text-[10px] font-bold uppercase leading-tight truncate w-full mt-0.5 ${isCur ? "text-white" : "text-slate-300"}`}>{lifter.name}</p>
                  <p className={`text-[10px] font-bold tabular-nums ${isCur ? "text-green-300" : "text-slate-400"}`}>
                    {w !== null ? `${w.toFixed(1)} KG` : "—"}
                  </p>
                  <p className="text-[8px] text-slate-500 font-semibold">{lifter.lot || "—"}</p>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  if (displayMode === "bar_loading_tables") {
    const curPlates = buildPlateBreakdown(loadingWeight, includeCollars);
    const nxtPlates = nextLoadingWeight !== null ? buildPlateBreakdown(nextLoadingWeight, includeCollars) : [];
    const curPerSideTotal = curPlates.reduce((s: number, p: number) => s + p, 0) + (includeCollars ? COLLAR_PAIR_KG / 2 : 0);
    const nxtPerSideTotal = nxtPlates.reduce((s: number, p: number) => s + p, 0) + (includeCollars ? COLLAR_PAIR_KG / 2 : 0);
    const { toRemove, toAdd } = computePlateChanges(curPlates, nxtPlates);
    const noPlateChange = toRemove.length === 0 && toAdd.length === 0;
    const weightDelta = nextLoadingWeight !== null ? nextLoadingWeight - loadingWeight : null;
    const T07_GREEN = "#39ff14";
    const T07_RED = "#ff3b30";
    const clockStr = clockTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });

    const renderT07Barbell = (plates: number[], ic: boolean) => {
      const SCALE = 0.42;
      const left = [...plates].reverse();
      const right = plates;
      const renderPl = (plate: number, idx: number, side: "l" | "r") => {
        const col = PLATE_COLORS[String(plate)] || "#64748b";
        const h = Math.round((PLATE_HEIGHT[String(plate)] ?? 80) * SCALE);
        const w = Math.round((PLATE_WIDTH[String(plate)] ?? 16) * SCALE);
        const dark = plate === 15 || plate === 5;
        return (
          <div key={`${side}-${idx}`} className="relative flex items-start justify-center rounded-sm"
            style={{ width: `${w + 3}px`, height: `${h}px`, backgroundColor: col, border: "1px solid rgba(0,0,0,0.5)", boxShadow: "inset 0 0 5px rgba(255,255,255,0.15)" }}>
            <span className={`pt-0.5 font-black leading-none ${dark ? "text-black" : "text-white"}`} style={{ fontSize: "6px" }}>{plate}</span>
          </div>
        );
      };
      const collar = (k: string) => (
        <div key={k} className="flex items-center justify-center rounded-sm bg-slate-500"
          style={{ height: "28px", width: "5px", border: "1px solid rgba(0,0,0,0.4)" }} />
      );
      return (
        <div className="flex items-center justify-center w-full">
          <div className="flex items-end gap-[1px]">
            {ic && collar("cl")}
            {left.map((p, i) => renderPl(p, i, "l"))}
          </div>
          <div className="relative shrink-0 rounded-full bg-gradient-to-r from-slate-700 via-slate-400 to-slate-700"
            style={{ height: "7px", width: "70px", boxShadow: "0 1px 6px rgba(0,0,0,0.6)" }}>
            <div className="absolute right-0 top-1/2 rounded bg-slate-400" style={{ height: "11px", width: "5px", transform: "translateY(-50%)" }} />
            <div className="absolute left-0 top-1/2 rounded bg-slate-400" style={{ height: "11px", width: "5px", transform: "translateY(-50%)" }} />
          </div>
          <div className="flex items-end gap-[1px]">
            {right.map((p, i) => renderPl(p, i, "r"))}
            {ic && collar("cr")}
          </div>
        </div>
      );
    };

    const renderIPFOrderBadges = (plates: number[], ic: boolean) => {
      const uniquePlates = [...new Set(plates)].slice(0, ic ? 3 : 4);
      const ordinal = (n: number) => ["1ST","2ND","3RD","4TH"][n - 1] ?? `${n}TH`;
      return (
        <div className="flex items-center justify-center gap-0.5 flex-wrap">
          {uniquePlates.map((p, i) => {
            const col = PLATE_COLORS[String(p)] || "#64748b";
            const displayCol = col === "#111827" ? "#374151" : col;
            const dark = p === 15 || p === 5;
            return (
              <div key={i} className="flex items-center gap-0.5">
                {i > 0 && <span className="text-slate-500 font-bold" style={{ fontSize: "9px" }}>›</span>}
                <div className="flex flex-col items-center">
                  <div className="rounded px-1 py-0.5 text-center font-black flex flex-col items-center"
                    style={{ backgroundColor: displayCol, color: dark ? "#000" : "#fff", minWidth: "24px", fontSize: "8px", lineHeight: 1.1 }}>
                    <span>{p}</span><span style={{ fontSize: "6px" }}>KG</span>
                  </div>
                  <span className="text-slate-500 mt-0.5" style={{ fontSize: "6px" }}>{ordinal(i + 1)}</span>
                </div>
              </div>
            );
          })}
          {ic && (
            <div className="flex items-center gap-0.5">
              <span className="text-slate-500 font-bold" style={{ fontSize: "9px" }}>›</span>
              <div className="flex flex-col items-center">
                <div className="rounded px-1 py-0.5 text-center font-black bg-slate-600 text-white flex items-center justify-center"
                  style={{ minWidth: "24px", fontSize: "10px", height: "24px" }}>🔒</div>
                <span className="text-slate-500 mt-0.5" style={{ fontSize: "6px" }}>COLLAR</span>
              </div>
            </div>
          )}
        </div>
      );
    };

    const renderPerSideCalc = (plates: number[], ic: boolean, color: string) => {
      const total = plates.reduce((s, p) => s + p, 0) + (ic ? 2.5 : 0);
      if (plates.length === 0 && !ic) return <span style={{ color: "#6b7280", fontSize: "10px", fontWeight: 900 }}>bar only</span>;
      return (
        <div className="flex items-center justify-center flex-wrap" style={{ fontSize: "10px", gap: "2px" }}>
          {plates.map((p, i) => (
            <span key={i} style={{ color, fontWeight: 900 }}>
              {i > 0 && <span style={{ color: "#6b7280", margin: "0 1px" }}>+</span>}
              {p}
            </span>
          ))}
          {ic && <><span style={{ color: "#6b7280", margin: "0 1px" }}>+</span><span style={{ color, fontWeight: 900 }}>2.5</span></>}
          <span style={{ color: "#6b7280", margin: "0 2px" }}>=</span>
          <span style={{ color, fontWeight: 900 }}>{formatKg(total)} KG</span>
        </div>
      );
    };

    const tableLifters = flightLineOrdered.slice(0, 8);
    const upcomingLifters = activeStageOrdered.filter(l => l.id !== currentLifterId).slice(0, 8);

    const attOrdinal = (i: number) => ["1ST","2ND","3RD"][i] ?? `${i+1}TH`;

    return (
      <div className="w-full overflow-hidden flex flex-col text-white select-none"
        style={{ ...displayRootStyle, height: "100vh", background: "#080810", fontFamily: "'Arial Narrow', 'Arial', sans-serif" }}>

        {!competitionStarted && !forceLive && (
          <div className="shrink-0 border-b border-amber-400/30 px-4 py-1 text-center" style={{ background: "rgba(245,158,11,0.12)" }}>
            <span className="font-semibold uppercase tracking-widest text-amber-300" style={{ fontSize: "11px" }}>Preview mode — competition not started</span>
          </div>
        )}

        {/* ── TOP HEADER ── */}
        <div className="shrink-0 flex items-center justify-between px-5 py-2 border-b border-slate-700/60" style={{ background: "#06060e", minHeight: "50px" }}>
          <div style={{ width: "120px" }} />
          <div className="flex-1 text-center">
            <p className="font-semibold uppercase text-slate-400" style={{ fontSize: "9px", letterSpacing: "0.35em" }}>EVENT</p>
            <p className="font-black uppercase leading-tight text-white" style={{ fontSize: "clamp(1.1rem,2.8vw,2rem)", letterSpacing: "0.03em" }}>
              {competitions.find(c => c.id === activeCompetitionId)?.name || "COMPETITION"}
              {activeCompetitionGroupName ? <span style={{ color: "#94a3b8" }}> — {activeCompetitionGroupName}</span> : ""}
            </p>
          </div>
          <div className="text-right shrink-0" style={{ minWidth: "120px" }}>
            <p className="font-semibold uppercase text-slate-400" style={{ fontSize: "9px", letterSpacing: "0.35em" }}>TIME</p>
            <p className="font-black tabular-nums text-white" style={{ fontSize: "clamp(1rem,2.2vw,1.5rem)" }}>{clockStr}</p>
          </div>
        </div>

        {/* ── BAR LOADING PANELS (top ~44%) ── */}
        <div className="shrink-0 flex border-b border-slate-700/50" style={{ height: "44%", minHeight: "220px", maxHeight: "370px" }}>

          {/* LEFT: CURRENT BAR LOADING */}
          <div className="flex-1 flex flex-col min-w-0 border-r border-slate-700/40" style={{ background: "linear-gradient(180deg,#0d150d,#090909)" }}>
            <div className="shrink-0 text-center py-1.5 border-b border-red-900/40" style={{ background: "rgba(220,38,38,0.07)" }}>
              <p className="font-black uppercase tracking-[0.22em] text-red-400" style={{ fontSize: "clamp(0.5rem,1vw,0.7rem)" }}>CURRENT BAR LOADING</p>
            </div>
            <div className="flex-1 flex flex-col items-center justify-between px-2 py-1.5 min-h-0 overflow-hidden">
              <div className="text-center shrink-0 leading-none">
                <span className="font-black tabular-nums" style={{ fontSize: "clamp(2rem,5.5vw,4rem)", color: "#ffffff" }}>{loadingWeight.toFixed(1)}</span>
                <span className="font-black text-slate-400 ml-1" style={{ fontSize: "clamp(0.85rem,2vw,1.6rem)" }}>KG</span>
              </div>
              <div className="flex-1 flex items-center justify-center w-full min-h-0 overflow-hidden py-1">
                {renderT07Barbell(curPlates, includeCollars)}
              </div>
              <div className="shrink-0 w-full text-center">
                <p className="font-semibold uppercase text-amber-400 mb-1" style={{ fontSize: "6px", letterSpacing: "0.2em" }}>EACH SIDE (IPF LOADING ORDER)</p>
                {renderIPFOrderBadges(curPlates, includeCollars)}
              </div>
              <div className="shrink-0 mt-1 text-center">
                <p className="text-slate-500 mb-0.5" style={{ fontSize: "6px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.18em" }}>PER SIDE CALCULATION</p>
                {renderPerSideCalc(curPlates, includeCollars, "#f87171")}
              </div>
              <div className="shrink-0 w-full grid grid-cols-3 text-center border-t border-slate-700/40 mt-1 pt-1">
                {[
                  { label: "PER SIDE TOTAL", val: `${formatKg(curPerSideTotal)} KG`, color: "#f87171" },
                  { label: "BAR WEIGHT", val: `${BAR_WEIGHT_KG}.0 KG`, color: "#94a3b8" },
                  { label: "TOTAL WEIGHT", val: `${loadingWeight.toFixed(1)} KG`, color: "#f87171" },
                ].map(({ label, val, color }) => (
                  <div key={label}>
                    <p className="text-slate-500 font-semibold uppercase" style={{ fontSize: "5.5px", letterSpacing: "0.12em" }}>{label}</p>
                    <p className="font-black tabular-nums" style={{ fontSize: "clamp(0.6rem,1.3vw,0.85rem)", color }}>{val}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* CENTER: PLATE CHANGE INSTRUCTIONS */}
          <div className="shrink-0 flex flex-col border-r border-slate-700/40" style={{ width: "clamp(160px,20vw,240px)", background: "#080808" }}>
            <div className="shrink-0 text-center py-1.5 border-b border-slate-700/40" style={{ background: "#0a0a0a" }}>
              <p className="font-black uppercase leading-tight" style={{ fontSize: "clamp(0.58rem,1.1vw,0.75rem)", color: T07_GREEN }}>PLATE CHANGE</p>
              <p className="font-bold uppercase text-slate-300" style={{ fontSize: "clamp(0.5rem,0.9vw,0.65rem)" }}>INSTRUCTIONS</p>
            </div>
            <div className="flex-1 flex flex-col items-center justify-center px-3 py-2 min-h-0 gap-2">
              {!nextLifter || nextLoadingWeight === null ? (
                <p className="text-slate-600 font-black uppercase text-center tracking-widest" style={{ fontSize: "11px" }}>NO NEXT<br />LIFTER</p>
              ) : noPlateChange ? (
                <div className="flex flex-col items-center gap-2">
                  <div className="flex items-center justify-center rounded-full" style={{ width: "44px", height: "44px", border: `3px solid ${T07_GREEN}`, color: T07_GREEN, fontSize: "1.4rem", fontWeight: 900 }}>✓</div>
                  <p className="font-black uppercase text-center" style={{ fontSize: "clamp(0.65rem,1.2vw,0.85rem)", color: T07_GREEN }}>NO CHANGE</p>
                  <p className="font-bold uppercase text-slate-400 text-center" style={{ fontSize: "9px" }}>SAME LOADING</p>
                </div>
              ) : (
                <div className="w-full flex flex-col gap-2 items-center">
                  {weightDelta !== null && (
                    <div className="text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <div className="flex items-center justify-center rounded-full" style={{ width: "clamp(28px,4vw,40px)", height: "clamp(28px,4vw,40px)", border: `2.5px solid ${weightDelta >= 0 ? T07_GREEN : T07_RED}`, color: weightDelta >= 0 ? T07_GREEN : T07_RED, fontSize: "clamp(0.9rem,1.8vw,1.3rem)", fontWeight: 900 }}>{weightDelta >= 0 ? "+" : "−"}</div>
                        <span className="font-black tabular-nums" style={{ fontSize: "clamp(1.4rem,3.5vw,2.2rem)", color: weightDelta >= 0 ? T07_GREEN : T07_RED }}>{Math.abs(weightDelta).toFixed(1)}</span>
                        <span className="font-black text-slate-300" style={{ fontSize: "clamp(0.7rem,1.3vw,0.9rem)" }}>KG</span>
                      </div>
                    </div>
                  )}
                  {[...toAdd.reduce((m, p) => { m.set(p, (m.get(p) || 0) + 1); return m; }, new Map<number, number>()).entries()].map(([plate, count]) => {
                    const col = PLATE_COLORS[String(plate)] || "#64748b";
                    const dc = col === "#111827" ? "#374151" : col;
                    return (
                      <div key={`add-${plate}`} className="flex items-center gap-2 w-full">
                        <div className="flex items-center justify-center rounded-sm font-black shrink-0" style={{ width: "24px", height: "24px", backgroundColor: dc, color: plate === 15 || plate === 5 ? "#000" : "#fff", fontSize: "8px" }}>{plate}</div>
                        <div>
                          <p className="font-black uppercase" style={{ fontSize: "clamp(0.58rem,1.1vw,0.75rem)", color: T07_GREEN }}>ADD {plate} KG PLATES × {count * 2}</p>
                          <p className="text-slate-400 font-semibold" style={{ fontSize: "7.5px" }}>{count} per side</p>
                        </div>
                      </div>
                    );
                  })}
                  {[...toRemove.reduce((m, p) => { m.set(p, (m.get(p) || 0) + 1); return m; }, new Map<number, number>()).entries()].map(([plate, count]) => {
                    const col = PLATE_COLORS[String(plate)] || "#64748b";
                    const dc = col === "#111827" ? "#374151" : col;
                    return (
                      <div key={`rem-${plate}`} className="flex items-center gap-2 w-full">
                        <div className="flex items-center justify-center rounded-sm font-black shrink-0" style={{ width: "24px", height: "24px", backgroundColor: dc, color: plate === 15 || plate === 5 ? "#000" : "#fff", fontSize: "8px" }}>{plate}</div>
                        <div>
                          <p className="font-black uppercase" style={{ fontSize: "clamp(0.58rem,1.1vw,0.75rem)", color: T07_RED }}>REMOVE {plate} KG PLATES × {count * 2}</p>
                          <p className="text-slate-400 font-semibold" style={{ fontSize: "7.5px" }}>{count} per side</p>
                        </div>
                      </div>
                    );
                  })}
                  <div className="flex items-center gap-2 w-full">
                    <div className="flex items-center justify-center rounded-sm bg-slate-700 shrink-0" style={{ width: "24px", height: "24px", fontSize: "11px" }}>🔒</div>
                    <div>
                      <p className="font-black uppercase text-slate-300" style={{ fontSize: "clamp(0.55rem,1vw,0.7rem)" }}>COLLARS UNCHANGED × 2</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="shrink-0 border-t border-slate-700/40 px-2 py-1.5 flex items-center gap-1.5">
              <span style={{ color: T07_GREEN, fontSize: "0.7rem", fontWeight: 900 }}>ℹ</span>
              <p className="font-black uppercase text-slate-400 tracking-wider" style={{ fontSize: "6.5px" }}>MAKE SURE COLLARS ARE TIGHT</p>
            </div>
          </div>

          {/* RIGHT: NEXT BAR LOADING + COLLAR STATUS */}
          <div className="flex flex-row flex-1 min-w-0">
            <div className="flex-1 flex flex-col min-w-0" style={{ background: "linear-gradient(180deg,#0a0d16,#090909)" }}>
              <div className="shrink-0 text-center py-1.5 border-b border-blue-900/40" style={{ background: "rgba(37,99,235,0.07)" }}>
                <p className="font-black uppercase tracking-[0.22em] text-blue-400" style={{ fontSize: "clamp(0.5rem,1vw,0.7rem)" }}>NEXT BAR LOADING</p>
              </div>
              {nextLifter && nextLoadingWeight !== null ? (
                <div className="flex-1 flex flex-col items-center justify-between px-2 py-1.5 min-h-0 overflow-hidden">
                  <div className="text-center shrink-0 leading-none">
                    <span className="font-black tabular-nums" style={{ fontSize: "clamp(2rem,5.5vw,4rem)", color: "#ffffff" }}>{nextLoadingWeight.toFixed(1)}</span>
                    <span className="font-black text-slate-400 ml-1" style={{ fontSize: "clamp(0.85rem,2vw,1.6rem)" }}>KG</span>
                  </div>
                  <div className="flex-1 flex items-center justify-center w-full min-h-0 overflow-hidden py-1">
                    {renderT07Barbell(nxtPlates, includeCollars)}
                  </div>
                  <div className="shrink-0 w-full text-center">
                    <p className="font-semibold uppercase text-amber-400 mb-1" style={{ fontSize: "6px", letterSpacing: "0.2em" }}>EACH SIDE (IPF LOADING ORDER)</p>
                    {renderIPFOrderBadges(nxtPlates, includeCollars)}
                  </div>
                  <div className="shrink-0 mt-1 text-center">
                    <p className="text-slate-500 mb-0.5" style={{ fontSize: "6px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.18em" }}>PER SIDE CALCULATION</p>
                    {renderPerSideCalc(nxtPlates, includeCollars, "#60a5fa")}
                  </div>
                  <div className="shrink-0 w-full grid grid-cols-3 text-center border-t border-slate-700/40 mt-1 pt-1">
                    {[
                      { label: "PER SIDE TOTAL", val: `${formatKg(nxtPerSideTotal)} KG`, color: "#60a5fa" },
                      { label: "BAR WEIGHT", val: `${BAR_WEIGHT_KG}.0 KG`, color: "#94a3b8" },
                      { label: "TOTAL WEIGHT", val: `${nextLoadingWeight.toFixed(1)} KG`, color: "#60a5fa" },
                    ].map(({ label, val, color }) => (
                      <div key={label}>
                        <p className="text-slate-500 font-semibold uppercase" style={{ fontSize: "5.5px", letterSpacing: "0.12em" }}>{label}</p>
                        <p className="font-black tabular-nums" style={{ fontSize: "clamp(0.6rem,1.3vw,0.85rem)", color }}>{val}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-slate-500 font-semibold uppercase tracking-wide" style={{ fontSize: "12px" }}>No next lifter</p>
                </div>
              )}
            </div>
            {/* Collar Status */}
            <div className="shrink-0 flex flex-col items-center justify-center border-l border-slate-700/40 gap-1.5" style={{ width: "58px", background: "#060606", padding: "8px 4px" }}>
              <p className="font-black uppercase text-slate-400 text-center leading-tight" style={{ fontSize: "6px", letterSpacing: "0.12em" }}>COLLAR<br />STATUS</p>
              <div className="flex items-center justify-center rounded-full" style={{ width: "36px", height: "36px", border: `2.5px solid ${includeCollars ? T07_GREEN : "#374151"}`, color: includeCollars ? T07_GREEN : "#374151", fontSize: "1rem", fontWeight: 900 }}>
                {includeCollars ? "✓" : "✗"}
              </div>
              <p className="font-black uppercase" style={{ fontSize: "10px", color: includeCollars ? T07_GREEN : "#4b5563" }}>
                {includeCollars ? "ON" : "OFF"}
              </p>
            </div>
          </div>
        </div>

        {/* ── BOTTOM: Two lifter tables ── */}
        <div className="flex-1 flex min-h-0">

          {/* LEFT: CURRENT LIFTER UPDATES */}
          <div className="flex flex-col min-w-0 border-r border-slate-700/40" style={{ flex: "60", background: "#06060d" }}>
            <div className="shrink-0 px-3 py-1.5 border-b border-slate-700/40 text-center" style={{ background: "#0b0b16" }}>
              <p className="font-black uppercase text-white tracking-[0.22em]" style={{ fontSize: "clamp(0.55rem,1vw,0.72rem)" }}>CURRENT LIFTER UPDATES</p>
            </div>
            <div className="flex-1 overflow-hidden">
              <table className="w-full" style={{ borderCollapse: "collapse", height: "100%" }}>
                <thead>
                  <tr style={{ background: "#0e0e1c", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                    {["ORDER", "LIFTER", "CURRENT ATTEMPT", "NEXT ATTEMPT", "STATUS"].map(col => (
                      <th key={col} className="px-2 py-1 text-left font-black uppercase text-slate-500 whitespace-nowrap" style={{ fontSize: "6.5px", letterSpacing: "0.2em" }}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableLifters.map((lifter, idx) => {
                    const att = getAttempts(lifter, currentLift)[currentAttemptIndex];
                    const nextAtt = currentAttemptIndex < 2 ? getAttempts(lifter, currentLift)[currentAttemptIndex + 1] : null;
                    const isCurrent = lifter.id === currentLifterId;
                    const isGood = att?.status === "GOOD";
                    const isNo = att?.status === "NO";
                    const status = isCurrent
                      ? { label: "LOADED", bg: "#14532d", border: "#22c55e", text: "#86efac" }
                      : isGood ? { label: "GOOD", bg: "#14532d", border: "#22c55e", text: "#86efac" }
                      : isNo ? { label: "NO LIFT", bg: "#7f1d1d", border: "#ef4444", text: "#fca5a5" }
                      : { label: "WAITING", bg: "#1c1c2e", border: "#374151", text: "#6b7280" };
                    const curW = att?.weight !== undefined && att.weight !== "" ? `${att.weight} KG` : "—";
                    const nxtW = nextAtt?.weight !== undefined && nextAtt.weight !== "" ? `${nextAtt.weight} KG` : "—";
                    return (
                      <tr key={lifter.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", background: isCurrent ? "rgba(34,197,94,0.05)" : idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)" }}>
                        <td className="px-2 py-1.5 font-black tabular-nums text-center" style={{ fontSize: "clamp(0.65rem,1.2vw,0.85rem)", color: isCurrent ? "#22c55e" : "#4b5563" }}>{idx + 1}</td>
                        <td className="px-2 py-1.5 font-black uppercase" style={{ fontSize: "clamp(0.6rem,1.1vw,0.8rem)", color: isCurrent ? "#ffffff" : "#d1d5db", maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lifter.name || "—"}</td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-baseline gap-1">
                            <span className="font-black tabular-nums text-white" style={{ fontSize: "clamp(0.6rem,1.1vw,0.8rem)" }}>{curW}</span>
                            <span className="text-slate-500 font-semibold" style={{ fontSize: "7px" }}>{attOrdinal(currentAttemptIndex)}</span>
                          </div>
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-baseline gap-1">
                            <span className="font-black tabular-nums text-slate-300" style={{ fontSize: "clamp(0.6rem,1.1vw,0.8rem)" }}>{nxtW}</span>
                            {nxtW !== "—" && <span className="text-slate-500 font-semibold" style={{ fontSize: "7px" }}>{attOrdinal(currentAttemptIndex + 1)}</span>}
                          </div>
                        </td>
                        <td className="px-2 py-1.5">
                          <span className="font-black uppercase rounded px-1.5 py-0.5 whitespace-nowrap"
                            style={{ fontSize: "clamp(0.5rem,0.85vw,0.65rem)", background: status.bg, border: `1px solid ${status.border}`, color: status.text, letterSpacing: "0.07em" }}>
                            {status.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {tableLifters.length === 0 && (
                    <tr><td colSpan={5} className="text-center text-slate-500 py-4 font-semibold" style={{ fontSize: "11px" }}>No lifters in session</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="shrink-0 border-t border-slate-700/40 px-3 py-1.5 flex items-center justify-center gap-1.5" style={{ background: "#060610" }}>
              <span style={{ fontSize: "10px" }}>⏱</span>
              <p className="font-black uppercase tracking-[0.18em]" style={{ fontSize: "clamp(0.5rem,0.85vw,0.65rem)", color: "#f472b6" }}>
                ATTEMPT WILL START ONCE LOADED AND READY
              </p>
            </div>
          </div>

          {/* RIGHT: UPCOMING LIFTERS */}
          <div className="flex flex-col min-w-0" style={{ flex: "40", background: "#06060d" }}>
            <div className="shrink-0 px-3 py-1.5 border-b border-slate-700/40 text-center" style={{ background: "#0b0b16" }}>
              <p className="font-black uppercase text-white tracking-[0.22em]" style={{ fontSize: "clamp(0.55rem,1vw,0.72rem)" }}>UPCOMING LIFTERS</p>
            </div>
            <div className="flex-1 overflow-hidden">
              <table className="w-full" style={{ borderCollapse: "collapse", height: "100%" }}>
                <thead>
                  <tr style={{ background: "#0e0e1c", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                    {["ORDER", "LIFTER", "ATTEMPT", "NEXT ATTEMPT", "STATUS"].map(col => (
                      <th key={col} className="px-2 py-1 text-left font-black uppercase text-slate-500 whitespace-nowrap" style={{ fontSize: "6.5px", letterSpacing: "0.2em" }}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {upcomingLifters.map((lifter, idx) => {
                    const isNext = idx === 0;
                    const nextAtt = currentAttemptIndex < 2 ? getAttempts(lifter, currentLift)[currentAttemptIndex + 1] : null;
                    const nxtW = nextAtt?.weight !== undefined && nextAtt.weight !== "" ? `${nextAtt.weight} KG` : "—";
                    const status = isNext
                      ? { label: "UP NEXT", bg: "#1e3a5f", border: "#3b82f6", text: "#93c5fd" }
                      : { label: "WAITING", bg: "#1c1c2e", border: "#374151", text: "#6b7280" };
                    return (
                      <tr key={lifter.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", background: isNext ? "rgba(59,130,246,0.06)" : idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)" }}>
                        <td className="px-2 py-1.5 font-black tabular-nums text-center" style={{ fontSize: "clamp(0.65rem,1.2vw,0.85rem)", color: isNext ? "#3b82f6" : "#4b5563" }}>{idx + 1}</td>
                        <td className="px-2 py-1.5 font-black uppercase" style={{ fontSize: "clamp(0.6rem,1.1vw,0.8rem)", color: isNext ? "#ffffff" : "#d1d5db", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lifter.name || "—"}</td>
                        <td className="px-2 py-1.5 font-black tabular-nums text-slate-300" style={{ fontSize: "clamp(0.6rem,1.1vw,0.8rem)" }}>{currentAttemptIndex + 1}</td>
                        <td className="px-2 py-1.5 font-black tabular-nums text-slate-300" style={{ fontSize: "clamp(0.6rem,1.1vw,0.8rem)" }}>{nxtW}</td>
                        <td className="px-2 py-1.5">
                          <span className="font-black uppercase rounded px-1.5 py-0.5 whitespace-nowrap"
                            style={{ fontSize: "clamp(0.5rem,0.85vw,0.65rem)", background: status.bg, border: `1px solid ${status.border}`, color: status.text, letterSpacing: "0.07em" }}>
                            {status.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {upcomingLifters.length === 0 && (
                    <tr><td colSpan={5} className="text-center text-slate-500 py-4 font-semibold" style={{ fontSize: "11px" }}>No upcoming lifters</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (displayMode === "next_attempt_queue") {
    return <NextAttemptQueueDisplay forceLive={forceLive} displayRootStyle={displayRootStyle} />;
  }

  // Viewport-fitted display screen — no page scroll, all content fits inside h-screen.
  if (["signal_results_plate", "signal_results", "order_attempts", "results_all"].includes(displayMode)) {

    return (
      <div
        className={`relative flex h-screen flex-col overflow-hidden ${activeTheme.rootClass}`}
        style={displayRootStyle}
      >
        {/* ── Top header strip ── */}
        <div className={`flex-none border-b px-3 py-2 md:px-5 md:py-3 ${isDarkTheme ? "border-white/10" : "border-black/10"}`}>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <p className="text-sm font-black uppercase leading-tight tracking-tight">
              {currentLifter?.name || "NO LIFTER"}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-right">
              <p
                className={`text-sm font-semibold uppercase ${
                  isDarkTheme ? "text-cyan-300" : "text-cyan-800"
                }`}
              >
                {currentLift.toUpperCase()} · ATT {currentAttemptIndex + 1}
              </p>
              <p className="text-sm font-bold tabular-nums">{loadingWeight.toFixed(1)} kg</p>
            </div>
          </div>
          {!competitionStarted && !forceLive && (
            <p
              className={`mt-1 text-sm font-semibold uppercase tracking-widest ${
                isDarkTheme ? "text-amber-400" : "text-amber-800"
              }`}
            >
              Preview mode — competition not started
            </p>
          )}
        </div>

        {/* Flight order strip */}
        {resultsInlineLiftingOrderRow ? (
          <div className={`flex-none border-b px-3 py-2 md:px-5 md:py-2.5 ${isDarkTheme ? "border-white/10" : "border-black/10"}`}>
            {resultsInlineLiftingOrderRow}
          </div>
        ) : null}

        {/* ── Bottom: results / order table — scrolls internally ── */}
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2 md:px-5 md:py-3">
          {displayMode === "signal_results_plate" ? (() => {
            const curPlates = buildPlateBreakdown(loadingWeight, includeCollars);
            const nxtPlates = nextLoadingWeight !== null ? buildPlateBreakdown(nextLoadingWeight, includeCollars) : [];
            const curPerSideTotal = curPlates.reduce((s: number, p: number) => s + p, 0) + (includeCollars ? COLLAR_PAIR_KG / 2 : 0);
            const nxtPerSideTotal = nxtPlates.reduce((s: number, p: number) => s + p, 0) + (includeCollars ? COLLAR_PAIR_KG / 2 : 0);
            const { toRemove, toAdd } = computePlateChanges(curPlates, nxtPlates);
            const noPlateChange = toRemove.length === 0 && toAdd.length === 0;
            const GREEN = "#39ff14";
            const RED = "#ff3b30";

            const renderPlateBadges = (plates: number[]) => {
              if (plates.length === 0) return <span className="text-slate-500 text-xs font-semibold">bar only</span>;
              return (
                <div className="flex items-center justify-center gap-1 flex-wrap">
                  {plates.map((plate, i) => {
                    const raw = PLATE_COLORS[String(plate)] || "#94a3b8";
                    const displayCol = raw === "#111827" ? "#9ca3af" : raw;
                    const isDark = plate === 15 || plate === 5;
                    return (
                      <span key={i} className="inline-flex items-center gap-1">
                        {i > 0 && <span className="text-white font-bold text-[10px]">+</span>}
                        <span
                          className="flex flex-col items-center justify-center font-black rounded-sm px-1.5 py-0.5 text-[10px] leading-none"
                          style={{ backgroundColor: displayCol, color: isDark ? "#000" : "#fff", minWidth: "26px" }}
                        >
                          <span>{plate}</span>
                          <span className="font-semibold" style={{ fontSize: "8px" }}>KG</span>
                        </span>
                      </span>
                    );
                  })}
                  {includeCollars && (
                    <span className="inline-flex items-center gap-1">
                      <span className="text-white font-bold text-[10px]">+</span>
                      <span className="flex flex-col items-center justify-center font-black rounded-sm px-1.5 py-0.5 text-[9px] leading-none bg-slate-600 text-white" style={{ minWidth: "28px" }}>
                        <span>🔒</span>
                        <span className="font-semibold" style={{ fontSize: "7px" }}>COLLAR</span>
                      </span>
                    </span>
                  )}
                </div>
              );
            };

            const renderChangeStep = (plates: number[], isAdd: boolean) => {
              const color = isAdd ? GREEN : RED;
              const symbol = isAdd ? "+" : "−";
              const action = isAdd ? "ADD" : "REMOVE";
              return plates.map((plate, i) => (
                <div key={`${isAdd ? "a" : "r"}-${i}`} style={{ display: "flex", alignItems: "flex-start", gap: "8px", width: "100%" }}>
                  <div style={{ width: "22px", height: "22px", border: `2px solid ${color}`, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color, fontSize: "0.9rem", fontWeight: 900, flexShrink: 0, marginTop: "2px" }}>
                    {symbol}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ color, fontSize: "1.3rem", fontWeight: 900, lineHeight: 1, fontVariantNumeric: "tabular-nums", marginBottom: "3px" }}>
                      {symbol}{plate} KG
                    </p>
                    <p style={{ color: "#ffffff", fontSize: "0.65rem", fontWeight: 900, textTransform: "uppercase", lineHeight: 1.25, letterSpacing: "0.05em" }}>
                      {action} {plate} KG PLATES<br />TO BOTH SIDES
                    </p>
                  </div>
                </div>
              ));
            };

            return (
              <div className="flex h-full flex-col gap-2" style={{ background: "#0a0a0a" }}>
                {/* ── 15-player table (top, fills available space) ── */}
                <div className={`min-h-0 flex-1 overflow-auto rounded-xl border ${isDarkTheme ? "border-white/10" : "border-slate-200"}`}>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className={`sticky top-0 text-left ${isDarkTheme ? "bg-[#0d1117] text-slate-400" : "bg-slate-100 text-slate-600"}`}>
                        <th className="px-3 py-2 font-semibold uppercase tracking-wide">#</th>
                        <th className="px-3 py-2 font-semibold uppercase tracking-wide">Name</th>
                        <th className="px-3 py-2 font-semibold uppercase tracking-wide">WC</th>
                        <th className="px-3 py-2 font-semibold uppercase tracking-wide">BW</th>
                        <th className="px-3 py-2 font-semibold uppercase tracking-wide">Lot</th>
                        <th className="px-3 py-2 font-semibold uppercase tracking-wide">Att 1</th>
                        <th className="px-3 py-2 font-semibold uppercase tracking-wide">Att 2</th>
                        <th className="px-3 py-2 font-semibold uppercase tracking-wide">Att 3</th>
                      </tr>
                    </thead>
                    <tbody>
                      {flightLineOrdered.map((lifter, idx) => {
                        const isCurrent = lifter.id === flightOrderHighlightId;
                        const atts = getAttempts(lifter, currentLift);
                        return (
                          <tr
                            key={lifter.id}
                            className={`border-t ${isDarkTheme ? "border-white/[0.07]" : "border-black/[0.06]"} ${
                              isCurrent
                                ? isDarkTheme ? "bg-cyan-500/15" : "bg-cyan-50"
                                : idx % 2 === 0 ? "" : isDarkTheme ? "bg-white/[0.02]" : "bg-black/[0.02]"
                            }`}
                          >
                            <td className={`px-3 py-1.5 tabular-nums font-bold ${isCurrent ? (isDarkTheme ? "text-cyan-300" : "text-cyan-700") : isDarkTheme ? "text-slate-500" : "text-slate-400"}`}>{idx + 1}</td>
                            <td className={`px-3 py-1.5 font-semibold ${isDarkTheme ? (isCurrent ? "text-cyan-100" : "text-white") : "text-slate-900"}`}>
                              {lifter.name || "—"}
                              {isCurrent && <span className={`ml-1.5 text-[10px] font-black ${isDarkTheme ? "text-cyan-400" : "text-cyan-600"}`}>▶</span>}
                            </td>
                            <td className={`px-3 py-1.5 ${isDarkTheme ? "text-slate-400" : "text-slate-500"}`}>{lifter.weightClass || "—"}</td>
                            <td className={`px-3 py-1.5 tabular-nums ${isDarkTheme ? "text-slate-400" : "text-slate-500"}`}>{typeof lifter.bodyweight === "number" ? lifter.bodyweight : "—"}</td>
                            <td className={`px-3 py-1.5 tabular-nums ${isDarkTheme ? "text-slate-400" : "text-slate-500"}`}>{typeof lifter.lot === "number" ? lifter.lot : "—"}</td>
                            {([0, 1, 2] as const).map((ai) => {
                              const att = atts[ai];
                              const w = att?.weight;
                              const s = att?.status ?? "UNATTEMPTED";
                              const displayW = w !== undefined && w !== "" ? String(w) : "—";
                              const cls = s === "GOOD" ? (isDarkTheme ? "text-green-400 font-bold" : "text-green-700 font-bold")
                                : s === "NO" ? (isDarkTheme ? "text-red-400 line-through" : "text-red-600 line-through")
                                : s === "PENDING" ? (isDarkTheme ? "text-amber-300 font-semibold" : "text-amber-700 font-semibold")
                                : (isDarkTheme ? "text-slate-600" : "text-slate-400");
                              return <td key={ai} className={`px-3 py-1.5 tabular-nums ${cls}`}>{displayW}</td>;
                            })}
                          </tr>
                        );
                      })}
                      {flightLineOrdered.length === 0 && (
                        <tr><td colSpan={8} className={`px-3 py-8 text-center ${isDarkTheme ? "text-slate-500" : "text-slate-400"}`}>No lifters in this session.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* ── 3-panel plate loading section (bottom) ── */}
                <div className="shrink-0 flex gap-2" style={{ height: "200px" }}>

                  {/* Current bar loading */}
                  <div className="flex-1 flex flex-col rounded-lg overflow-hidden min-w-0" style={{ border: "2px solid rgba(34,197,94,0.6)", background: "#0d0d0d" }}>
                    <div className="shrink-0 px-2 py-1 text-center border-b" style={{ borderColor: "rgba(34,197,94,0.3)", background: "rgba(34,197,94,0.09)" }}>
                      <p className="text-[9px] font-black uppercase tracking-[0.2em] text-green-400">CURRENT BAR LOADING</p>
                      <p className="text-[8px] text-slate-400 truncate">{currentLifter?.name || "—"}</p>
                    </div>
                    <div className="flex-1 flex flex-col items-center justify-between px-2 py-2 min-h-0 overflow-hidden">
                      <p className="font-black tabular-nums text-green-400 leading-none shrink-0" style={{ fontSize: "1.6rem" }}>{loadingWeight.toFixed(1)} KG</p>
                      <div className="shrink-0">{renderPlateBadges(curPlates)}</div>
                      <div className="text-center shrink-0">
                        <p className="text-[7px] font-semibold uppercase tracking-[0.25em] text-slate-400">TOTAL PER SIDE</p>
                        <p className="font-black tabular-nums text-green-400 leading-none" style={{ fontSize: "1rem" }}>{formatKg(curPerSideTotal)} KG</p>
                        <p className="text-[7px] font-semibold uppercase tracking-widest text-slate-500 mt-0.5">COLLAR {includeCollars ? "ON" : "OFF"}</p>
                      </div>
                    </div>
                  </div>

                  {/* Plate change instructions */}
                  <div className="w-[220px] shrink-0 flex flex-col rounded-xl overflow-hidden"
                    style={{ border: `2px solid ${noPlateChange ? "#22c55e" : (toRemove.length > 0 && toAdd.length > 0 ? "#f59e0b" : toAdd.length > 0 ? GREEN : RED)}`, background: "#0a0a0a" }}>
                    <div className="shrink-0 px-2 pt-2 pb-1 text-center">
                      <p className="font-black uppercase leading-none" style={{ fontSize: "0.75rem", color: GREEN }}>PLATE CHANGE</p>
                      <p className="font-black uppercase text-white leading-none text-[0.65rem] mt-0.5">INSTRUCTIONS</p>
                    </div>
                    <div className="flex-1 flex flex-col items-center justify-center px-3 gap-1.5 overflow-hidden min-h-0">
                      {!nextLifter || nextLoadingWeight === null ? (
                        <p className="text-slate-600 text-[0.65rem] font-black uppercase text-center tracking-widest">NO NEXT LIFTER</p>
                      ) : noPlateChange ? (
                        <div className="flex flex-col items-center gap-1">
                          <div className="flex items-center justify-center rounded-full font-black" style={{ width: "30px", height: "30px", border: `2px solid ${GREEN}`, color: GREEN, fontSize: "1rem" }}>✓</div>
                          <p className="font-black uppercase text-center text-[0.65rem]" style={{ color: GREEN }}>NO CHANGE · SAME LOADING</p>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center w-full gap-1.5">
                          {toRemove.length > 0 && renderChangeStep(toRemove, false)}
                          {toRemove.length > 0 && toAdd.length > 0 && <div className="w-full border-t" style={{ borderColor: "rgba(255,255,255,0.1)" }} />}
                          {toAdd.length > 0 && renderChangeStep(toAdd, true)}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 border-t px-2 py-1 flex items-center gap-1" style={{ borderColor: "rgba(255,255,255,0.1)" }}>
                      <span style={{ color: GREEN, fontSize: "0.7rem", fontWeight: 900 }}>ℹ</span>
                      <p className="text-[7px] font-black uppercase tracking-wider text-white">MAKE SURE COLLARS ARE TIGHT</p>
                    </div>
                  </div>

                  {/* Next bar loading */}
                  <div className="flex-1 flex flex-col rounded-lg overflow-hidden min-w-0" style={{ border: "2px solid rgba(6,182,212,0.6)", background: "#0d0d0d" }}>
                    <div className="shrink-0 px-2 py-1 text-center border-b" style={{ borderColor: "rgba(6,182,212,0.3)", background: "rgba(6,182,212,0.08)" }}>
                      <p className="text-[9px] font-black uppercase tracking-[0.2em] text-cyan-400">NEXT BAR LOADING</p>
                      <p className="text-[8px] text-slate-400 truncate">{nextLifter?.name || "—"}</p>
                    </div>
                    {nextLifter && nextLoadingWeight !== null ? (
                      <div className="flex-1 flex flex-col items-center justify-between px-2 py-2 min-h-0 overflow-hidden">
                        <p className="font-black tabular-nums text-cyan-400 leading-none shrink-0" style={{ fontSize: "1.6rem" }}>{nextLoadingWeight.toFixed(1)} KG</p>
                        <div className="shrink-0">{renderPlateBadges(nxtPlates)}</div>
                        <div className="text-center shrink-0">
                          <p className="text-[7px] font-semibold uppercase tracking-[0.25em] text-slate-400">TOTAL PER SIDE</p>
                          <p className="font-black tabular-nums text-cyan-400 leading-none" style={{ fontSize: "1rem" }}>{formatKg(nxtPerSideTotal)} KG</p>
                          <p className="text-[7px] font-semibold uppercase tracking-widest text-slate-500 mt-0.5">COLLAR {includeCollars ? "ON" : "OFF"}</p>
                        </div>
                      </div>
                    ) : (
                      <div className="flex-1 flex items-center justify-center">
                        <p className="text-slate-500 text-xs font-semibold uppercase tracking-wide">No next lifter</p>
                      </div>
                    )}
                  </div>

                </div>
              </div>
            );
          })() : displayMode === "order_attempts" ? (
            <div className="flex h-full flex-col gap-3">
              <div
                className={`rounded-xl border p-3 text-center ${
                  isDarkTheme ? "border-white/20 bg-black/30" : "border-slate-200 bg-white shadow-sm ring-1 ring-black/5"
                }`}
              >
                <p
                  className={`text-sm font-semibold uppercase tracking-[0.2em] ${
                    isDarkTheme ? "text-cyan-200" : "text-cyan-900"
                  }`}
                >
                  {currentLift.toUpperCase()} ATTEMPT {currentAttemptIndex + 1}
                  {activeCompetitionGroupName && (
                    <span
                      className={`ml-3 text-sm font-normal normal-case tracking-normal ${
                        isDarkTheme ? "text-slate-300" : "text-slate-600"
                      }`}
                    >
                      — {activeCompetitionGroupName}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
                <p className={`shrink-0 text-sm uppercase tracking-widest ${isDarkTheme ? "text-cyan-300" : "text-cyan-800"}`}>
                  Lifting order{" "}
                  <span className={`font-normal normal-case tracking-normal ${isDarkTheme ? "text-slate-500" : "text-slate-500"}`}>
                    — scroll sideways
                  </span>
                </p>
                <div className="min-h-0 overflow-x-auto overflow-y-hidden pb-1 [-webkit-overflow-scrolling:touch]">
                  <div className="flex w-max snap-x snap-mandatory gap-2 pl-[max(0.5rem,calc(50%-6rem))] pr-[max(0.5rem,calc(50%-6rem))]">
                    {flightLineOrdered.map((lifter, idx) => {
                      const attemptWeight = getAttemptValue(lifter, currentLift, currentAttemptIndex);
                      const isCurrent = lifter.id === currentLifterId;
                      const { first, last } = splitLifterNameParts(lifter.name || "");
                      return (
                        <div
                          key={lifter.id}
                          data-display-order-lifter={lifter.id}
                          className={`snap-start shrink-0 rounded-xl border p-3 shadow-sm ${
                            isCurrent
                              ? isDarkTheme
                                ? "border-cyan-300/90 bg-cyan-500/15 ring-1 ring-cyan-400/40"
                                : "border-cyan-600 bg-cyan-50 ring-1 ring-cyan-400/50"
                              : isDarkTheme
                                ? "border-white/20 bg-black/30"
                                : "border-slate-200 bg-white ring-1 ring-black/5"
                          } w-[min(46vw,12.5rem)] sm:w-[11.5rem]`}
                        >
                          <p
                            className={`text-sm font-black uppercase leading-snug tracking-tight ${
                              isDarkTheme ? "text-white" : "text-slate-900"
                            }`}
                          >
                            <span className={`tabular-nums ${isDarkTheme ? "text-cyan-200" : "text-cyan-800"}`}>#{idx + 1}</span>{" "}
                            <span>{first.toUpperCase()}</span>
                            {last ? <> <span>{last.toUpperCase()}</span></> : null}{" "}
                            <span className={`font-bold ${isDarkTheme ? "text-slate-500" : "text-slate-400"}`}>*</span>{" "}
                            <span className={`tabular-nums ${isDarkTheme ? "text-amber-200" : "text-amber-800"}`}>
                              {attemptWeight === null ? "—" : `${attemptWeight.toFixed(1)} KG`}
                            </span>
                          </p>
                          {lifter.group && !activeCompetitionGroupName && (
                            <p
                              className={`mt-1 truncate text-xs font-semibold uppercase tracking-widest ${
                                isDarkTheme ? "text-amber-300/85" : "text-amber-900/90"
                              }`}
                            >
                              {Array.isArray(lifter.group) ? lifter.group.join(" + ") : lifter.group}
                            </p>
                          )}
                          <p className={`mt-1 text-sm tabular-nums ${isDarkTheme ? "text-slate-400" : "text-slate-600"}`}>
                            BW {typeof lifter.bodyweight === "number" ? lifter.bodyweight : "-"} · Lot{" "}
                            {typeof lifter.lot === "number" ? lifter.lot : "-"}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
                {flightLineOrdered.length === 0 && (
                  <p className={`text-sm ${isDarkTheme ? "text-slate-400" : "text-slate-600"}`}>No lifters added yet.</p>
                )}
              </div>
            </div>
          ) : displayMode === "signal_results" ? (
            <LiveScoreboard
              lifters={competitionScopedLifters}
              currentLifterId={currentLifterId}
              currentLift={currentLift}
              currentAttemptIndex={currentAttemptIndex}
              nextLifterId={nextLifter?.id ?? null}
              competitionMode={competitionMode}
              activeGroupName={activeCompetitionGroupName}
            />
          ) : groups.length === 0 ? (
            <div
              className={`flex min-h-[8rem] items-center justify-center rounded-xl border px-4 py-6 text-center ${
                isDarkTheme ? "border-white/15 bg-black/25 text-slate-300" : "border-slate-200 bg-white/80 text-slate-600"
              }`}
            >
              <p className="text-sm">
                No groups configured. Add groups in the admin Groups tab to show results tables.
              </p>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-hidden">
              <ResultsTable
                rankingByGroup={rankingByGroup}
                ungroupedRanking={ungroupedRanking}
                currentLifterId={currentLifterId}
                isDarkTheme={isDarkTheme}
                competitionMode={competitionMode}
              />
            </div>
          )}
        </div>

        {/* ── Incoming: only cyan balls (one per signal received). White/red wait until all 3 in — see overlayPhase circles. ── */}
        {showSignalOverlay && !overlayPhase && !isFinalVerdictAnimating && liveReceivedSignalCount > 0 && liveReceivedSignalCount < 3 && (
          <div className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90">
            <div className="flex items-center gap-6 md:gap-10 lg:gap-14">
              {Array.from({ length: liveReceivedSignalCount }).map((_, idx) => (
                <motion.div
                  key={`incoming-signal-${idx}`}
                  initial={{ scale: 0.65, opacity: 0 }}
                  animate={{ scale: [1, 1.08, 1], opacity: [0.85, 1, 0.9] }}
                  transition={{ duration: 1.05, repeat: Infinity, ease: "easeInOut", delay: idx * 0.08 }}
                  className="h-20 w-20 rounded-full border-4 border-cyan-300 bg-cyan-500 shadow-[0_0_60px_rgba(34,211,238,0.85)] md:h-32 md:w-32 lg:h-44 lg:w-44"
                />
              ))}
            </div>
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-8 text-[clamp(1rem,3vw,2.2rem)] font-black uppercase tracking-[0.3em] text-cyan-200"
            >
              SIGNAL{receivedSignalCount > 1 ? "S" : ""} RECEIVED
            </motion.p>
          </div>
        )}

        {overlayPhase === "circles" && (
          <div className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center justify-center bg-black">
            <div className="flex gap-6 md:gap-12 lg:gap-20">
              {[0, 1, 2].map((idx) => {
                const sig = displaySignals[idx];
                const isGood = sig === "GOOD";
                return (
                  <motion.div
                    key={idx}
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay: idx * 0.28, type: "spring", stiffness: 220, damping: 14 }}
                    className={`h-24 w-24 rounded-full border-4 md:h-40 md:w-40 lg:h-52 lg:w-52 ${
                      isGood
                        ? "border-white bg-white shadow-[0_0_80px_rgba(255,255,255,0.95)]"
                        : "border-rose-400 bg-rose-600 shadow-[0_0_75px_rgba(244,63,94,0.92)]"
                    }`}
                  />
                );
              })}
            </div>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.9, duration: 0.4 }}
              className="mt-10 text-[clamp(1.4rem,4vw,3rem)] font-black uppercase tracking-[0.35em] text-white"
            >
              GOOD LIFT
            </motion.p>
          </div>
        )}

        {/* ── IPF Good Lift: Phase 2 — lift-specific animation (1.5 s) ── */}
        {overlayPhase === "lift" && (
          <div className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center justify-center bg-black">
            <motion.div
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 280, damping: 16 }}
              className="flex flex-col items-center gap-6 text-center"
            >
              <p className="text-[clamp(3rem,10vw,7rem)] font-black uppercase leading-none tracking-tight text-white">
                GOOD LIFT
              </p>

              {currentLift === "bench" && (
                <div className="relative flex items-center justify-center">
                  <motion.div
                    animate={{ y: [0, -30, 0, -20, 0] }}
                    transition={{ duration: 1.4, ease: "easeInOut" }}
                    className="relative flex items-center"
                  >
                    <div className="h-6 w-6 rounded bg-amber-400 md:h-8 md:w-8" />
                    <div className="h-3 w-32 rounded-full bg-white md:h-4 md:w-56" />
                    <div className="h-6 w-6 rounded bg-amber-400 md:h-8 md:w-8" />
                  </motion.div>
                </div>
              )}

              {currentLift === "squat" && (
                <div className="flex items-end justify-center gap-6">
                  <motion.div
                    animate={{ scaleY: [0.5, 1, 0.5, 1] }}
                    style={{ transformOrigin: "bottom", height: "clamp(60px,10vw,120px)" }}
                    transition={{ duration: 1.4, ease: "easeInOut" }}
                    className="w-10 rounded-t-full bg-white md:w-16"
                  />
                  <motion.div
                    animate={{ scaleY: [0.5, 1, 0.5, 1] }}
                    style={{ transformOrigin: "bottom", height: "clamp(80px,12vw,140px)" }}
                    transition={{ duration: 1.4, ease: "easeInOut", delay: 0.05 }}
                    className="w-10 rounded-t-full bg-cyan-400 md:w-16"
                  />
                  <motion.div
                    animate={{ scaleY: [0.5, 1, 0.5, 1] }}
                    style={{ transformOrigin: "bottom", height: "clamp(60px,10vw,120px)" }}
                    transition={{ duration: 1.4, ease: "easeInOut", delay: 0.1 }}
                    className="w-10 rounded-t-full bg-white md:w-16"
                  />
                </div>
              )}

              {currentLift === "deadlift" && (
                <div className="flex items-center justify-center">
                  <motion.div
                    animate={{ y: [30, -30] }}
                    transition={{ duration: 1.3, ease: "easeOut" }}
                    className="relative flex items-center"
                  >
                    <div className="h-8 w-8 rounded-full border-4 border-amber-400 bg-transparent md:h-12 md:w-12" />
                    <div className="h-3 w-40 rounded-full bg-white md:h-4 md:w-64" />
                    <div className="h-8 w-8 rounded-full border-4 border-amber-400 bg-transparent md:h-12 md:w-12" />
                  </motion.div>
                </div>
              )}

              <p className="text-[clamp(1rem,3vw,2rem)] font-bold uppercase tracking-[0.3em] text-cyan-300">
                {currentLift === "bench" ? "BENCH PRESS" : currentLift === "squat" ? "SQUAT" : "DEADLIFT"}
              </p>
            </motion.div>
          </div>
        )}

        {/* ── NO lift overlay — full-screen colored circles ── */}
        {overlayPhase === "no-lift" && (
          <div className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center justify-center bg-black">
            <motion.p
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-10 text-[clamp(2rem,6vw,4.5rem)] font-black uppercase tracking-[0.25em] text-red-400"
            >
              NO LIFT
            </motion.p>
            <div className="flex gap-6 md:gap-12 lg:gap-20">
              {displaySignals.map((signal, idx) => (
                <motion.div
                  key={idx}
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ delay: idx * 0.2, type: "spring", stiffness: 220, damping: 14 }}
                  className={`h-24 w-24 rounded-full md:h-40 md:w-40 lg:h-52 lg:w-52 ${
                    signal === "NO"
                      ? "bg-red-600 shadow-[0_0_80px_rgba(239,68,68,0.95)]"
                      : "bg-white shadow-[0_0_80px_rgba(255,255,255,0.9)]"
                  }`}
                />
              ))}
            </div>
          </div>
        )}

        {platformTimerChip}
      </div>
    );
  }

  return (
    <div className={`relative min-h-screen px-4 py-5 ${activeTheme.rootClass}`} style={displayRootStyle}>
      {!competitionStarted && !forceLive && (
        <div
          className={`mb-3 inline-block rounded border px-3 py-1 text-xs font-semibold ${
            isDarkTheme
              ? "border-amber-500/50 bg-amber-400/15 text-amber-200"
              : "border-amber-600 bg-amber-100 text-amber-900"
          }`}
        >
          Competition not started. Preview mode is active.
        </div>
      )}
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
        <p className="text-center text-xs font-semibold uppercase tracking-[0.2em] text-slate-700 md:text-sm">
          Design by SUMIT BHANJA
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-4xl font-bold italic uppercase md:text-6xl">{currentLifter?.name || "No Lifter"}</h1>
            <div className="text-right">
              <p className="text-xl font-semibold md:text-4xl">Height: {currentLift === "bench" ? currentLifter?.rackHeightBench || "-" : currentLifter?.rackHeightSquat || "-"}</p>
            </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <div>
            <p className="text-6xl font-bold md:text-8xl">{currentWeight.toFixed(1)} kg</p>
            <p className="mt-1 text-base font-semibold md:text-2xl">
              {includeCollars ? "With collar" : "Without collar"}: {loadingWeight.toFixed(1)} kg
            </p>
            <p className="mt-3 text-2xl font-semibold uppercase md:text-4xl">
              {currentLift.toUpperCase()} ATTEMPT {currentAttemptIndex + 1}
            </p>
          </div>
          <div className="grid min-h-0 min-w-0 grid-cols-2 gap-2 divide-x divide-black/15">
            <div className="min-w-0 pr-2">
              <p className="text-center text-sm font-semibold uppercase text-slate-600">Current</p>
              <p className="truncate text-center text-sm font-bold">{currentLifter?.name || "—"}</p>
              <div className="mt-1">
                <PlateStack weight={loadingWeight} includeCollars={includeCollars} />
              </div>
            </div>
            <div className="min-w-0 pl-2">
              <p className="text-center text-sm font-semibold uppercase text-slate-600">Next</p>
              {nextLifter && nextLoadingWeight !== null ? (
                <>
                  <p className="truncate text-center text-sm font-bold text-slate-800">{nextLifter.name || "—"}</p>
                  <div className="mt-1">
                    <PlateStack weight={nextLoadingWeight} includeCollars={includeCollars} />
                  </div>
                </>
              ) : (
                <div className="mt-1 flex min-h-[140px] flex-col items-center justify-center rounded-xl border border-black/10 bg-black/5 px-2 py-4 text-center">
                  <p className="text-sm text-slate-500">No next lifter</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {showSignalOverlay && (
        <div className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center justify-center bg-black">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex gap-6 md:gap-12 lg:gap-20"
          >
            {displaySignals.map((signal, idx) => (
              <motion.div
                key={idx}
                initial={{ scale: 0, opacity: 0 }}
                animate={{
                  scale: 1,
                  opacity: signal !== null ? 1 : 0.3,
                }}
                transition={{
                  type: "spring",
                  stiffness: 220,
                  damping: 14,
                }}
                className={`h-32 w-32 rounded-full md:h-48 md:w-48 lg:h-64 lg:w-64 ${
                  signal !== null
                    ? "bg-blue-500 shadow-[0_0_60px_rgba(59,130,246,0.95)]"
                    : "border-2 border-blue-500/30 shadow-[0_0_40px_rgba(59,130,246,0.3)]"
                }`}
              />
            ))}
          </motion.div>
        </div>
      )}

      <Link to="/control" className="fixed bottom-4 right-4 rounded bg-black/70 px-3 py-2 text-sm text-white">
        Back
      </Link>

      {platformTimerChip}
    </div>
  );
};

const DB_SETUP_SQL = `-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)

CREATE TABLE IF NOT EXISTS competitions (
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
);

CREATE TABLE IF NOT EXISTS groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  current_lift text NOT NULL DEFAULT 'squat',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lifters (
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
);

CREATE TABLE IF NOT EXISTS referee_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  position integer NOT NULL,
  signal text DEFAULT NULL,
  device_id text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(competition_id, position)
);

CREATE TABLE IF NOT EXISTS referee_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  device_id text NOT NULL DEFAULT '',
  position integer NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(competition_id, position)
);

CREATE INDEX IF NOT EXISTS idx_groups_competition_id ON groups(competition_id);
CREATE INDEX IF NOT EXISTS idx_lifters_competition_id ON lifters(competition_id);
CREATE INDEX IF NOT EXISTS idx_referee_signals_competition_id ON referee_signals(competition_id);
CREATE INDEX IF NOT EXISTS idx_referee_devices_competition_id ON referee_devices(competition_id);

ALTER TABLE competitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifters ENABLE ROW LEVEL SECURITY;
ALTER TABLE referee_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE referee_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "competitions_select" ON competitions FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "competitions_insert" ON competitions FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "competitions_update" ON competitions FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "competitions_delete" ON competitions FOR DELETE TO anon, authenticated USING (true);
CREATE POLICY "groups_select" ON groups FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "groups_insert" ON groups FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "groups_update" ON groups FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "groups_delete" ON groups FOR DELETE TO anon, authenticated USING (true);
CREATE POLICY "lifters_select" ON lifters FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "lifters_insert" ON lifters FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "lifters_update" ON lifters FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "lifters_delete" ON lifters FOR DELETE TO anon, authenticated USING (true);
CREATE POLICY "referee_signals_select" ON referee_signals FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "referee_signals_insert" ON referee_signals FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "referee_signals_update" ON referee_signals FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "referee_signals_delete" ON referee_signals FOR DELETE TO anon, authenticated USING (true);
CREATE POLICY "referee_devices_select" ON referee_devices FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "referee_devices_insert" ON referee_devices FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "referee_devices_update" ON referee_devices FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "referee_devices_delete" ON referee_devices FOR DELETE TO anon, authenticated USING (true);

ALTER PUBLICATION supabase_realtime ADD TABLE competitions;
ALTER PUBLICATION supabase_realtime ADD TABLE lifters;
ALTER PUBLICATION supabase_realtime ADD TABLE groups;
ALTER PUBLICATION supabase_realtime ADD TABLE referee_signals;
ALTER PUBLICATION supabase_realtime ADD TABLE referee_devices;`;

const DbSetupBanner = () => {
  const [dbReady, setDbReady] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    let interval: number;
    const check = async () => {
      try {
        const { isFirebaseConfigured: fbConfigured, firebaseDb } = await import("./lib/firebase");
        if (!fbConfigured || !firebaseDb) {
          setDbReady(true);
          return;
        }
        const { ref, get } = await import("firebase/database");
        try {
          await get(ref(firebaseDb, "competitions"));
          setDbReady(true);
          window.clearInterval(interval);
        } catch {
          setDbReady(false);
        }
      } catch {
        setDbReady(false);
      }
    };
    check();
    interval = window.setInterval(check, 5000);
    return () => window.clearInterval(interval);
  }, []);

  const copySQL = async () => {
    try {
      await navigator.clipboard.writeText(DB_SETUP_SQL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  if (dbReady === null || dbReady === true) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-amber-400/30 bg-[#1a1200] px-4 py-3">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-amber-400" />
          <p className="text-sm font-semibold text-amber-200">Database not set up yet</p>
          <p className="hidden text-xs text-amber-300/70 sm:block">— App will work offline using local storage until the database is configured.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShow((v) => !v)}
            className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-200 transition hover:bg-amber-500/20"
          >
            {show ? "Hide SQL" : "View Setup SQL"}
          </button>
          <button
            onClick={copySQL}
            className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-bold text-black transition hover:bg-amber-400"
          >
            {copied ? "Copied!" : "Copy SQL"}
          </button>
        </div>
      </div>
      {show && (
        <div className="mx-auto mt-3 max-w-4xl">
          <p className="mb-2 text-xs text-amber-300/80">
            Run this in your <span className="font-semibold">Supabase Dashboard → SQL Editor</span> to enable full database sync and real-time referee signals.
          </p>
          <pre className="max-h-48 overflow-y-auto rounded-lg border border-white/10 bg-black/40 p-3 text-xs text-slate-300">
            {DB_SETUP_SQL}
          </pre>
        </div>
      )}
    </div>
  );
};

const AppRoutes = () => (
  <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route
      path="/display/full"
      element={(
        <RequireAuth>
          <DisplayFullPage />
        </RequireAuth>
      )}
    />
    <Route path="/signals/:station" element={<RefereeStationPage />} />
    <Route
      element={(
        <RequireAuth>
          <DashboardLayout />
        </RequireAuth>
      )}
    >
      <Route path="/" element={<CompetitionPage />} />
      <Route path="/competitions" element={<CompetitionPage />} />
      <Route path="/control" element={<ControlPage />} />
      <Route
        path="/lifters"
        element={
          <CompetitionGate>
            <LifterManagementPage />
          </CompetitionGate>
        }
      />
      <Route
        path="/groups"
        element={
          <CompetitionGate>
            <GroupManagementPage />
          </CompetitionGate>
        }
      />
      <Route path="/signals" element={<RefereePage />} />
      <Route path="/screen" element={<ScreenPage />} />
      <Route
        path="/results"
        element={
          <CompetitionGate>
            <ResultsPage />
          </CompetitionGate>
        }
      />
      <Route
        path="/admin/users"
        element={(
          <RequireAdmin>
            <AdminUsersPage />
          </RequireAdmin>
        )}
      />
      <Route path="/settings" element={<SettingsPage />} />
    </Route>
  </Routes>
);

export default function App() {
  return (
    <AuthProvider>
      <AppProvider>
        <HashRouter>
          <AppRoutes />
          <DbSetupBanner />
        </HashRouter>
      </AppProvider>
    </AuthProvider>
  );
}
