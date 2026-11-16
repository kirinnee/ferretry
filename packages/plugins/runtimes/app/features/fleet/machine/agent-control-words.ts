import type { AgentControl } from '../../../../contract/index.ts';

export type AgentControlKind = keyof AgentControl;

/** The switches, in the order they are drawn. */
export const AGENT_CONTROL_KINDS: readonly AgentControlKind[] = [
  'terminals',
  'browsers',
  'files',
  'ferretrySettings',
  'pageScripts',
];

/**
 * "What agents may control": each switch's label and what it covers. The fourth, Ferretry settings, is the `config.*`
 * tools (docs/config-files.md); the fifth, Page scripts, is `browser.eval`. Every safety sentence stays: the longer
 * explanation sits behind an (i) button, it never leaves the screen.
 */
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
