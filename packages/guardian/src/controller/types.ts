export type FlagStatus =
  | 'idle'          // not rolling out
  | 'rolling'       // at a step, healthy so far
  | 'holding'       // at a step, waiting for data / samples
  | 'complete'      // reached the last step
  | 'rolled_back'   // guard breached, flag turned off
  | 'held'          // guard breached with on_breach: hold
  | 'watching';     // watching after a manual change

export interface FlagRuntime {
  status: FlagStatus;
  stepIndex: number;
  percent: number;
  stepStartedAt: number;
  breachStreak: number;
  values: Record<string, number | null>;
  samples: number | null;
  watchUntil?: number;
  /** status to return to when a watch window ends */
  afterWatch?: FlagStatus;
  reason?: string;
  /** a rollback failed part-way (e.g. override deleted, default PATCH failed); retried each tick */
  rollbackPending?: boolean;
  /** someone changed the flag outside Guardian, so `percent` no longer says who gets it */
  manualExposure?: boolean;
  updatedAt: number;
}

export type EventType =
  | 'started'
  | 'step_advanced'
  | 'holding'
  | 'breach_detected'
  | 'rolled_back'
  | 'held'
  | 'completed'
  | 'manual_change_detected'
  | 'watch_ended'
  | 'resumed'
  | 'error';

export interface GuardianEvent {
  ts: number;
  flag: string;
  type: EventType;
  message: string;
  percent?: number;
  values?: Record<string, number | null>;
}

export const initialRuntime = (now: number): FlagRuntime => ({
  status: 'idle',
  stepIndex: -1,
  percent: 0,
  stepStartedAt: now,
  breachStreak: 0,
  values: {},
  samples: null,
  updatedAt: now,
});
