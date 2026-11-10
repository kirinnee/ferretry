import type { PluginClient } from '@ferretry/kernel/manifest';
import type { InputRequestView } from '../../../app/lib/input-wire.ts';

/** Obvious fakes: the only secret-shaped strings any test here uses. */
export const FAKE_VALUE = 'fake-secret-000';

export const REQUEST_ID = 'a'.repeat(32);
const DIGEST = 'b'.repeat(64);
const FAR = '2099-01-01T00:00:00.000Z';

/** A terminal asking for one hidden secret: the case Enter starts ticked for. */
export function terminalRequest(patch: Partial<Record<string, unknown>> = {}): InputRequestView {
  return {
    id: REQUEST_ID,
    sessionId: 'hadi',
    agendaItemId: 'A7',
    target: { kind: 'terminal', key: 'dev' },
    prompt: '[sudo] password for kirin:',
    sensitivity: 'secret',
    fields: [{ id: 'value', label: 'Password', sensitivity: 'secret' }],
    submit: 'offer-owner',
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
  } as InputRequestView;
}

/** A page asking for one password: the case Enter starts un-ticked for. */
export function pageRequest(patch: Partial<Record<string, unknown>> = {}): InputRequestView {
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
