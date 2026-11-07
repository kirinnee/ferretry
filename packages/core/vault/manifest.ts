import { AskSources, AsksChanged, AsksPort } from '@ferretry/core-asks/contract';
import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import { CAPABILITIES, GatePort } from '@ferretry/core-gate/contract';
import { audit, cap } from '@ferretry/core-gate/contract';
import { definePlugin, route, tool } from '@ferretry/kernel/manifest';
import {
  ChildEnvironmentPort,
  HoldsChanged,
  HoldsFile,
  InputAskRefSchema,
  InputHoldsPort,
  InputRequestFiles,
  InputTargets,
  OutputGuardPort,
  RedactionPort,
  SealedDocumentsPort,
  SecretsChanged,
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
        summary: 'wait for the owner to answer your input card: where it stands, never the value',
      }),
    ],
  },
  provides: {
    vault: VaultPort,
    outputGuard: OutputGuardPort,
    inputHolds: InputHoldsPort,
    redaction: RedactionPort,
    childEnvironments: ChildEnvironmentPort,
    /** A daemon half's OWN sealed documents, scoped by its own state port (contract change C). Never a route. */
    sealedDocuments: SealedDocumentsPort,
  },
  data: {
    state: [VaultFile, VaultKeyFile, HoldsFile, InputRequestFiles],
    publishes: [SecretsChanged, HoldsChanged],
    subscribes: [AsksChanged, FerretsChanged],
  },
  hooks: {
    offers: [{ hook: InputTargets }],
    takes: [{ hook: AskSources, key: 'input', schema: InputAskRefSchema }],
  },
});
