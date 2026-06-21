import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { useAppContext } from "../App";

const REFEREE_SLOTS = [
  { key: "left", label: "Left", index: 0 },
  { key: "center", label: "Center", index: 1 },
  { key: "right", label: "Right", index: 2 },
];

const REFEREE_CONFIRM_DELAY_MS = 1000;

export const RefereePanelPage = () => {
  const {
    activeCompetitionId,
    refereeSignals,
    setRefereeSignals,
  } = useAppContext();

  const [decisionEndsAt, setDecisionEndsAt] = useState<number | null>(null);
  const [pendingDecision, setPendingDecision] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [pendingPosition, setPendingPosition] = useState<number | null>(null);

  useEffect(() => {
    if (!decisionEndsAt) return;
    const ticker = window.setInterval(() => setNow(Date.now()), 50);
    return () => window.clearInterval(ticker);
  }, [decisionEndsAt]);

  const startHold = (position: number, decision: string) => {
    if (pendingDecision) return;
    setPendingPosition(position);
    setPendingDecision(decision);
    setDecisionEndsAt(Date.now() + REFEREE_CONFIRM_DELAY_MS);

    const timer = window.setTimeout(() => {
      if (navigator.vibrate) navigator.vibrate(80);
      const nextSignals = refereeSignals.map((s, idx) =>
        idx === position ? decision : s
      );
      setRefereeSignals(nextSignals);
      setPendingDecision(null);
      setPendingPosition(null);
      setDecisionEndsAt(null);
    }, REFEREE_CONFIRM_DELAY_MS);

    return () => window.clearTimeout(timer);
  };

  const countdown = decisionEndsAt ? Math.max(0, (decisionEndsAt - now) / 1000) : 0;

  return (
    <div className="min-h-screen bg-[#05070f] p-6 text-white">
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-2 text-2xl font-bold">Referee Panel</h1>
        <p className="mb-6 text-sm text-slate-400">
          Competition: {activeCompetitionId ?? "—"} · Verdict is recorded on the display screen after all three
          signals are in.
        </p>

        <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-3">
          {REFEREE_SLOTS.map((slot) => {
            const signal = refereeSignals[slot.index];
            return (
              <motion.div
                key={slot.key}
                className="rounded-2xl border border-white/10 bg-white/5 p-6"
                whileHover={{ scale: 1.02 }}
              >
                <h3 className="mb-4 text-center text-lg font-semibold">{slot.label}</h3>
                <div className="mb-4 flex justify-center gap-3">
                  <button
                    onMouseDown={() => startHold(slot.index, "GOOD")}
                    className="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700"
                  >
                    GOOD
                  </button>
                  <button
                    onMouseDown={() => startHold(slot.index, "NO")}
                    className="rounded-lg bg-rose-600 px-4 py-2 font-semibold text-white hover:bg-rose-700"
                  >
                    NO
                  </button>
                </div>
                {pendingPosition === slot.index && pendingDecision && (
                  <p className="text-center text-sm text-amber-300">
                    Hold… {countdown.toFixed(1)}s ({pendingDecision})
                  </p>
                )}
                <p className="mt-2 text-center text-sm text-slate-400">
                  Current: {signal ?? "—"}
                </p>
              </motion.div>
            );
          })}
        </div>

        <div className="flex justify-center">
          <button
            onClick={() => setRefereeSignals([null, null, null])}
            className="rounded-lg bg-amber-600 px-6 py-3 font-semibold text-white transition-colors hover:bg-amber-700"
          >
            Reset All Signals
          </button>
        </div>
      </div>
    </div>
  );
};
