import { AskSources, AsksChanged, AsksPort } from '@ferretry/core-asks/contract';
import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import { CAPABILITIES, GatePort } from '@ferretry/core-gate/contract';
import { audit, cap } from '@ferretry/core-gate/contract';
import type { ConfigDef } from '@ferretry/kernel/contract';
import { definePlugin, renderer, route, settingsTab, tool, verb } from '@ferretry/kernel/manifest';
import {
  ChildEnvironmentPort,
  HoldsChanged,
  HoldsFile,
  InputAskRefSchema,
  InputHoldsPort,
  InputPhoneApprovals,
  InputSecureCopies,
  InputRequestFiles,
  InputTargets,
  OutputGuardPort,
  RedactionPort,
  RedactionSources,
  ProfileSecrets,
  SealedDocumentsPort,
  SecretResolverPort,
  SecretsChanged,
  VaultConfigFile,
  MintsFile,
  VaultFile,
  VaultKeyFile,
  VaultPort,
} from './contract/index.ts';

// ─── inputs (vault-b): today's `runtime/mounts/input-requests.ts` descriptors, field for field ───────────────────
const INPUT_USE_TERMINAL = { capability: CAPABILITIES.terminal, axis: 'use' } as const;
const INPUT_USE_BROWSER = { capability: CAPABILITIES.browser, axis: 'use' } as const;
const INPUT_READ = { skip: 'a read: it changes nothing' } as const;
const INPUT_BY_SERVICE = {
  skip: 'the input service records input.* itself, with the request id and its outcome',
} as const;
const INPUT_GUARD = {
  none: 'requests, facts and states only: no value, length or digest, and the prompt line is replaced during a hold',
} as const;
const INPUT_PERSON = { minimum: 'operator', caller: 'person', noStore: true, guard: INPUT_GUARD } as const;

/**
 * Vault (§2.2): keeps secrets ferrets use but never see; types values the owner gives into a terminal or page; hides
 * them everywhere afterwards. Core. The secret routes are today's `lib/runtime/mounts/secrets.ts` vault half,
 * descriptors copied field for field (minimum, caller, capability, noStore); the audit kinds are today's
 * `lib/audit/routes.ts` rows for them. The input-request and hold routes are added by the input half (vault-b).
 *
 * NOTHING HERE RETURNS A VALUE (S6): there is no `GET /v1/secrets/:name` and there never will be.
 */
