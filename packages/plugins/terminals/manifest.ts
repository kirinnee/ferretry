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
      verb('terminal list', { summary: 'list the terminals in the session' }),
      verb('terminal open', { summary: 'open a named terminal, optionally running a command in it' }),
      verb('terminal send', { summary: 'type text and press keys in a terminal' }),
      verb('terminal read', { summary: 'print the last lines of a terminal' }),
      verb('terminal wait', { summary: 'wait until text appears or the running command ends; exits 1 on timeout' }),
      verb('terminal close', {
        summary: 'close a terminal, or with --all-finished every terminal a finished ferret left open',
      }),
      verb('terminal slots', { summary: 'show who holds the open terminals, across every ferret, against the limit' }),
      verb('terminal ask', { summary: 'hand a terminal to the owner' }),
      verb('terminal takeover', { summary: 'take a terminal over from the ferret until you hand it back' }),
      verb('terminal handback', { summary: 'hand a terminal you took over back to the ferret' }),
      verb('terminal handover', { summary: 'let the ferret use a terminal you opened' }),
      verb('terminal control', { summary: 'show which terminals a ferret is driving, taken over, or handed to it' }),
      verb('attach', { summary: 'attach to the terminal a ferret runs in (Ctrl-b d detaches)' }),
    ],
  },

  ui: {
    panels: [
      panel('ferret.side', { id: 'terminals', order: 20 }),
      panel('ferret.side', { id: 'console', order: 21 }),
      panel('ferret.side', { id: 'processes', order: 22 }),
    ],
    settings: [settingsTab('terminals', { label: 'Terminals', order: 50 })],
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
