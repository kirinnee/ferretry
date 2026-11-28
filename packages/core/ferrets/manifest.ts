import { AgendaContext, AsksPort } from '@ferretry/core-asks/contract';
import { Bearers, GatePort } from '@ferretry/core-gate/contract';
import { VaultPort } from '@ferretry/core-vault/contract';
import type { ConfigDef } from '@ferretry/kernel/contract';
import { definePlugin, panel, screen } from '@ferretry/kernel/manifest';
import {
  ArchiveConfigFile,
  ArchiveKeeps,
  AutoResumeDecide,
  CompactionHistoryHook,
  FerretChanged,
  FerretStopping,
  FerretStarted,
  FerretWake,
  FerretsChanged,
  FerretsPort,
  FERRETS_STATE,
  Harnesses,
  LaunchParts,
  LaunchRoots,
  OpeningAttachments,
  ConversationStage,
  QuestionOpen,
  LimitsConfigFile,
  Logins,
  Runners,
  RuntimeStart,
  SitrepLines,
  JobKeeper,
  TerminalRoots,
  StartDecide,
  WorkFoldersPort,
  AgentControlPort,
  FERRET_MENU_SLOT,
} from './contract/index.ts';
import actions from './manifest/generated/actions.ts';

/**
 * Ferrets (§2.2): who each ferret is, its name, parent, pack, token and state. Starting and stopping are done by a
 * harness plugin through a runner. Core. Its routes (ferret list, start, stop, resume, fork, sitrep) are added by the
 * Ferrets port with today's descriptors; the day-1 spine declares the contract surface only.
 */
export default definePlugin({
  id: 'ferrets',
  title: 'Ferrets',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: ['instruction'],
  words: [
    {
      word: 'sitrep',
      means: "a ferret's whole status: what it is doing across its tasks, its turn, its blockers",
      insteadOf: ['status'],
    },
    { word: 'start', means: 'bring a ferret up', insteadOf: ['spawn', 'launch'] },
    { word: 'stop', means: "end a ferret's process; it can resume", insteadOf: ['kill'] },
    { word: 'state', means: 'starting, working, idle, stopped' },
  ],
  needs: { gate: GatePort, vault: VaultPort, asks: AsksPort },
  provides: { ferrets: FerretsPort, workFolders: WorkFoldersPort, agentControl: AgentControlPort },
  actions,
  // The ferret's own pages and header (today's packages/pwa new-session page, migrate sheet, session top bar, Actions ▾,
  // Info and file browser). `new-ferret` and `move` OFFER the two account slots (contract/slots.ts) that Runtimes
  // contributes its runtime picker to; neither half imports the other. The header is panels on `ferret.toolbar`, the
  // file browser a panel on `ferret.side`; the screen that hosts them (Conversation's chat) mounts the slots.
  ui: {
    screens: [
      screen('ferrets', { path: 'ferrets', nav: { label: 'Ferrets', icon: 'list', order: 5 } }),
      screen('new-ferret', { path: 'new', title: 'New ferret' }),
      screen('move', { path: 'ferrets/:ferret/move' }),
    ],
    panels: [
      panel('ferret.toolbar', { id: 'name', order: 10 }),
      panel('ferret.toolbar', { id: 'status', order: 20 }),
      // Everything else about a ferret is one click behind the header's one menu (Conversation's Modes button).
      panel(FERRET_MENU_SLOT, { id: 'info', order: 10 }),
      panel(FERRET_MENU_SLOT, { id: 'actions', order: 20 }),
      panel('ferret.side', { id: 'files', order: 40 }),
      // Settings › This device (S4): "Group Needs you at the top", before the conversation width.
      panel('device.settings', { id: 'needs-you', order: 15 }),
      panel('ferret.side', { id: 'instructions', order: 41 }),
    ],
  },

  /** Never reached by a ferret, through any root: the digests of every ferret token (`PrivacyDecl`). */
  privacy: {
    // `sessions/*/environment.json` is each ferret's plaintext `fys_` credential (the kernel's own `sessions` root).
    private: ['tokens.json', 'sessions/*/environment.json'],
  },
  data: {
    // Generated from contract/state/*.state.ts: a state file is a new file there, never a line here.
    state: [...FERRETS_STATE],
    // Cast: see packages/core/gate/manifest.ts (leaf `ConfigDef<unknown>` variance; reported to the lead).
    // biome-ignore lint/suspicious/noExplicitAny: the leaf cast named above
    config: [LimitsConfigFile as ConfigDef<any>, ArchiveConfigFile as ConfigDef<any>],
    publishes: [FerretsChanged],
  },
  hooks: {
    offers: [
      { hook: Harnesses },
      { hook: Runners },
      { hook: Logins },
      { hook: LaunchParts },
      { hook: OpeningAttachments },
      { hook: ConversationStage },
      { hook: QuestionOpen },
      { hook: LaunchRoots },
      { hook: CompactionHistoryHook },
      { hook: RuntimeStart },
      { hook: StartDecide },
      { hook: ArchiveKeeps },
      { hook: AutoResumeDecide },
      { hook: SitrepLines },
      { hook: JobKeeper },
      { hook: TerminalRoots },
      { hook: FerretChanged },
      { hook: FerretStopping },
      { hook: FerretStarted },
      { hook: FerretWake },
    ],
    takes: [
      { hook: Bearers, key: 'ferret' },
      { hook: AgendaContext, key: 'ferrets' },
    ],
  },
  // Moves and forks (copying today's reach): a harness home is read through the read-only `harness-history` root, a
  // pane's process tree through `ps` and procfs (tmux joins when the pane preflight is bound, through Terminals' runner).
  // `git`: the file browser's status, listing and diff, and the managed worktrees (today's Git runner).
  // `imports` (read-only): the repository worktree list of a REGISTERED project reads the folders that project's own record names.
  permissions: {
    roots: ['worktrees', 'work', 'harness-history', 'sessions', 'imports'],
    spawn: ['git', 'ps'],
    // `fy history claim` names the runtime it is claiming for in the refusal another claimant reads (FY_RUNTIME).
    cliEnvReads: ['FY_RUNTIME'],
    hostFacts: true,
    checkDirectory: true,
  },
});
