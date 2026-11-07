import { AsksPort } from '@ferretry/core-asks/contract';
import { audit, Bearers, GatePort } from '@ferretry/core-gate/contract';
import { VaultPort } from '@ferretry/core-vault/contract';
import type { ConfigDef } from '@ferretry/kernel/contract';
import { definePlugin, route, verb } from '@ferretry/kernel/manifest';
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
  actions: {
    routes: [
      // ── moves and forks (ferrets-c): today's descriptors from mounts/session-{fork,handover,migrate}.ts, field for
      // field; paths /v1/sessions/:sessionId/… → /v1/ferrets/:ferretId/…, migrate → move (§1.4).
      // R-0344
      route('POST /v1/ferrets/:ferretId/fork', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
        audit: audit('session.opened'),
        guard: { none: 'the fresh ferret summary and the public plan projection; no transcript text' },
      }),
      // R-0345
      route('POST /v1/ferrets/:ferretId/handover', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'drives an existing session; its journal records it' },
        guard: { none: 'the handover receipt: ids, phases and accounts, no transcript text' },
      }),
      // R-0154
      route('GET /v1/ferrets/:ferretId/handover', {
        minimum: 'authenticated',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read of the handover receipt records nothing' },
        guard: { none: 'the handover receipt: ids, phases and accounts, no transcript text' },
      }),
      // R-0346
      route('POST /v1/ferrets/:ferretId/handover/cancel', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'drives an existing session; its journal records it' },
        guard: { none: 'the handover receipt: ids, phases and accounts, no transcript text' },
      }),
      // R-0169
      route('GET /v1/ferrets/:ferretId/relaunch-settings', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read records nothing' },
        guard: { none: 'whether the launch settings drifted, and which kind; no setting values' },
      }),
      // R-0341
      route('POST /v1/ferrets/:ferretId/conversion-preview', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: {
          skip: 'a read with a body: previews a cross-harness conversion and writes nothing; the move it precedes is audited',
        },
        guard: { none: 'conversion counts and versions; no transcript text' },
      }),
      // R-0355
      route('POST /v1/ferrets/:ferretId/move', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'drives an existing session; its journal records it' },
        guard: { none: 'the moved ferret view, or the in-flight inventory as titles and trimmed commands' },
      }),
      // R-0356
      route('POST /v1/ferrets/:ferretId/move/ask-to-stop-jobs', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: audit('agent.prompted'),
        guard: { none: 'the queued message id and the jobs as pid and trimmed command' },
      }),
    ],
    cli: [
      // V-0329: `fy migrate <id>` → `fy ferret move <id>` (§1.4).
      verb('ferret move <id>', {
        summary: 'continue a ferret on another runtime (another harness only with --convert)',
      }),
    ],
  },
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
