import { useEffect, useMemo, useRef, useState } from "react";
import type { Lifter, Attempt, LiftType, AttemptStatus, CompetitionMode } from "@/lib/types";

// ════════════════════════════════════════════════════════════════════════════════
// GL Points calculation — uses same formula as App.tsx (calculateGoodliftPoints)
// ════════════════════════════════════════════════════════════════════════════════════════════════

const GL_COEFFICIENTS: Record<string, { a: number; b: number; c: number }> = {
  "Male Classic Raw": { a: 1199.72839, b: 1025.18162, c: 0.00921 },
  "Female Classic Raw": { a: 610.32796, b: 1045.59282, c: 0.03048 },
  "Male Equipped": { a: 1236.25115, b: 1449.21864, c: 0.01644 },
  "Female Equipped": { a: 758.63871, b: 949.31382, c: 0.02435 },
  "Male Classic Raw Bench": { a: 320.98041, b: 281.40258, c: 0.01008 },
  "Female Classic Raw Bench": { a: 142.40398, b: 442.52671, c: 0.04724 },
  "Male Equipped Bench": { a: 381.22073, b: 733.79378, c: 0.02398 },
  "Female Equipped Bench": { a: 221.09511, b: 596.24238, c: 0.04137 },
};

function getGLCoefficientSet(
  sex: "Male" | "Female",
  equipped: boolean,
  benchOnly: boolean,
): { a: number; b: number; c: number } {
  const eq = equipped ? "Equipped" : "Classic Raw";
  const lift = benchOnly ? " Bench" : "";
  const key = `${sex} ${eq}${lift}` as keyof typeof GL_COEFFICIENTS;
  return GL_COEFFICIENTS[key] ?? GL_COEFFICIENTS["Male Classic Raw"];
}

function calculateGLPoints(
  totalKg: number,
  bodyweight: number | "",
  sex: "Male" | "Female",
  equipped: boolean,
  benchOnly: boolean,
): number {
  if (!(typeof bodyweight === "number" && Number.isFinite(bodyweight) && bodyweight > 0)) return 0;
  if (!(Number.isFinite(totalKg) && totalKg > 0)) return 0;
  const { a, b, c } = getGLCoefficientSet(sex, equipped, benchOnly);
  const denominator = a - b * Math.exp(-c * bodyweight);
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return Number(((totalKg * 100) / denominator).toFixed(2));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Category header color mapping (matches the screenshot exactly)
// ═══════════════════════════════════════════════════════════════════════════════
const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  "SUB JUNIOR":   { bg: "#164d1e", text: "#ffffff", border: "#22c55e" },
  "JUNIOR":       { bg: "#1e3a8a", text: "#ffffff", border: "#3b82f6" },
  "SENIOR":       { bg: "#7c4a0a", text: "#ffffff", border: "#f59e0b" },
  "MASTER":       { bg: "#581c87", text: "#ffffff", border: "#a855f7" },
  "MASTER 1":     { bg: "#581c87", text: "#ffffff", border: "#a855f7" },
  "MASTER 2":     { bg: "#581c87", text: "#ffffff", border: "#a855f7" },
  "MASTER 3":     { bg: "#581c87", text: "#ffffff", border: "#a855f7" },
  "MASTER 4":     { bg: "#581c87", text: "#ffffff", border: "#a855f7" },
};

function getCategoryColor(categoryName: string) {
  const upper = categoryName.toUpperCase();
  for (const key of Object.keys(CATEGORY_COLORS)) {
    if (upper.includes(key)) return CATEGORY_COLORS[key];
  }
  return { bg: "#1f2937", text: "#ffffff", border: "#4b5563" };
}

