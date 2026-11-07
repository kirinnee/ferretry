import { AsksPort } from '@ferretry/core-asks/contract';
import { AUDIT_KINDS, Bearers, CAPABILITIES, GatePort } from '@ferretry/core-gate/contract';
import { VaultPort } from '@ferretry/core-vault/contract';
import type { ConfigDef } from '@ferretry/kernel/contract';
import { definePlugin, route } from '@ferretry/kernel/manifest';
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
import { StartRequestsFile } from './daemon/lib/ferrets/start-requests.ts';

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
    // Today's descriptors (packages/daemon/src/lib/runtime/mounts/{sessions,session-control,session-resume,
    // session-rename,session-credential,names,session-filesystem}.ts), paths renamed by the parity table.
    routes: [
      // R-0134: conditional (R501, R503); registered before the pattern below.
      route('GET /v1/ferrets', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        compress: true,
        audit: { skip: 'a fleet read records nothing' },
        guard: { none: 'ferret identity records: names, lineage, folders and states, no pane or vault text' },
      }),
      // R-0135
      route('GET /v1/ferrets/:ferretId', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a ferret read records nothing' },
        guard: { none: 'one ferret identity record' },
      }),
      // R-0332
      route('POST /v1/ferrets', {
        minimum: 'operator',
        caller: 'any',
        audit: { skip: 'a start is recorded in the ferret history, as today' },
        guard: { none: 'answers the new ferret id only' },
      }),
      // R-0187: four segments deep with a literal third, so it never matches a ferret id. The payload digest is the proof.
      route('GET /v1/ferrets/by-request/:requestId', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a start recovery read records nothing, as today' },
        guard: { none: 'one ferret identity record, for the caller that proves it sent the start' },
      }),
      // R-0372
      route('POST /v1/ferrets/:ferretId/stop', {
        minimum: 'operator',
        caller: 'any',
        audit: { skip: 'a stop is recorded in the ferret history, as today' },
        guard: { none: 'answers the new state only' },
      }),
      // R-0363
      route('POST /v1/ferrets/:ferretId/resume', {
        minimum: 'operator',
        caller: 'any',
        consultsGrants: true,
        audit: { skip: 'a resume is recorded in the ferret history, as today' },
        guard: { none: 'answers the ferret id only' },
      }),
      // R-0362
      route('POST /v1/ferrets/:ferretId/rename', {
        minimum: 'operator',
        caller: 'any',
        audit: { skip: 'a rename records nothing, as today' },
        guard: { none: 'one ferret identity record' },
      }),
      // R-0364
      route('POST /v1/ferrets/:ferretId/revoke-credential', {
        minimum: 'operator',
        caller: 'person',
        audit: { record: AUDIT_KINDS['ferret.credential-revoked'] },
        guard: { none: 'answers whether a token was live, never a token or digest' },
      }),
      // R-0114
      route('GET /v1/names', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a name suggestion records nothing' },
        guard: { none: 'names from the callsign pool' },
      }),
      // R-0151 (S47)
      route('GET /v1/ferrets/:ferretId/fs/file', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        capability: { capability: CAPABILITIES.filesystem, axis: 'use' },
        audit: { skip: 'a file read records nothing, as today' },
        guard: 'secrets',
      }),
      // The file browser (today's `mounts/session-filesystem.ts`). They answer 503 until the kernel's root walk lands.
      // R-0152
      route('GET /v1/ferrets/:ferretId/fs/index', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        capability: { capability: CAPABILITIES.filesystem, axis: 'use' },
        audit: { skip: 'a file index read records nothing, as today' },
        guard: 'secrets',
      }),
      // R-0149
      route('GET /v1/ferrets/:ferretId/fs/changes', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        capability: { capability: CAPABILITIES.filesystem, axis: 'use' },
        audit: { skip: 'a change list read records nothing, as today' },
        guard: 'secrets',
      }),
      // R-0150
      route('GET /v1/ferrets/:ferretId/fs/diff', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        capability: { capability: CAPABILITIES.filesystem, axis: 'use' },
        audit: { skip: 'a diff read records nothing, as today' },
        guard: 'secrets',
      }),
      // R-0148
      route('GET /v1/ferrets/:ferretId/fs', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        capability: { capability: CAPABILITIES.filesystem, axis: 'use' },
        audit: { skip: 'a folder listing records nothing, as today' },
        guard: 'secrets',
      }),
      // Managed worktrees (today's `mounts/worktrees.ts`); the removal check is a deeper literal than the collection.
      // R-0211
      route('GET /v1/worktrees/removal', {
        minimum: 'operator',
        caller: 'any',
        capability: { capability: CAPABILITIES.filesystem, axis: 'use' },
        noStore: true,
        audit: { skip: 'a removal check records nothing, as today' },
        guard: { none: 'a removal verdict: paths, branch names and blocker codes, no file contents' },
      }),
      // R-0411
      route('POST /v1/worktrees/remove', {
        minimum: 'operator',
        caller: 'any',
        capability: { capability: CAPABILITIES.filesystem, axis: 'configure' },
        noStore: true,
        audit: { record: AUDIT_KINDS['worktree.removed'] },
        guard: { none: 'answers the removed checkout: its path and branch' },
      }),
      // R-0210
      route('GET /v1/worktrees', {
        minimum: 'operator',
        caller: 'any',
        capability: { capability: CAPABILITIES.filesystem, axis: 'use' },
        noStore: true,
        audit: { skip: 'a worktree list records nothing, as today' },
        guard: { none: 'managed checkouts: paths, branches, heads and occupancy, no file contents' },
      }),
      // R-0410
      route('POST /v1/worktrees', {
        minimum: 'operator',
        caller: 'any',
        capability: { capability: CAPABILITIES.filesystem, axis: 'configure' },
        noStore: true,
        audit: { skip: 'creating a checkout is not kept in the security log, as today' },
        guard: { none: 'answers the new checkout and the folder to start work in' },
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
      StartRequestsFile,
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
