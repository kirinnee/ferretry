import { expect, test } from 'bun:test';
import type { HarnessScreenReader } from '@ferretry/core-ferrets/contract';
import { TmuxController } from '../../../../daemon/lib/tmux/controller.ts';
import { TmuxPaneDelivery } from '../../../../daemon/adapters/tmux/pane-delivery.ts';
import { FakeTmuxServer } from '../support/fake-tmux-server.ts';

const PAYLOAD = 'native payload';

function fixture(after: 'unreadable' | 'lost' | 'empty' | 'other' | 'match') {
  const server = new FakeTmuxServer();
  let readsAfterTyping = 0;
  const reader: HarnessScreenReader = {
    key: 'opencode',
    read: () => {
      const typed = server.composer !== '';
      if (typed) readsAfterTyping++;
      const state = typed && (after === 'unreadable' || readsAfterTyping > 1) ? after : 'match';
      return {
        working: false,
        atPrompt: true,
        composer:
          state === 'unreadable' || state === 'lost'
            ? null
            : {
                text: !typed || state === 'empty' ? '' : state === 'other' ? 'someone else' : PAYLOAD,
                placeholder: false,
                pasted: false,
              },
      };
    },
  };
  const delivery = new TmuxPaneDelivery(new TmuxController(server, undefined, reader), async ms => server.advance(ms), {
    windowMs: 1,
    stalledWindowMs: 1,
    submitAttempts: 1,
    readinessAttempts: 1,
  });
  return { server, delivery };
}

for (const state of ['unreadable', 'lost', 'empty', 'other'] as const) {
  test(`native ${state} composer cannot authorize Enter from screen-wide payload evidence`, async () => {
    const { server, delivery } = fixture(state);
    await expect(delivery.deliver('fy-native', PAYLOAD)).rejects.toMatchObject({
      deliveryFailure: { kind: 'unconfirmed' },
    });
    expect(server.calls.filter(args => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toEqual([]);
  });
}

test('matching native composer can submit its payload', async () => {
  const { server, delivery } = fixture('match');
  await delivery.deliver('fy-native', PAYLOAD);
  expect(server.submitted).toEqual([PAYLOAD]);
});
