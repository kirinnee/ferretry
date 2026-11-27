import { afterEach, describe, expect, test } from 'bun:test';
import { ensureDom, interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { RowSlotProvider } from '../../../../app/chat/row-slots.tsx';
import { ForkFromHere } from '../../../../app/fork/fork-from-here.tsx';
import { fakeClient } from '../../../support/app/fake-client.ts';
import { withClient } from '../../../support/app/client.tsx';

ensureDom();

const MESSAGES = 'GET /v1/ferrets/:ferretId/messages';
const page = {
  v: 1,
  ferret: 'f1',
  messages: [
    { point: '10.0', role: 'user', text: 'first question', selectionBinding: 's2.one' },
    { point: '20.0', role: 'assistant', text: 'first answer', selectionBinding: 's2.a1' },
    { point: '30.0', role: 'user', text: 'second question', selectionBinding: 's2.two' },
  ],
  nextCursor: null,
  previousCursor: null,
};

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

describe('Fork from here… on a message', () => {
  test('draws nothing outside a chat that says which ferret it is', async () => {
    const view = await mount(withClient(fakeClient({}), <ForkFromHere offsets={[10]} />));
    mounted.push(view);
    expect(view.container.querySelector('[data-fork-from-here]')).toBeNull();
  });

  test('opens the form on THAT message rather than the latest', async () => {
    const client = fakeClient({ [MESSAGES]: () => page });
    const view = await mount(
      withClient(
        client,
        <RowSlotProvider daemon="d1" ferret="f1">
          <ForkFromHere offsets={[10]} />
        </RowSlotProvider>,
      ),
    );
    mounted.push(view);
    const button = must(view.container.querySelector('[data-fork-from-here]'), 'the button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Fork from here…');
    expect(client.calls).toEqual([]);

    await interact(() => button.click());
    await settle();

    const picked = must(
      view.container.querySelector('[data-fork-picker] input:checked'),
      'the picked message',
    ) as HTMLInputElement;
    expect(picked.value).toBe('10.0');
  });

  const message = (offset: number, role: string, text: string) => ({
    point: `${String(offset)}.0`,
    role,
    text,
    selectionBinding: `s2.${String(offset)}`,
  });
  const clickFork = async (client: ReturnType<typeof fakeClient>, offsets: readonly number[]) => {
    const view = await mount(
      withClient(
        client,
        <RowSlotProvider daemon="d1" ferret="f1">
          <ForkFromHere offsets={offsets} />
        </RowSlotProvider>,
      ),
    );
    mounted.push(view);
    const button = must(view.container.querySelector('[data-fork-from-here]'), 'the button') as HTMLButtonElement;
    await interact(() => button.click());
    await settle();
    return view;
  };

  test('forks the row that was clicked when another row says the very same words', async () => {
    const client = fakeClient({
      [MESSAGES]: () => ({
        ...page,
        messages: [message(10, 'user', 'continue'), message(20, 'assistant', 'done'), message(30, 'user', 'continue')],
      }),
    });

    const view = await clickFork(client, [10]);

    const picked = must(
      view.container.querySelector('[data-fork-picker] input:checked'),
      'the picked',
    ) as HTMLInputElement;
    expect(picked.value).toBe('10.0');
  });

  test('finds a row older than the newest page by reading back to it', async () => {
    const client = fakeClient({
      [MESSAGES]: call =>
        call.query.through === 'c2.back'
          ? {
              ...page,
              messages: [message(5, 'user', 'the very first thing')],
              nextCursor: 'c2.n',
              previousCursor: null,
            }
          : { ...page, messages: [message(30, 'user', 'a later thing')], nextCursor: null, previousCursor: 'c2.back' },
    });

    const view = await clickFork(client, [5]);

    const picked = must(
      view.container.querySelector('[data-fork-picker] input:checked'),
      'the picked',
    ) as HTMLInputElement;
    expect(picked.value).toBe('5.0');
    expect(view.container.textContent).not.toContain('Older messages are not listed');
  });

  test("says so, and forks nothing, when the clicked row is not among the conversation's messages", async () => {
    const client = fakeClient({ [MESSAGES]: () => page });

    const view = await clickFork(client, [999]);

    expect(view.container.querySelector('[data-fork-picker]')).toBeNull();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('could not be found');
  });
});
