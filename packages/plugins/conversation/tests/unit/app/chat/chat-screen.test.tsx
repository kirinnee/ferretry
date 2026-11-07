import { afterEach, describe, expect, test } from 'bun:test';
import { ensureDom, mount, type Mounted, runAsync } from '@ferretry/app/testing';
import type { EventDef } from '@ferretry/kernel/contract';
import { ChatScreen } from '../../../../app/chat/chat-screen.tsx';
import { ConversationClientProvider } from '../../../../app/client.ts';
import { QueueChanged } from '../../../../contract/index.ts';
import { type FakeClient, fakeClient } from '../../../support/app/fake-client.ts';
import { ferretView } from '../../../support/app/ferret-view.ts';

ensureDom();

/**
 * THE CHAT SCREEN as the shell mounts it: `screens.chat` at `/ferrets/:ferret/chat`, inside the half's client. It reads
 * the ferret's view and its transcript tail through the client, draws the chat once the view is there, and nudges its
 * refresh on the half's own wake-ups.
 */

const VIEW = 'GET /v1/ferrets/:ferretId';
const LOG_PAGE = 'GET /v1/ferrets/:ferretId/log-page';
const SENDS = 'GET /v1/ferrets/:ferretId/sends';
const QUEUE = 'GET /v1/ferrets/:ferretId/queue';
const QUESTION = 'GET /v1/ferrets/:ferretId/question';

/** A client whose events the suite delivers by hand. */
const withEvents = (client: FakeClient) => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const subscribe = <Name extends string, Payload>(event: EventDef<Name, Payload>, listener: (p: Payload) => void) => {
    const set = listeners.get(event.name) ?? new Set();
    set.add(listener as (payload: unknown) => void);
    listeners.set(event.name, set);
    return () => void set.delete(listener as (payload: unknown) => void);
  };
  Object.assign(client, { subscribe });
  return (name: string, payload: unknown) => {
    for (const listener of listeners.get(name) ?? []) listener(payload);
  };
};

const daemon = (log: () => string) =>
  fakeClient(
    {
      [VIEW]: call => ferretView(call.params['ferretId'] ?? ''),
      [LOG_PAGE]: call => ({ v: 1, ferret: call.params['ferretId'], log: log(), start: 0, file: 'f1' }),
      [SENDS]: () => ({ sends: [] }),
      [QUEUE]: () => ({ messages: [] }),
      [QUESTION]: () => ({ question: null }),
    },
    'alpha',
  );

/** Waits on the real clock (the refresh's nudge settles on a timer) until `ready`, at most two seconds. */
const waitFor = async (ready: () => boolean, what: string, seen: () => string = () => ''): Promise<void> => {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited >= 2_000) throw new Error(`waited 2s for ${what}; the screen said: ${seen()}`);
    await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 10)));
  }
};

const views: Mounted[] = [];
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
});

const open = async (client: FakeClient, ferret: string | undefined) => {
  const view = await mount(
    <ConversationClientProvider client={client}>
      <ChatScreen params={ferret === undefined ? {} : { ferret }} />
    </ConversationClientProvider>,
  );
  views.push(view);
  return view;
};

describe('the chat screen', () => {
  test('says the link names no ferret when it has none, and reads nothing', async () => {
    const client = daemon(() => '');
    const view = await open(client, undefined);
    expect(view.container.textContent).toContain('names no ferret');
    expect(client.calls).toEqual([]);
  });

  test('reads the ferret’s view and transcript tail through the half’s client, then draws the chat', async () => {
    const client = daemon(() => '[10:11:12] assistant/message: The daemon answered.');
    const view = await open(client, 'shared');
    await waitFor(
      () => view.container.textContent?.includes('The daemon answered.') === true,
      'the transcript to draw',
      () => view.container.textContent ?? '',
    );

    expect(client.callsTo(VIEW)[0]?.params).toEqual({ ferretId: 'shared' });
    expect(client.callsTo(LOG_PAGE)[0]?.params).toEqual({ ferretId: 'shared' });
    expect(view.container.querySelector('[data-session-state]')?.getAttribute('data-session-state')).toBe('connected');
  });

  test('a QueueChanged wake-up for this ferret reads again at once; without waiting for the poll', async () => {
    let text = '[10:11:12] assistant/message: first';
    const client = daemon(() => text);
    const emit = withEvents(client);
    const view = await open(client, 'shared');
    await waitFor(() => view.container.textContent?.includes('first') === true, 'the first read');
    const before = client.callsTo(LOG_PAGE).length;

    emit(QueueChanged.name, { ferret: 'other', message: 'm1', change: 'moved' });
    text = '[10:11:13] assistant/message: second';
    emit(QueueChanged.name, { ferret: 'shared', message: 'm1', change: 'moved' });
    await waitFor(() => view.container.textContent?.includes('second') === true, 'the nudged read');

    expect(client.callsTo(LOG_PAGE).length).toBeGreaterThan(before);
  });
});
