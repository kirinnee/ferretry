/**
 * What the "Default for new agents" control on the Runtimes tab SAYS — the pure half of
 * `./default-runtime.tsx`.
 *
 * Each option names its runtime and says its state in words, from what the Runtimes tab already read:
 * a runtime that is switched off, whose CLI is not installed or whose login cannot start anything says
 * so BEFORE it is picked, so a broken default is visible at a glance.
 */

import type { FleetMachineView, FleetRuntimeView } from '@ferretry/protocol';
import { HARNESS_NAMES } from '../components/component-model.ts';
import { untilWords } from '../shell/disable-model.ts';
import { harnessInstalled } from './runtimes-model.ts';

export const DEFAULT_RUNTIME_LABEL = 'Default for new agents';
export const DEFAULT_RUNTIME_HINT = 'Used when a start names no runtime.';

/** Said when no default is set: the daemon picks one itself. */
export const AUTOMATIC_DEFAULT = 'automatic';

const LOGIN_WORDS: Readonly<Record<NonNullable<FleetRuntimeView['credential']['status']> | 'checking', string>> = {
  ready: 'ready',
  refresh_due: 'refresh due',
  needs_sign_in: 'needs sign-in',
  checking: 'checking',
};

/** The runtimes that can be the default: the agent ones, in the order the list shows them. */
export const agentRuntimes = (runtimes: readonly FleetRuntimeView[]): readonly FleetRuntimeView[] =>
  runtimes.filter(runtime => runtime.agent);

/** One runtime's state in a few words: "ready", "disabled until 4 Nov 2026", "Codex not installed". */
export const runtimeStateWords = (runtime: FleetRuntimeView, machine: FleetMachineView | null): string => {
  if (runtime.disabled !== undefined)
    return runtime.disabled.until === undefined
      ? 'switched off'
      : `switched off until ${untilWords(runtime.disabled.until)}`;
  if (!harnessInstalled(machine, runtime.harness)) return `${HARNESS_NAMES[runtime.harness]} not installed`;
  return LOGIN_WORDS[runtime.credential.status ?? 'checking'];
};

/** An option of the select: "claude-default · ready". */
export const defaultOptionLabel = (runtime: FleetRuntimeView, machine: FleetMachineView | null): string =>
  `${runtime.name} · ${runtimeStateWords(runtime, machine)}`;

/** Whether this runtime is the machine's default for new agents. */
export const isDefaultRuntime = (machine: FleetMachineView | null, runtime: FleetRuntimeView): boolean =>
  machine?.defaultRuntime === runtime.name;

/** The "Keep …" button's words. */
export const keepDefaultLabel = (current: string | null): string => `Keep ${current ?? AUTOMATIC_DEFAULT}`;
