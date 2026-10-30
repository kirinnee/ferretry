import { describe, expect, test } from 'bun:test';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { MessageFooter } from '../../src/components/send-receipt.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { clockOfInstant } from '../../src/lib/message-clock.ts';
import type { LedgerSendRecord } from '../../src/lib/send-ledger.ts';
import { sendBadge } from '../../src/lib/send-badge.ts';
import { RECEIPT_LEGEND, type SendReceiptKind, sendReceipt } from '../../src/lib/send-receipt.ts';
import { type TranscriptEntry, transcriptItems } from '../../src/lib/session-screens.ts';
import { render, runAsync } from '../support/react.ts';

const record = (overrides: Partial<LedgerSendRecord> = {}): LedgerSendRecord => ({
  sendId: 'send-1',
  acceptedAt: '2026-07-31T10:00:00.000Z',
  message: 'ship the tool group',
  attachmentIds: [],
  fate: 'accepted',
  ...overrides,
});

const STATE_AT = '2026-07-31T10:00:05.000Z';

const textOf = (renderer: ReactTestRenderer): string => {
  const walk = (node: unknown): string => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(walk).join('');
    if (node !== null && typeof node === 'object' && 'children' in node) {
      return walk((node as { children: unknown }).children);
    }
    return '';
  };
  return walk(renderer.toJSON());
};

const receiptButton = (renderer: ReactTestRenderer): ReactTestInstance =>
  renderer.root.find(node => node.type === 'button' && node.props['data-send-receipt'] !== undefined);

describe('sendReceipt', () => {
  test('maps every daemon state to exactly one receipt, and only the two that need the reader get a word', () => {
    const cases: readonly [string, LedgerSendRecord, boolean, SendReceiptKind, string, string | undefined][] = [
      ['accepted', record(), false, 'sending', 'Sending', undefined],
      ['held', record({ held: true }), false, 'held', 'Held for revive', undefined],
      ['held while queued', record({ fate: 'queued', held: true }), false, 'held', 'Held for revive', undefined],
      ['queued', record({ fate: 'queued' }), false, 'queued', 'Queued', undefined],
      ['typed in the composer', record({ typedNotSent: true }), false, 'typed', 'Typed, not sent', 'typed, not sent'],
      [
        'typed and queued',
        record({ fate: 'queued', typedNotSent: true }),
        false,
        'typed',
        'Typed, not sent',
        'typed, not sent',
      ],
      // A settled fate outranks the typed flag, and the typed flag outranks held.
      [
        'typed but timed out',
        record({ fate: 'timed_out', typedNotSent: true }),
        false,
        'failed',
        'Not delivered',
        'not delivered',
      ],
      [
        'typed but held',
        record({ held: true, typedNotSent: true }),
        false,
        'typed',
        'Typed, not sent',
        'typed, not sent',
      ],
      [
        'cancelled',
        record({ fate: 'cancelled', cancelEffect: 'cleared' }),
        false,
        'cancelled',
        'Cancelled',
        'cancelled',
      ],
      ['cancelled and held', record({ fate: 'cancelled', held: true }), false, 'cancelled', 'Cancelled', 'cancelled'],
      ['delivered', record({ fate: 'delivered' }), false, 'delivered', 'Delivered', undefined],
      ['delivered, then answered', record({ fate: 'delivered' }), true, 'answered', 'Answered', undefined],
      ['unaccounted', record({ fate: 'unaccounted' }), false, 'unconfirmed', 'Unconfirmed', 'unconfirmed'],
      ['timed out', record({ fate: 'timed_out' }), false, 'failed', 'Not delivered', 'not delivered'],
      // A settled fate outranks `held`, exactly as the badge's order has it.
      [
        'held but timed out',
        record({ fate: 'timed_out', held: true }),
        false,
        'failed',
        'Not delivered',
        'not delivered',
      ],
    ];
    for (const [, sent, answered, kind, name, chip] of cases) {
      const receipt = sendReceipt(sent, answered);
      expect(receipt.kind).toBe(kind);
      expect(receipt.name).toBe(name);
      expect(receipt.chip).toBe(chip);
      expect(receipt.detail.length).toBeGreaterThan(10);
    }
  });

  test('a reply after a send is not evidence about an unsettled one — only a delivered send reads as answered', () => {
    expect(sendReceipt(record({ fate: 'queued' }), true).kind).toBe('queued');
    expect(sendReceipt(record({ fate: 'unaccounted' }), true).kind).toBe('unconfirmed');
    expect(sendReceipt(record({ fate: 'delivered' }), true).detail).toContain('the agent has replied since');
  });

  test('an open send whose ledger cannot be read says its status is unknown and why, never "Sending"', () => {
    // Arrange
    const unread = { since: '2026-07-31T10:01:00.000Z', reason: 'fyd did not answer within 20s' };

    // Act
    const sending = sendReceipt(record({ unread }));
    const typed = sendReceipt(record({ fate: 'queued', typedNotSent: true, unread }));

    // Assert
    for (const receipt of [sending, typed]) {
      expect(receipt.kind).toBe('unconfirmed');
      expect(receipt.name).toBe('Status unknown');
      expect(receipt.chip).toBe('status unknown');
      expect(receipt.detail).toContain('has not been able to read where this message went since');
      expect(receipt.detail).toContain('(fyd did not answer within 20s); it may still have arrived');
    }
  });
});

