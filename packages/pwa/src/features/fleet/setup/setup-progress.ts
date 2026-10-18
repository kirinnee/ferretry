/**
 * "Finish later" keeps your place: where a machine's New machine setup is, which steps were set or
 * skipped, fresh-or-clone, and the runtime names typed on the Claude Code and Codex steps — kept in THIS
 * browser so coming back to `/d/<id>/setup` resumes where you left.
 *
 * Nothing in it is a secret or a value from the machine — step ids, a few words and the names typed — and
 * nothing is sent anywhere. Browser storage can be absent (a private window, blocked site data), so every
 * read and write is guarded, and the setup still works without it; it only starts at the top.
 */

import { z } from 'zod';
import type { DaemonId } from '../../../lib/daemon-connection.ts';
import {
  type MachineSetupProgress,
  type MachineSetupStepId,
  type MachineSetupTaskId,
  ONBOARDING_STEPS,
  ONBOARDING_TASKS,
} from './onboarding-model.ts';

/** The browser's own storage, or `null` where reaching it throws. */
export const browserSetupStorage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/**
 * The browser-storage key for the New machine setup rail. Version 2: the rail's Logins step became the
 * Claude Code and Codex steps, so a place kept by version 1 is not resumed.
 */
export const MACHINE_SETUP_PROGRESS_KEY = 'fy-onboarding-progress-v2';

const StepState = z.enum(['done', 'skipped']);
const Harness = z.enum(['claude', 'codex']);
const HarnessAnswersSchema = z.object({
  name: z.string().optional(),
  addAnother: z.boolean().optional(),
  accepted: z.array(z.string()).optional(),
});
const MachineSetupProgressSchema = z.object({
  at: z.enum(ONBOARDING_STEPS.map(step => step.id) as [MachineSetupStepId, ...MachineSetupStepId[]]),
  states: z.partialRecord(z.enum(ONBOARDING_TASKS as [MachineSetupTaskId, ...MachineSetupTaskId[]]), StepState),
  start: z.enum(['fresh', 'clone']),
  answers: z.partialRecord(Harness, HarnessAnswersSchema).optional(),
});
const StoredMachineSetupSchema = z.record(z.string(), MachineSetupProgressSchema);

/** What the rail is handed: what was kept, and how to keep more (`null` forgets it). */
export interface MachineSetupProgressPort {
  readonly saved: MachineSetupProgress | null;
  readonly save: (progress: MachineSetupProgress | null) => void;
}

/** Every machine's kept progress. An unreadable or hand-edited value is nothing kept, never an error. */
const readAllMachineSetup = (storage: Pick<Storage, 'getItem'>): Record<string, MachineSetupProgress> => {
  try {
    const parsed = StoredMachineSetupSchema.safeParse(JSON.parse(storage.getItem(MACHINE_SETUP_PROGRESS_KEY) ?? '{}'));
    return parsed.success ? (parsed.data as Record<string, MachineSetupProgress>) : {};
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
