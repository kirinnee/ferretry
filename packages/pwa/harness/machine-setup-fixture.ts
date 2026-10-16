/**
 * What the harness machines answer for New machine setup and Copy settings (build plan P9): the
 * Speed-ups read, the Warden's and Learning's settings, the secret store's NAMES, and the three
 * settings files a copy reads from the source and writes here. In memory and per machine, so a key
 * "added" on one screen shows as set on the next, and nothing ever leaves the page.
 *
 * No value is held: a stored "secret" is its name and two instants, as the daemon answers.
 */

import {
  DEFAULT_LEARNING_CONFIG,
  DEFAULT_WARDEN_CONFIG,
  type SpeedupsView,
  type WardenConfig,
} from '@ferretry/protocol';

const NOW = '2026-10-16T09:00:00.000Z';

/** What each harness machine's settings files say, by path; the source machine runs the Jev guard. */
const SOURCE_FILES: Readonly<Record<string, string>> = {
  'warden.yaml':
    '# yaml-language-server: $schema=./.schema/warden.json\nenabled: true\ntriage: jev\nintervalMinutes: 5\n',
  'learning.yaml': '# yaml-language-server: $schema=./.schema/learning.json\npassiveDefault: true\n',
  'voice.yaml': '# yaml-language-server: $schema=./.schema/voice.json\npostProcessing:\n  provider: groq\n',
};

interface MachineState {
  secrets: string[];
  warden: WardenConfig;
  passiveDefault: boolean;
}

const states = new Map<string, MachineState>();

const stateOf = (machine: string): MachineState => {
  const known = states.get(machine);
  if (known !== undefined) return known;
  const fresh: MachineState = { secrets: [], warden: DEFAULT_WARDEN_CONFIG, passiveDefault: true };
  states.set(machine, fresh);
  return fresh;
};

const speedups = (held: readonly string[]): SpeedupsView => ({
  vault: 'ok',
  providers: [
    {
      provider: 'jev',
      label: 'Jev',
      purpose: 'Fast, cheap typed decisions: the Warden’s guard decides skip or investigate.',
      costNote: 'Fractions of a cent per decision.',
      privacyNote: 'A redacted summary of a flagged ferret leaves this machine.',
      keyUrl: 'https://jev.typesafe.ai/keys',
      testNote: 'One tiny decision; spends a fraction of a cent.',
      secretName: 'JEV_API_KEY',
      set: held.includes('JEV_API_KEY'),
      testStale: false,
    },
    {
      provider: 'groq',
      label: 'Groq',
      purpose: 'Cleans up a dictated transcript: punctuation, filler words, formatting.',
      costNote: 'Fractions of a cent per dictation.',
      privacyNote: 'Only the transcript text, only when you dictate.',
      keyUrl: 'https://console.groq.com/keys',
      testNote: 'Lists models; spends nothing.',
      secretName: 'GROQ_API_KEY',
      set: held.includes('GROQ_API_KEY'),
      testStale: false,
    },
    {
      provider: 'cerebras',
      label: 'Cerebras',
      purpose: 'The alternative fast clean-up of a dictated transcript.',
      costNote: 'Fractions of a cent per dictation.',
      privacyNote: 'Only the transcript text, only when you dictate.',
      keyUrl: 'https://cloud.cerebras.ai',
      testNote: 'Lists models; spends nothing.',
      secretName: 'CEREBRAS_API_KEY',
      set: held.includes('CEREBRAS_API_KEY'),
      testStale: false,
    },
  ],
});

const body = (init?: RequestInit): Record<string, unknown> =>
  typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};

/**
 * One answer for `machine`, or `undefined` when the path is not one of these, so the caller's own
 * fixtures answer it. `source` machines hold the settings files a copy reads.
 */
export const machineSetupAnswer = (machine: string, source: boolean, path: string, init?: RequestInit): unknown => {
  const state = stateOf(machine);
  const url = new URL(path, 'http://harness.invalid');
  const method = init?.method ?? 'GET';
  switch (url.pathname) {
    case '/v1/speedups':
      return speedups(state.secrets);
    case '/v1/secrets':
      if (method === 'POST') {
        const name = String(body(init).name);
        if (!state.secrets.includes(name)) state.secrets.push(name);
        return { name, createdAt: NOW, updatedAt: NOW };
      }
      return {
        v: 1,
        health: 'ready',
        secrets: state.secrets.map(name => ({ name, createdAt: NOW, updatedAt: NOW })),
        references: [],
      };
    case '/v1/warden/config':
      if (method === 'PATCH') state.warden = { ...state.warden, ...(body(init) as Partial<WardenConfig>) };
      return { config: state.warden, accounts: state.warden.accounts, warnings: [] };
    case '/v1/learning/config':
      if (method === 'PATCH') state.passiveDefault = body(init).passiveDefault === true;
      return { ...DEFAULT_LEARNING_CONFIG, passiveDefault: state.passiveDefault };
    case '/v1/config/file': {
      if (method === 'PUT') {
        const written = String(body(init).path);
        // The copied Warden turns on the Jev guard, which spends: the daemon holds it for the owner.
        return written === 'warden.yaml'
          ? {
              path: written,
              etag: 'sha256:harness-warden-pending',
              outcome: 'pending',
              pending: {
                path: written,
                etag: 'sha256:harness-warden-pending',
                changes: ['triage moves to the Jev guard, which spends up to $0.50/day'],
              },
            }
          : { path: written, etag: `sha256:harness-${written}`, outcome: 'applied' };
      }
      const file = url.searchParams.get('path') ?? '';
      const text = source ? SOURCE_FILES[file] : undefined;
      return {
        path: file,
        absolutePath: `/home/harness/.ferretry/config/${file}`,
        kind: file.replace(/\.yaml$/u, ''),
        schema: file.replace(/\.yaml$/u, ''),
        exists: text !== undefined,
        text: text ?? '# yaml-language-server: $schema=./.schema/defaults.json\n',
        etag: text === undefined ? 'absent' : `sha256:harness-${file}`,
        state: 'ok',
        issues: [],
      };
    }
    case '/v1/config/confirm':
      return { path: String(body(init).path), confirmed: true };
    default:
      return undefined;
  }
};
