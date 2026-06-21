import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import type { RefSignal, RefereSignalState, SignalState } from "./types";
import { dbRefereeSessions, dbSignalHistory, dbRefereeSignals } from "./db";
import type { DbRefereeSession, DbSignalHistory } from "./types";

interface RefereSignalContextType {
  signals: RefereSignalState[];
  sessionId: string | null;
  competitionId: string | null;
  isSessionValid: boolean;
  sessionExpiresAt: Date | null;
  createNewSession: (competitionId: string) => Promise<string>;
  invalidateAllSessions: (competitionId: string) => Promise<void>;
  validateSession: (sessionId: string) => Promise<boolean>;
  submitSignal: (position: number, signal: RefSignal, deviceId: string) => Promise<void>;
  markSignalDelivered: (position: number, historyId: string) => Promise<void>;
  getSignalState: (position: number) => RefereSignalState;
  resetAllSignals: () => Promise<void>;
}

const RefereSignalContext = createContext<RefereSignalContextType | null>(null);

interface RefereSignalManagerProps {
  competitionId: string;
  children: React.ReactNode;
}

const INITIAL_SIGNAL_STATE: RefereSignalState = {
  position: 0,
  signal: null,
  state: "IDLE",
};

export function RefereSignalManager({ competitionId, children }: RefereSignalManagerProps) {
  const [signals, setSignals] = useState<RefereSignalState[]>([
    { ...INITIAL_SIGNAL_STATE, position: 0 },
    { ...INITIAL_SIGNAL_STATE, position: 1 },
    { ...INITIAL_SIGNAL_STATE, position: 2 },
  ]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isSessionValid, setIsSessionValid] = useState(false);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<Date | null>(null);
  const [signalHistoryMap, setSignalHistoryMap] = useState<Map<number, string>>(new Map());

  const createNewSession = useCallback(
    async (compId: string) => {
      try {
        const session = await dbRefereeSessions.create(compId);
        setSessionId(session.id);
        setIsSessionValid(true);
        setSessionExpiresAt(new Date(session.expires_at));
        return session.id;
      } catch (error) {
        console.error("Failed to create referee session:", error);
        throw error;
      }
    },
    []
  );

  const invalidateAllSessions = useCallback(async (compId: string) => {
    try {
      await dbRefereeSessions.invalidateAll(compId);
      setSessionId(null);
      setIsSessionValid(false);
      setSignals([
        { ...INITIAL_SIGNAL_STATE, position: 0 },
        { ...INITIAL_SIGNAL_STATE, position: 1 },
        { ...INITIAL_SIGNAL_STATE, position: 2 },
      ]);
      setSignalHistoryMap(new Map());
    } catch (error) {
      console.error("Failed to invalidate sessions:", error);
      throw error;
    }
  }, []);

  const validateSession = useCallback(async (sid: string) => {
    try {
      const session = await dbRefereeSessions.validate(sid);
      if (session) {
        setSessionId(sid);
        setIsSessionValid(true);
        setSessionExpiresAt(new Date(session.expires_at));
        return true;
      }
      setIsSessionValid(false);
      return false;
    } catch (error) {
      console.error("Failed to validate session:", error);
      setIsSessionValid(false);
      return false;
    }
  }, []);

  const submitSignal = useCallback(
    async (position: number, signal: RefSignal, deviceId: string) => {
      if (!sessionId || !isSessionValid || !signal) return;

      try {
        const history = await dbSignalHistory.create(sessionId, competitionId, position, signal, deviceId);
        setSignalHistoryMap((prev) => new Map(prev).set(position, history.id));

        setSignals((prev) =>
          prev.map((s) =>
            s.position === position
              ? {
                  ...s,
                  signal,
                  state: "SUBMITTED" as SignalState,
                  submittedAt: new Date(),
                }
              : s
          )
        );

        await dbRefereeSignals.upsertSignal(competitionId, position, signal, deviceId);
      } catch (error) {
        console.error("Failed to submit signal:", error);
        throw error;
      }
    },
    [sessionId, isSessionValid, competitionId]
  );

  const markSignalDelivered = useCallback(
    async (position: number, historyId: string) => {
      try {
        await dbSignalHistory.markDelivered(historyId);
        setSignals((prev) =>
          prev.map((s) =>
            s.position === position
              ? {
                  ...s,
                  state: "DELIVERED" as SignalState,
                  deliveredAt: new Date(),
                }
              : s
          )
        );
      } catch (error) {
        console.error("Failed to mark signal delivered:", error);
        throw error;
      }
    },
    []
  );

  const getSignalState = useCallback(
    (position: number): RefereSignalState => {
      return signals[position] || { ...INITIAL_SIGNAL_STATE, position };
    },
    [signals]
  );

  const resetAllSignals = useCallback(async () => {
    try {
      await dbRefereeSignals.clearAll(competitionId);
      setSignals([
        { ...INITIAL_SIGNAL_STATE, position: 0 },
        { ...INITIAL_SIGNAL_STATE, position: 1 },
        { ...INITIAL_SIGNAL_STATE, position: 2 },
      ]);
      setSignalHistoryMap(new Map());
    } catch (error) {
      console.error("Failed to reset signals:", error);
      throw error;
    }
  }, [competitionId]);

  const value: RefereSignalContextType = {
    signals,
    sessionId,
    competitionId,
    isSessionValid,
    sessionExpiresAt,
    createNewSession,
    invalidateAllSessions,
    validateSession,
    submitSignal,
    markSignalDelivered,
    getSignalState,
    resetAllSignals,
  };

  return (
    <RefereSignalContext.Provider value={value}>{children}</RefereSignalContext.Provider>
  );
}

export function useRefereSignalManager() {
  const context = useContext(RefereSignalContext);
  if (!context) {
    throw new Error("useRefereSignalManager must be used within RefereSignalManager provider");
  }
  return context;
}