export default definePlugin({
  id: 'vault',
  title: 'Vault',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  words: [
    { word: 'secret', means: 'a value ferrets use by name and never see', insteadOf: ['credential', 'env var'] },
    { word: 'input', means: 'a card asking you to type a value', insteadOf: ['input request'] },
    {
      word: 'hold',
      means: 'a short time a terminal or page is closed to ferrets after you typed into it',
      insteadOf: ['quarantine', 'lock'],
    },
    { word: 'mask', means: 'hiding a secret in text', insteadOf: ['redact', 'scrub'] },
  ],
  /**
   * A run spawns the program the owner or a ferret named in a `${secret:NAME}` command, and an authorized fetch reaches
   * whichever host a secret's own allowlist names, so neither can be listed here. `'*'` is the kernel's to admit and it
   * admits it from a core piece alone: `effectivePermissions` drops it from any other manifest at run time.
   */
  permissions: { spawn: ['*'], network: ['*'] },
  needs: { gate: GatePort, asks: AsksPort },
  actions: {
    routes: [
      route('GET /v1/input-requests', { ...INPUT_PERSON, capability: INPUT_USE_TERMINAL, audit: INPUT_READ }),
      route('GET /v1/ferrets/:ferretId/input-requests', {
        ...INPUT_PERSON,
        capability: INPUT_USE_TERMINAL,
        audit: INPUT_READ,
      }),
      route('GET /v1/ferrets/:ferretId/input-requests/:requestId/shot', {
        ...INPUT_PERSON,
        capability: INPUT_USE_BROWSER,
        audit: INPUT_READ,
      }),
      route('POST /v1/ferrets/:ferretId/input-requests/:requestId/deliver', {
        ...INPUT_PERSON,
        capability: INPUT_USE_TERMINAL,
        audit: INPUT_BY_SERVICE,
      }),
      route('GET /v1/ferrets/:ferretId/input-quarantines', {
        ...INPUT_PERSON,
        capability: INPUT_USE_TERMINAL,
        audit: INPUT_READ,
      }),
      route('POST /v1/ferrets/:ferretId/input-quarantines/:key/end', {
        ...INPUT_PERSON,
        capability: INPUT_USE_TERMINAL,
        audit: INPUT_BY_SERVICE,
      }),
      route('POST /v1/ferrets/:ferretId/input-requests/:requestId/cancel', {
        ...INPUT_PERSON,
        capability: INPUT_USE_TERMINAL,
        audit: INPUT_BY_SERVICE,
      }),
      route('GET /v1/secrets', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('secrets', 'use'),
        noStore: true,
        audit: { skip: 'a listing of names and instants; not recorded today' },
        guard: { none: 'names, instants and configured references only; never a value or pane text' },
      }),
      route('POST /v1/secrets/use', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('secrets', 'use'),
        noStore: true,
        audit: audit('secrets.used'),
        guard: { none: "a use child's own output, masked with the values that use opened; never pane or page text" },
      }),
      route('POST /v1/secrets', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('secrets', 'configure'),
        noStore: true,
        audit: audit('secrets.changed'),
        guard: { none: 'answers a name and two instants; a value goes in and never comes back' },
      }),
      route('DELETE /v1/secrets/:name', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('secrets', 'configure'),
        noStore: true,
        audit: audit('secrets.changed'),
        guard: { none: 'answers the name it removed' },
      }),
      route('POST /v1/secrets/imports', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('secrets', 'configure'),
        noStore: true,
        audit: { skip: 'opening an import files nothing; the import it opens is recorded when it is completed' },
        guard: { none: 'a signed offer of public keys, an id and an expiry' },
      }),
      route('POST /v1/secrets/imports/:importId', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('secrets', 'configure'),
        noStore: true,
        audit: audit('secrets.changed'),
        guard: { none: 'answers the names filed and kept, never a value' },
      }),
      route('POST /v1/secrets/exports/:importId', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('secrets', 'configure'),
        noStore: true,
        audit: audit('secrets.used'),
        guard: { none: 'ciphertext sealed to another machine, which no caller of this daemon can open' },
      }),
    ],
    agentTools: [
      tool('input_wait', {
        minimum: 'authenticated',
        caller: 'any',
        capability: INPUT_USE_TERMINAL,
        audit: { skip: 'a wait on the ferret’s own card: it changes nothing' },
        guard: 'secrets',
        summary:
          'wait for the owner to answer your input card, or approve a sign-in on their phone (a pa_ id): where it stands, never the value or the number',
      }),
    ],
    /** `fy secret set <name>` takes the value from stdin only, never from an argument (S1, S33). */
    cli: [
      verb('secret set', {
        summary: 'save or replace a secret, reading its VALUE from stdin',
        args: [
          { name: 'name', help: 'the secret’s name (the value is read from stdin, never typed on the command line)' },
        ],
      }),
    ],
  },
  ui: {
    settings: [settingsTab('secrets', { label: 'Secrets', order: 42 })],
    renderers: [renderer('ask', { source: 'input' })],
  },
  provides: {
    vault: VaultPort,
    outputGuard: OutputGuardPort,
    inputHolds: InputHoldsPort,
    redaction: RedactionPort,
    childEnvironments: ChildEnvironmentPort,
    /** A daemon half's OWN sealed documents, scoped by its own state port (contract change C). Never a route. */
    sealedDocuments: SealedDocumentsPort,
    /**
     * The Vault's value for a secret NAME, for the KERNEL's own `${secret:NAME}` configuration references only
     * (`kernel.secrets`, lead decision J). Kernel-only: no route, tool or other plugin can hold it, and the kernel
     * asks it only after the plugin declared the name and its own configuration names it.
     */
    secretResolver: SecretResolverPort,
  },
  /** Never reached by a ferret, through any root: the sealed secrets and the key that opens them (`PrivacyDecl`). */
  privacy: {
    private: ['vault.key', 'vault.json', 'mints.json'],
  },
  data: {
    // biome-ignore lint/suspicious/noExplicitAny: the leaf cast Gate, Asks and Ferrets use for a typed config def
    config: [VaultConfigFile as ConfigDef<any>],
    state: [VaultFile, VaultKeyFile, MintsFile, HoldsFile, InputRequestFiles],
    publishes: [SecretsChanged, HoldsChanged],
    subscribes: [AsksChanged, FerretsChanged],
  },
  hooks: {
    offers: [
      { hook: InputTargets },
      { hook: InputPhoneApprovals },
      { hook: InputSecureCopies },
      { hook: RedactionSources },
      { hook: ProfileSecrets },
    ],
    takes: [{ hook: AskSources, key: 'input', schema: InputAskRefSchema }],
  },
});
