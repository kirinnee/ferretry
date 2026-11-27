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
    const view = await mount(withClient(fakeClient({}), <ForkFromHere text="first question" />));
    mounted.push(view);
    expect(view.container.querySelector('[data-fork-from-here]')).toBeNull();
  });

  test('opens the form on THAT message rather than the latest', async () => {
    const client = fakeClient({ [MESSAGES]: () => page });
    const view = await mount(
      withClient(
        client,
        <RowSlotProvider daemon="d1" ferret="f1">
          <ForkFromHere text="first question" />
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
});
