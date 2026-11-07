import { AsksPort } from '@ferretry/core-asks/contract';
import { Bearers, GatePort } from '@ferretry/core-gate/contract';
import { VaultPort } from '@ferretry/core-vault/contract';
import type { ConfigDef } from '@ferretry/kernel/contract';
import { definePlugin } from '@ferretry/kernel/manifest';
import {
  ArchiveFile,
  AutoResumeFile,
  FerretChanged,
  FerretFiles,
  FerretHistoryFiles,
  FerretIndexFile,
  FerretsChanged,
  FerretsPort,
  FerretTokensFile,
  ForkFiles,
  Harnesses,
  LaunchParts,
  LimitsAppliedFile,
  LimitsConfigFile,
  Logins,
  MoveFiles,
  NamesFile,
  RestartsFile,
  Runners,
  SitrepLines,
  StartDecide,
  WorkFoldersPort,
  WorktreesFile,
} from './contract/index.ts';

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
      means: "a ferret's whole status: what it is doing across its cards, its turn, its blockers",
      insteadOf: ['status'],
    },
    { word: 'start', means: 'bring a ferret up', insteadOf: ['spawn', 'launch'] },
    { word: 'stop', means: "end a ferret's process; it can resume", insteadOf: ['kill'] },
    { word: 'state', means: 'starting, working, idle, stopped' },
  ],
  needs: { gate: GatePort, vault: VaultPort, asks: AsksPort },
  provides: { ferrets: FerretsPort, workFolders: WorkFoldersPort },
  data: {
    state: [
      FerretFiles,
      FerretHistoryFiles,
      FerretTokensFile,
      NamesFile,
      ArchiveFile,
      AutoResumeFile,
      RestartsFile,
      WorktreesFile,
      ForkFiles,
      MoveFiles,
      LimitsAppliedFile,
      FerretIndexFile,
    ],
    // Cast: see packages/core/gate/manifest.ts (leaf `ConfigDef<unknown>` variance; reported to the lead).
    config: [LimitsConfigFile as ConfigDef<any>],
    publishes: [FerretsChanged],
  },
  hooks: {
    offers: [
      { hook: Harnesses },
      { hook: Runners },
      { hook: Logins },
      { hook: LaunchParts },
      { hook: StartDecide },
      { hook: SitrepLines },
      { hook: FerretChanged },
    ],
    takes: [{ hook: Bearers, key: 'ferret' }],
  },
  permissions: { roots: ['agent-homes', 'worktrees', 'work'] },
});
