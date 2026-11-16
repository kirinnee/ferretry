import { type ConfigDef, defineConfig, defineState } from '@ferretry/kernel/contract';
import { definePlugin, panel, renderer, route, settingsTab, socket, tool, verb } from '@ferretry/kernel/manifest';
import { HoldsChanged, InputTargets, VaultPort } from '@ferretry/core-vault/contract';
import { AgentControlPort, FerretsPort, Runners } from '@ferretry/core-ferrets/contract';
import { ConversationPort, ReferenceCatalog } from '@ferretry/plugin-conversation/contract';
import {
  AUDIT,
  GUARD_ACK,
  GUARD_NONE,
  SKIP_READ,
  SKIP_UNRECORDED,
  TERMINALS_WORDS,
  TerminalAskOwnerInputSchema,
  AttachmentsStateSchema,
  TerminalChanged,
  TerminalCloseInputSchema,
  TerminalListInputSchema,
  TerminalOpenInputSchema,
  TerminalReadInputSchema,
  TerminalSendInputSchema,
  TerminalsConfigSchema,
  terminalsLoosens,
  TerminalsPort,
  TerminalsStateSchema,
  TerminalWaitInputSchema,
  USE,
} from './contract/index.ts';

/** Where jobs live: an opaque named tree the wrapper in the pane writes into, and the registry of live attachments. */
export const JobFiles = defineState({ name: 'jobs', path: 'jobs/*', store: 'opaque', format: 1 });
export const JobAttachments = defineState({
  name: 'job-attachments',
  path: 'job-attachments.json',
  store: 'json',
  format: 1,
  schema: AttachmentsStateSchema,
  onDamaged: { narrower: 'no attachment is known; a running attach carries on and re-registers nothing' },
});

const GUARD_NONE_JOBS = {
  none: 'job ids, pids and acknowledgements only; no job output or command text',
} as const;

/** Every terminal tool: a ferret's call (or the owner's tools), on `terminal.use`, kept as one `agent.tool` entry. */
const TOOL = {
  minimum: 'authenticated',
  caller: 'any',
  capability: USE.terminal,
  audit: { record: AUDIT.agentTool },
} as const;

/**
 * Terminals (§2.3): gives ferrets terminals to drive, lets you watch them, and is the default place ferrets run.
 *
 * Routes copied from today's `runtime/mounts/{terminals,session-processes,session-console-input,session-attach,
 * cgroups}.ts` and the terminal surface control and owner-tools routes of `agent-tools.ts` (placed with Ferrets
 * by file; declared here because they act on terminals — see the slice report). Every act goes through the
 * kernel's act runner, so a hold can never be skipped (§4.7).
 */
