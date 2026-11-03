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
  isMachineSetupStepId,
  type MachineSetupProgress,
  type MachineSetupStepId,
  type MachineSetupTaskId,
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

/**
 * What an earlier rail stored. Ten steps became five: Voice, Learning and Agent controls are the Defaults
 * page, the Warden's question moved onto Speed-ups, and Pair is never a step. Reading maps each old id to
 * where its subject lives now, so a kept place opens on a real page and no set step is lost.
 */
const MOVED_TO: Readonly<Record<string, MachineSetupStepId>> = {
  pair: 'start',
  voice: 'defaults',
  learning: 'defaults',
  controls: 'defaults',
  warden: 'speedups',
};

const migratedAt = (at: string): MachineSetupStepId | null => (isMachineSetupStepId(at) ? at : (MOVED_TO[at] ?? null));

const migratedStates = (
  stored: Readonly<Record<string, 'done' | 'skipped' | undefined>>,
): MachineSetupProgress['states'] => {
  const states: Partial<Record<MachineSetupTaskId, 'done' | 'skipped'>> = {};
  for (const [id, state] of Object.entries(stored)) {
    if (state === undefined) continue;
    const target = isMachineSetupStepId(id) ? id : MOVED_TO[id];
    if (target === undefined || target === 'done') continue;
    // The Warden's old step is not a Speed-ups answer, and pairing was never a choice.
    if (id === 'warden' || id === 'pair') continue;
    // A moved step is set when any of the pages it became was set, and only skipped when all were not.
    if (states[target] !== 'done') states[target] = state;
  }
  return states;
};

const MachineSetupProgressSchema = z
  .object({
    at: z.string(),
    states: z.record(z.string(), StepState.optional()),
    start: z.enum(['fresh', 'clone']),
    answers: z.partialRecord(Harness, HarnessAnswersSchema).optional(),
  })
  .transform((stored, context): MachineSetupProgress => {
    const at = migratedAt(stored.at);
    if (at === null) {
      context.addIssue({ code: 'custom', message: 'Not a setup step.' });
      return z.NEVER;
    }
    return {
      at,
      states: migratedStates(stored.states),
      start: stored.start,
      ...(stored.answers === undefined ? {} : { answers: stored.answers }),
    };
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
