/**
 * The fields of a ferret's session document the runtime pickers read, and the two small pieces of the composer's
 * runtime bar they share. The session document is Ferrets' wire and the bar is the conversation app's; neither
 * has published its types through a contract yet, so these are the smallest copies the pickers need.
 */

import type { HarnessKey } from '@ferretry/core-ferrets/contract';

// GAP(ferrets): `SessionView` is not in Ferrets' contract; these are the only fields the runtime pickers read.
export interface RuntimeSessionView {
  readonly config: {
    readonly id: string;
    readonly harness: HarnessKey;
    readonly model?: string | undefined;
    readonly modelHint?: string | undefined;
    readonly harnessFlags?: readonly string[] | undefined;
    readonly launchReasoningEffort?: string | undefined;
    readonly launchFast?: boolean | undefined;
  };
  readonly state: {
    readonly status: string;
    readonly turnState?: string | undefined;
    readonly promptReady?: boolean | undefined;
    readonly observedModel?: string | undefined;
    readonly observedReasoningEffort?: string | undefined;
    readonly observedFast?: boolean | undefined;
  };
}

// GAP(conversation): `RuntimePickerPresentation`, `RuntimeSwitchLifecycle` and `launchedModel` are the composer
// runtime bar's (components/composer-runtime.tsx); the picker bodies are handed a lifecycle by that bar.
export type RuntimePickerPresentation = 'sheet' | 'popover';

export interface RuntimeSwitchLifecycle {
  /** Whether this particular sheet is open. The shared body uses this to read its catalog only while it is visible. */
  readonly open: boolean;
  /** Which shell the body is drawn in, so a popover body can drop the prose a sheet has room for. */
  readonly presentation: RuntimePickerPresentation;
  /** The Claude effort the chip shows as in force, so the picker can check the same value the chip names. */
  readonly claudeEffort?: string;
  /** A switch was submitted: the readout goes stale-until-evidence. */
  readonly onSwitchSubmitted: () => void;
  /** The submit failed, so nothing is pending and the readout is current again. */
  readonly onSwitchFailed: () => void;
  /** Claude effort is not observable; a successful send is all there is to show. */
  readonly onClaudeEffortSent: (effort: string) => void;
  readonly onClose: () => void;
}

const present = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

/**
 * The model the session was LAUNCHED on. The daemon puts the resolved model on the argv and appends the operator's
 * own flags after it, so a `--model` (or Codex's `-m`) among those flags is the one the harness actually started on.
 */
export const launchedModel = (config: RuntimeSessionView['config']): string | undefined => {
  const flags: readonly string[] = config.harnessFlags ?? [];
  let flagged: string | undefined;
  flags.forEach((flag, index) => {
    if (flag === '--model' || flag === '-m') flagged = present(flags[index + 1]) ?? flagged;
    else if (flag.startsWith('--model=')) flagged = present(flag.slice('--model='.length)) ?? flagged;
  });
  return flagged ?? present(config.model) ?? present(config.modelHint);
};
