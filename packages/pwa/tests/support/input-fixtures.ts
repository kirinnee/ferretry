/** Fake input requests and saved logins for the card's tests and screenshots. No real account or daemon. */

import type { InputRequest, InputSaved, InputSavedOffer, LoginEntryList, LoginEntrySummary } from '@ferretry/protocol';

export const NOW = Date.parse('2026-08-05T10:00:00.000Z');
const AT = '2026-08-01T09:00:00.000Z';
const DIGEST = 'a'.repeat(64);

export const request = (overrides: Partial<InputRequest> = {}): InputRequest => ({
  id: 'ab'.repeat(16),
  sessionId: 'sess-1',
  agendaItemId: 'A7',
  target: { kind: 'terminal', key: 'deploy' },
  prompt: '[sudo] password for kirin:',
  sensitivity: 'secret',
  submit: 'offer-owner',
  raisedAt: '2026-08-05T09:59:00.000Z',
  expiresAt: '2026-08-05T10:04:00.000Z',
  observed: {
    kind: 'terminal',
    paneProof: { paneId: '%1', pid: 4242 },
    foreground: { pid: 4300, pgid: 4300, comm: 'sudo', argv: 'sudo -k apt update' },
    echo: 'off',
    cursorRow: 12,
    promptLine: '[sudo] password for kirin:',
    promptLineDigest: DIGEST,
    recognisedConsumer: true,
  },
  risk: { level: 'green', reason: 'sudo is a recognised password prompt and typing is hidden.' },
  observedDigest: DIGEST,
  state: 'pending',
  ...overrides,
});

export const offer = (overrides: Partial<InputSavedOffer> = {}): InputSavedOffer => ({
  id: 'SUDO_KIRIN_BOX',
  label: 'sudo on kirin-box',
  fills: 'password',
  matched: true,
  ...overrides,
});

export const saved = (overrides: Partial<InputSaved> = {}): InputSaved => ({
  match: 'sudo@kirin-box',
  suggest: { id: 'SUDO_KIRIN_BOX', label: 'sudo on kirin-box' },
  saves: 'password',
  offers: [],
  ...overrides,
});

export const withSaved = (value: InputSaved, overrides: Partial<InputRequest> = {}): InputRequest =>
  request({ saved: value, ...overrides });

export const login = (overrides: Partial<LoginEntrySummary> = {}): LoginEntrySummary => ({
  id: 'GITHUB_KIRINNEE',
  label: 'GitHub (kirinnee)',
  match: ['github.com'],
  username: 'kirinnee',
  fields: { password: true, totp: false },
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

export const logins = (overrides: Partial<LoginEntryList> = {}): LoginEntryList => ({
  v: 1,
  health: 'ready',
  entries: [
    login(),
    login({
      id: 'SUDO_KIRIN_BOX',
      label: 'sudo on kirin-box',
      match: ['sudo@kirin-box'],
      username: undefined,
      fields: { password: true, totp: true },
      totp: { algorithm: 'SHA1', digits: 6, period: 30 },
    }),
  ],
  ...overrides,
});

/** The body a client sent, parsed, with the answer to give; what the card did is read off `calls`. */
export interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

export const fakeClient = (answer: (call: Call) => unknown = () => ({})) => {
  const calls: Call[] = [];
  const client = {
    request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
      const call = {
        path,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      calls.push(call);
      return schema.parse(answer(call));
    },
  };
  return { client: client as never, calls };
};
