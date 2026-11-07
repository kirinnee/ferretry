/**
 * What renaming and removing a runtime SAY and offer — the pure half of `./runtime-actions.tsx`
 * (docs/account-model.md "Renaming a runtime").
 *
 * The daemon decides what a rename or a removal does — it refuses a clash, a former name, the default
 * runtime — and its dry run lists the ferrets running on a runtime. This module only turns those
 * answers, and what the browser already holds, into the words and choices on screen.
 */

import type {
  FleetAccountChangeView,
  FleetMachineView,
  FleetRunningSession,
  FleetRuntimeView,
  MigrationConversation,
} from '@ferretry/protocol';
import { grantGuidance } from '../../../lib/grants.ts';
import type { FleetApplyAuthority } from '../shell/apply-change.ts';
import { type NameProblem, runtimeNameProblem } from './runtimes-model.ts';

/** The sentence every rename shows: what it does NOT do. */
export const RENAME_KEEPS_RUNNING = 'Running ferrets keep working — nothing restarts.';

/** Why a new name for `runtime` cannot be used, or `null`. Its own name is not a clash, only a no-op. */
export const renameProblem = (
  value: string,
  runtime: FleetRuntimeView,
  runtimes: readonly FleetRuntimeView[],
  machineName: string,
): NameProblem | null => {
  if (value === runtime.name) return { message: `It is already called ${runtime.name}.` };
  return runtimeNameProblem(
    value,
    runtimes.filter(other => other.name !== runtime.name),
    machineName,
  );
};

/**
 * Why this browser may not rename or remove a runtime here, as one sentence, or `null` when it may (or
 * cannot tell yet — the daemon refuses an apply it may not make, so an unknown answer is not a "no").
 */
export const runtimeActionRefusal = (authority: FleetApplyAuthority | null): string | null =>
  authority?.kind === 'refused' ? grantGuidance(authority.refusal, 'fleet').explanation : null;

/** Whether removing this runtime has to wait for another default runtime for new agents. */
export const blocksAsDefault = (runtime: FleetRuntimeView, machine: FleetMachineView | null): boolean =>
  machine?.defaultRuntime === runtime.name;

/** The agent runtimes that could become the default instead of this one. */
export const defaultCandidates = (
  runtime: FleetRuntimeView,
  runtimes: readonly FleetRuntimeView[],
): readonly FleetRuntimeView[] => runtimes.filter(other => other.name !== runtime.name && other.agent);

/**
 * The runtimes the ferrets on this one could move to: every other runtime that can launch, the ones on
 * the same CLI first, because those carry the conversation as it is.
 */
export const moveTargets = (
  runtime: FleetRuntimeView,
  runtimes: readonly FleetRuntimeView[],
): readonly FleetRuntimeView[] => {
  const others = runtimes.filter(other => other.name !== runtime.name && other.launch.available);
  return [
    ...others.filter(other => other.harness === runtime.harness),
    ...others.filter(other => other.harness !== runtime.harness),
  ];
};

/** How a moved ferret keeps its conversation: resumed on the same CLI, converted across to the other. */
export const moveConversation = (session: FleetRunningSession, target: FleetRuntimeView): MigrationConversation =>
  session.harness === target.harness ? 'resume' : 'convert';

/** The ferrets still running on the runtime, from the daemon's dry run of its removal. */
export const runningOnRuntime = (staged: FleetAccountChangeView): readonly FleetRunningSession[] =>
  staged.preview.kind === 'apply' ? (staged.preview.runningSessions ?? []) : [];

const ferrets = (count: number): string => `${String(count)} ${count === 1 ? 'ferret' : 'ferrets'}`;

/** The confirm button: exactly what pressing it does. */
export const removeLabel = (runtime: FleetRuntimeView, moving: number, target: string | null): string =>
  target === null || moving === 0
    ? `Remove ${runtime.name}`
    : `Move ${ferrets(moving)} to ${target} and remove ${runtime.name}`;

/** One line under the list of ferrets, for the choice the person made about them. */
export const movePlanSentence = (moving: number, target: string | null): string =>
  target === null
    ? `${moving === 1 ? 'It keeps' : 'They keep'} running until ${moving === 1 ? 'it ends' : 'they end'}.`
    : moving === 1
      ? `The ferret restarts on ${target} first, with its conversation, then the runtime is removed.`
      : `${ferrets(moving)} restart on ${target} first, each with its conversation, then the runtime is removed.`;
