import { AsksPort } from '@ferretry/core-asks/contract';
import { AUDIT_KINDS, Bearers, CAPABILITIES, GatePort } from '@ferretry/core-gate/contract';
import { VaultPort } from '@ferretry/core-vault/contract';
import type { ConfigDef } from '@ferretry/kernel/contract';
import { definePlugin, route, verb } from '@ferretry/kernel/manifest';
import {
  ArchiveFile,
  AutoResumeFile,
  FerretChanged,
  FerretStopping,
  FerretStarted,
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
import {
  AgentPinsFile,
  FerretDetailsFiles,
  FerretPinFiles,
  FerretSummaryFiles,
  FerretWaitFiles,
  SessionConfigFiles,
  SessionStateFiles,
} from './daemon/lib/state.ts';

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
      // Today's subtree API (G24): lineage is from the registry, excerpts are masked before truncation.
      route('GET /v1/ferrets/:ferretId/subtree', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        capability: { capability: CAPABILITIES.fleet, axis: 'use' },
        audit: { skip: 'a subtree read records nothing, as today' },
        guard: { none: 'G24 masks whole excerpts through kernel.redaction before cutting; failures withhold excerpts' },
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
      // Pins (today's mounts/session-pin.ts and mounts/pins.ts, renamed): the owner's sidebar pin is a person's act.
      route('POST /v1/ferrets/:ferretId/pin', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
        audit: { skip: 'a sidebar pin records nothing, as today' },
        guard: { none: 'one ferret identity record with its pin instant' },
      }),
      route('POST /v1/ferrets/:ferretId/unpin', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
        audit: { skip: 'a sidebar unpin records nothing, as today' },
        guard: { none: 'one ferret identity record' },
      }),
      route('GET /v1/ferrets/:ferretId/pins', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a pin board read records nothing, as today' },
        guard: { none: 'the notes and message references a person or the ferret pinned' },
      }),
      route('POST /v1/ferrets/:ferretId/pins', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a pin board change records nothing, as today' },
        guard: { none: 'answers the pin board' },
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
      // R-0371 (today's mounts/session-signal.ts, renamed).
      route('POST /v1/ferrets/:ferretId/signal', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a lifecycle signal is recorded in the ferret history, as today' },
        guard: { none: 'answers the ferret state' },
      }),
      // Restarts (today's mounts/session-restart.ts, paths unchanged).
      // R-0323
      route('POST /v1/restarts', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a restart is recorded in each ferret history, as today' },
        guard: { none: 'ferret ids and what was restarted or queued' },
      }),
      // R-0128
      route('GET /v1/restarts', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a restart list records nothing' },
        guard: { none: 'outdated ferret ids and the waiting restarts' },
      }),
      // R-0023
      route('DELETE /v1/restarts', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'clearing the restart queue records nothing, as today' },
        guard: { none: 'how many waiting restarts were cleared' },
      }),
      // R-0047 (today's mounts/session-archive.ts, path unchanged). 503 until the session services are bound.
      route('GET /v1/archived-sessions', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'an archive read records nothing' },
        guard: { none: 'archived ferret identity records' },
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
      StartRequestsFile,
      SessionConfigFiles,
      SessionStateFiles,
      AgentPinsFile,
      FerretPinFiles,
      FerretDetailsFiles,
      FerretSummaryFiles,
      FerretWaitFiles,
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
      { hook: FerretStopping },
      { hook: FerretStarted },
    ],
    takes: [{ hook: Bearers, key: 'ferret' }],
  },
  // `git`: the file browser's status, listing and diff, and the managed worktrees (today's Git runner).
  permissions: { roots: ['agent-homes', 'worktrees', 'work'], spawn: ['git'] },
});