describe('the legend', () => {
  test('names every mark once, in the words the tooltips use, and omits none a reader can meet but held', () => {
    expect(RECEIPT_LEGEND.map(row => row.kind)).toEqual([
      'sending',
      'queued',
      'typed',
      'delivered',
      'answered',
      'read',
      'unconfirmed',
      'failed',
      'cancelled',
    ]);
    const records: readonly [LedgerSendRecord, boolean][] = [
      [record(), false],
      [record({ fate: 'queued' }), false],
      [record({ typedNotSent: true }), false],
      [record({ fate: 'delivered' }), false],
      [record({ fate: 'delivered' }), true],
      [record({ fate: 'delivered', queue: { state: 'read', stateAt: STATE_AT, revision: 1 } }), false],
      [record({ fate: 'unaccounted' }), false],
      [record({ fate: 'timed_out' }), false],
      [record({ fate: 'cancelled' }), false],
    ];
    RECEIPT_LEGEND.forEach((row, index) => {
      const [sent, answered] = records[index] as [LedgerSendRecord, boolean];
      expect(sendReceipt(sent, answered).kind).toBe(row.kind);
      expect(sendReceipt(sent, answered).name).toBe(row.name);
      expect(row.meaning.length).toBeGreaterThan(10);
    });
  });
});

describe('MessageFooter', () => {
  test('draws nothing with neither a time nor a send', () => {
    expect(render(<MessageFooter />).toJSON()).toBeNull();
  });

  test('draws a bare faded time when the message has no ledger send', () => {
    const footer = render(<MessageFooter clock={{ short: '13:58', full: '18 Oct 2026, 13:58:44 JST' }} />);
    expect(footer.root.findAllByType('svg')).toHaveLength(0);
    expect(textOf(footer)).toBe('13:58');
    const time = footer.root.findByType('button');
    expect(time.props.title).toBe('18 Oct 2026, 13:58:44 JST');
    expect(time.props['aria-label']).toBe('Sent 18 Oct 2026, 13:58:44 JST');
  });

  test('a tap on a bare time reads out the full local date and time, and a second tap hides it', async () => {
    const footer = render(<MessageFooter clock={{ short: '13:58', full: '18 Oct 2026, 13:58:44 JST' }} side="other" />);
    expect(footer.root.findAllByProps({ 'data-time-full': '' })).toHaveLength(0);
    await runAsync(async () => footer.root.findByType('button').props.onClick());
    expect(footer.root.findByProps({ 'data-time-full': '' }).children).toEqual(['18 Oct 2026, 13:58:44 JST']);
    expect(footer.root.findByProps({ 'data-time-full': '' }).props['data-side']).toBe('other');
    await runAsync(async () => footer.root.findByType('button').props.onClick());
    expect(footer.root.findAllByProps({ 'data-time-full': '' })).toHaveLength(0);
  });

  test('is one tappable receipt — the time and the mark — that reads out the time to the second and why', async () => {
    const footer = render(
      <MessageFooter answered clock={{ short: '14:02', full: '14:02:55' }} record={record({ fate: 'delivered' })} />,
    );
    const receipt = receiptButton(footer);
    expect(receipt.props['data-send-receipt']).toBe('answered');
    expect(receipt.props['aria-label']).toBe('Answered, sent 14:02:55');
    expect(receipt.props.title).toContain('Answered\n');
    expect(receipt.props.title).toContain('sent 14:02:55');
    expect(receipt.props['aria-expanded']).toBe(false);
    expect(footer.root.findAllByProps({ 'data-send-chip': 'answered' })).toHaveLength(0);

    await runAsync(async () => receipt.props.onClick());

    expect(receiptButton(footer).props['aria-expanded']).toBe(true);
    expect(footer.root.findByProps({ 'data-send-reason': '' }).children.join('')).toContain(
      'Answered · sent 14:02:55 — ',
    );
  });

  test('names a send with no known time by its state alone, and keeps a word for a state that needs the reader', async () => {
    const footer = render(<MessageFooter record={record({ fate: 'timed_out' })} />);
    const receipt = receiptButton(footer);
    expect(receipt.props['aria-label']).toBe('Not delivered');
    expect(receipt.findAllByType('time')).toHaveLength(0);
    expect(footer.root.findByProps({ 'data-send-chip': 'failed' }).children).toEqual(['not delivered']);

    await runAsync(async () => receipt.props.onClick());

    expect(footer.root.findByProps({ 'data-send-reason': '' }).children.join('')).toContain('timed out');
  });
});

