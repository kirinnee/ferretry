import { appAction, definePlugin, panel, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import { LoginsPort } from '@ferretry/plugin-logins/contract';
import { audit, cap } from '@ferretry/core-gate/contract';
import {
  FerretsPort,
  MODEL_SET_ITEMS,
  PROFILE_ITEMS,
  RUNTIME_ITEMS,
  RUNTIMES_AUDIT,
  RUNTIMES_CONFIG,
  RUNTIMES_READ_MODELS,
  RUNTIMES_WORDS,
  RuntimesChanged,
  RuntimesDefaultChanged,
  RuntimesPort,
} from './contract/index.ts';

/**
 * Runtimes (§2.3): named ways to start a ferret (a login plus a profile), profiles, model sets, the first-run scan and
 * the Clone export. Route paths follow §3.2 (`/v1/<id>/…`): today's `/v1/fleet/…` and `/v1/recommend` moved under
 * `/v1/runtimes/…`, descriptors copied from `lib/runtime/mounts/{fleet-catalog,fleet-setup,recommend}.ts`.
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

  needs: { ferrets: FerretsPort, logins: LoginsPort },
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
      // ── the recommender (recommend.ts): no capability today; it names every login, so `operator` ───────────────────
      route('POST /v1/recommend', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read: it starts nothing' },
        guard: { none: 'logins, models and reasons; no pane text' },
      }),
    ],
    cli: [
      verb('runtime ls', { summary: 'the runtimes on this machine: a sign-in plus a profile' }),
      verb('runtime add', {
        summary: 'add a runtime: which sign-in, which profile, and whether Ferretry launches it as an agent',
      }),
      verb('runtime show', { summary: 'one runtime: its stack, models and fixed layer' }),
      verb('runtime set', { summary: 'change which sign-in or profile a runtime uses, or whether it is an agent' }),
      verb('runtime disable', {
        summary: 'switch a runtime off without deleting it: nothing new starts on it; running ferrets keep going',
      }),
      verb('runtime enable', { summary: 'switch a disabled runtime back on' }),
      verb('runtime rename', { summary: 'give a runtime a new name; nothing restarts' }),
      verb('runtime rm', { summary: 'remove a runtime' }),
      verb('runtime import', {
        summary: "import one harness's own sign-in and setup, with no questions (for scripts)",
      }),
      verb('runtime scan', {
        summary: 'what the first run would find: each harness, its sign-in, instructions, settings, servers and skills',
      }),
      verb('recommend', { summary: 'which sign-in and model should take one task, and why' }),
      verb('profile ls', { summary: 'the profiles on this machine, each with its scope' }),
      verb('profile show', { summary: 'one profile: its layers, overrides and where it is used' }),
      verb('profile build', { summary: 'build a new profile from layers' }),
      verb('profile edit', { summary: "replace a profile's layers; every runtime on it changes" }),
      verb('profile rm', { summary: 'delete a profile' }),
      verb('model-set ls', { summary: 'the model sets on this machine' }),
      verb('model-set show', { summary: 'one model set and where it is used' }),
      verb('model-set add', { summary: 'add a model set' }),
      verb('model-set edit', { summary: 'change a model set; every profile and runtime that uses it changes too' }),
      verb('model-set rm', { summary: 'remove a model set (refused while a profile uses it)' }),
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
    // The runtime picker above the composer (today's runtime controls on a new ferret).
    panels: [panel('composer.tools', { id: 'runtime-picker', order: 10 })],
  },

  data: {
    config: [RUNTIMES_CONFIG, RUNTIME_ITEMS, PROFILE_ITEMS, MODEL_SET_ITEMS],
    readModels: RUNTIMES_READ_MODELS,
    publishes: [RuntimesChanged, RuntimesDefaultChanged],
    // `items` stays empty: it lists items this package SHIPS. Runtimes are items the owner (or a catalog) installs.
  },

  onboarding: [{ id: 'runtimes', title: 'Name your runtimes', order: 40 }],
  doctor: ['runtimes-config'],

  permissions: {
    roots: [],
    network: [],
    spawn: ['brew', 'apt-get', 'npm'],
    secrets: [],
  },
});
