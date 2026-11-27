import { afterEach, describe, expect, test } from 'bun:test';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { ensureDom, interact, type Mounted, mount } from '@ferretry/app/testing';
import type { ActionsRowOffer } from '@ferretry/core-ferrets/contract';
import { ForkRowPanel, FORK_ROW_ID } from '../../../../app/slots/fork-row-panel.tsx';
import { type FakeClient, fakeClient, refusal } from '../../../support/app/fake-client.ts';
import { withClient } from '../../../support/app/client.tsx';

ensureDom();

/** The props a slot hands a panel: the shell spreads them beside `subject`. */
const slot = (props: object): PanelProps => props as PanelProps;

const MESSAGES = 'GET /v1/ferrets/:ferretId/messages';
const FORK = 'POST /v1/ferrets/:ferretId/fork';

const page = {
  v: 1,
  ferret: 'f1',
  messages: [
    { point: '10.0', role: 'user', text: 'first question', selectionBinding: 's2.one' },
    { point: '20.0', role: 'assistant', text: 'first answer', selectionBinding: 's2.a1' },
    { point: '30.0', role: 'user', text: 'second question', selectionBinding: 's2.two' },
    { point: '40.0', role: 'assistant', text: 'second answer', selectionBinding: 's2.a2' },
  ],
  nextCursor: null,
  previousCursor: null,
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});

interface Offers {
  readonly log: { id: string; row: ActionsRowOffer | null }[];
  readonly offer: (id: string, row: ActionsRowOffer | null) => void;
  readonly current: () => ActionsRowOffer | null;
}

const offers = (): Offers => {
  const log: { id: string; row: ActionsRowOffer | null }[] = [];
  return { log, offer: (id, row) => void log.push({ id, row }), current: () => log.at(-1)?.row ?? null };
};

const mountRow = async (client: FakeClient, held: Offers, canControl = true) => {
  const view = await mount(
    withClient(client, <ForkRowPanel {...slot({ canControl, ferret: 'f1', name: 'Ferret', offer: held.offer })} />),
  );
  mounted.push(view);
  await settle();
  return view;
};

describe('Fork into a new ferret… in the Actions menu', () => {
  test('is offered only to someone who may control the ferret, and reads nothing until it is opened', async () => {
    const client = fakeClient({});
    const held = offers();
    const view = await mountRow(client, held, true);
    expect(held.current()).toMatchObject({
      kind: 'run',
      id: FORK_ROW_ID,
      label: 'Fork into a new ferret…',
      group: 'ferret',
    });
    expect(client.calls).toEqual([]);
    await view.unmount();
    expect(held.current()).toBeNull();

    const refused = offers();
    await mountRow(fakeClient({}), refused, false);
    expect(refused.current()).toBeNull();
  });

  test('opens the form on the latest message, and forks from it into a new worktree', async () => {
    const client = fakeClient({
      [MESSAGES]: () => page,
      [FORK]: () => ({ ferret: 'f2', attachments: 1, worktree: { branch: 'fork/olive-1' } }),
    });
    const held = offers();
    const view = await mountRow(client, held);

    await interact(async () => await held.current()?.run());
    await settle();
    expect(client.callsTo(MESSAGES)[0]?.query).toEqual({ tail: '1', limit: '200' });
    const dialog = view.container.querySelector('[data-fork-dialog]');
    expect(dialog).not.toBeNull();
    // What the person said, newest first — an answer is not a choice.
    expect([...view.container.querySelectorAll('.fy-fork-pick__text')].map(node => node.textContent)).toEqual([
      'second question',
      'first question',
    ]);

    await interact(() => (view.container.querySelector('[data-action-submit]') as HTMLButtonElement).click());
    await settle();
    const sent = client.callsTo(FORK);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.params).toEqual({ ferretId: 'f1' });
    expect(sent[0]?.body).toEqual({ point: '30.0', selectionBinding: 's2.two', worktree: 'new' });
    expect(sent[0]?.headers['x-fy-request-id']).toBeString();
    expect(view.container.querySelector('[data-fork-done]')?.textContent).toContain('fork/olive-1');
    expect(view.container.querySelector('[data-fork-done]')?.textContent).toContain('1 attachment came with it');
  });

  test('shows the harness’s refusal in the form as plain words, and the form stays open', async () => {
    const sentence =
      'this cut includes a subagent whose separate transcript cannot be copied safely; pick a cut before it';
    const client = fakeClient({
      [MESSAGES]: () => page,
      [FORK]: () => {
        throw refusal(409, 'fork_refused', sentence);
      },
    });
    const held = offers();
    const view = await mountRow(client, held);
    await interact(async () => await held.current()?.run());
    await settle();

    await interact(() => (view.container.querySelector('[data-action-submit]') as HTMLButtonElement).click());
    await settle();

    expect(view.container.querySelector('[data-fork-form] [role="alert"]')?.textContent).toBe(sentence);
    expect(view.container.querySelector('[data-fork-done]')).toBeNull();
  });

  test('says so when the conversation cannot be read, instead of drawing an empty picker', async () => {
    const client = fakeClient({
      [MESSAGES]: () => {
        throw refusal(409, 'transcript_unreadable', 'the transcript could not be read completely');
      },
    });
    const held = offers();
    const view = await mountRow(client, held);
    await interact(async () => await held.current()?.run());
    await settle();
    expect(view.container.querySelector('[data-fork-dialog] [role="alert"]')?.textContent).toBe(
      'the transcript could not be read completely',
    );
    expect(view.container.querySelector('[data-fork-form]')).toBeNull();
  });
});
