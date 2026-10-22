import { afterEach, describe, expect, test } from 'bun:test';
import { COMPOSER_OCCUPIED_CODE, type ComposerDraftRequest, type ComposerDraftResult } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { ReactTestRenderer } from 'react-test-renderer';
import { Composer } from '../../src/components/composer.tsx';
import { OccupiedComposerNotice } from '../../src/features/occupied-composer/occupied-composer-notice.tsx';
import {
  draftQuote,
  draftResolved,
  draftStuckLine,
  occupiedDraftOf,
} from '../../src/features/occupied-composer/occupied-draft.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';

/**
 * A send refused because the agent's own box holds the person's unsent text — the notice, and the one
 * tap that sends or clears that text and then the person's message.
 */

const STUCK = 'check why the login test is flaky';

// The composer cases drive the Plain textarea; the editor style is put back for every other suite.
afterEach(() => writeMdComposePref('on'));

const occupied = (draft = STUCK): FyHttpError =>
  new FyHttpError('the agent’s composer already holds unsent text', 409, COMPOSER_OCCUPIED_CODE, {
    error: 'the agent’s composer already holds unsent text',
    code: COMPOSER_OCCUPIED_CODE,
    draft,
  });

describe('reading the refusal', () => {
  test('takes the draft from a composer_occupied refusal, and from nothing else', () => {
    expect(occupiedDraftOf(occupied())).toBe(STUCK);
    expect(occupiedDraftOf(new FyHttpError('x', 409, 'send_refused', { code: 'send_refused' }))).toBeUndefined();
    expect(
      occupiedDraftOf(new FyHttpError('x', 500, COMPOSER_OCCUPIED_CODE, { code: COMPOSER_OCCUPIED_CODE, draft: 'x' })),
    ).toBeUndefined();
    expect(occupiedDraftOf(new Error('the agent’s composer already holds unsent text'))).toBeUndefined();
  });

  test('quotes the draft on one line, clipped, and says which taps freed the box', () => {
    expect(draftQuote('fix the\n   login bug')).toBe('fix the login bug');
    expect(draftQuote('x'.repeat(100))).toBe(`${'x'.repeat(80)}…`);
    expect(['submitted', 'cleared', 'absent', 'changed'].every(outcome => draftResolved(outcome as never))).toBe(true);
    expect(draftResolved('holding')).toBe(false);
    expect(draftResolved('stuck')).toBe(false);
    expect(draftStuckLine('holding')).toContain('didn’t take that Enter');
    expect(draftStuckLine('stuck')).toContain('didn’t clear');
  });
});