const AT = Date.UTC(2026, 9, 18, 1, 45, 44);

describe('the reader’s own row', () => {
  test('has no "You" header, and wears its time and receipt at its foot', () => {
    const row = render(
      <TranscriptRow
        answered
        entry={{ at: AT, id: 'u', kind: 'user', text: 'ship it', send: record({ fate: 'delivered' }) }}
      />,
    );
    expect(row.root.findAllByType('header')).toHaveLength(0);
    expect(receiptButton(row).props['data-send-receipt']).toBe('answered');
    // A row that IS a send reads when it was sent, so it says the same before and after it lands.
    expect(receiptButton(row).props['aria-label']).toBe(
      `Answered, sent ${clockOfInstant('2026-07-31T10:00:00.000Z')?.full}`,
    );
  });

  test('falls back to the row’s own instant when the send’s time cannot be read', () => {
    const row = render(
      <TranscriptRow
        entry={{ at: AT, id: 'u', kind: 'user', text: 'ship it', send: record({ acceptedAt: 'not a date' }) }}
      />,
    );
    expect(receiptButton(row).props['aria-label']).toBe(`Sending, sent ${clockOfInstant(AT)?.full}`);
  });

  test('prints the row’s instant on the reader’s clock and ignores any clock a label carries', () => {
    const row = render(
      <TranscriptRow entry={{ at: AT, id: 'u', kind: 'user', text: 'ship it', label: 'You · 01:45:44' }} />,
    );
    expect(row.root.findByType('time').children).toEqual([clockOfInstant(AT)?.short ?? '']);
    expect(row.root.findAllByType('time')).toHaveLength(1);
  });
});

describe('transcriptItems', () => {
  test('marks every row before the last assistant reply as answered, and none after it', () => {
    const entries: TranscriptEntry[] = [
      { id: 'a', kind: 'user', text: 'first' },
      { id: 'b', kind: 'assistant', text: 'reply' },
      { id: 'c', kind: 'user', text: 'second' },
      { id: 'd', kind: 'notice', text: 'hidden bookkeeping' },
      { id: 'e', kind: 'assistant', text: 'reply two' },
      { id: 'f', kind: 'user', text: 'not answered yet' },
    ];
    expect(transcriptItems(entries).map(item => [item.entry.id, item.answered === true])).toEqual([
      ['a', true],
      ['b', true],
      ['c', true],
      ['e', false],
      ['f', false],
    ]);
    expect(transcriptItems([{ id: 'x', kind: 'user', text: 'alone' }])[0]?.answered).toBeUndefined();
  });
});

describe('MessageFooter with a lead', () => {
  const lead = <span data-lead="">via turn file</span>;

  test('draws the lead alone on the line when nothing recorded a time', () => {
    const footer = render(<MessageFooter lead={lead} />);
    expect(footer.root.findAllByProps({ 'data-lead': '' })).toHaveLength(1);
    expect(footer.root.findAllByType('button')).toHaveLength(0);
  });

  test('puts the lead ahead of the time on the same line, and its detail under the line', () => {
    const footer = render(
      <MessageFooter
        clock={{ short: '13:58', full: '18 Oct 2026, 13:58:44 JST' }}
        lead={lead}
        leadDetail={<p data-lead-detail="">why</p>}
      />,
    );
    expect(footer.root.findAllByProps({ 'data-message-footer': '' })).toHaveLength(1);
    expect(footer.root.findAllByProps({ 'data-lead': '' })).toHaveLength(1);
    expect(footer.root.findAllByProps({ 'data-lead-detail': '' })).toHaveLength(1);
  });

  test('shares the line with a receipt too', () => {
    const footer = render(
      <MessageFooter
        clock={{ short: '14:02', full: '14:02:55' }}
        lead={lead}
        leadDetail={<p data-lead-detail="">why</p>}
        record={record({ fate: 'delivered' })}
      />,
    );
    expect(footer.root.findAllByProps({ 'data-message-footer': '' })).toHaveLength(1);
    expect(footer.root.findAllByProps({ 'data-lead': '' })).toHaveLength(1);
    expect(footer.root.findAllByProps({ 'data-lead-detail': '' })).toHaveLength(1);
  });
});

