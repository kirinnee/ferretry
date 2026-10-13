/**
 * Installing a harness tool, as data (docs/design/account-model.md §8.6, §9.6, E1, E2).
 *
 * The machine runs the install, never the browser, and the command each tool would run is shown
 * BEFORE anything runs: it comes from the machine's own declared table, read by the setup scan. A
 * tool the machine has no package manager for cannot be picked; it says why and what to run by hand.
 *
 * Installing is one request that answers when it is done — progress is not streamed — so the panel
 * says so honestly ("this can take a minute") rather than showing a frozen button.
 */

import type { FleetSetupTool, FleetToolInstallOutcome } from '@ferretry/protocol';
import { countWords, listWords, SETUP_HARNESS_NAMES, type SetupHarness } from './setup-words.ts';

export type MissingTool = Extract<FleetSetupTool, { installed: false }>;

export type InstallPhase =
  | { readonly kind: 'choose' }
  | { readonly kind: 'running'; readonly harnesses: readonly SetupHarness[] }
  | { readonly kind: 'done'; readonly installed: readonly SetupHarness[] }
  | { readonly kind: 'failed'; readonly harnesses: readonly SetupHarness[]; readonly failures: readonly InstallFailure[] };

export interface InstallFailure {
  readonly harness: SetupHarness;
  readonly reason: string;
  readonly manualCommand: string;
}

/** The tools that can be installed from here: the ones with a command the machine can run. */
export const runnableTools = (tools: readonly MissingTool[]): MissingTool[] =>
  tools.filter(tool => tool.install.kind === 'runnable');

/** The command a runnable tool would run, or the one to run by hand. */
export const toolCommand = (tool: MissingTool): string =>
  tool.install.kind === 'runnable' ? tool.install.command : tool.install.manualCommand;

/** "Install 2 tools", or the nudge when nothing is picked. */
export const installLabel = (picked: number): string =>
  picked === 0 ? 'Pick a tool to install' : `Install ${countWords(picked, 'tool')}`;

/** "Installing Claude Code and Codex on studio-mac…" */
export const installingSentence = (harnesses: readonly SetupHarness[], machineName: string): string =>
  `Installing ${listWords(harnesses.map(harness => SETUP_HARNESS_NAMES[harness]))} on ${machineName}…`;

/** What the outcomes mean for the panel: done when nothing failed, otherwise the failures to show. */
export const phaseAfter = (
  harnesses: readonly SetupHarness[],
  outcomes: readonly FleetToolInstallOutcome[],
): InstallPhase => {
  const failures = outcomes.flatMap((outcome): InstallFailure[] =>
    outcome.outcome === 'failed'
      ? [{ harness: outcome.harness, reason: outcome.reason, manualCommand: outcome.manualCommand }]
      : [],
  );
  if (failures.length > 0) return { kind: 'failed', harnesses, failures };
  return { kind: 'done', installed: outcomes.map(outcome => outcome.harness) };
};

/** "Installed Claude Code." */
export const installedSentence = (harnesses: readonly SetupHarness[]): string =>
  harnesses.length === 0
    ? 'Nothing needed installing.'
    : `Installed ${listWords(harnesses.map(harness => SETUP_HARNESS_NAMES[harness]))}.`;
