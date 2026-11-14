import { appAction, definePlugin, panel, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import { LoginChanged, LoginChangesPort, LoginsPort, LoginsUsedBy } from '@ferretry/plugin-logins/contract';
import { LoginPaused, LoginResumed, UsagePort } from '@ferretry/plugin-usage/contract';
import {
  AutoResumeDecide,
  FerretsChanged,
  LaunchParts,
  MOVE_ACCOUNT_SLOT,
  NEW_FERRET_ACCOUNT_SLOT,
  RuntimeStart,
  StartDecide,
} from '@ferretry/core-ferrets/contract';
import { audit, cap } from '@ferretry/core-gate/contract';
import {
  FerretsPort,
  INSTRUCTION_ITEMS,
  MODEL_SET_ITEMS,
  PROFILE_ITEMS,
  ProfileClaudeHooksSource,
  ProfileClaudeSettingsSource,
  ProfileCodexHooksSource,
  ProfileCodexSettingsSource,
  ProfileMcpSource,
  ProfileSkillsSource,
  RUNTIME_ITEMS,
  RUNTIMES_AUDIT,
  RUNTIMES_CONFIG,
  RUNTIMES_READ_MODELS,
  RUNTIMES_WORDS,
  RuntimesChanged,
  RuntimesDefaultChanged,
  RuntimesLaunchFailed,
  RuntimesPort,
} from './contract/index.ts';

/**
 * Runtimes (§2.3): named ways to start a ferret (a login plus a profile), profiles, model sets, the first-run scan and
 * the Clone export. Route paths follow §3.2 (`/v1/<id>/…`): today's `/v1/fleet/…` moved under `/v1/runtimes/…`,
 * descriptors copied from `lib/runtime/mounts/{fleet-catalog,fleet-setup}.ts`. `fy recommend` is Packs' verb (D2 #14).
 *
 * The per-ferret runtime model/control routes belong here. Ferrets owns its detail GET; Logins owns sign-in.
 * MCP and skill installs belong to their plugins.
 */
export default definePlugin({
  id: 'runtimes',
  title: 'Runtimes',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['runtime', 'command', 'view'],
  words: RUNTIMES_WORDS,

  // Logins is one plugin: reading it (`logins`) and changing it (`loginChanges`) are two ports, and only Runtimes holds the second.
  needs: { ferrets: FerretsPort, logins: LoginsPort, loginChanges: LoginChangesPort },
  // Optional (§2.4): the account picker shows each runtime's quota from Usage's feed. Usage off = the picker without quota.
  uses: { usage: UsagePort },
  provides: { runtimes: RuntimesPort },

  actions: {
    routes: [
      route('GET /v1/ferrets/:id/runtime-models', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a live catalog read' },
        guard: { none: 'model choices; no pane text' },
      }),
      route('POST /v1/ferrets/:id/runtime', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'the runtime subsystem records the control outcome' },
        guard: { none: 'runtime control; no pane text' },
      }),
      // ── the catalogue (fleet-catalog.ts): noStore on all eight, every answer is a statement about now ─────────────
      route('GET /v1/runtimes/machine', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read' },
        guard: { none: 'tools, settings and counts; no pane text' },
      }),
      route('GET /v1/runtimes/components', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read' },
        guard: { none: 'component text with every secret-looking value already cut out; no pane text' },
      }),
      route('GET /v1/runtimes/profiles', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read' },
        guard: { none: 'layers and resolved stacks; no pane text' },
      }),
      route('POST /v1/runtimes/profiles/preview', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read with a body; it writes nothing' },
        guard: { none: 'layers and resolved stacks; no pane text' },
      }),
      route('GET /v1/runtimes', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read' },
        guard: { none: 'runtimes and model lists; no pane text' },
      }),
      route('POST /v1/runtimes/proposals', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(RUNTIMES_AUDIT.propose),
        guard: { none: 'a staged change names an intent; it carries no pane text' },
      }),
      route('GET /v1/runtimes/proposals/:proposalId', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'a read of a staged change' },
        guard: { none: 'a staged change names an intent; it carries no pane text' },
      }),
      route('POST /v1/runtimes/proposals/:proposalId/apply', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(RUNTIMES_AUDIT.apply),
        guard: { none: 'an outcome of writes; it carries no pane text' },
      }),
      // ── setup (fleet-setup.ts): all `fleet.configure`, because the scan and the export read the person's own setup ─
      route('GET /v1/runtimes/setup/scan', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'a read; names only, never a value' },
        guard: { none: 'file names, server names and secret-looking key NAMES; never a value' },
      }),
      route('POST /v1/runtimes/machine/tools/install', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(RUNTIMES_AUDIT.installTool),
        guard: { none: 'an install outcome and the command to run by hand; no pane text' },
      }),
      route('GET /v1/runtimes/export', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'a read; the bundle carries no credential and no secret value' },
        guard: { none: 'configuration text and secret NAMES as ${secret:NAME}; never a value' },
      }),
      route('POST /v1/runtimes/clone/review', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'a read with a body; it writes nothing' },
        guard: { none: 'configuration text; a ${secret:NAME} stays a reference' },
      }),
      route('POST /v1/runtimes/clone/forget', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(RUNTIMES_AUDIT.forgetCloneSource),
        guard: { none: 'whether a record was forgotten; nothing copied is touched' },
      }),
      route('POST /v1/runtimes/clone/keys', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: "records timestamps of secret names only; not on today's audit table" },
        guard: { none: 'counts only' },
      }),
    ],
    cli: [
      verb('runtimes', {
        summary: 'the runtimes on this machine: a sign-in plus a profile',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('runtime ls', {
        summary: 'the runtimes on this machine: a sign-in plus a profile',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('runtime add', {
        summary: 'add a runtime: which sign-in, which profile, and whether Ferretry launches it as an agent',
        args: [{ name: 'name', help: 'the runtime name' }],
        options: [
          { flag: '--credential <id>', help: 'the login it uses' },
          { flag: '--profile <name>', help: 'the profile it uses' },
          {
            flag: '--agent',
            help: 'Ferretry launches it as an agent: no trust or onboarding prompts, and the agent permissions',
          },
          { flag: '--add-another', help: 'add it even when another runtime already uses this login and profile' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'do not ask before a change that removes or replaces something (for scripts)' },
          { flag: '--json', help: 'print the change and its outcome as JSON' },
        ],
      }),
      verb('runtime show', {
        summary: 'one runtime: its stack, models and fixed layer',
        args: [{ name: 'name', help: 'the runtime' }],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('runtime set', {
        summary: 'change which sign-in or profile a runtime uses, or whether it is an agent',
        args: [{ name: 'name', help: 'the runtime' }],
        options: [
          { flag: '--credential <id>', help: 'the login it uses' },
          { flag: '--profile <name>', help: 'the profile it uses' },
          { flag: '--agent', help: 'Ferretry launches it as an agent' },
          { flag: '--no-agent', help: 'it is not launched as an agent' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'do not ask before a change that removes or replaces something (for scripts)' },
          { flag: '--json', help: 'print the change and its outcome as JSON' },
        ],
      }),
      verb('runtime disable', {
        summary: 'switch a runtime off without deleting it: nothing new starts on it; running ferrets keep going',
        args: [{ name: 'name', help: 'the runtime' }],
        options: [
          { flag: '--until <when>', help: 'switch back on by itself: a date (2026-11-01), a time or a wait (3d, 12h)' },
          { flag: '--reason <text>', help: 'why, shown beside the switch and in every refusal' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'do not ask before a change that removes or replaces something (for scripts)' },
          { flag: '--json', help: 'print the change and its outcome as JSON' },
        ],
      }),
      verb('runtime enable', {
        summary: 'switch a disabled runtime back on',
        args: [{ name: 'name', help: 'the runtime' }],
        options: [
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'do not ask before a change that removes or replaces something (for scripts)' },
          { flag: '--json', help: 'print the change and its outcome as JSON' },
        ],
      }),
      verb('runtime rename', {
        summary: 'give a runtime a new name; nothing restarts',
        args: [
          { name: 'name', help: 'the runtime' },
          { name: 'new-name', help: 'its new name' },
        ],
        options: [
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'do not ask before a change that removes or replaces something (for scripts)' },
          { flag: '--json', help: 'print the change and its outcome as JSON' },
        ],
      }),
      verb('runtime rm', {
        summary: 'remove a runtime',
        args: [{ name: 'name', help: 'the runtime' }],
        options: [
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'do not ask before a change that removes or replaces something (for scripts)' },
          { flag: '--json', help: 'print the change and its outcome as JSON' },
        ],
      }),
      verb('runtime link', {
        summary: "link one harness's own sign-in and setup as a runtime, with no questions (for scripts)",
        args: [{ name: 'tool', help: 'the tool to link: claude or codex' }],
        options: [
          { flag: '--name <name>', help: 'the runtime’s name; default is the suggested one (claude-default)' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'go ahead without asking' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
      verb('runtime scan', {
        summary: 'what the first run would find: each harness, its sign-in, instructions, settings, servers and skills',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('profiles', {
        summary: 'the profiles on this machine: scope, layers, overrides and where each is used',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('profile ls', {
        summary: 'the profiles on this machine, each with its scope',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('profile show', {
        summary: 'one profile: its layers, overrides and where it is used',
        args: [{ name: 'name', help: 'the profile' }],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('profile build', {
        summary: 'build a new profile from layers',
        args: [{ name: 'name', help: 'the profile name' }],
        options: [
          {
            flag: '--layer <kind/name>',
            help: 'a component (instructions/main) or another profile (profile/default); repeat it, oldest first (default: [])',
          },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'do not ask before a change that removes or replaces something (for scripts)' },
          { flag: '--json', help: 'print the change and its outcome as JSON' },
        ],
      }),
      verb('profile edit', {
        summary: "replace a profile's layers; every runtime on it changes",
        args: [{ name: 'name', help: 'the profile' }],
        options: [
          {
            flag: '--layer <kind/name>',
            help: 'a component (instructions/main) or another profile (profile/default); repeat it, oldest first (default: [])',
          },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'do not ask before a change that removes or replaces something (for scripts)' },
          { flag: '--json', help: 'print the change and its outcome as JSON' },
        ],
      }),
      verb('profile rm', {
        summary: 'delete a profile',
        args: [{ name: 'name', help: 'the profile' }],
        options: [
          { flag: '--switch-runtimes-to <profile>', help: 'move every runtime on it to this profile first' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'do not ask before a change that removes or replaces something (for scripts)' },
          { flag: '--json', help: 'print the change and its outcome as JSON' },
        ],
      }),
      verb('model-set ls', {
        summary: 'the model sets on this machine',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('model-set show', {
        summary: 'one model set and where it is used',
        args: [{ name: 'name', help: 'the model set’s name' }],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('model-set add', {
        summary: 'add a model set',
        args: [{ name: 'name', help: 'the model set’s name' }],
        options: [
          { flag: '--model <id>', help: 'model set: one model; repeat it' },
          { flag: '--default <id>', help: 'model set: the model it starts with' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'go ahead without asking' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
      verb('model-set edit', {
        summary: 'change a model set; every profile and runtime that uses it changes too',
        args: [{ name: 'name', help: 'the model set’s name' }],
        options: [
          { flag: '--model <id>', help: 'model set: one model; repeat it' },
          { flag: '--default <id>', help: 'model set: the model it starts with' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'go ahead without asking' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
      verb('model-set rm', {
        summary: 'remove a model set (refused while a profile uses it)',
        args: [{ name: 'name', help: 'the model set’s name' }],
        options: [
          { flag: '--remove-from-profiles', help: 'take it out of every profile that has it first' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'go ahead without asking' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
    ],
    app: [
      appAction('runtimes.apply', {
        on: 'daemon',
        label: 'Apply change',
        calls: 'POST /v1/runtimes/proposals/:proposalId/apply',
      }),
      appAction('runtimes.install-tools', {
        on: 'daemon',
        label: 'Install Claude Code or Codex',
        calls: 'POST /v1/runtimes/machine/tools/install',
      }),
    ],
  },

  ui: {
    // Today these sit under Settings › <machine>: the Runtimes, Profiles and Components tabs. Components other than
    // model sets live with their own plugins now, so the third tab is the model sets.
    settings: [
      settingsTab('runtimes', { label: 'Runtimes', order: 10 }),
      settingsTab('profiles', { label: 'Profiles', order: 11 }),
      settingsTab('model-sets', { label: 'Model sets', order: 12 }),
    ],
    // The model and effort switches above the composer, and the account picker (with its health and quota) that
    // Ferrets' new-ferret and move pages OFFER as slots: Runtimes contributes, Ferrets imports nothing of it.
    panels: [
      panel('composer.tools', { id: 'runtime-picker', order: 10 }),
      panel(NEW_FERRET_ACCOUNT_SLOT, { id: 'new-ferret-account', order: 10 }),
      panel(MOVE_ACCOUNT_SLOT, { id: 'move-account', order: 10 }),
      // The first-run step's body (Onboarding's steps screen offers this slot): the runtimes view.
      panel('onboarding.step', { id: 'onboarding-step', order: 40 }),
    ],
  },

  data: {
    config: [RUNTIMES_CONFIG, RUNTIME_ITEMS, PROFILE_ITEMS, MODEL_SET_ITEMS, INSTRUCTION_ITEMS],
    readModels: RUNTIMES_READ_MODELS,
    publishes: [RuntimesChanged, RuntimesDefaultChanged, RuntimesLaunchFailed],
    // An ended Codex ferret's runtime has its app-server pair stopped, and a Codex that could not start offline says so.
    // A login switched off or on moves the disable-until timer (docs/disabling.md).
    // A login its spend budget starts or stops holding is published unavailable or runnable again (docs/budgets.md).
    subscribes: [FerretsChanged, LoginChanged, LoginPaused, LoginResumed],
    // `items` stays empty: it lists items this package SHIPS. Runtimes are items the owner (or a catalog) installs.
  },

  // Logins asks which runtimes use a login before it removes one; Runtimes is the only plugin that knows.
  // Ferrets asks whether an automatic resume may spend (W2-a); only this plugin's own yes resumes anything.
  // Runtimes OFFERS the profile component sources (`contract/component-source.ts`): the plugin that owns a kind of
  // component provides Runtimes' read of it, so Runtimes reads no other plugin's config. Taking a hook is an edge from the
  // offerer, so Runtimes starts before each owner; Runtimes needs none of them, so there is no cycle.
  hooks: {
    takes: [
      { hook: LoginsUsedBy, key: 'runtimes' },
      { hook: AutoResumeDecide },
      // A start's own compaction trigger is judged against its model's window; the launch carries the login's trigger.
      { hook: StartDecide },
      // Ferrets asks which harness and login a runtime starts with (a start that names a runtime); only this plugin answers.
      { hook: RuntimeStart, key: 'runtimes' },
      { hook: LaunchParts },
    ],
    offers: [
      { hook: ProfileMcpSource },
      { hook: ProfileSkillsSource },
      { hook: ProfileClaudeSettingsSource },
      { hook: ProfileCodexSettingsSource },
      { hook: ProfileClaudeHooksSource },
      { hook: ProfileCodexHooksSource },
    ],
  },

  onboarding: [{ id: 'runtimes', title: 'Name your runtimes', order: 40 }],
  doctor: ['runtimes-config'],

  permissions: {
    // `fleet`: the wrappers, one harness home per runtime, `manifest.json`, `ids.json` (writable, Runtimes alone).
    // `harness-home`: the machine's own Claude Code and Codex homes, READ-ONLY, for the first-run scan and, scoped to one folder, a runtime's home.
    roots: ['fleet', 'harness-home'],
    network: [],
    spawn: ['brew', 'apt-get', 'npm'],
    secrets: [],
    // Whether an MCP server's command and a harness are installed (`kernel.paths.which`: bounded, never executing).
    which: true,
    // Claude keeps its user-scope MCP servers in `~/.claude.json`, BESIDE `~/.claude`: one read-only file, no listing.
    harnessFiles: ['.claude.json'],
    // The provisioner keeps or narrows the mode of an entry it copied into a runtime's home (`RootHandle.setMode`, the
    // `fleet` root only: an internal root keeps owner bits, never group or other).
    setMode: true,
    // An ended Codex ferret's app-server pair: pids and yes/no only, SIGTERM only, to a process running from one of
    // Runtimes' own `fleet/homes/<id>` folders. `CODEX_HOME` is the one variable `usersOf` may match.
    processes: { environment: ['CODEX_HOME'] },
  },
});
