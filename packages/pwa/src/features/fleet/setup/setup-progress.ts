/**
 * "Finish later" keeps your place: the answers and the step of a machine's first run, kept in THIS
 * browser so coming back to `/d/<id>/setup` resumes where you left.
 *
 * Nothing in it is a secret or a value from the machine — only which tools were imported or skipped,
 * the runtime names typed, and the step — and nothing is sent anywhere: a first run imports nothing
 * until its last step. Browser storage can be absent (a private window, blocked site data), so every
 * read and write is guarded, and the setup still works without it; it only starts at the top.
 */

import { z } from 'zod';
import type { DaemonId } from '../../../lib/daemon-connection.ts';
import type { FirstRunAnswers } from './first-run-model.ts';
import {
  type MachineSetupProgress,
  type MachineSetupStepId,
  type MachineSetupTaskId,
  ONBOARDING_STEPS,
  ONBOARDING_TASKS,
} from './onboarding-model.ts';

/** The one browser-storage key for setup progress. */
export const SETUP_PROGRESS_KEY = 'fy-setup-progress-v1';

export interface FirstRunProgress {
  /** The step to come back to. */
  readonly at: string;
  readonly answers: FirstRunAnswers;
}

/** What the first run is handed: what was kept, and how to keep more (`null` forgets it). */
export interface FirstRunProgressPort {
  readonly saved: FirstRunProgress | null;
  readonly save: (progress: FirstRunProgress | null) => void;
}

const Harness = z.enum(['claude', 'codex']);
const ProgressSchema = z.object({
  at: z.string().min(1),
  answers: z.object({
    choices: z.partialRecord(Harness, z.enum(['import', 'skip'])),
    names: z.partialRecord(Harness, z.string()),
    make: z.partialRecord(Harness, z.boolean()),
    accepted: z.array(z.string()),
  }),
});
const StoredSchema = z.record(z.string(), ProgressSchema);

type Stored = z.infer<typeof StoredSchema>;

/** Every machine's kept progress. An unreadable or hand-edited value is nothing kept, never an error. */
const readAll = (storage: Pick<Storage, 'getItem'>): Stored => {
  try {
    const parsed = StoredSchema.safeParse(JSON.parse(storage.getItem(SETUP_PROGRESS_KEY) ?? '{}'));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
};

export const readSetupProgress = (storage: Pick<Storage, 'getItem'>, daemonId: DaemonId): FirstRunProgress | null =>
  readAll(storage)[String(daemonId)] ?? null;

export const writeSetupProgress = (
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  daemonId: DaemonId,
  progress: FirstRunProgress | null,
): void => {
  const { [String(daemonId)]: _previous, ...others } = readAll(storage);
  try {
    storage.setItem(
      SETUP_PROGRESS_KEY,
      JSON.stringify(progress === null ? others : { ...others, [daemonId]: progress }),
    );
  } catch {
    // Full or blocked storage: the setup still works, it just cannot resume.
  }
};

/** The browser's own storage, or `null` where reaching it throws. */
export const browserSetupStorage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

// ── New machine setup ────────────────────────────────────────────────────────────────────────────

/**
 * The browser-storage key for the New machine setup rail: which step is open, which were set or
 * skipped, and fresh-or-clone. Step ids and those two words only — never a value from the machine.
 */
export const MACHINE_SETUP_PROGRESS_KEY = 'fy-onboarding-progress-v1';

const StepState = z.enum(['done', 'skipped']);
const MachineSetupProgressSchema = z.object({
  at: z.enum(ONBOARDING_STEPS.map(step => step.id) as [MachineSetupStepId, ...MachineSetupStepId[]]),
  states: z.partialRecord(z.enum(ONBOARDING_TASKS as [MachineSetupTaskId, ...MachineSetupTaskId[]]), StepState),
  start: z.enum(['fresh', 'clone']),
});
const StoredMachineSetupSchema = z.record(z.string(), MachineSetupProgressSchema);

/** What the rail is handed: what was kept, and how to keep more (`null` forgets it). */
export interface MachineSetupProgressPort {
  readonly saved: MachineSetupProgress | null;
  readonly save: (progress: MachineSetupProgress | null) => void;
}

const readAllMachineSetup = (storage: Pick<Storage, 'getItem'>): Record<string, MachineSetupProgress> => {
  try {
    const parsed = StoredMachineSetupSchema.safeParse(JSON.parse(storage.getItem(MACHINE_SETUP_PROGRESS_KEY) ?? '{}'));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
};

export const readMachineSetupProgress = (
  storage: Pick<Storage, 'getItem'>,
  daemonId: DaemonId,
): MachineSetupProgress | null => readAllMachineSetup(storage)[String(daemonId)] ?? null;

export const writeMachineSetupProgress = (
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  daemonId: DaemonId,
  progress: MachineSetupProgress | null,
): void => {
  const { [String(daemonId)]: _previous, ...others } = readAllMachineSetup(storage);
  try {
    storage.setItem(
      MACHINE_SETUP_PROGRESS_KEY,
      JSON.stringify(progress === null ? others : { ...others, [daemonId]: progress }),
    );
  } catch {
    // Full or blocked storage: the setup still works, it just starts at the top next time.
  }
};