export default definePlugin({
  id: 'terminals',
  title: 'Terminals',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['tool', 'runner', 'command', 'view'],
  words: TERMINALS_WORDS,

  provides: { terminals: TerminalsPort },
  /** Who holds terminals and where a ferret works (Ferrets); input cards a ferret raises (Vault). */
  needs: { ferrets: FerretsPort, vault: VaultPort },
  /**
   * Conversation (optional; lead ruling 2026-11-07): Off, nothing asks Terminals for the composer's `%terminal` menu.
   * Agent control (core Ferrets, bound by the kernel): the owner's "What agents may control › Terminals" switch, read on
   * every terminal tool call; unbound, every agent terminal tool is refused (fail closed).
   */
  uses: { conversation: ConversationPort, agentControl: AgentControlPort },

  actions: {
    routes: [
      route('GET /v1/cgroups/config', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.fleet,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('GET /v1/ferrets/:ferretId/attach', {
        minimum: 'operator',
        caller: 'person',
        privilegedOnly: true,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/ferrets/:ferretId/console/input', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.terminal,
        noStore: true,
        audit: { record: AUDIT.terminalInput },
        guard: GUARD_NONE,
      }),
      route('GET /v1/ferrets/:ferretId/processes', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: 'secrets',
      }),
      route('GET /v1/ferrets/:ferretId/processes/:processId/output', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: 'secrets',
      }),
      route('POST /v1/ferrets/:ferretId/processes/:processId/stop', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: { record: AUDIT.terminalInput },
        guard: GUARD_NONE,
      }),
      route('GET /v1/ferrets/:ferretId/surfaces/terminals/control', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/ferrets/:ferretId/surfaces/terminals/control', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.terminal,
        noStore: true,
        audit: { record: AUDIT.surfaceControl },
        guard: GUARD_NONE,
      }),
      route('POST /v1/ferrets/:ferretId/surfaces/terminals/tools', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.terminal,
        noStore: true,
        audit: { record: AUDIT.agentTool },
        guard: 'secrets',
      }),
      route('GET /v1/ferrets/:ferretId/terminals', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: 'secrets',
      }),
      route('POST /v1/ferrets/:ferretId/terminals', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: { record: AUDIT.terminalOpened },
        guard: 'secrets',
      }),
      route('DELETE /v1/ferrets/:ferretId/terminals/:terminalId', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
      route('GET /v1/ferrets/:ferretId/terminals/:terminalId', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: 'secrets',
      }),
      route('PATCH /v1/ferrets/:ferretId/terminals/:terminalId', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: 'secrets',
      }),
      route('GET /v1/ferrets/:ferretId/snapshot', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: 'secrets',
      }),
      route('GET /v1/terminals', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: 'secrets',
      }),
      route('POST /v1/terminals/close-finished', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
      route('GET /v1/ferrets/:ferretId/jobs', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: 'secrets',
      }),
      route('POST /v1/ferrets/:ferretId/jobs', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: { record: AUDIT.terminalOpened },
        guard: 'secrets',
      }),
      route('GET /v1/ferrets/:ferretId/jobs/:jobId', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: 'secrets',
      }),
      route('GET /v1/ferrets/:ferretId/jobs/:jobId/output', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: 'secrets',
      }),
      route('POST /v1/ferrets/:ferretId/jobs/:jobId/stop', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: { record: AUDIT.terminalInput },
        guard: 'secrets',
      }),
      route('GET /v1/ferrets/:ferretId/job-attachments', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE_JOBS,
      }),
      route('POST /v1/ferrets/:ferretId/job-attachments', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE_JOBS,
      }),
      route('DELETE /v1/ferrets/:ferretId/job-attachments/:attachmentId', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE_JOBS,
      }),
      route('POST /v1/ferrets/:ferretId/job-attachments/detach', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE_JOBS,
      }),
    ],
    sockets: [
      socket('GET /v1/ferrets/:ferretId/terminals/:terminalId/stream', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.terminal,
        audit: { record: AUDIT.terminalOpened },
        guard: 'secrets',
      }),
    ],
    agentTools: [
      tool('terminal_list', {
        ...TOOL,
        op: 'read',
        guard: 'secrets',
        input: TerminalListInputSchema,
        summary: 'list the terminals in the session',
      }),
      tool('terminal_open', {
        ...TOOL,
        op: 'open',
        guard: GUARD_ACK,
        input: TerminalOpenInputSchema,
        summary: 'open a named terminal, optionally running a command in it',
      }),
      tool('terminal_send', {
        ...TOOL,
        op: 'keys',
        guard: GUARD_ACK,
        input: TerminalSendInputSchema,
        summary: 'type text and press keys in a terminal',
      }),
      tool('terminal_read', {
        ...TOOL,
        op: 'read',
        guard: 'secrets',
        input: TerminalReadInputSchema,
        summary: 'read the last lines of a terminal',
      }),
      tool('terminal_wait', {
        ...TOOL,
        op: 'wait',
        guard: 'secrets',
        input: TerminalWaitInputSchema,
        summary: 'wait until text appears or the running command ends',
      }),
      tool('terminal_close', {
        ...TOOL,
        op: 'close',
        guard: GUARD_ACK,
        input: TerminalCloseInputSchema,
        summary: 'close a terminal',
      }),
      tool('terminal_ask_owner', {
        ...TOOL,
        guard: GUARD_NONE,
        input: TerminalAskOwnerInputSchema,
        summary: 'hand a terminal to the owner',
      }),
      tool('terminal_request_input', {
        ...TOOL,
        guard: { none: 'raises an input card through the Vault; answers its state, never a value' },
        summary: 'ask the owner to type a password or code into a terminal',
      }),
    ],
    cli: [
      verb('terminal list', {
        summary: 'list the terminals in the session',
        args: [],
        options: [
          {
            flag: '-s, --session <id>',
            help: 'act on this session yourself; without it, act as the agent session this runs inside',
          },
        ],
      }),
      verb('terminal open', {
        summary: 'open a named terminal, optionally running a command in it',
        args: [
          { name: 'name', help: 'its name: a lowercase letter, then letters, digits or dashes' },
          {
            name: 'command',
            help: 'a command to run in it; use -- before one that starts with a dash',
            optional: true,
            variadic: true,
          },
        ],
        options: [
          {
            flag: '-s, --session <id>',
            help: 'act on this session yourself; without it, act as the agent session this runs inside',
          },
          { flag: '-f, --folder <dir>', help: 'where it starts: absolute, or relative to the session folder' },
          {
            flag: '--ask [message]',
            help: 'hand it to the owner at once: their tab comes forward with "Your turn here"; optionally say what to do',
          },
        ],
      }),
      verb('terminal send', {
        summary: 'type text and press keys in a terminal',
        args: [
          { name: 'name', help: "the terminal's name or id" },
          {
            name: 'text',
            help: 'text to type; use -- before text that starts with a dash',
            optional: true,
            variadic: true,
          },
        ],
        options: [
          {
            flag: '-s, --session <id>',
            help: 'act on this session yourself; without it, act as the agent session this runs inside',
          },
          { flag: '-k, --key <key...>', help: 'keys to press after the text: enter, tab, escape, up, ctrl-c, …' },
        ],
      }),
      verb('terminal read', {
        summary: 'print the last lines of a terminal',
        args: [{ name: 'name', help: "the terminal's name or id" }],
        options: [
          {
            flag: '-s, --session <id>',
            help: 'act on this session yourself; without it, act as the agent session this runs inside',
          },
          { flag: '-n, --lines <n>', help: 'how many lines' },
        ],
      }),
      verb('terminal wait', {
        summary: 'wait until text appears or the running command ends; exits 1 on timeout',
        args: [{ name: 'name', help: "the terminal's name or id" }],
        options: [
          {
            flag: '-s, --session <id>',
            help: 'act on this session yourself; without it, act as the agent session this runs inside',
          },
          { flag: '--text <text>', help: 'wait until this text appears' },
          { flag: '--exit', help: 'wait until the running command ends' },
          { flag: '-t, --timeout <ms>', help: 'how long to wait in all (default: "10000")' },
        ],
      }),
      verb('terminal close', {
        summary: 'close a terminal, or with --all-finished every terminal a finished ferret left open',
        args: [{ name: 'name', help: "the terminal's name or id", optional: true }],
        options: [
          {
            flag: '-s, --session <id>',
            help: 'act on this session yourself; without it, act as the agent session this runs inside',
          },
          {
            flag: '--all-finished',
            help: "the owner's cleanup: close the terminals of ferrets that completed, stopped or were removed",
          },
          { flag: '--json', help: 'print the --all-finished result as JSON' },
        ],
      }),
      verb('terminal slots', {
        summary: 'show who holds the open terminals, across every ferret, against the limit',
        args: [],
        options: [{ flag: '--json', help: 'print the result as JSON' }],
      }),
      verb('terminal ask', {
        summary: 'hand a terminal to the owner',
        args: [
          { name: 'name', help: "the terminal's name or id" },
          { name: 'message', help: 'what the owner should do there; never a secret', optional: true, variadic: true },
        ],
        options: [
          {
            flag: '-s, --session <id>',
            help: 'act on this session yourself; without it, act as the agent session this runs inside',
          },
        ],
      }),
      verb('terminal takeover', {
        summary: 'take a terminal over from the ferret until you hand it back',
        args: [{ name: 'name', help: "the terminal's name or id" }],
        options: [
          {
            flag: '-s, --session <id>',
            help: 'act on this session yourself; without it, act as the agent session this runs inside',
          },
        ],
      }),
      verb('terminal handback', {
        summary: 'hand a terminal you took over back to the ferret',
        args: [{ name: 'name', help: "the terminal's name or id" }],
        options: [
          {
            flag: '-s, --session <id>',
            help: 'act on this session yourself; without it, act as the agent session this runs inside',
          },
        ],
      }),
      verb('terminal handover', {
        summary: 'let the ferret use a terminal you opened',
        args: [{ name: 'name', help: "the terminal's name or id" }],
        options: [
          {
            flag: '-s, --session <id>',
            help: 'act on this session yourself; without it, act as the agent session this runs inside',
          },
        ],
      }),
      verb('terminal control', {
        summary: 'show which terminals a ferret is driving, taken over, or handed to it',
        args: [],
        options: [
          {
            flag: '-s, --session <id>',
            help: 'act on this session yourself; without it, act as the agent session this runs inside',
          },
        ],
      }),
      verb('attach', {
        summary: 'attach to the terminal a ferret runs in (Ctrl-b d detaches)',
        args: [{ name: 'id', help: 'session id' }],
      }),
      verb('job run', {
        summary:
          "start a background job in the keeper and attach to it; exits with the job's exit code (75 if the attachment broke)",
        args: [
          {
            name: 'command',
            help: 'the command, after --: ONE word is a shell command line as written (pipes work), several words are an argv',
            variadic: true,
          },
        ],
        options: [
          {
            flag: '-s, --session <id>',
            help: 'act on this session yourself; without it, act as the agent session this runs inside',
          },
          { flag: '--name <name>', help: 'its name: a lowercase letter, then letters, digits or dashes' },
        ],
      }),
      verb('job attach', {
        summary:
          "stream a job's log until it ends, then exit with its exit code; a signal only detaches (exit 75), the job runs on",
        args: [{ name: 'job', help: "the job's name or id" }],
        options: [
          {
            flag: '-s, --session <id>',
            help: 'act on this session yourself; without it, act as the agent session this runs inside',
          },
          { flag: '--from-start', help: 'print the whole log first (default: its last 100 lines)' },
          { flag: '--tail <n>', help: 'print only the last N lines first' },
        ],
      }),
      verb('job logs', {
        summary: "print a job's log without following it",
        args: [{ name: 'job', help: "the job's name or id" }],
        options: [
          {
            flag: '-s, --session <id>',
            help: 'act on this session yourself; without it, act as the agent session this runs inside',
          },
          { flag: '--tail <n>', help: 'only the last N lines' },
        ],
      }),
      verb('job wait', {
        summary: 'block until a job ends and print its exit; exits with its exit code (124 on timeout)',
        args: [{ name: 'job', help: "the job's name or id" }],
        options: [
          {
            flag: '-s, --session <id>',
            help: 'act on this session yourself; without it, act as the agent session this runs inside',
          },
          { flag: '--timeout <duration>', help: 'give up after this long: 30, 30s, 5m, 2h' },
        ],
      }),
      verb('job stop', {
        summary: 'stop a job: SIGTERM to its tree, then SIGKILL after a grace period',
        args: [{ name: 'job', help: "the job's name or id" }],
        options: [
          {
            flag: '-s, --session <id>',
            help: 'act on this session yourself; without it, act as the agent session this runs inside',
          },
        ],
      }),
      verb('job ls', {
        summary: "list a session's running and recent jobs with exit codes and ages",
        args: [],
        options: [
          {
            flag: '-s, --session <id>',
            help: 'act on this session yourself; without it, act as the agent session this runs inside',
          },
          { flag: '--all', help: 'every retained job, not just the running ones and the latest finished' },
          { flag: '--json', help: 'print the result as JSON' },
        ],
      }),
    ],
  },

  ui: {
    panels: [
      panel('ferret.side', { id: 'terminals', order: 20 }),
      panel('ferret.side', { id: 'console', order: 21 }),
      panel('ferret.side', { id: 'processes', order: 22 }),
    ],
    settings: [
      settingsTab('terminals', { group: 'advanced', label: 'Terminals', order: 50 }),
      settingsTab('limits', { group: 'health', label: 'Ferret limits', order: 51 }),
    ],
    renderers: [renderer('reference', { prefix: '%terminal' })],
  },

  /** Never reached by a ferret, through any root: the tmux socket: whoever opens it drives every terminal (`PrivacyDecl`). */
  privacy: {
    private: ['tmux.sock'],
  },
  data: {
    state: [
      /** tmux's own server socket: not a document, never parsed by Ferretry. */
      defineState({
        name: 'tmux',
        path: 'tmux.sock',
        store: 'opaque',
        format: 1,
        onDamaged: { narrower: 'a new tmux server is started; no pane is adopted' },
      }),
      defineState({
        name: 'terminals',
        path: 'terminals.json',
        store: 'json',
        format: 1,
        schema: TerminalsStateSchema,
      }),
      /** Jobs: `<ferret>/<job>/{job.json,output.log,exit.json}`; the wrapper in the pane writes the last two itself. */
      JobFiles,
      /** The live `fy job attach` clients, so a move can ask a ferret's attachments to let go. */
      JobAttachments,
    ],
    config: [
      defineConfig({
        file: 'terminals.yaml',
        schema: TerminalsConfigSchema,
        axis: 'configure',
        loosens: terminalsLoosens,
      }) as ConfigDef,
    ],
    readModels: ['terminals', 'holders'],
    publishes: [TerminalChanged],
    /** A hold began or ended on a terminal: the viewer's frames built before it are not sent (§7.3). */
    subscribes: [HoldsChanged],
  },

  hooks: {
    takes: [
      { hook: InputTargets, key: 'terminal' },
      { hook: Runners, key: 'tmux' },
      /** The composer's `%terminal` menu is this plugin's: the terminals the ferret holds (reference.catalog). */
      { hook: ReferenceCatalog, key: '%terminal' },
    ],
  },

  /** `tmux-release`: today's `tmux release` row, asked fresh per report (it never starts a tmux server). */
  doctor: ['tmux', 'user-slice', 'tmux-release'],

  /** `fyd --check` asks the installed tmux and this daemon's own socket for their releases; nothing runs it at boot. */
  selftest: ['tmux-release'],

  permissions: {
    /**
     * tmux (the server and its control client); systemd-run, systemctl, ionice, taskpolicy, nice (ferret limits); ps (process trees and
     * incarnations on macOS); stty (a terminal's echo and line mode, for an input card); getent (the login shell).
     */
    spawn: [
      'tmux',
      'systemd-run',
      'systemctl',
      'ionice',
      'taskpolicy',
      'nice',
      'ps',
      'stty',
      'getent',
      'lsof',
      '/usr/bin/dscl',
    ],
    /** `downloads`: only to locate Terminals' state folder for tmux's socket (no kernel port names it). */
    roots: ['downloads'],
    /** The kernel's launch-guard fact: whether this daemon is a test's, and the PATH a real harness would be found on. */
    hostFacts: true,
    /** Whether tmux is installed (`kernel.paths.which`: a PATH lookup, never executing) — the required `tmux` doctor row. */
    which: true,
  },
});
