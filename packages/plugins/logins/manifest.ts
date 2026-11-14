import { appAction, definePlugin, panel, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import { HOSTED_APP_ORIGIN } from '@ferretry/kernel/contract';
import { audit, cap } from '@ferretry/core-gate/contract';
import { Logins } from '@ferretry/core-ferrets/contract';
import { VaultPort } from '@ferretry/core-vault/contract';
import { BrowsersPort } from '@ferretry/plugin-browsers/contract';
import {
  ENDPOINTS_CONFIG,
  LOGIN_KINDS,
  LOGINS_AUDIT,
  LOGINS_CONFIG,
  LOGINS_CREDENTIALS,
  LOGINS_MODELS,
  LOGINS_READ_MODELS,
  LOGINS_WORDS,
  LoginChanged,
  LoginSignedIn,
  LoginChangesPort,
  LoginsPort,
  LoginsBudget,
  LoginsUsedBy,
  MODELS_CONFIG,
  ModelsChanged,
} from './contract/index.ts';

/**
 * Logins (§2.3): the AI provider sign-ins, API keys, proxies and endpoints ferrets spend. It takes the five `logins:*`
 * keys from Ferrets and needs the Vault (secrets by name; there is no getter). Paths follow the plugin prefix
 * (`/v1/logins/…`, §3.2); today's `/v1/fleet/login*`, `/v1/fleet/credentials*` and `/v1/fleet/presets` (a retired word) move there, while `/v1/models*` keeps its path
 * come here, descriptors copied field for field (minimum, caller, capability, noStore).
 *
 * NOT HERE, on purpose: `GET/POST /v1/speedups…` (the provider test for voice speed-up keys) is Voice's and Usage's,
 * not a login's; and the `fleet/mcp-auth` sign-in is MCP's.
 */
export default definePlugin({
  id: 'logins',
  title: 'Logins',
  version: '5.0.0',
  api: 5,
  core: false,
  // `item`: an endpoint preset is a data item kind (§4.9), shareable through Catalogs.
  kinds: ['login', 'item', 'command', 'view'],
  words: LOGINS_WORDS,

  needs: { vault: VaultPort },
  uses: { browsers: BrowsersPort },
  provides: { logins: LoginsPort, loginChanges: LoginChangesPort },

  actions: {
    routes: [
      // The sign-in flow (today's fleet-login.ts): one flow per harness, no shared abstraction.
      route('POST /v1/logins/sign-in', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(LOGINS_AUDIT.signIn),
        guard: { none: 'a flow state names a verification URL and a device code, which authorize nothing alone' },
      }),
      route('GET /v1/logins/sign-in/:flowId', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'a read of a flow the person started; not recorded today' },
        guard: { none: 'a flow state names a verification URL and a device code, which authorize nothing alone' },
      }),
      route('POST /v1/logins/sign-in/:flowId', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(LOGINS_AUDIT.signInAnswer),
        guard: { none: 'the code or address a person brings back goes to the harness child and is kept nowhere' },
      }),
      route('DELETE /v1/logins/sign-in/:flowId', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(LOGINS_AUDIT.signInCancel),
        guard: { none: 'a flow state names a verification URL and a device code, which authorize nothing alone' },
      }),

      // The logins themselves (today's fleet-credentials.ts).
      route('GET /v1/logins', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read' },
        guard: { none: 'status words, usage windows and secret NAMES only; no token or digest has a field' },
      }),
      route('POST /v1/logins/:loginId/check', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'not recorded today (docs/audit.md has no Check now row); it spends nothing' },
        guard: { none: 'status words and usage windows only' },
      }),
      route('POST /v1/logins/:loginId/test', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(LOGINS_AUDIT.loginTest),
        guard: { none: 'one fixed sentence per code; a provider body is never returned' },
      }),

      // One login changed (today's reviewed `credential.*` changes; Logins stages and applies its own
      // `config/logins/<id>.yaml`). Staging holds the change and says what applying it does; applying runs exactly that.
      route('POST /v1/logins/changes', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(LOGINS_AUDIT.changeStage),
        guard: { none: 'a staged change names an intent and secret NAMES; a raw secret is refused, no value is held' },
      }),
      route('GET /v1/logins/changes/:changeId', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'a read of a staged change' },
        guard: { none: 'a staged change names an intent and secret NAMES; no value is held' },
      }),
      route('POST /v1/logins/changes/:changeId/apply', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(LOGINS_AUDIT.changeApply),
        guard: { none: 'an outcome of writes; it carries no token, only a login as the list shows it' },
      }),
      route('GET /v1/logins/presets', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        audit: { skip: 'a read' },
        guard: { none: 'a preset names secrets only by the name they are suggested to be kept under' },
      }),

      // The model catalogs (today's models.ts): reads and a refresh that spends nothing.
      route('GET /v1/models', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read' },
        guard: { none: 'labels, model ids and tiers only' },
      }),
      route('POST /v1/models/refresh', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a refresh is a read that spends nothing (no rule today)' },
        guard: { none: 'labels, model ids and tiers only' },
      }),
      route('POST /v1/models/local/refresh', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read of this machine; it spends nothing (no rule today)' },
        guard: { none: 'model ids and sizes of a local server only' },
      }),
    ],
    cli: [
      verb('login ls', {
        summary: 'the logins on this machine, with whether each works and its usage',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('login add', {
        summary: 'add a sign-in: sign claude-code or codex in, or build one for a provider from its list',
        args: [
          {
            name: 'tool-or-provider',
            help: 'claude, codex, or a provider — e.g. glm, deepseek, bedrock',
            optional: true,
          },
        ],
        options: [
          { flag: '--label <label>', help: 'a name to tell this login apart from another with the same email' },
          { flag: '--id <id>', help: 'the id to give it (default: made from the tool and the label)' },
          { flag: '--no-sign-in', help: 'add the login without signing in now' },
          { flag: '--preset <id>', help: 'an environment login from a provider preset (see `fy login presets`)' },
          {
            flag: '--env <NAME=VALUE>',
            help: 'an environment login variable: a plain value, or ${secret:NAME} for a secret (repeat it) (default: {})',
          },
          { flag: '--cloud-credential <reference>', help: 'aws-profile:<name>, gcloud-adc[:<path>] or azure-cli' },
          {
            flag: '--for <tool>',
            help: 'which CLI a provider that drives both is listed under first (claude or codex)',
          },
          { flag: '--from-env', help: 'import from the variables already set in this shell, instead of typing one' },
          { flag: '--test', help: 'test the login once it is added, the same as `login test`' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'do not ask before a change that removes or replaces something (for scripts)' },
          { flag: '--json', help: 'print the change and its outcome as JSON' },
        ],
      }),
      verb('login check', {
        summary: 'check now whether a sign-in still works (a refresh for Codex)',
        args: [{ name: 'id', help: 'the login' }],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('login test', {
        summary: 'test an environment sign-in with one call, the cheapest its provider allows',
        args: [{ name: 'id', help: 'the login' }],
        options: [
          {
            flag: '--allow-inference',
            help: 'agree to one message capped at one token, for a provider with no free check',
          },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
      verb('login presets', {
        summary: 'the provider presets an environment sign-in can be made from',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('login signin', {
        summary: 'sign one in, or in again',
        args: [{ name: 'id', help: 'the login' }],
        options: [
          {
            flag: '--force',
            help: 'start over: end the sign-in already running for it, and clear a leftover Codex sign-in from its port',
          },
        ],
      }),
      verb('login signout', {
        summary: 'sign one out; every runtime on it then needs sign-in',
        args: [{ name: 'id', help: 'the login' }],
        options: [
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'do not ask before a change that removes or replaces something (for scripts)' },
          { flag: '--json', help: 'print the change and its outcome as JSON' },
        ],
      }),
      verb('login disable', {
        summary: 'switch a sign-in off without deleting it: nothing new starts on it; running ferrets keep going',
        args: [{ name: 'id', help: 'the login' }],
        options: [
          { flag: '--until <when>', help: 'switch back on by itself: a date (2026-11-01), a time or a wait (3d, 12h)' },
          { flag: '--reason <text>', help: 'why, shown beside the switch and in every refusal' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'do not ask before a change that removes or replaces something (for scripts)' },
          { flag: '--json', help: 'print the change and its outcome as JSON' },
        ],
      }),
      verb('login enable', {
        summary: 'switch a disabled sign-in back on',
        args: [{ name: 'id', help: 'the login' }],
        options: [
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'do not ask before a change that removes or replaces something (for scripts)' },
          { flag: '--json', help: 'print the change and its outcome as JSON' },
        ],
      }),
      verb('login label', {
        summary: 'give a sign-in a label, or take it away with --clear',
        args: [
          { name: 'id', help: 'the login' },
          { name: 'label', help: 'the label', optional: true },
        ],
        options: [
          { flag: '--clear', help: 'remove the label' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'do not ask before a change that removes or replaces something (for scripts)' },
          { flag: '--json', help: 'print the change and its outcome as JSON' },
        ],
      }),
      verb('login rm', {
        summary: 'remove a sign-in (refused while a runtime uses it)',
        args: [{ name: 'id', help: 'the login' }],
        options: [
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'do not ask before a change that removes or replaces something (for scripts)' },
          { flag: '--json', help: 'print the change and its outcome as JSON' },
        ],
      }),
      verb('login models list', {
        summary: 'every model catalog in effect, where it came from, and its models by tier',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('login models refresh', {
        summary: 'check now for a newer published model catalog',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
    ],
    app: [
      appAction('login.sign-in', { on: 'daemon', label: 'Sign in', calls: 'POST /v1/logins/sign-in' }),
      appAction('login.check', { on: 'daemon', label: 'Check now', calls: 'POST /v1/logins/:loginId/check' }),
    ],
  },

  ui: {
    // Today these live in Settings › Machines › Sign-ins; the quota readout sits in the shell's status area.
    panels: [
      panel('settings', { id: 'sign-ins', order: 10 }),
      panel('settings', { id: 'add-login', order: 11 }),
      panel('settings', { id: 'claude-code-login', order: 12 }),
      panel('settings', { id: 'codex-login', order: 13 }),
      panel('settings', { id: 'local-models', order: 14 }),
      panel('daemon.status', { id: 'quota-readout', order: 30 }),
      // The first-run step's body (Onboarding's steps screen offers this slot): the sign-ins view.
      panel('onboarding.step', { id: 'onboarding-step', order: 30 }),
    ],
    settings: [settingsTab('logins', { group: 'agents', label: 'Logins', order: 25 })],
  },

  /** Never reached by a ferret, through any root: the sign-in material of every login (`PrivacyDecl`). */
  privacy: {
    private: ['credentials'],
  },
  data: {
    state: [LOGINS_CREDENTIALS, LOGINS_MODELS],
    config: [LOGINS_CONFIG, ENDPOINTS_CONFIG, MODELS_CONFIG],
    readModels: LOGINS_READ_MODELS,
    publishes: [LoginSignedIn, LoginChanged, ModelsChanged],
  },

  hooks: {
    takes: LOGIN_KINDS.map(kind => ({ hook: Logins, key: kind })),
    // Which runtimes use a login: Runtimes answers, so a removal can be refused while one still does (`LoginsUsedBy`).
    offers: [{ hook: LoginsUsedBy }, { hook: LoginsBudget }],
  },

  onboarding: [{ id: 'login', title: 'Sign in', order: 30 }],
  doctor: ['logins-store'],

  permissions: {
    // Logins' own sign-in stores (§7.7): the kernel gives this internal root to Logins alone.
    roots: ['credentials'],
    // The one file Logins hands another plugin: Codex's `auth.json`, linked into a ferret's home by the kernel
    // (`RootsPort.shareCredential`). Only the `credentials` root's owner can mint, and only to a receiver it names.
    shareCredentials: ['auth.json'],
    // Fixed hosts: the two usage reads and the built-in presets' test hosts. A login's OWN gateway host (custom
    // endpoints, Azure resources) is a user value; the kernel's network allowlist cannot name it yet (GAP).
    network: [
      'api.anthropic.com',
      'chatgpt.com',
      'api.openai.com',
      'claude.ai',
      new URL(HOSTED_APP_ORIGIN).host,
      'openrouter.ai',
      'ai-gateway.vercel.sh',
      'api.deepseek.com',
      'api.minimax.io',
      'www.minimax.io',
      'api.moonshot.ai',
      'api.z.ai',
      'localhost',
      '127.0.0.1',
    ],
    spawn: ['claude', 'codex', 'ollama', 'lsof', 'ss', 'ps'],
    secrets: [],
  },
});
