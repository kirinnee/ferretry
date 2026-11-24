/**
 * What the "Default for new agents" control on the Runtimes tab SAYS — the pure half of
 * `./default-runtime.tsx`.
 *
 * Each option names its runtime and says its state in words, from what the Runtimes tab already read:
 * a runtime that is switched off, whose CLI is not installed or whose login cannot start anything says
 * so BEFORE it is picked, so a broken default is visible at a glance.
 */

import {
  type MachineView,
  type RuntimeAccounts,
  type RuntimeView,
  runtimeDisplayName,
} from '../../../../contract/index.ts';
import { untilWords } from '../shell/disable-model.ts';
import { harnessInstalled } from './runtimes-model.ts';
import { harnessName } from '../../../../contract/harness-words.ts';

export const DEFAULT_RUNTIME_LABEL = 'Default for new agents';
export const DEFAULT_RUNTIME_HINT = 'Used when a start names no runtime.';

/** Said when no default is set: the daemon picks one itself. */
export const AUTOMATIC_DEFAULT = 'automatic';

const LOGIN_WORDS: Readonly<Record<NonNullable<RuntimeView['credential']['status']> | 'checking', string>> = {
  ready: 'ready',
  refresh_due: 'refresh due',
  needs_sign_in: 'needs sign-in',
  checking: 'checking',
};

/** One runtime's state in a few words: "ready", "disabled until 4 Nov 2026", "Codex not installed". */
export const runtimeStateWords = (runtime: RuntimeView, machine: MachineView | null): string => {
  if (runtime.disabled !== undefined)
    return runtime.disabled.until === undefined
      ? 'switched off'
      : `switched off until ${untilWords(runtime.disabled.until)}`;
  if (!harnessInstalled(machine, runtime.harness)) return `${harnessName(runtime.harness)} not installed`;
  return LOGIN_WORDS[runtime.credential.status ?? 'checking'];
};

/** An option of the select: the name only ("claude-default"); its state is the badge beside the select. */
export const defaultOptionLabel = (
  runtime: RuntimeView,
  runtimes: readonly RuntimeView[],
  accounts: RuntimeAccounts,
): string => runtimeDisplayName(runtime, runtimes, accounts);

/** Whether this runtime is the machine's default for new agents. */
export const isDefaultRuntime = (machine: MachineView | null, runtime: RuntimeView): boolean =>
  machine?.defaultRuntime === runtime.name;

/** The "Keep …" button's words. */
export const keepDefaultLabel = (current: string | null): string => `Keep ${current ?? AUTOMATIC_DEFAULT}`;
