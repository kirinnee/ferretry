import { describe, expect, test } from 'bun:test';
import { sessionActionSections } from '../../src/features/session-actions/registry.ts';
import {
  CLEAR_STUCK_MESSAGES_ACTION_ID,
  cancelAllStuck,
  clearStuckMessagesContribution,
  NO_STUCK_MESSAGES_REASON,
  type StuckMessageActionContext,
  type StuckMessageActions,
  stuckSends,
  useStuckMessageActions,
} from '../../src/features/stuck-messages/use-stuck-message-actions.tsx';
import type { LedgerSendRecord } from '../../src/lib/send-ledger.ts';
import { render, run } from '../support/react.ts';

const NOW = Date.parse('2026-07-31T10:05:00.000Z');

const record = (overrides: Partial<LedgerSendRecord> = {}): LedgerSendRecord => ({
  sendId: 'send-1',
  acceptedAt: '2026-07-31T10:00:00.000Z',
  message: 'ship the tool group',
  attachmentIds: [],
  fate: 'accepted',
  ...overrides,
});

const ledger = [
  record({ sendId: 'sending' }),
  record({ sendId: 'queued', fate: 'queued' }),
  record({ sendId: 'typed', typedNotSent: true }),
  record({ sendId: 'lost', fate: 'timed_out' }),
  record({ sendId: 'delivered', fate: 'delivered' }),
  record({ sendId: 'cancelled', fate: 'cancelled', cancelEffect: 'cleared' }),
  record({ sendId: 'held', held: true }),
];

const owner: StuckMessageActionContext = { canControl: true };

describe('stuckSends', () => {
  test('is what the reader can see waiting: not delivered, cancelled or held', () => {
    expect(stuckSends(ledger, NOW).map(entry => entry.sendId)).toEqual(['sending', 'queued', 'typed', 'lost']);
  });

  test('defaults to now, when a settled row of last summer has long retired', () => {
    expect(stuckSends([record({ fate: 'timed_out' }), record({ sendId: 'open' })]).map(entry => entry.sendId)).toEqual([
      'open',
    ]);
  });
});

describe('cancelAllStuck', () => {
  test('cancels each in turn, one at a time, then refreshes once', async () => {
    const order: string[] = [];
    let refreshed = 0;
    const client = {
      cancelSend: async (sessionId: string, sendId: string) => {
        order.push(`start ${sessionId}/${sendId}`);
        await Promise.resolve();
        order.push(`end ${sendId}`);
        return {} as never;
      },
    };
    await cancelAllStuck(client, 's-1', stuckSends(ledger, NOW), () => (refreshed += 1));
    expect(order).toEqual([
      'start s-1/sending',
      'end sending',
      'start s-1/queued',
      'end queued',
      'start s-1/typed',
      'end typed',
      'start s-1/lost',
      'end lost',
    ]);
    expect(refreshed).toBe(1);
  });

  test('carries on past a refusal, refreshes anyway, and reports the first refusal in the daemon’s words', async () => {
    const tried: string[] = [];
    let refreshed = 0;
    const client = {
      cancelSend: async (_sessionId: string, sendId: string) => {
        tried.push(sendId);
        if (sendId === 'queued') throw new Error('the pane is busy');
        if (sendId === 'typed') throw 'plain';
        return {} as never;
      },
    };
    await expect(cancelAllStuck(client, 's-1', stuckSends(ledger, NOW), () => (refreshed += 1))).rejects.toThrow(
      '2 of 4 could not be cleared — the pane is busy. The rest were cleared.',
    );
    expect(tried).toEqual(['sending', 'queued', 'typed', 'lost']);
    expect(refreshed).toBe(1);
  });

  test('says it all failed without claiming the rest were cleared', async () => {
    const client = {
      cancelSend: async () => {
        throw new Error('   ');
      },
    };
    await expect(cancelAllStuck(client, 's-1', [record()], () => {})).rejects.toThrow(
      '1 of 1 could not be cleared — refused.',
    );
  });

  test('says there is no connection rather than doing nothing', async () => {
    await expect(cancelAllStuck(null, 's-1', [record()], () => {})).rejects.toThrow('not connected');
  });
});

