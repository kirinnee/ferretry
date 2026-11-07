import { audit, cap } from '@ferretry/core-gate/contract';
import { VaultPort } from '@ferretry/core-vault/contract';
import { definePlugin, panel, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import {
  CLEANUP_PROVIDERS,
  MODELS_STATE,
  SPEEDUP_TESTS_STATE,
  VOICE_CONFIG,
  VOICE_READ_MODELS,
  VoicePort,
} from './contract/index.ts';
import { LoginsPort } from '@ferretry/plugin-logins/contract';

/**
 * Voice (§2.3): talk instead of type. Recognition runs in the browser; the daemon's part is the one JSON exchange a
 * browser cannot perform (`POST /v1/stt/enhance`: a transcript repaired by a hosted chat model, spending a key only the
 * daemon holds, R626: no audio crosses the daemon) and the speed-up keys' status and Test. Routes are today's mounts
 * (`stt.ts`, `speedups.ts`), descriptor fields copied exactly; the paths contain no replaced word, so they are kept.
 *
 * Keys are Vault secrets by NAME (`GROQ_API_KEY`, `CEREBRAS_API_KEY`, `JEV_API_KEY`), spent only through the Vault's
 * outbound holder (`authorizeFetch`, S162–S166); `voice.yaml` never holds one.
 */
export default definePlugin({
  id: 'voice',
  title: 'Voice',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view', 'command'],
  words: [{ word: 'dictate', means: 'speak a message', insteadOf: ['STT'] }],

  needs: { vault: VaultPort },
  uses: { logins: LoginsPort },
  provides: { voice: VoicePort },

  actions: {
    routes: [
      route('POST /v1/stt/enhance', {
        minimum: 'operator',
        caller: 'any',
        audit: {
          skip: 'not recorded today (no rule in lib/audit/routes.ts); the payload is dictated speech and is never logged',
        },
        guard: { none: 'the dictated transcript and its repaired copy; no pane, page or vault text' },
      }),
      route('GET /v1/speedups', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('secrets', 'use'),
        noStore: true,
        audit: { skip: 'a read of secret names and instants; it never opens the vault' },
        guard: { none: 'names, booleans, instants and fixed sentences; no key and no provider body' },
      }),
      route('POST /v1/speedups/:provider/test', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('secrets', 'use'),
        noStore: true,
        // A Test spends one provider key on the operator's account; the secret's NAME is the subject.
        audit: audit('secrets.used'),
        guard: { none: 'a code and one fixed sentence; never the provider body' },
      }),
    ],
    cli: [
      verb('voice', { summary: 'clean up dictated text through the enhancement provider (same as voice enhance)' }),
      verb('voice enhance', { summary: 'clean up dictated text — punctuation, casing and proper nouns' }),
    ],
  },

  ui: {
    panels: [panel('composer.tools', { id: 'dictation', order: 20 })],
    settings: [
      settingsTab('voice', { label: 'Voice', order: 60 }),
      settingsTab('speedups', { label: 'Speed-ups', order: 70 }),
    ],
  },

  data: {
    state: [SPEEDUP_TESTS_STATE, MODELS_STATE],
    config: [VOICE_CONFIG],
    readModels: [...VOICE_READ_MODELS],
  },

  permissions: {
    // Keys ride only on requests the Vault's outbound holder builds; the hosts are the provider table's.
    network: [CLEANUP_PROVIDERS.groq.host, CLEANUP_PROVIDERS.cerebras.host, 'api.typesafe.ai'],
    secrets: ['GROQ_API_KEY', 'CEREBRAS_API_KEY', 'JEV_API_KEY'],
  },
});