describe('a message the durable queue holds', () => {
  const queued = (
    state: 'queued' | 'typing' | 'delivered' | 'read' | 'cancelled' | 'failed',
    extra: Partial<NonNullable<LedgerSendRecord['queue']>> = {},
    overrides: Partial<LedgerSendRecord> = {},
  ): LedgerSendRecord => record({ queue: { state, stateAt: STATE_AT, revision: 1, ...extra }, ...overrides });

  test('queued is one tick, and says in plain words why it waits for every reason', () => {
    const reasons = {
      launching: 'it is still starting',
      busy: 'the ferret is busy',
      question: 'a question is open',
      dialog: 'a dialog is on its screen',
      draft: 'its box holds a draft',
      unreadable: 'its screen can’t be read',
      stopped: 'it is not running',
    } as const;
    for (const [waitReason, words] of Object.entries(reasons)) {
      const receipt = sendReceipt(queued('queued', { waitReason: waitReason as keyof typeof reasons }));
      expect(receipt).toEqual({
        kind: 'queued',
        name: 'Queued',
        detail: `waiting: ${words}`,
        chip: `waiting: ${words}`,
      });
    }
    expect(sendReceipt(queued('queued')).detail).toBe('waiting for its turn');
  });

  test('typing is one tick that says it is sending', () => {
    expect(sendReceipt(queued('typing'))).toMatchObject({ kind: 'queued', name: 'Sending' });
    expect(sendReceipt(queued('typing')).detail).toContain('being typed into the agent now');
  });

  test('delivered is two ticks and read is three', () => {
    expect(sendReceipt(queued('delivered', {}, { fate: 'delivered' })).kind).toBe('delivered');
    expect(sendReceipt(queued('read', {}, { fate: 'delivered' }))).toMatchObject({ kind: 'read', name: 'Read' });
  });

  test('failed says the failure sentence, never the ledger’s "not delivered" or a retry', () => {
    const receipt = sendReceipt(queued('failed', { failure: 'the pane never came back' }, { fate: 'timed_out' }));
    expect(receipt).toEqual({
      kind: 'failed',
      name: 'Failed',
      detail: 'the pane never came back',
      chip: 'failed',
    });
    expect(sendReceipt(queued('failed', {}, { fate: 'timed_out' })).detail).toBe('it could not be delivered');
  });

  test('cancelled before it was typed says the agent never saw it', () => {
    const receipt = sendReceipt(queued('cancelled', {}, { fate: 'cancelled' }));
    expect(receipt).toMatchObject({ kind: 'cancelled', chip: 'cancelled' });
    expect(receipt.detail).toContain('the agent never saw it');
    expect(sendReceipt(queued('cancelled', {}, { fate: 'cancelled', cancelEffect: 'cleared' })).detail).toContain(
      'erased from the agent’s composer',
    );
  });

  test('a ledger that already says delivered outranks a queue that has not caught up', () => {
    for (const state of ['queued', 'typing', 'failed'] as const)
      expect(sendReceipt(queued(state, {}, { fate: 'delivered' })).kind).toBe('delivered');
  });

  test('a person’s own ledger cancel outranks a queue that is still typing', () => {
    for (const state of ['queued', 'typing', 'failed'] as const)
      expect(sendReceipt(queued(state, {}, { fate: 'cancelled' })).kind).toBe('cancelled');
  });

  test('the ledger being unreadable does not turn a queued message into "status unknown"', () => {
    const unread = { since: '2026-07-31T10:01:00.000Z', reason: 'offline' };
    expect(sendReceipt(queued('queued', { waitReason: 'busy' }, { unread })).kind).toBe('queued');
  });

  test('a row with no queue view keeps the ledger mapping', () => {
    expect(sendReceipt(record({ fate: 'queued' })).detail).toContain('its own queue');
  });
});

describe('a session that ended is never "not delivered"', () => {
  test('a ledger timeout with session_ended reads unconfirmed, quietly and without the red mark', () => {
    const ended = record({ fate: 'timed_out', unaccountedReason: 'session_ended', retryable: true });
    const receipt = sendReceipt(ended);
    expect(receipt).toMatchObject({ kind: 'unconfirmed', name: 'Unconfirmed', chip: 'unconfirmed' });
    expect(receipt.detail).toBe('unconfirmed — the session ended before it arrived; it may still have landed');
    expect(sendBadge(ended).tone).not.toContain('err');
  });

  test('every other timeout still reads not delivered', () => {
    const receipt = sendReceipt(record({ fate: 'timed_out', unaccountedReason: 'timeout' }));
    expect(receipt).toMatchObject({ kind: 'failed', name: 'Not delivered' });
  });
});

describe('a queue state the ledger fate has not caught up to', () => {
  test('falls back to the ledger’s own words instead of inventing a tick', () => {
    const row = record({ fate: 'accepted', queue: { state: 'cancelled', stateAt: STATE_AT, revision: 2 } });
    expect(sendBadge(row).label).toBe('sending');
  });
});