describe('the Clear stuck messages entry', () => {
  const entryOf = (stuck: readonly LedgerSendRecord[], context: StuckMessageActionContext = owner) => {
    const clear = async (): Promise<void> => {};
    const entry = clearStuckMessagesContribution(stuck, clear).build(context);
    return { entry, clear };
  };

  test('asks "Clear N stuck messages?" and says what is erased and what may still be read', () => {
    const { entry, clear } = entryOf(stuckSends(ledger, NOW));
    expect(entry).toMatchObject({
      kind: 'confirm',
      id: CLEAR_STUCK_MESSAGES_ACTION_ID,
      label: 'Clear stuck messages',
      question: 'Clear 4 stuck messages?',
      detail: '4',
      confirmLabel: 'Clear messages',
      run: clear,
    });
    expect(entry).not.toHaveProperty('unavailable');
    const consequence = entry?.kind === 'confirm' ? entry.consequence : '';
    expect(consequence).toContain('erased from it');
    expect(consequence).toContain('may still read them');
  });

  test('is singular for one', () => {
    const { entry } = entryOf([record()]);
    expect(entry).toMatchObject({ kind: 'confirm', question: 'Clear 1 stuck message?', detail: '1' });
  });

  test('is dimmed with its reason when nothing is stuck, and hidden from a connection that cannot control', () => {
    const { entry } = entryOf([]);
    expect(entry).toMatchObject({ kind: 'confirm', unavailable: NO_STUCK_MESSAGES_REASON });
    expect(entry).not.toHaveProperty('detail');
    expect(entryOf([record()], { canControl: false }).entry).toBeNull();
  });

  test('sits in the Session section of the menu', () => {
    const sections = sessionActionSections([clearStuckMessagesContribution([record()], async () => {})], owner);
    expect(sections.map(section => [section.group, section.entries.map(entry => entry.id)])).toEqual([
      ['session', [CLEAR_STUCK_MESSAGES_ACTION_ID]],
    ]);
  });
});

describe('useStuckMessageActions', () => {
  function Probe({
    client,
    sends,
    refresh,
    out,
  }: {
    readonly client: { cancelSend: (sessionId: string, sendId: string) => Promise<never> } | null;
    readonly sends: readonly LedgerSendRecord[];
    readonly refresh: () => void;
    readonly out: { current: StuckMessageActions | null };
  }) {
    out.current = useStuckMessageActions({ client, sessionId: 's-1', sends, refresh });
    return null;
  }

  test('counts the stuck messages, and its entry clears them through the client and refreshes', async () => {
    const out: { current: StuckMessageActions | null } = { current: null };
    const cancelled: string[] = [];
    let refreshed = 0;
    const client = {
      cancelSend: async (_sessionId: string, sendId: string) => {
        cancelled.push(sendId);
        return {} as never;
      },
    };
    const refresh = () => {
      refreshed += 1;
    };
    // Only open rows are counted: the hook asks the same question the transcript does, at the time it asks.
    const sends = [
      record({ sendId: 'a' }),
      record({ sendId: 'b', fate: 'queued' }),
      record({ sendId: 'd', fate: 'delivered' }),
    ];
    const view = render(<Probe client={client} out={out} refresh={refresh} sends={sends} />);

    expect(out.current?.count).toBe(2);
    const first = out.current?.contributions;
    const entry = out.current?.contributions[0]?.build(owner);
    expect(entry?.kind === 'confirm' ? entry.question : '').toBe('Clear 2 stuck messages?');
    if (entry?.kind === 'confirm') await entry.run();
    expect(cancelled).toEqual(['a', 'b']);
    expect(refreshed).toBe(1);

    // The same inputs keep the same contributions, so the menu is not rebuilt for nothing.
    run(() => view.update(<Probe client={client} out={out} refresh={refresh} sends={sends} />));
    expect(out.current?.contributions).toBe(first);
    run(() => view.update(<Probe client={client} out={out} refresh={refresh} sends={[]} />));
    expect(out.current?.count).toBe(0);
  });
});
