import type { PluginClient } from '@ferretry/kernel/manifest';
import type { InputRequest } from '../../../contract/index.ts';

/** Obvious fakes: the only secret-shaped strings any test here uses. */
export const FAKE_VALUE = 'fake-secret-000';

export const REQUEST_ID = 'a'.repeat(32);
const DIGEST = 'b'.repeat(64);
const FAR = '2099-01-01T00:00:00.000Z';

/** A terminal asking for one hidden secret: the case Enter starts ticked for. */
export function terminalRequest(patch: Partial<Record<string, unknown>> = {}): InputRequest {
  return {
    id: REQUEST_ID,
    sessionId: 'hadi',
    agendaItemId: 'A7',
    target: { kind: 'terminal', key: 'dev' },
    prompt: '[sudo] password for kirin:',
    sensitivity: 'secret',
    fields: [{ id: 'value', label: 'Password', sensitivity: 'secret' }],
    submit: 'offer-owner',
    raisedAt: '2026-11-10T00:00:00.000Z',
    expiresAt: FAR,
    observed: {
      kind: 'terminal',
      paneProof: { paneId: '%1', pid: 100 },
      foreground: { pid: 100, pgid: 100, comm: 'sudo', argv: 'sudo ls' },
      echo: 'off',
      cursorRow: 3,
      promptLine: '[sudo] password for kirin:',
      promptLineDigest: 'c'.repeat(64),
      recognisedConsumer: true,
    },
    observedDigest: DIGEST,
    state: 'pending',
    ...patch,
  } as InputRequest;
}

/** A page asking for one password: the case Enter starts un-ticked for. */
export function pageRequest(patch: Partial<Record<string, unknown>> = {}): InputRequest {
  return terminalRequest({
    target: { kind: 'page', key: 'app' },
    prompt: 'Sign in to example.test',
    observed: {
      kind: 'page',
      pageId: 'p1',
      origin: 'https://example.test',
      secure: true,
      navigationId: 'n1',
      fields: [
        {
          fieldId: 'value',
          frameOrigin: 'https://example.test',
          frameId: 'f1',
          backendNodeId: 5,
          field: { tag: 'input', type: 'password' },
          box: { x: 0, y: 0, w: 10, h: 10 },
          visible: true,
        },
      ],
    },
    ...patch,
  });
}

export interface Call {
  readonly route: string;
  readonly init: { params?: Record<string, string>; body?: unknown } | undefined;
}

/** A plugin client that records every call and answers from `answer`; a deliver can be held open. */
export function recordingClient(answer: (route: string, init: Call['init']) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  const client = {
    call: async (route: string, init?: Call['init']) => {
      calls.push({ route, init });
      return await answer(route, init);
    },
  } as unknown as Pick<PluginClient, 'call'>;
  return { client, calls };
}

/** The copy a paste draws from, as the owner's card is told it: the handle's name and where it was read, never a value. */
export const COPY_SOURCE = {
  kind: 'sealed',
  name: 'vercel',
  from: { kind: 'command', program: 'vercel', path: '/usr/bin/vercel' },
  length: 40,
  capturedAt: '2026-11-10T00:00:00.000Z',
} as const;

/** A paste of a secure copy into a terminal: nothing to type, the owner allows it. */
export function pasteRequest(patch: Partial<Record<string, unknown>> = {}): InputRequest {
  return terminalRequest({
    prompt: 'the new Vercel token',
    source: COPY_SOURCE,
    ...patch,
  });
}

/** The one-tap account the daemon matched to this target, as an offer: handles, labels and a sign-in id, never a value. */
export const MATCHED_OFFER = {
  id: 'SUDO_KIRIN_BOX',
  label: 'sudo on kirin-box',
  username: 'kirin',
  fills: 'password',
  matched: true,
  signIn: 'si_0123456789abcdef',
  primary: true,
  why: 'only',
} as const;

/** An account the owner may pick by hand: it signs in somewhere else, so it is never the one-tap choice. */
export const HAND_OFFER = {
  id: 'WORK_ADMIN',
  label: 'Work admin',
  fills: 'password',
  matched: false,
  elsewhere: ['liftoff.okta.com'],
} as const;

/** A card the daemon drew saved-login offers for: the matched account and one picked by hand. */
export function savedRequest(patch: Partial<Record<string, unknown>> = {}): InputRequest {
  return terminalRequest({
    saved: {
      match: 'sudo@kirin-box',
      offers: [MATCHED_OFFER, HAND_OFFER],
      project: { id: 'p1', name: 'ferretry' },
    },
    ...patch,
  });
}