describe('the notice', () => {
  const text = (view: ReactTestRenderer): string =>
    view.root
      .findAll(node => node.type === 'p')
      .map(node => [node.props.children].flat().join(''))
      .join(' | ');

  test('offers both taps, and says only the terminal remedy when this composer cannot act', () => {
    const taps: string[] = [];
    const acting = render(
      <OccupiedComposerNotice busy={false} draft={STUCK} onResolve={action => taps.push(action)} />,
    );
    const passive = render(<OccupiedComposerNotice busy={false} draft={STUCK} failure="That text didn’t clear." />);

    for (const button of acting.root.findAll(node => node.type === 'button')) run(() => button.props.onClick());

    expect(taps).toEqual(['submit', 'clear']);
    expect(text(acting)).toContain(`“${STUCK}”`);
    expect(text(acting)).toContain('Send it sends that text first, then yours.');
    expect(passive.root.findAll(node => node.type === 'button')).toHaveLength(0);
    expect(text(passive)).toContain('in the terminal');
    expect(text(passive)).toContain('That text didn’t clear.');
    run(() => {
      acting.unmount();
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

interface Harness {
  readonly view: ReactTestRenderer;
  readonly sent: unknown[];
  readonly taps: ComposerDraftRequest[];
  tap(action: 'submit' | 'clear'): Promise<void>;
  notice(): string | null;
  error(): string | null;
  buttons(): number;
  draft(): unknown;
}

/** The shipped composer, with a send refused once for `STUCK` and a resolver that answers `outcome`. */
const composerWith = async (
  resolve: ((request: ComposerDraftRequest) => Promise<ComposerDraftResult>) | undefined,
): Promise<Harness> => {
  writeMdComposePref('off');
  const sent: unknown[] = [];
  const taps: ComposerDraftRequest[] = [];
  let refusing = true;
  const view = render(
    <Composer
      api={{
        send: async (_id, body) => {
          if (refusing) throw occupied();
          sent.push(body);
          return { disposition: 'queued' } as never;
        },
        ...(resolve === undefined
          ? {}
          : {
              resolveComposerDraft: async (_id: string, request: ComposerDraftRequest) => {
                taps.push(request);
                const result = await resolve(request);
                refusing = false;
                return result;
              },
            }),
      }}
      daemon={daemon}
      draftStore={new DaemonDraftStore(new MemoryStorage())}
      sessionId="s"
    />,
  );
  run(() =>
    view.root
      .findByType('textarea')
      .props.onChange({ currentTarget: { value: 'ship the fix', selectionStart: 12, selectionEnd: 12 } }),
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
    sent,
    taps,
    tap: async action =>
      await runAsync(async () => {
        view.root.find(node => node.type === 'button' && node.props['data-occupied-action'] === action).props.onClick();
      }),
    notice: () => {
      const found = view.root.findAll(
        node => node.props['data-occupied-composer'] !== undefined && node.type === 'section',
      );
      return found.length === 0
        ? null
        : (lines('fy-occupied-composer__failure') ?? lines('fy-occupied-composer__draft'));
    },
    error: () => lines('fy-composer-error'),
    buttons: () =>
      view.root.findAll(node => node.type === 'button' && node.props['data-occupied-action'] !== undefined).length,
    draft: () => view.root.findByType('textarea').props.value,
  };
};

describe('the composer with an occupied agent box', () => {
  test('shows the notice instead of a red error, keeping the person’s message', async () => {
    const harness = await composerWith(async request => ({ action: request.action, outcome: 'submitted' }));

    expect(harness.notice()).toBe(`“${STUCK}”`);
    expect(harness.error()).toBeNull();
    expect(harness.draft()).toBe('ship the fix');
    run(() => harness.view.unmount());
  });

  test('Send it acts on exactly that text, then sends the person’s message and clears the box', async () => {
    const harness = await composerWith(async request => ({ action: request.action, outcome: 'submitted' }));

    await harness.tap('submit');

    expect(harness.taps).toEqual([{ action: 'submit', draft: STUCK }]);
    expect(harness.sent).toEqual([{ message: 'ship the fix', now: false }]);
    expect(harness.notice()).toBeNull();
    expect(harness.draft()).toBe('');
    run(() => harness.view.unmount());
  });

  test('a box changed in the terminal meanwhile still frees the send, which meets the box as it now is', async () => {
    const harness = await composerWith(async request => ({ action: request.action, outcome: 'changed' }));

    await harness.tap('clear');

    expect(harness.taps).toEqual([{ action: 'clear', draft: STUCK }]);
    expect(harness.sent).toHaveLength(1);
    run(() => harness.view.unmount());
  });

  test('says so, and sends nothing, when the key did not take or the tap failed', async () => {
    const holding = await composerWith(async request => ({ action: request.action, outcome: 'holding' }));
    const failed = await composerWith(async () => {
      throw new Error('this device may not type into that terminal');
    });

    await holding.tap('submit');
    await failed.tap('clear');

    expect(holding.notice()).toContain('didn’t take that Enter');
    expect(failed.notice()).toBe('this device may not type into that terminal');
    expect([...holding.sent, ...failed.sent]).toEqual([]);
    expect(holding.buttons()).toBe(2);
    run(() => {
      holding.view.unmount();
      failed.view.unmount();
    });
  });

  test('ignores a second tap while the first is in flight', async () => {
    let release: () => void = () => undefined;
    const harness = await composerWith(
      request =>
        new Promise(resolve => {
          release = () => resolve({ action: request.action, outcome: 'submitted' });
        }),
    );

    await runAsync(async () => {
      const button = harness.view.root.find(
        node => node.type === 'button' && node.props['data-occupied-action'] === 'submit',
      );
      button.props.onClick();
      button.props.onClick();
    });
    await runAsync(async () => release());

    expect(harness.taps).toHaveLength(1);
    run(() => harness.view.unmount());
  });

  test('offers no taps when the client cannot act on the box', async () => {
    const harness = await composerWith(undefined);

    expect(harness.notice()).toBe(`“${STUCK}”`);
    expect(harness.buttons()).toBe(0);
    run(() => harness.view.unmount());
  });
});
