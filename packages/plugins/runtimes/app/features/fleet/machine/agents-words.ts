/**
 * The Agents tab's words (today's v4 `fleet/machine/settings-tab.tsx` and `conversations-setting.ts`, word for word):
 * what each setting is called, what it covers, and the sentences around a save. Pure: no React, no client.
 */

import type { AgentControl, MachineView } from '../../../../contract/index.ts';

export type AgentPermissions = MachineView['agentPermissions'];
export type AgentControlKind = keyof AgentControl;

export const AGENT_PERMISSION_WORDS: Readonly<Record<AgentPermissions, string>> = {
  auto: 'Auto mode',
  skip: 'Skip all permission checks',
};

/** The words on each segment of the permissions pick; the full name is its tooltip. */
export const AGENT_PERMISSION_SEGMENTS: Readonly<Record<AgentPermissions, string>> = {
  auto: 'Auto mode',
  skip: 'Skip all checks',
};

export const agentPermissionDetail = (draft: AgentPermissions, machineName: string): string =>
  draft === 'auto'
    ? 'Agents work on their own and stop to ask before anything that looks risky.'
    : `Agents never stop to ask. They can change any file and run any command on ${machineName}.`;

const plural = (count: number, one: string): string => `${count} ${count === 1 ? one : `${one}s`}`;

/** What happens to sessions already running when the mode changes. */
export const runningSessionsSentence = (running: number, old: AgentPermissions): string =>
  `${plural(running, 'running session')} ${running === 1 ? 'keeps' : 'keep'} the old mode (${AGENT_PERMISSION_WORDS[old]}) until restarted.`;

/** "What agents may control": each switch's label and what it covers. */
export const AGENT_CONTROL_WORDS: Readonly<
  Record<AgentControlKind, { readonly title: string; readonly hint?: string; readonly detail: string }>
> = {
  terminals: { title: 'Terminals', detail: 'Open, read and type into session terminals.' },
  browsers: { title: 'Browsers', detail: 'Open, navigate and read the session browser.' },
  files: { title: 'Files', detail: "Read and change files in the session's project." },
  ferretrySettings: {
    title: 'Ferretry settings',
    hint: 'Lets agents use config tools',
    detail:
      "Read and edit this machine's configuration files (the config tools). Off by default; an agent's edit that loosens anything still waits for you.",
  },
  pageScripts: {
    title: 'Page scripts',
    hint: 'Can read site sign-ins',
    detail:
      'Let agents run their own JavaScript in pages they drive. A script can read what a page holds — on the shared agent profile, that includes your sign-ins to every site you signed it in to. Off by default; turn it on only if you need it.',
  },
};

export const AGENT_CONTROL_KINDS: readonly AgentControlKind[] = [
  'terminals',
  'browsers',
  'files',
  'ferretrySettings',
  'pageScripts',
];

/** "Auto-resume after restart": each choice's words. */
export const AUTO_RESUME_WORDS: Readonly<Record<'on' | 'off', { readonly title: string; readonly detail: string }>> = {
  on: {
    title: 'On',
    detail:
      'When this machine restarts, ferrets that were running pick up where they left off, with their conversation intact. Ones you stopped stay stopped.',
  },
  off: {
    title: 'Off',
    detail: 'Nothing restarts by itself. Resume each ferret yourself when you want it back.',
  },
};

/** The summary of the last pass, as the sentence the row leads with. */
export const autoResumeSentence = (resumed: number): string =>
  `Resumed ${resumed} ${resumed === 1 ? 'ferret' : 'ferrets'} after restart`;

/** "Agenda mode" for new ferrets: each choice's words. */
export const AGENDA_MODE_WORDS: Readonly<Record<'on' | 'off', { readonly title: string; readonly detail: string }>> = {
  on: {
    title: 'On',
    detail:
      'New ferrets keep an agenda: what only you can decide or do becomes an item you answer from the Inbox. A ferret you already have keeps its own switch.',
  },
  off: {
    title: 'Off',
    detail:
      'New ferrets send plain notices only. Turn Agenda mode on for one ferret from its Actions menu; a ferret you already have keeps its own switch.',
  },
};

export const KEEP_IN_SYNC_EXPLANATION =
  'Show conversations from this computer’s own Claude Code and Codex in Continue. Read-only; nothing is imported until you continue one.';

/** The sentence for a change the daemon holds until the owner confirms it (it loosens what this machine allows). */
export const HELD_CHANGE_SENTENCE = 'Saved, but not in effect until you confirm it.';
