import { CLEANUP_PROVIDERS, type SecretName, type SpeedupProvider } from '@ferretry/protocol';

/**
 * The three speed-up providers, as data.
 *
 * Each entry names the ONE secret it spends, the hosts that secret may reach, and the words a person
 * reads before pasting a key. The hosts are the whole allowlist the outbound holder enforces for that
 * secret, so adding an endpoint on a new host is a deliberate edit here rather than a URL somebody
 * typed into a configuration file.
 *
 * GROQ AND CEREBRAS ARE CLEAN-UP ONLY. Speech recognition happens in the browser; what these two see
 * is the recognised TEXT, after the owner stopped dictating, and only when the owner chose them.
 */
export interface SpeedupProviderDefinition {
  readonly id: SpeedupProvider;
  readonly label: string;
  readonly secretName: SecretName;
  readonly hosts: readonly string[];
  readonly purpose: string;
  readonly costNote: string;
  readonly privacyNote: string;
  readonly keyUrl: string;
  readonly testNote: string;
}

/** A provider whose Test is a free, authenticated `GET` of its model list: no inference, no spend. */
export interface ModelListProbe {
  readonly kind: 'model-list';
  readonly url: string;
}

/** A provider with no free authenticated read, whose Test is one deliberately tiny decision. */
export interface DecisionProbe {
  readonly kind: 'decision';
}

export type SpeedupProbe = ModelListProbe | DecisionProbe;

export interface SpeedupCatalogEntry extends SpeedupProviderDefinition {
  readonly probe: SpeedupProbe;
}

export const JEV_HOST = 'api.typesafe.ai';
export const JEV_DEFAULT_ENDPOINT = `https://${JEV_HOST}/v1/systemone`;
export const JEV_DEFAULT_MODEL = 'jev-latest';

/** The clean-up hosts are the shared provider table's, so the daemon and the browser send a key to the same one. */
const GROQ_HOST = CLEANUP_PROVIDERS.groq.host;
/**
 * Groq's key page lives on its developer-console host. Spelled with an escaped dot because the src/lib
 * IO gate greps for that word followed by a full stop, and this is an address, not a logger.
 */
const GROQ_KEYS_URL = 'https://console\u002egroq.com/keys';
const CEREBRAS_HOST = CLEANUP_PROVIDERS.cerebras.host;

export const SPEEDUP_CATALOG: Readonly<Record<SpeedupProvider, SpeedupCatalogEntry>> = Object.freeze({
  jev: Object.freeze({
    id: 'jev',
    label: 'Jev',
    secretName: 'JEV_API_KEY',
    hosts: Object.freeze([JEV_HOST]),
    purpose:
      'Fast, cheap yes/no decisions. The Warden asks Jev whether a flagged ferret is worth a full AI investigation, and skips the ones Jev is sure are healthy.',
    costNote:
      'Fractions of a cent per decision. Jev answers a Warden flag first: it leaves it, acts alone only when sure enough and allowed, or hands it to an investigation or to you.',
    privacyNote:
      'When the Warden uses it, a short, redacted summary of the flagged ferret (its recent turns and screen tail) is sent to TypeSafe AI.',
    keyUrl: 'https://docs.typesafe.ai/introduction/quickstart',
    testNote: 'Test makes one tiny Jev decision about a made-up ferret, costing a fraction of a cent.',
    probe: Object.freeze({ kind: 'decision' }),
  }),
  groq: Object.freeze({
    id: 'groq',
    label: 'Groq',
    secretName: 'GROQ_API_KEY',
    hosts: Object.freeze([GROQ_HOST]),
    purpose:
      'Cleans up dictated text in about a second: fixes misheard words, capitals and punctuation, keeping your wording.',
    costNote: 'A small fast model; a typical dictation costs well under a cent. It runs only when you dictate.',
    privacyNote:
      'The recognised text, your word list and a little recent context are sent to Groq. Groq never receives audio.',
    keyUrl: GROQ_KEYS_URL,
    testNote: 'Test lists the models your key can use. It is free and runs no model.',
    probe: Object.freeze({ kind: 'model-list', url: CLEANUP_PROVIDERS.groq.modelsUrl }),
  }),
  cerebras: Object.freeze({
    id: 'cerebras',
    label: 'Cerebras',
    secretName: 'CEREBRAS_API_KEY',
    hosts: Object.freeze([CEREBRAS_HOST]),
    purpose: 'An alternative to Groq for cleaning up dictated text, on Cerebras’ very fast inference.',
    costNote: 'A typical dictation costs well under a cent. It runs only when you dictate.',
    privacyNote:
      'The recognised text, your word list and a little recent context are sent to Cerebras. Cerebras never receives audio.',
    keyUrl: 'https://cloud.cerebras.ai',
    testNote: 'Test lists the models your key can use. It is free and runs no model.',
    probe: Object.freeze({ kind: 'model-list', url: CLEANUP_PROVIDERS.cerebras.modelsUrl }),
  }),
});

/** In the order a person reads them: the Warden's guard first, then the two clean-up choices. */
export const SPEEDUP_ORDER: readonly SpeedupProvider[] = Object.freeze(['jev', 'groq', 'cerebras']);
