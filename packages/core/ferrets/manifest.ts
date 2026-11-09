import { AsksPort } from '@ferretry/core-asks/contract';
import { AUDIT_KINDS, audit, Bearers, CAPABILITIES, GatePort } from '@ferretry/core-gate/contract';
import { VaultPort } from '@ferretry/core-vault/contract';
import type { ConfigDef } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { definePlugin, panel, route, screen, socket, tool, verb } from '@ferretry/kernel/manifest';
import {
  ArchiveConfigFile,
  ArchiveFile,
  ArchiveKeeps,
  AutoResumeDecide,
  AutoResumeFile,
  AutoResumeSummaryFile,
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
  HandoverFiles,
  MoveInflightFiles,
  TransferPlanFiles,
  Harnesses,
  LaunchParts,
  LimitsAppliedFile,
  LimitsConfigFile,
  Logins,
  MoveFiles,
  NamesFile,
  SystemCallsignsFile,
  RestartsFile,
  Runners,
  SitrepLines,
  StartDecide,
  WorkFoldersPort,
  AgentControlPort,
  WorktreesFile,
  AgentPinsFile,
  FerretConfigFile,
  FerretDetailsFile,
  FerretLaunchEnvironmentFiles,
  FerretLaunchSectionsFiles,
  FerretPinsFile,
  FerretStateFile,
  StartRequestsFile,
  FerretSummaryFiles,
  FerretWaitFiles,
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
  provides: { ferrets: FerretsPort, workFolders: WorkFoldersPort, agentControl: AgentControlPort },
  actions: {
    // R-0424: the journal stream (a ferret from its cursor, or the fleet's recent tail). Today's descriptor.
    sockets: [
      socket('GET /v1/events', {
        minimum: 'operator',
        caller: 'any',
        audit: { skip: 'a live read of the journals records nothing' },
        guard: 'secrets',
      }),
    ],
    // Today's `instructions` tool: which of its own system-prompt sections THIS ferret launched with. The launch parts own
    // those sections, so Ferrets answers it, for the ferret the session credential names.
    agentTools: [
      tool('instructions', {
        minimum: 'authenticated',
        caller: 'any',
        audit: { skip: 'a read of the ferret’s own launch sections: it changes nothing' },
        guard: { none: 'section names and on/off; never a value' },
        input: z.strictObject({}),
        summary:
          'Which Ferretry sections your prompt launched with (hypermedia, Pack mode, agenda mode, lessons) and how to turn each on. Check before saying one is missing.',
      }),
    ],
    // Today's descriptors (packages/daemon/src/lib/runtime/mounts/{sessions,session-control,session-resume,
    // session-rename,session-credential,names,session-filesystem}.ts), paths renamed by the parity table.
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
        audit: { record: AUDIT_KINDS['session.opened'] },
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
      // R-0047 (today's mounts/session-archive.ts, path unchanged): how many are archived and the newest, read-only.
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
      // V-0329: `fy migrate <id>` → `fy ferret move <id>` (§1.4).
      verb('ferret move <id>', {
        summary: 'continue a ferret on another runtime (another harness only with --convert)',
      }),
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
      // V-0452: today's `fy stream [id]`: the journal socket `GET /v1/events`, followed until interrupted.
      verb('stream [id]', { summary: "follow one ferret or this daemon's whole fleet until interrupted" }),
      verb('wait <id>', {
        summary:
          'block until a ferret settles; exits 0 finished, 1 ended, 3 needs a human, 69 daemon lost, 124 timeout',
      }),
      verb('instructions', { summary: 'which of its own instruction sections this ferret launched with' }),
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
  // The ferret's own pages and header (today's packages/pwa new-session page, migrate sheet, session top bar, Actions ▾,
  // Info and file browser). `new-ferret` and `move` OFFER the two account slots (contract/slots.ts) that Runtimes
  // contributes its runtime picker to; neither half imports the other. The header is panels on `ferret.toolbar`, the
  // file browser a panel on `ferret.side`; the screen that hosts them (Conversation's chat) mounts the slots.
  ui: {
    screens: [screen('new-ferret', { path: 'new' }), screen('move', { path: 'ferrets/:ferret/move' })],
    panels: [
      panel('ferret.toolbar', { id: 'name', order: 10 }),
      panel('ferret.toolbar', { id: 'status', order: 20 }),
      panel('ferret.toolbar', { id: 'info', order: 30 }),
      panel('ferret.toolbar', { id: 'actions', order: 40 }),
      panel('ferret.side', { id: 'files', order: 40 }),
    ],
  },

  /** Never reached by a ferret, through any root: the digests of every ferret token (`PrivacyDecl`). */
  privacy: {
    private: ['tokens.json'],
  },
  data: {
    state: [
      FerretFiles,
      FerretHistoryFiles,
      FerretTokensFile,
      NamesFile,
      SystemCallsignsFile,
      ArchiveFile,
      AutoResumeFile,
      AutoResumeSummaryFile,
      RestartsFile,
      WorktreesFile,
      ForkFiles,
      MoveFiles,
      LimitsAppliedFile,
      FerretIndexFile,
      StartRequestsFile,
      FerretConfigFile,
      FerretStateFile,
      AgentPinsFile,
      FerretPinsFile,
      FerretDetailsFile,
      FerretSummaryFiles,
      HandoverFiles,
      TransferPlanFiles,
      MoveInflightFiles,
      FerretWaitFiles,
      FerretLaunchEnvironmentFiles,
      FerretLaunchSectionsFiles,
    ],
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
      { hook: StartDecide },
      { hook: ArchiveKeeps },
      { hook: AutoResumeDecide },
      { hook: SitrepLines },
      { hook: FerretChanged },
      { hook: FerretStopping },
      { hook: FerretStarted },
    ],
    takes: [{ hook: Bearers, key: 'ferret' }],
  },
  // Moves and forks (copying today's reach): a harness home is read through the read-only `harness-history` root, a
  // pane's process tree through `ps` and procfs (tmux joins when the pane preflight is bound, through Terminals' runner).
  // `git`: the file browser's status, listing and diff, and the managed worktrees (today's Git runner).
  permissions: {
    roots: ['worktrees', 'work', 'harness-history', 'sessions'],
    spawn: ['git', 'ps'],
    hostFacts: true,
    checkDirectory: true,
  },
});
