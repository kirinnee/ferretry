import { afterEach, describe, expect, test } from 'bun:test';
import { COMPOSER_OCCUPIED_CODE, SEND_UNCONFIRMED_CODE, type SendRecord } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { ReactTestRenderer } from 'react-test-renderer';
import { Composer } from '../../src/components/composer.tsx';
import {
  STILL_UNCONFIRMED_LINE,
  type UnconfirmedAction,
  unconfirmedSendOf,
} from '../../src/features/unconfirmed-send/unconfirmed-send.ts';
import { UnconfirmedSendNotice } from '../../src/features/unconfirmed-send/unconfirmed-send-notice.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';

/**
 * A send whose message was typed into the agent's box and never shown there — the notice that replaced
 * "the turn did not land in the composer of tmux session …", and the three taps on exactly that send.
 */

const SEND_ID = 'send-7';

afterEach(() => writeMdComposePref('on'));

const unconfirmed = (sendId = SEND_ID): FyHttpError =>
  new FyHttpError('the message was typed into the agent’s box', 409, SEND_UNCONFIRMED_CODE, {
    error: 'the message was typed into the agent’s box',
    code: SEND_UNCONFIRMED_CODE,
    sendId,
  });

describe('reading the answer', () => {
  test('takes the send id from a send_unconfirmed answer, and from nothing else', () => {
    expect(unconfirmedSendOf(unconfirmed())).toBe(SEND_ID);
    expect(
      unconfirmedSendOf(
        new FyHttpError('x', 409, COMPOSER_OCCUPIED_CODE, { code: COMPOSER_OCCUPIED_CODE, draft: 'x' }),
      ),
    ).toBeUndefined();
    expect(
      unconfirmedSendOf(new FyHttpError('x', 500, SEND_UNCONFIRMED_CODE, { code: SEND_UNCONFIRMED_CODE, sendId: 'x' })),
    ).toBeUndefined();
    expect(unconfirmedSendOf(new Error('the turn did not land in the composer of tmux session fy-1'))).toBeUndefined();
  });
});

describe('the notice', () => {
  test('offers the taps it is given, in order, and names no terminal or session', () => {
    const taps: UnconfirmedAction[] = [];
    const view = render(
      <UnconfirmedSendNotice actions={['submit', 'clear', 'retry']} busy={false} onAct={action => taps.push(action)} />,
    );
    const passive = render(<UnconfirmedSendNotice actions={[]} busy={false} failure="nope" onAct={() => undefined} />);

    const buttons = view.root.findAll(node => node.type === 'button');
    for (const button of buttons) run(() => button.props.onClick());

    expect(buttons.map(button => [button.props.children].flat().join(''))).toEqual(['Send it', 'Clear it', 'Retry']);
    expect(taps).toEqual(['submit', 'clear', 'retry']);
    const words = (tree: ReactTestRenderer): string =>
      tree.root
        .findAll(node => node.type === 'p')
        .map(node => [node.props.children].flat().join(''))
        .join(' ');
    expect(words(view)).not.toMatch(/tmux|session/u);
    expect(passive.root.findAll(node => node.type === 'button')).toHaveLength(0);
    expect(words(passive)).toContain('nope');
    run(() => {
      view.unmount();
      passive.unmount();
    });
  });
});

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const daemon = daemonConnection({ daemonId: 'm', baseUrl: 'https://m.example.test', deviceId: 'device' });

type Answer = 'ok' | 'unconfirmed' | Error;

interface Calls {
  readonly submitted: string[];
  readonly cancelled: string[];
  readonly retried: Array<readonly [string, boolean | undefined]>;
}