function parseCategoryParts(categoryName: string): {
  category: string;
  sex: string;
  federation: string;
  weightRange: string;
} {
  const upper = categoryName.toUpperCase();
  let category = categoryName;
  let sex = "MEN";
  let federation = "IPF";
  let weightRange = "";

  if (upper.includes("WOMEN") || upper.includes("FEMALE")) sex = "WOMEN";
  if (upper.includes("MEN") || upper.includes("MALE")) sex = "MEN";

  // Extract weight range if present (e.g. "53 – 59 KG" or "(53-59kg)")
  const weightMatch = categoryName.match(/(\d+(?:\.\d+)?)\s*[-\u2013\u2014]\s*(\d+(?:\.\d+)?)\s*(?:kg|KG)/i);
  if (weightMatch) {
    weightRange = `${weightMatch[1]} – ${weightMatch[2]} KG`;
  }

  return { category, sex, federation, weightRange };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utility helpers
// ═══════════════════════════════════════════════════════════════════════════════
const bestGoodLift = (attempts: Attempt[]): number => {
  return attempts.reduce((best, cur) => {
    if (cur.status !== "GOOD" || cur.weight === "") return best;
    return cur.weight > best ? cur.weight : best;
  }, 0);
};

const resolveAttemptWeight = (lifter: Lifter, lift: LiftType, attemptIndex: number): number => {
  const attempts = lift === "squat" ? lifter.squatAttempts : lift === "bench" ? lifter.benchAttempts : lifter.deadliftAttempts;
  const att = attempts[attemptIndex];
  if (!att || att.weight === "") return 0;
  return att.weight;
};

function getAttemptStyle(status: AttemptStatus, isBenchOnly: boolean): { text: string; className: string } {
  const dash = "\u2013"; // en dash

  if (isBenchOnly) {
    return { text: dash, className: "text-slate-600" };
  }

  switch (status) {
    case "GOOD":
      return { text: "", className: "text-[#22c55e] font-bold" };
    case "NO":
      return { text: "", className: "text-[#ef4444] font-bold line-through decoration-2" };
    case "PENDING":
      return { text: "", className: "text-[#eab308] font-semibold" };
    case "UNATTEMPTED":
    default:
      return { text: dash, className: "text-slate-600" };
  }
}

function formatAttemptCell(attempt: Attempt | undefined, isBenchOnly: boolean): { text: string; className: string } {
  const dash = "\u2013";
  if (!attempt) return { text: dash, className: "text-slate-600" };

  const weight = attempt.weight;
  const status = attempt.status;

  if (isBenchOnly) return { text: dash, className: "text-slate-600" };

  if (weight === "") {
    if (status === "UNATTEMPTED" || status === "PENDING") return { text: dash, className: "text-slate-600" };
    return { text: dash, className: "text-slate-600" };
  }

  const style = getAttemptStyle(status, false);
  return { text: String(weight), className: style.className };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Types for the scoreboard
// ═══════════════════════════════════════════════════════════════════════════════
export type ScoreboardLifter = Lifter & {
  total: number;
  glPoints: number;
};

export type ScoreboardCategory = {
  name: string;
  sex: string;
  federation: string;
  weightRange: string;
  lifters: ScoreboardLifter[];
};

export type ScoreboardData = {
  currentLifter: {
    name: string;
    weight: number;
    lift: LiftType;
    attemptIndex: number;
  } | null;
  nextLifter: {
    name: string;
    weight: number;
  } | null;
  categories: ScoreboardCategory[];
  competitionMode: CompetitionMode;
};

// ═══════════════════════════════════════════════════════════════════════════════
// Font size control
// ═══════════════════════════════════════════════════════════════════════════════
const FONT_SIZE_KEY = "powerlifting.scoreboard.fontSize";
const MIN_FONT = 10;
const MAX_FONT = 32;

function useFontSize() {
  const [fontSize, setFontSize] = useState(() => {
    if (typeof window === "undefined") return 16;
    const saved = localStorage.getItem(FONT_SIZE_KEY);
    if (saved) {
      const n = parseInt(saved, 10);
      if (Number.isFinite(n) && n >= MIN_FONT && n <= MAX_FONT) return n;
    }
    return 16;
  });

  const [showControls, setShowControls] = useState(true);

  useEffect(() => {
    localStorage.setItem(FONT_SIZE_KEY, String(fontSize));
  }, [fontSize]);

  const increase = () => setFontSize((s) => Math.min(MAX_FONT, s + 1));
  const decrease = () => setFontSize((s) => Math.max(MIN_FONT, s - 1));

  return { fontSize, increase, decrease, showControls, setShowControls };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Live clock
// ═══════════════════════════════════════════════════════════════════════════════
function useLiveClock() {
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Data builder from existing Lifter[] (no new API — uses existing state)
// ═══════════════════════════════════════════════════════════════════════════════
function buildScoreboardData(
  lifters: Lifter[],
  currentLifterId: string | null,
  currentLift: LiftType,
  currentAttemptIndex: number,
  nextLifterId: string | null,
  competitionMode: CompetitionMode,
): ScoreboardData {
  const isBenchOnly = competitionMode === "BENCH_ONLY";

  // Scoreboard lifters with totals and GL points
  const scoredLifters: ScoreboardLifter[] = lifters.map((l) => {
    const squat = bestGoodLift(l.squatAttempts);
    const bench = bestGoodLift(l.benchAttempts);
    const deadlift = bestGoodLift(l.deadliftAttempts);
    const total = isBenchOnly ? bench : squat + bench + deadlift;
    const glPoints = calculateGLPoints(total, l.bodyweight, l.sex, l.isEquipped, isBenchOnly);
    return { ...l, total, glPoints };
  });

  // Group by category
  const categoryMap = new Map<string, ScoreboardLifter[]>();
  for (const lifter of scoredLifters) {
    const category = (lifter.category || "Unclassified").trim();
    if (!categoryMap.has(category)) categoryMap.set(category, []);
    categoryMap.get(category)!.push(lifter);
  }

  const categories: ScoreboardCategory[] = Array.from(categoryMap.entries())
    .map(([name, lifters]) => {
      const { sex, federation, weightRange } = parseCategoryParts(name);
      // Sort by lot number, then name
      const sorted = [...lifters].sort((a, b) => {
        const lotA = typeof a.lot === "number" ? a.lot : Infinity;
        const lotB = typeof b.lot === "number" ? b.lot : Infinity;
        if (lotA !== lotB) return lotA - lotB;
        return a.name.localeCompare(b.name);
      });
      return { name, sex, federation, weightRange, lifters: sorted };
    })
    .sort((a, b) => {
      const orderA = getCategorySortOrder(a.name);
      const orderB = getCategorySortOrder(b.name);
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });

  const currentLifter = lifters.find((l) => l.id === currentLifterId);
  const nextLifter = lifters.find((l) => l.id === nextLifterId);

  return {
    currentLifter: currentLifter
      ? {
          name: currentLifter.name,
          weight: resolveAttemptWeight(currentLifter, currentLift, currentAttemptIndex),
          lift: currentLift,
          attemptIndex: currentAttemptIndex,
        }
      : null,
    nextLifter: nextLifter
      ? {
          name: nextLifter.name,
          weight: resolveAttemptWeight(nextLifter, currentLift, currentAttemptIndex),
        }
      : null,
    categories,
    competitionMode,
  };
}

function getCategorySortOrder(category: string): number {
  const upper = category.toUpperCase();
  if (upper.includes("SUB JUNIOR")) return 0;
  if (upper.includes("JUNIOR")) return 1;
  if (upper.includes("SENIOR")) return 2;
  if (upper.includes("MASTER 4")) return 6;
  if (upper.includes("MASTER 3")) return 5;
  if (upper.includes("MASTER 2")) return 4;
  if (upper.includes("MASTER 1")) return 3;
  if (upper.includes("MASTER")) return 3;
  return 100;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main component
// ═══════════════════════════════════════════════════════════════════════════════
type LiveScoreboardProps = {
  lifters: Lifter[];
  currentLifterId: string | null;
  currentLift: LiftType;
  currentAttemptIndex: number;
  nextLifterId: string | null;
  competitionMode: CompetitionMode;
  activeGroupName: string | null;
  // TODO: Replace polling with your real-time API hook
  // TODO: Add `apiUrl?: string` and `pollInterval?: number` when you wire your backend
};

export default function LiveScoreboard({
  lifters,
  currentLifterId,
  currentLift,
  currentAttemptIndex,
  nextLifterId,
  competitionMode,
  activeGroupName,
}: LiveScoreboardProps) {
  const { fontSize, increase, decrease, showControls, setShowControls } = useFontSize();
  const clock = useLiveClock();
  const containerRef = useRef<HTMLDivElement>(null);

  // TODO: Replace this with your real API polling / WebSocket hook
  // Expected endpoint: GET /api/competition/{id}/scoreboard
  // Expected response shape:
  // {
  //   currentLifter: { name: "Aman", weight: 90.0, lift: "squat", attemptIndex: 0 },
  //   nextLifter: { name: "Rahul", weight: 100.0 },
  //   categories: [
  //     {
  //       name: "JUNIOR MEN (IPF)",
  //       sex: "MEN",
  //       federation: "IPF",
  //       weightRange: "53 – 59 KG",
  //       lifters: [...]
  //     }
  //   ],
  //   competitionMode: "FULL_GAME"
  // }
  // For now, we derive data from existing props (same as your current app)
  const data = useMemo(
    () => buildScoreboardData(lifters, currentLifterId, currentLift, currentAttemptIndex, nextLifterId, competitionMode),
    [lifters, currentLifterId, currentLift, currentAttemptIndex, nextLifterId, competitionMode],
  );

  // Keyboard shortcut: H = hide controls
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "h" || e.key === "H") {
        setShowControls((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setShowControls]);

  const isBenchOnly = competitionMode === "BENCH_ONLY";

  // Base CSS variable for rem scaling
  const rootStyle = { "--sb-font-base": `${fontSize}px` } as React.CSSProperties;

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full flex-col overflow-hidden bg-[#0a0a0a] font-sans"
      style={rootStyle}
    >
      {/* ════════════════════════════════════════════════
          TOP STATUS BAR
      ════════════════════════════════════════════════ */}
      <div
        className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2"
        style={{ fontSize: "calc(var(--sb-font-base) * 0.9375)" }}
      >
        {/* LEFT: Current lifter */}
        <div className="flex items-center gap-3">
          <span className="font-black uppercase tracking-wider text-[#f59e0b]">Current:</span>
          <span className="font-bold text-white">{data.currentLifter?.name || "—"}</span>
          <span className="text-white/30">|</span>
          <span className="font-bold text-[#22c55e]">
            {data.currentLifter?.weight ? `${data.currentLifter.weight} KG` : "—"}
          </span>
          <span className="text-white/30">|</span>
          <span className="font-bold uppercase tracking-wider text-[#9ca3af]">
            {data.currentLifter?.lift?.toUpperCase() || "SQUAT"} ATT {data.currentLifter ? data.currentLifter.attemptIndex + 1 : 1}
          </span>
          {activeGroupName && (
            <span className="ml-2 text-[#9ca3af]">
              — {activeGroupName}
            </span>
          )}
        </div>

        {/* CENTER: Next lifter */}
        <div className="flex items-center gap-3">
          <span className="font-black uppercase tracking-wider text-[#06b6d4]">Next:</span>
          <span className="font-bold text-white">{data.nextLifter?.name || "—"}</span>
          <span className="text-white/30">|</span>
          <span className="font-bold text-[#22c55e]">
            {data.nextLifter?.weight ? `${data.nextLifter.weight} KG` : "—"}
          </span>
        </div>

        {/* RIGHT: Live clock */}
        <div className="tabular-nums font-bold text-white/80">
          {clock}
        </div>
      </div>

      {/* ════════════════════════════════════════════════
          RESULTS TABLE (scrollable)
      ════════════════════════════════════════════════ */}
      <div className="flex-1 overflow-auto">
        {data.categories.map((category, catIdx) => {
          const colors = getCategoryColor(category.name);
          return (
            <div key={catIdx} className="mb-1">
              {/* Category header bar */}
              <div
                className="flex items-center gap-3 border-b px-4 py-1.5"
                style={{
                  backgroundColor: colors.bg,
                  borderColor: colors.border,
                  fontSize: "calc(var(--sb-font-base) * 0.875)",
                }}
              >
                <span className="font-black uppercase tracking-wider text-white">
                  {category.name}
                </span>
                <span className="text-white/60">
                  ({category.lifters.length})
                </span>
                {category.federation && (
                  <span className="rounded px-1.5 py-0.5 text-xs font-bold text-white/80 ring-1 ring-white/20">
                    {category.federation}
                  </span>
                )}
                {category.weightRange && (
                  <span className="ml-auto text-sm text-white/70">
                    Bodyweight: {category.weightRange}
                  </span>
                )}
              </div>

              {/* Lifters table */}
              <table className="w-full" style={{ borderCollapse: "collapse" }}>
                <thead>
                  <tr className="bg-[#111827]">
                    {/* Rank column */}
                    <th
                      rowSpan={2}
                      className="border border-white/5 px-1 py-1 text-center font-black uppercase tracking-wider text-[#9ca3af]"
                      style={{ fontSize: "calc(var(--sb-font-base) * 0.75)", width: "3%" }}
                    >
                      #
                    </th>
                    {/* Name */}
                    <th
                      rowSpan={2}
                      className="border border-white/5 px-2 py-1 text-left font-black uppercase tracking-wider text-[#9ca3af]"
                      style={{ fontSize: "calc(var(--sb-font-base) * 0.75)", width: "18%" }}
                    >
                      Name
                    </th>
                    {/* Team/District */}
                    <th
                      rowSpan={2}
                      className="border border-white/5 px-1 py-1 text-center font-black uppercase tracking-wider text-[#9ca3af]"
                      style={{ fontSize: "calc(var(--sb-font-base) * 0.75)", width: "6%" }}
                    >
                      Dist
                    </th>
                    {/* BW */}
                    <th
                      rowSpan={2}
                      className="border border-white/5 px-1 py-1 text-center font-black uppercase tracking-wider text-[#9ca3af]"
                      style={{ fontSize: "calc(var(--sb-font-base) * 0.75)", width: "5%" }}
                    >
                      BW
                    </th>
                    {/* SQUAT group header */}
                    {!isBenchOnly && (
                      <th
                        colSpan={3}
                        className="border border-white/5 px-1 py-0.5 text-center font-black uppercase tracking-wider text-[#9ca3af]"
                        style={{ fontSize: "calc(var(--sb-font-base) * 0.75)", width: "15%" }}
                      >
                        Squat
                      </th>
                    )}
                    {/* BENCH group header */}
                    <th
                      colSpan={3}
                      className="border border-white/5 px-1 py-0.5 text-center font-black uppercase tracking-wider text-[#9ca3af]"
                      style={{ fontSize: "calc(var(--sb-font-base) * 0.75)", width: "15%" }}
                    >
                      Bench Press
                    </th>
                    {/* DEADLIFT group header */}
                    {!isBenchOnly && (
                      <th
                        colSpan={3}
                        className="border border-white/5 px-1 py-0.5 text-center font-black uppercase tracking-wider text-[#9ca3af]"
                        style={{ fontSize: "calc(var(--sb-font-base) * 0.75)", width: "15%" }}
                      >
                        Deadlift
                      </th>
                    )}
                    {/* TOTAL */}
                    <th
                      rowSpan={2}
                      className="border border-white/5 px-1 py-1 text-center font-black uppercase tracking-wider text-[#9ca3af]"
                      style={{ fontSize: "calc(var(--sb-font-base) * 0.75)", width: "6%" }}
                    >
                      Total
                    </th>
                    {/* GL */}
                    <th
                      rowSpan={2}
                      className="border border-white/5 px-1 py-1 text-center font-black uppercase tracking-wider text-[#9ca3af]"
                      style={{ fontSize: "calc(var(--sb-font-base) * 0.75)", width: "6%" }}
                    >
                      GL
                    </th>
                  </tr>
                  {/* Sub-column headers */}
                  <tr className="bg-[#111827]">
                    {!isBenchOnly && (
                      <>
                        <th className="border border-white/5 px-1 py-0.5 text-center text-[10px] font-bold text-[#6b7280]" style={{ fontSize: "calc(var(--sb-font-base) * 0.6875)" }}>SQ1</th>
                        <th className="border border-white/5 px-1 py-0.5 text-center text-[10px] font-bold text-[#6b7280]" style={{ fontSize: "calc(var(--sb-font-base) * 0.6875)" }}>SQ2</th>
                        <th className="border border-white/5 px-1 py-0.5 text-center text-[10px] font-bold text-[#6b7280]" style={{ fontSize: "calc(var(--sb-font-base) * 0.6875)" }}>SQ3</th>
                      </>
                    )}
                    <th className="border border-white/5 px-1 py-0.5 text-center text-[10px] font-bold text-[#6b7280]" style={{ fontSize: "calc(var(--sb-font-base) * 0.6875)" }}>BP1</th>
                    <th className="border border-white/5 px-1 py-0.5 text-center text-[10px] font-bold text-[#6b7280]" style={{ fontSize: "calc(var(--sb-font-base) * 0.6875)" }}>BP2</th>
                    <th className="border border-white/5 px-1 py-0.5 text-center text-[10px] font-bold text-[#6b7280]" style={{ fontSize: "calc(var(--sb-font-base) * 0.6875)" }}>BP3</th>
                    {!isBenchOnly && (
                      <>
                        <th className="border border-white/5 px-1 py-0.5 text-center text-[10px] font-bold text-[#6b7280]" style={{ fontSize: "calc(var(--sb-font-base) * 0.6875)" }}>DL1</th>
                        <th className="border border-white/5 px-1 py-0.5 text-center text-[10px] font-bold text-[#6b7280]" style={{ fontSize: "calc(var(--sb-font-base) * 0.6875)" }}>DL2</th>
                        <th className="border border-white/5 px-1 py-0.5 text-center text-[10px] font-bold text-[#6b7280]" style={{ fontSize: "calc(var(--sb-font-base) * 0.6875)" }}>DL3</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {category.lifters.map((lifter, idx) => {
                    const isCurrent = lifter.id === currentLifterId;
                    const rowBg = isCurrent
                      ? "bg-cyan-500/10"
                      : idx % 2 === 0
                        ? "bg-[#0d0d0d]"
                        : "bg-[#111111]";
                    return (
                      <tr key={lifter.id} className={`${rowBg} border-b border-white/[0.03]`}>
                        {/* # */}
                        <td
                          className={`border border-white/5 px-1 py-1 text-center tabular-nums font-bold ${isCurrent ? "text-[#06b6d4]" : "text-[#6b7280]"}`}
                          style={{ fontSize: "calc(var(--sb-font-base) * 0.875)" }}
                        >
                          {idx + 1}
                        </td>
                        {/* NAME */}
                        <td
                          className={`border border-white/5 px-2 py-1 font-semibold text-white ${isCurrent ? "text-white" : ""}`}
                          style={{ fontSize: "calc(var(--sb-font-base) * 0.875)" }}
                        >
                          {isCurrent && <span className="mr-1 text-[#06b6d4]">▶</span>}
                          {lifter.name || "—"}
                        </td>
                        {/* DIST */}
                        <td
                          className="border border-white/5 px-1 py-1 text-center text-[#9ca3af]"
                          style={{ fontSize: "calc(var(--sb-font-base) * 0.8125)" }}
                        >
                          {lifter.team || "—"}
                        </td>
                        {/* BW */}
                        <td
                          className="border border-white/5 px-1 py-1 text-center tabular-nums text-[#9ca3af]"
                          style={{ fontSize: "calc(var(--sb-font-base) * 0.8125)" }}
                        >
                          {typeof lifter.bodyweight === "number" ? lifter.bodyweight.toFixed(1) : "—"}
                        </td>
                        {/* SQUAT attempts */}
                        {!isBenchOnly && (
                          <>
                            {lifter.squatAttempts.map((att, ai) => {
                              const cell = formatAttemptCell(att, false);
                              return (
                                <td
                                  key={`sq${ai}`}
                                  className={`border border-white/5 px-1 py-1 text-center tabular-nums ${cell.className}`}
                                  style={{ fontSize: "calc(var(--sb-font-base) * 0.875)" }}
                                >
                                  {cell.text}
                                </td>
                              );
                            })}
                          </>
                        )}
                        {/* BENCH attempts */}
                        {lifter.benchAttempts.map((att, ai) => {
                          const cell = formatAttemptCell(att, false);
                          return (
                            <td
                              key={`bp${ai}`}
                              className={`border border-white/5 px-1 py-1 text-center tabular-nums ${cell.className}`}
                              style={{ fontSize: "calc(var(--sb-font-base) * 0.875)" }}
                            >
                              {cell.text}
                            </td>
                          );
                        })}
                        {/* DEADLIFT attempts */}
                        {!isBenchOnly && (
                          <>
                            {lifter.deadliftAttempts.map((att, ai) => {
                              const cell = formatAttemptCell(att, false);
                              return (
                                <td
                                  key={`dl${ai}`}
                                  className={`border border-white/5 px-1 py-1 text-center tabular-nums ${cell.className}`}
                                  style={{ fontSize: "calc(var(--sb-font-base) * 0.875)" }}
                                >
                                  {cell.text}
                                </td>
                              );
                            })}
                          </>
                        )}
                        {/* TOTAL */}
                        <td
                          className="border border-white/5 px-1 py-1 text-center tabular-nums font-bold text-[#06b6d4]"
                          style={{ fontSize: "calc(var(--sb-font-base) * 0.875)" }}
                        >
                          {lifter.total > 0 ? lifter.total.toFixed(1) : "—"}
                        </td>
                        {/* GL */}
                        <td
                          className="border border-white/5 px-1 py-1 text-center tabular-nums font-bold text-white"
                          style={{ fontSize: "calc(var(--sb-font-base) * 0.875)" }}
                        >
                          {lifter.glPoints > 0 ? lifter.glPoints.toFixed(2) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}

        {data.categories.length === 0 && (
          <div className="flex h-64 items-center justify-center text-[#6b7280]">
            No lifters configured. Add lifters in the admin panel.
          </div>
        )}
      </div>

      {/* ════════════════════════════════════════════════
          BOTTOM LEGEND BAR
      ════════════════════════════════════════════════ */}
      <div
        className="flex shrink-0 items-center justify-center gap-6 border-t border-white/10 bg-[#0d0d0d] px-4 py-1.5"
        style={{ fontSize: "calc(var(--sb-font-base) * 0.75)" }}
      >
        <span className="font-bold text-white/60">ALL WEIGHTS IN KG</span>
        <span className="text-white/20">|</span>
        <span className="font-bold text-[#22c55e]">GREEN = GOOD LIFT</span>
        <span className="text-white/20">|</span>
        <span className="font-bold text-[#ef4444]">RED = NO LIFT</span>
        <span className="text-white/20">|</span>
        <span className="font-bold text-[#eab308]">YELLOW = MISSED LIFT</span>
        <span className="text-white/20">|</span>
        <span className="font-bold text-white/60">GL = GOOD LIFT POINTS</span>
      </div>

      {/* ════════════════════════════════════════════════
          FONT SIZE CONTROL (floating, bottom-right)
      ════════════════════════════════════════════════ */}
      {showControls && (
        <div className="fixed bottom-10 right-4 z-50 flex flex-col gap-2 rounded-lg border border-white/10 bg-black/80 px-3 py-2 shadow-xl backdrop-blur-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-white/60">Display Size</span>
            <button
              onClick={() => setShowControls(false)}
              className="rounded px-1 py-0.5 text-[10px] font-bold text-white/40 hover:bg-white/10 hover:text-white"
              title="Hide (H)"
            >
              ✕
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={decrease}
              className="flex h-7 w-7 items-center justify-center rounded bg-white/10 text-sm font-bold text-white hover:bg-white/20"
              aria-label="Decrease font size"
            >
              −
            </button>
            <span className="min-w-[2.5rem] text-center text-sm font-bold text-white tabular-nums">
              {fontSize}px
            </span>
            <button
              onClick={increase}
              className="flex h-7 w-7 items-center justify-center rounded bg-white/10 text-sm font-bold text-white hover:bg-white/20"
              aria-label="Increase font size"
            >
              +
            </button>
          </div>
          <p className="text-[10px] text-white/30">Press H to toggle</p>
        </div>
      )}

      {/* Hidden corner button to re-show controls */}
      {!showControls && (
        <button
          onClick={() => setShowControls(true)}
          className="fixed bottom-2 right-2 z-50 h-6 w-6 rounded-full bg-white/5 text-[10px] text-white/20 hover:bg-white/10 hover:text-white/50"
          title="Show controls (H)"
        >
          ⚙
        </button>
      )}
    </div>
  );
}
