import { AgendaContext, AsksPort } from '@ferretry/core-asks/contract';
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
  LaunchRoots,
  OpeningAttachments,
  LimitsAppliedFile,
  LimitsConfigFile,
  Logins,
  MoveFiles,
  NamesFile,
  SystemCallsignsFile,
  RestartsFile,
  Runners,
  RuntimeStart,
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
        noStore: true,
        // B2: a governed device's start outside every project is `terminal.use` (route-security/launch.ts). Gate gives a call
        // its grant standing only when the route asks for it, so without this the decision has no standing to read.
        consultsGrants: true,
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
        noStore: true,
        audit: { skip: 'a stop is recorded in the ferret history, as today' },
        guard: { none: 'answers the new state only' },
      }),
      // R-0363
      route('POST /v1/ferrets/:ferretId/resume', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        consultsGrants: true,
        audit: { skip: 'a resume is recorded in the ferret history, as today' },
        guard: { none: 'answers the ferret id only' },
      }),
      // R-0362
      route('POST /v1/ferrets/:ferretId/rename', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a rename records nothing, as today' },
        guard: { none: 'one ferret identity record' },
      }),
      // R-0364
      route('POST /v1/ferrets/:ferretId/revoke-credential', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
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
        args: [{ name: 'id', help: 'session id or callsign' }],
        options: [
          { flag: '-a, --agent <agent>', help: 'the runtime to move the session onto' },
          { flag: '--model <model>', help: "override the model; defaults to the target account's configured model" },
          {
            flag: '--allow-context-downgrade',
            help: 'accept a target context window smaller than the current one (the daemon otherwise refuses)',
          },
          {
            flag: '--force-inflight',
            help: 'go ahead even though the daemon could not show that what the agent is running is safe to stop (the daemon otherwise refuses; the move is journalled)',
          },
          {
            flag: '--conversation <choice>',
            help: 'resume (default) continues the conversation the session is on; fresh starts a new one; previous goes back to the one an earlier Restart left behind; convert rewrites it for the other harness',
          },
          {
            flag: '--convert',
            help: 'move onto a runtime of the OTHER harness (Claude ↔ Codex) by converting the conversation; same as --conversation convert',
          },
          { flag: '--preview', help: 'with --convert: show what the conversion would carry and change nothing' },
          { flag: '--request-id <id>', help: 'stable idempotency key for an explicit retry of this move' },
          { flag: '--json', help: 'print the moved session as JSON' },
        ],
      }),
      verb('ps', {
        summary: 'list ferrets',
        args: [],
        options: [
          { flag: '-a, --all', help: 'include terminal sessions (completed/failed/stalled/stopped)' },
          { flag: '-l, --label <label>', help: 'only sessions started with this ownership label' },
          { flag: '--json', help: 'print the selected sessions as JSON' },
        ],
      }),
      verb('status [id]', {
        summary: 'show one ferret in detail, or with --subtree a table of its helpers',
        args: [
          {
            name: 'id',
            help: 'session id or callsign (with --subtree: defaults to the calling session)',
            optional: true,
          },
        ],
        options: [
          {
            flag: '--subtree',
            help: 'one table of every live descendant (and those ended in the last 2h): model, state, card, PR and its last line',
          },
          { flag: '--json', help: 'print the session, or with --subtree its rows, as JSON' },
        ],
      }),
      verb('start [prompt...]', {
        summary: 'start a ferret on one of your agent runtimes',
        args: [{ name: 'prompt', help: 'the task prompt; required for --mode auto', optional: true, variadic: true }],
        options: [
          {
            flag: '-a, --agent <agent>',
            help: 'the runtime to run it on, such as claude-default (--runtime also works); leave it out to use this machine’s default runtime for new agents',
          },
          {
            flag: '--parent <id>',
            help: 'start it under this ferret; one started inside a pane inherits that pane by default',
          },
          {
            flag: '-f, --file <file>',
            help: 'attach a supported image or document to the opening message; repeatable',
          },
          {
            flag: '--request-id <id>',
            help: 'idempotency key: running start again with the same id returns the same ferret',
          },
          {
            flag: '--mode <mode>',
            help: 'auto for an autonomous teammate (the default), interactive for a human terminal',
          },
          { flag: '--name <title>', help: 'task title shown in `ps` and the dashboard; free-form, kept verbatim' },
          { flag: '--teammate <callsign>', help: 'use this callsign instead of auto-assigning one' },
          {
            flag: '--teammate-fallback',
            help: 'with --teammate: auto-assign a free callsign instead of failing on a collision',
          },
          { flag: '--label <label>', help: 'ownership label; filter later with `ps --label`' },
          {
            flag: '--card <id>',
            help: 'an existing card it takes over (assigned to it; no second card is made); needs a prompt',
          },
          { flag: '--prompt-file <file>', help: 'read the prompt from a file instead of the command line' },
          { flag: '--model <model>', help: 'override the model (alias or full id)' },
          { flag: '--effort <level>', help: 'the reasoning effort' },
          {
            flag: '--fast',
            help: "launch in the harness's fast mode (faster output; the model must offer it, and it can cost more)",
          },
          { flag: '--no-fast', help: 'launch with fast mode off, even where the login would otherwise turn it on' },
          {
            flag: '--compact-at <tokens|auto>',
            help: "squeeze this ferret's conversation at this many tokens (e.g. 250k); auto leaves the harness's own trigger",
          },
          { flag: '--rc', help: 'launch with remote control so the session is steerable from the web surface' },
          { flag: '--no-rc', help: 'launch without remote control' },
          { flag: '--harness <harness>', help: 'start on this harness (claude or codex) instead of the runtime’s own' },
          { flag: '--login <id>', help: 'start on this login' },
          { flag: '--pack <label>', help: 'put it in this pack' },
          { flag: '--harness-flag <flag>', help: 'extra flag passed straight to the agent binary; repeatable' },
          { flag: '--cwd <dir>', help: 'working directory for it (defaults to this one)' },
          { flag: '--interval <seconds>', help: 'supervision interval' },
          { flag: '--turn-timeout <seconds>', help: 'kill it when one turn runs longer than this' },
          { flag: '--nudge-after <seconds>', help: 'zero life signs for this long earns a continue nudge' },
          { flag: '--stall-kill-after <seconds>', help: 'zero life signs for this long is a stall kill' },
          {
            flag: '--direct-max <chars>',
            help: 'short single-line payloads up to this length are typed verbatim (0 disables)',
          },
          { flag: '--max-snapshots <count>', help: 'pane snapshots to retain' },
          { flag: '--json', help: 'print the session as JSON' },
        ],
      }),
      verb('new [words...]', {
        summary: 'start a helper ferret (Pack mode); needs --runtime <name> or --auto',
        args: [{ name: 'words', help: 'the complete brief for the helper', optional: true, variadic: true }],
        options: [
          {
            flag: '--runtime <name>',
            help: 'the runtime to run it on (`fy recommend` lists them); name one, or pass --auto',
          },
          {
            flag: '--auto',
            help: 'let Ferretry choose the runtime: the models the routing prompt names, in its order; do not name a runtime with it',
          },
          {
            flag: '--mode <mode>',
            help: 'auto for an autonomous teammate (the default), interactive for a human terminal',
          },
          { flag: '--name <title>', help: 'task title shown in `ps` and the dashboard; free-form, kept verbatim' },
          { flag: '--teammate <callsign>', help: 'use this callsign instead of auto-assigning one' },
          {
            flag: '--teammate-fallback',
            help: 'with --teammate: auto-assign a free callsign instead of failing on a collision',
          },
          { flag: '--label <label>', help: 'ownership label; filter later with `ps --label`' },
          {
            flag: '--card <id>',
            help: 'an existing card it takes over (assigned to it; no second card is made); needs a prompt',
          },
          { flag: '--prompt-file <file>', help: 'read the prompt from a file instead of the command line' },
          { flag: '--model <model>', help: 'override the model (alias or full id)' },
          { flag: '--effort <level>', help: 'the reasoning effort' },
          {
            flag: '--fast',
            help: "launch in the harness's fast mode (faster output; the model must offer it, and it can cost more)",
          },
          { flag: '--no-fast', help: 'launch with fast mode off, even where the login would otherwise turn it on' },
          {
            flag: '--compact-at <tokens|auto>',
            help: 'squeeze its conversation at this many tokens (e.g. 250k); auto leaves the default',
          },
          { flag: '--rc', help: 'launch with remote control so the session is steerable from the web surface' },
          { flag: '--no-rc', help: 'launch without remote control' },
          { flag: '--harness <harness>', help: 'start on this harness (claude or codex) instead of the runtime’s own' },
          { flag: '--login <id>', help: 'start on this login' },
          { flag: '--pack <label>', help: 'put it in this pack' },
          { flag: '--harness-flag <flag>', help: 'extra flag passed straight to the agent binary; repeatable' },
          { flag: '--cwd <dir>', help: 'working directory for it (defaults to this one)' },
          { flag: '--interval <seconds>', help: 'supervision interval' },
          { flag: '--turn-timeout <seconds>', help: 'kill it when one turn runs longer than this' },
          { flag: '--nudge-after <seconds>', help: 'zero life signs for this long earns a continue nudge' },
          { flag: '--stall-kill-after <seconds>', help: 'zero life signs for this long is a stall kill' },
          {
            flag: '--direct-max <chars>',
            help: 'short single-line payloads up to this length are typed verbatim (0 disables)',
          },
          { flag: '--max-snapshots <count>', help: 'pane snapshots to retain' },
          { flag: '--json', help: 'print the session as JSON' },
        ],
      }),
      verb('stop', {
        summary: 'stop ferrets in bulk, selected by lineage or pack',
        args: [],
        options: [{ flag: '-r, --reason <text>', help: 'reason recorded against every stopped session' }],
      }),
      verb('stop orphan <session>', {
        summary: 'stop one ferret and leave its helpers running',
        args: [{ name: 'session', help: 'session to stop' }],
        options: [
          { flag: '-r, --reason <text>', help: 'reason recorded against every stopped session' },
          { flag: '-n, --dry-run', help: 'print the plan and stop nothing' },
          { flag: '-y, --yes', help: 'skip the typed confirmation' },
          { flag: '--include-caller', help: 'also stop the issuing session, last' },
        ],
      }),
      verb('stop cascade <session>', {
        summary: 'stop a ferret and every transitive helper',
        args: [{ name: 'session', help: 'root of the subtree to stop' }],
        options: [
          { flag: '-r, --reason <text>', help: 'reason recorded against every stopped session' },
          { flag: '-n, --dry-run', help: 'print the plan and stop nothing' },
          { flag: '-y, --yes', help: 'skip the typed confirmation' },
          { flag: '--include-caller', help: 'also stop the issuing session, last' },
        ],
      }),
      verb('stop children <session>', {
        summary: 'stop every transitive helper and keep the ferret running',
        args: [{ name: 'session', help: 'root whose descendants are stopped' }],
        options: [
          { flag: '-r, --reason <text>', help: 'reason recorded against every stopped session' },
          { flag: '-n, --dry-run', help: 'print the plan and stop nothing' },
          { flag: '-y, --yes', help: 'skip the typed confirmation' },
          { flag: '--include-caller', help: 'also stop the issuing session, last' },
        ],
      }),
      verb('stop label <label>', {
        summary: 'stop every ferret in a pack, independent of lineage',
        args: [{ name: 'label', help: 'exact label to match' }],
        options: [
          { flag: '-r, --reason <text>', help: 'reason recorded against every stopped session' },
          { flag: '-n, --dry-run', help: 'print the plan and stop nothing' },
          { flag: '-y, --yes', help: 'skip the typed confirmation' },
          { flag: '--include-caller', help: 'also stop the issuing session, last' },
        ],
      }),
      verb('rename <session> [name]', {
        summary: 'give a ferret a new first name',
        args: [
          { name: 'session', help: 'session id or current first name' },
          {
            name: 'name',
            help: 'the new first name: letters, digits or hyphens, starting with a letter',
            optional: true,
          },
        ],
        options: [
          { flag: '--title <title>', help: 'a new task title' },
          { flag: '--json', help: 'print the renamed session as JSON' },
        ],
      }),
      verb('name', {
        summary: 'print available callsigns so a name can be chosen before start',
        args: [],
        options: [
          { flag: '-n, --count <count>', help: 'print this many callsigns' },
          { flag: '--json', help: 'print the callsigns as a JSON array' },
        ],
      }),
      verb('resume <id> [message...]', {
        summary: 'revive a stopped ferret with its conversation intact',
        args: [
          { name: 'id', help: 'session id or callsign' },
          { name: 'message', help: 'optional message to deliver on revival', optional: true, variadic: true },
        ],
        options: [{ flag: '--json', help: 'print the session as JSON' }],
      }),
      verb('restart [ids...]', {
        summary:
          'restart ferrets on the same runtime, keeping the conversation; a busy one waits for its next idle moment',
        args: [
          {
            name: 'ids',
            help: 'session ids or callsigns to restart (with none and no flag: show what is out of date)',
            optional: true,
            variadic: true,
          },
        ],
        options: [
          { flag: '--outdated', help: 'restart every ferret whose instructions are out of date' },
          { flag: '--all', help: 'restart every running ferret' },
          { flag: '--cancel', help: 'clear the restarts that are waiting for a ferret to go idle' },
          { flag: '--request-id <id>', help: 'stable idempotency key for an explicit retry of this restart' },
          { flag: '--json', help: 'print the result as JSON' },
        ],
      }),
      // V-0452: today's `fy stream [id]`: the journal socket `GET /v1/events`, followed until interrupted.
      verb('stream [id]', {
        summary: "follow one ferret or this daemon's whole fleet until interrupted",
        args: [{ name: 'id', help: 'optional session id; omitted follows the daemon-local fleet', optional: true }],
        options: [
          { flag: '--after <sequence>', help: 'start after this sequence' },
          { flag: '--json', help: 'print one protocol event per line' },
        ],
      }),
      verb('wait <id>', {
        summary:
          'block until a ferret settles; exits 0 finished, 1 ended, 3 needs a human, 69 daemon lost, 124 timeout',
        args: [{ name: 'id', help: 'session id' }],
        options: [
          { flag: '--json', help: 'print the session state as one line of JSON' },
          { flag: '--timeout <seconds>', help: 'give up after this many seconds (exit 124)' },
          {
            flag: '--interval <seconds>',
            help: 'how often to ask the daemon again (default: after 1 s, slowing to every 5 s while the session is still)',
          },
          { flag: '--until-marker <file>', help: 'wait for this file rather than trusting a completion claim' },
          {
            flag: '--keep',
            help: 'leave the session running after its result is collected (a settled wait stops it otherwise)',
          },
        ],
      }),
      verb('instructions', {
        summary: 'which of its own instruction sections this ferret launched with',
        args: [],
        options: [{ flag: '--json', help: 'print the report as JSON' }],
      }),
      verb('signal <kind> [message...]', {
        summary: 'done | help | waiting | working — the teammate lifecycle signals',
        args: [
          { name: 'kind', help: 'done, help, waiting, or working' },
          { name: 'message', help: 'optional signal detail; required for help', optional: true, variadic: true },
        ],
        options: [
          { flag: '--session <id>', help: 'session id or callsign; defaults to FY_SESSION_ID' },
          { flag: '--until <when>', help: 'waiting deadline as a duration (45m, 2h) or ISO timestamp' },
          { flag: '--on <condition>', help: 'what external condition is being waited for' },
          { flag: '--peer <id>', help: 'park until this teammate sends a reply' },
          { flag: '--json', help: 'print the resulting session as JSON' },
        ],
      }),
      verb('session', { summary: "act on a ferret's own standing with this daemon", args: [] }),
      verb('session revoke-credential <session>', {
        summary: 'cut a ferret off at once: its own credential stops working until a person resumes it',
        args: [{ name: 'session', help: 'session id or first name' }],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('session pin <session>', {
        summary: 'pin a ferret to the top of the sidebar',
        args: [{ name: 'session', help: 'session id or first name' }],
        options: [{ flag: '--json', help: 'print the session as JSON' }],
      }),
      verb('session unpin <session>', {
        summary: 'unpin a ferret from the top of the sidebar',
        args: [{ name: 'session', help: 'session id or first name' }],
        options: [{ flag: '--json', help: 'print the session as JSON' }],
      }),
      verb('worktree', {
        summary: 'inspect and remove the checkouts the daemon created for ferrets',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('worktrees', {
        summary: 'alias of fy worktree',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('worktree ls', {
        summary: 'every managed worktree, live ones first',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('worktree list', {
        summary: 'alias of fy worktree ls',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('worktree check <path>', {
        summary: 'say whether a worktree can be removed, and what stands in the way',
        args: [{ name: 'path', help: 'the worktree path' }],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('worktree rm <path>', {
        summary: 'remove a worktree once every blocker is accounted for',
        args: [{ name: 'path', help: 'the worktree path' }],
        options: [
          { flag: '--discard-changes', help: 'accept losing uncommitted work in the worktree' },
          { flag: '--accept-unpushed', help: 'accept losing commits that exist nowhere else' },
          { flag: '--delete-unmerged', help: 'accept deleting a branch that was never merged' },
          { flag: '--delete-branch', help: 'delete the branch too instead of leaving it behind' },
          { flag: '--delete-preexisting', help: 'allow deleting a branch that existed before the worktree' },
          { flag: '-y, --yes', help: 'skip the typed confirmation; required when not on a terminal' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('worktree remove <path>', {
        summary: 'alias of fy worktree rm',
        args: [{ name: 'path', help: 'the worktree path' }],
        options: [
          { flag: '--discard-changes', help: 'accept losing uncommitted work in the worktree' },
          { flag: '--accept-unpushed', help: 'accept losing commits that exist nowhere else' },
          { flag: '--delete-unmerged', help: 'accept deleting a branch that was never merged' },
          { flag: '--delete-branch', help: 'delete the branch too instead of leaving it behind' },
          { flag: '--delete-preexisting', help: 'allow deleting a branch that existed before the worktree' },
          { flag: '-y, --yes', help: 'skip the typed confirmation; required when not on a terminal' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('worktree fork <branch>', {
        summary: 'fork a new checkout for a branch, and say where to start work in it',
        args: [{ name: 'branch', help: 'the branch to check out; created when it does not exist yet' }],
        options: [
          { flag: '--base <ref>', help: 'start a new branch at this commit-ish' },
          { flag: '--from-default', help: "start a new branch at the repository's default branch" },
          { flag: '--from-head', help: "start a new branch at the source checkout's current commit" },
          { flag: '--from <path>', help: 'the checkout to fork from; the current directory otherwise' },
          { flag: '--session <id>', help: 'the session that will own the new checkout' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('worktree add <branch>', {
        summary: 'alias of fy worktree fork',
        args: [{ name: 'branch', help: 'the branch to check out; created when it does not exist yet' }],
        options: [
          { flag: '--base <ref>', help: 'start a new branch at this commit-ish' },
          { flag: '--from-default', help: "start a new branch at the repository's default branch" },
          { flag: '--from-head', help: "start a new branch at the source checkout's current commit" },
          { flag: '--from <path>', help: 'the checkout to fork from; the current directory otherwise' },
          { flag: '--session <id>', help: 'the session that will own the new checkout' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
    ],
  },
  // The ferret's own pages and header (today's packages/pwa new-session page, migrate sheet, session top bar, Actions ▾,
  // Info and file browser). `new-ferret` and `move` OFFER the two account slots (contract/slots.ts) that Runtimes
  // contributes its runtime picker to; neither half imports the other. The header is panels on `ferret.toolbar`, the
  // file browser a panel on `ferret.side`; the screen that hosts them (Conversation's chat) mounts the slots.
  ui: {
    screens: [
      screen('ferrets', { path: 'ferrets', nav: { label: 'Ferrets', icon: 'list', order: 5 } }),
      screen('new-ferret', { path: 'new' }),
      screen('move', { path: 'ferrets/:ferret/move' }),
    ],
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
    // `sessions/*/environment.json` is each ferret's plaintext `fys_` credential (the kernel's own `sessions` root).
    private: ['tokens.json', 'sessions/*/environment.json'],
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
      { hook: OpeningAttachments },
      { hook: LaunchRoots },
      { hook: RuntimeStart },
      { hook: StartDecide },
      { hook: ArchiveKeeps },
      { hook: AutoResumeDecide },
      { hook: SitrepLines },
      { hook: FerretChanged },
      { hook: FerretStopping },
      { hook: FerretStarted },
    ],
    takes: [
      { hook: Bearers, key: 'ferret' },
      { hook: AgendaContext, key: 'ferrets' },
    ],
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