/** The shipped composer, with its first send answered `send_unconfirmed` and each tap answering `answer`. */
const composerWith = async (answer: Answer, withActions = true) => {
  writeMdComposePref('off');
  const calls: Calls = { submitted: [], cancelled: [], retried: [] };
  let sent = 0;
  const act = async (record: () => void): Promise<SendRecord> => {
    record();
    if (answer === 'unconfirmed') throw unconfirmed();
    if (answer instanceof Error) throw answer;
    return { sendId: SEND_ID } as SendRecord;
  };
  const view = render(
    <Composer
      api={{
        send: async () => {
          sent += 1;
          throw unconfirmed();
        },
        ...(withActions
          ? {
              submitSend: async (_id: string, sendId: string) => await act(() => calls.submitted.push(sendId)),
              cancelSend: async (_id: string, sendId: string) => await act(() => calls.cancelled.push(sendId)),
              retrySend: async (_id: string, sendId: string, force?: boolean) =>
                await act(() => calls.retried.push([sendId, force])),
            }
          : {}),
      }}
      daemon={daemon}
      draftStore={new DaemonDraftStore(new MemoryStorage())}
      sessionId="s"
    />,
  );
  run(() =>
    view.root
      .findByType('textarea')
      .props.onChange({ currentTarget: { value: 'look thru the emails', selectionStart: 20, selectionEnd: 20 } }),
  );
  await runAsync(async () => {
    view.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });
  const lines = (className: string): string | null => {
    const found = view.root.findAll(node => node.type === 'p' && node.props.className === className);
    return found.length === 0 ? null : found.map(node => [node.props.children].flat().join('')).join(' | ');
  };
  return {
    view,
    calls,
    sends: () => sent,
    tap: async (action: UnconfirmedAction) =>
      await runAsync(async () => {
        view.root
          .find(node => node.type === 'button' && node.props['data-unconfirmed-action'] === action)
          .props.onClick();
      }),
    shown: () =>
      view.root.findAll(node => node.type === 'section' && node.props['data-unconfirmed-send'] !== undefined).length >
      0,
    failure: () => lines('fy-occupied-composer__failure'),
    error: () => lines('fy-composer-error'),
    buttons: () =>
      view.root.findAll(node => node.type === 'button' && node.props['data-unconfirmed-action'] !== undefined).length,
    draft: () => view.root.findByType('textarea').props.value,
  };
};

describe('the composer with an unconfirmed send', () => {
  test('shows the notice instead of a red tmux line, keeping the person’s message', async () => {
    const harness = await composerWith('ok');

    expect(harness.shown()).toBe(true);
    expect(harness.error()).toBeNull();
    expect(harness.draft()).toBe('look thru the emails');
    expect(harness.buttons()).toBe(3);
    run(() => harness.view.unmount());
  });

  test('Send it presses Enter on exactly that send, and then the message is done here', async () => {
    const harness = await composerWith('ok');

    await harness.tap('submit');

    expect(harness.calls.submitted).toEqual([SEND_ID]);
    expect(harness.shown()).toBe(false);
    expect(harness.draft()).toBe('');
    // Nothing is re-posted as a new message.
    expect(harness.sends()).toBe(1);
    run(() => harness.view.unmount());
  });

  test('Clear it takes that send back and leaves the person’s text to edit or send again', async () => {
    const harness = await composerWith('ok');

    await harness.tap('clear');

    expect(harness.calls.cancelled).toEqual([SEND_ID]);
    expect(harness.shown()).toBe(false);
    expect(harness.draft()).toBe('look thru the emails');
    run(() => harness.view.unmount());
  });

  test('Retry forces the same send again, never a new one, and finishes it when it goes through', async () => {
    const harness = await composerWith('ok');

    await harness.tap('retry');

    expect(harness.calls.retried).toEqual([[SEND_ID, true]]);
    expect(harness.sends()).toBe(1);
    expect(harness.draft()).toBe('');
    run(() => harness.view.unmount());
  });

  test('keeps the notice, the text and the taps when a tap is refused or comes back unconfirmed again', async () => {
    const refused = await composerWith(
      new Error('send send-7 is typed in the agent’s composer and not sent; press Enter instead'),
    );
    const again = await composerWith('unconfirmed');

    await refused.tap('retry');
    await again.tap('retry');

    expect(refused.failure()).toContain('press Enter instead');
    expect(again.failure()).toBe(STILL_UNCONFIRMED_LINE);
    for (const harness of [refused, again]) {
      expect(harness.shown()).toBe(true);
      expect(harness.draft()).toBe('look thru the emails');
      expect(harness.buttons()).toBe(3);
    }
    run(() => {
      refused.view.unmount();
      again.view.unmount();
    });
  });

  test('offers no taps when the client cannot act on a send', async () => {
    const harness = await composerWith('ok', false);

    expect(harness.shown()).toBe(true);
    expect(harness.buttons()).toBe(0);
    run(() => harness.view.unmount());
  });
});
