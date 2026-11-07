import { AsksPort } from '@ferretry/core-asks/contract';
import { AUDIT_KINDS, Bearers, CAPABILITIES, GatePort } from '@ferretry/core-gate/contract';
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
    ],
    // Today's `fy` verbs (packages/cli/src/lib/{session,stop,restart,worktrees}), V-rows of the parity inventory.
    cli: [
      verb('ps', { summary: 'list ferrets' }),
      verb('status [id]', { summary: 'show one ferret in detail, or with --subtree a table of its helpers' }),
      verb('start [prompt...]', { summary: 'start a ferret on one of your agent runtimes' }),
      verb('new [words...]', { summary: 'start a helper ferret (Pack mode)' }),
      verb('stop', { summary: 'stop ferrets in bulk, selected by lineage or pack' }),
      verb('stop orphan <session>', { summary: 'stop one ferret and leave its helpers running' }),
      verb('stop cascade <session>', { summary: 'stop a ferret and every transitive helper' }),
      verb('stop children <session>', { summary: 'stop every transitive helper and keep the ferret running' }),
      verb('stop label <label>', { summary: 'stop every ferret in a pack, independent of lineage' }),
      verb('rename <session> [name]', { summary: 'give a ferret a new first name' }),
      verb('name', { summary: 'print available callsigns so a name can be chosen before start' }),
      verb('resume <id> [message...]', { summary: 'revive a stopped ferret with its conversation intact' }),
      verb('restart [ids...]', {
        summary:
          'restart ferrets on the same runtime, keeping the conversation; a busy one waits for its next idle moment',
      }),
      verb('signal <kind> [message...]', {
        summary: 'done | help | waiting | working — the teammate lifecycle signals',
      }),
      verb('session', { summary: "act on a ferret's own standing with this daemon" }),
      verb('session revoke-credential <session>', {
        summary: 'cut a ferret off at once: its own credential stops working until a person resumes it',
      }),
      verb('session pin <session>', { summary: 'pin a ferret to the top of the sidebar' }),
      verb('session unpin <session>', { summary: 'unpin a ferret from the top of the sidebar' }),
      verb('session compact-at <session> [value]', {
        summary: 'show or set where a ferret squeezes its conversation (a size like 250k, auto, or inherit)',
      }),
      verb('worktree', { summary: 'inspect and remove the checkouts the daemon created for ferrets' }),
      verb('worktrees', { summary: 'alias of fy worktree' }),
      verb('worktree ls', { summary: 'every managed worktree, live ones first' }),
      verb('worktree list', { summary: 'alias of fy worktree ls' }),
      verb('worktree check <path>', { summary: 'say whether a worktree can be removed, and what stands in the way' }),
      verb('worktree rm <path>', { summary: 'remove a worktree once every blocker is accounted for' }),
      verb('worktree remove <path>', { summary: 'alias of fy worktree rm' }),
      verb('worktree fork <branch>', {
        summary: 'fork a new checkout for a branch, and say where to start work in it',
      }),
      verb('worktree add <branch>', { summary: 'alias of fy worktree fork' }),
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
