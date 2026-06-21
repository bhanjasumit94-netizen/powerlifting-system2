import type {
  Lifter,
  Group,
  RefSignal,
  LiftType,
  TimerPhase,
  CompetitionMode,
  NextAttemptEntry,
  CompetitionRecord,
} from "./types";

type BroadcastPayload = Partial<{
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
  competitions: CompetitionRecord[];
  activeCompetitionId: string | null;
}>;

let broadcastFn: ((payload: BroadcastPayload) => void) | null = null;

export function initializeStateManager(broadcast: (payload: BroadcastPayload) => void) {
  broadcastFn = broadcast;
}

function ensureBroadcast() {
  if (!broadcastFn) {
    throw new Error("State manager not initialized. Call initializeStateManager first.");
  }
}

export function createStateSetters<T extends keyof BroadcastPayload>(
  stateSetterFn: (value: BroadcastPayload[T]) => void,
) {
  return (value: BroadcastPayload[T]) => {
    stateSetterFn(value);
    ensureBroadcast();
    broadcastFn!({ [stateSetterFn.name]: value } as BroadcastPayload);
  };
}

export function wrapStateSetter<T>(
  key: keyof BroadcastPayload,
  stateSetterFn: (value: T) => void,
): (value: T) => void {
  return (value: T) => {
    stateSetterFn(value);
    ensureBroadcast();
    broadcastFn!({ [key]: value } as BroadcastPayload);
  };
}

export function broadcastState(payload: BroadcastPayload) {
  ensureBroadcast();
  broadcastFn!(payload);
}

export const GUARDED_STATE_KEY = "__GUARDED_STATE__";

export function createGuardedStateSetter<T>(
  key: keyof BroadcastPayload,
  stateSetterFn: (value: T) => void,
) {
  return function setState(value: T) {
    if (!(this && this[GUARDED_STATE_KEY])) {
      if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
        console.warn(
          `[StateManager] Direct state setter called for "${key}". Use the wrapper function instead.`,
        );
      }
      return;
    }
    stateSetterFn(value);
    ensureBroadcast();
    broadcastFn!({ [key]: value } as BroadcastPayload);
  };
}
