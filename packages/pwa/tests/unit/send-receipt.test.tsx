import { describe, expect, test } from 'bun:test';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { MessageFooter } from '../../src/components/send-receipt.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import type { LedgerSendRecord } from '../../src/lib/send-ledger.ts';
import { clockOfInstant, clockOfLabel, type SendReceiptKind, sendReceipt } from '../../src/lib/send-receipt.ts';
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
      ['delivered', record({ fate: 'delivered' }), false, 'delivered', 'Delivered', undefined],
      ['delivered, then answered', record({ fate: 'delivered' }), true, 'read', 'Read', undefined],
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

  test('a reply after a send is not evidence about an unsettled one — only a delivered send reads as read', () => {
    expect(sendReceipt(record({ fate: 'queued' }), true).kind).toBe('queued');
    expect(sendReceipt(record({ fate: 'unaccounted' }), true).kind).toBe('unconfirmed');
    expect(sendReceipt(record({ fate: 'delivered' }), true).detail).toContain('the agent has replied since');
  });
});

describe('message clocks', () => {
  test('reads an instant as local HH:MM, with the seconds kept for the tooltip', () => {
    const at = new Date(2026, 6, 31, 9, 8, 7);
    expect(clockOfInstant(at.getTime())).toEqual({ short: '09:08', full: '09:08:07' });
    expect(clockOfInstant(at.toISOString())).toEqual({ short: '09:08', full: '09:08:07' });
    expect(clockOfInstant(undefined)).toBeUndefined();
    expect(clockOfInstant('not a date')).toBeUndefined();
  });

  test('lifts the daemon-printed clock off a transcript label', () => {
    expect(clockOfLabel('You · 13:58:44')).toEqual({ short: '13:58', full: '13:58:44' });
    expect(clockOfLabel('You')).toBeUndefined();
    expect(clockOfLabel(undefined)).toBeUndefined();
  });
});

describe('MessageFooter', () => {
  test('draws nothing with neither a time nor a send', () => {
    expect(render(<MessageFooter />).toJSON()).toBeNull();
  });

  test('draws a bare faded time when the message has no ledger send', () => {
    const footer = render(<MessageFooter clock={{ short: '13:58', full: '13:58:44' }} />);
    const time = footer.root.findByType('time');
    expect(time.props.title).toBe('13:58:44');
    expect(textOf(footer)).toBe('13:58');
    expect(footer.root.findAllByType('button')).toHaveLength(0);
  });

  test('is one tappable receipt — the time and the mark — that reads out the time to the second and why', async () => {
    const footer = render(
      <MessageFooter answered clock={{ short: '14:02', full: '14:02:55' }} record={record({ fate: 'delivered' })} />,
    );
    const receipt = receiptButton(footer);
    expect(receipt.props['data-send-receipt']).toBe('read');
    expect(receipt.props['aria-label']).toBe('Read, sent 14:02:55');
    expect(receipt.props.title).toContain('Read\n');
    expect(receipt.props.title).toContain('sent 14:02:55');
    expect(receipt.props['aria-expanded']).toBe(false);
    expect(footer.root.findAllByProps({ 'data-send-chip': 'read' })).toHaveLength(0);

    await runAsync(async () => receipt.props.onClick());

    expect(receiptButton(footer).props['aria-expanded']).toBe(true);
    expect(footer.root.findByProps({ 'data-send-reason': '' }).children.join('')).toContain('Read · sent 14:02:55 — ');
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

describe('the reader’s own row', () => {
  test('has no "You" header, and wears its time and receipt at its foot', () => {
    const row = render(
      <TranscriptRow
        answered
        entry={{ id: 'u', kind: 'user', text: 'ship it', label: 'You · 13:58:44', send: record({ fate: 'delivered' }) }}
      />,
    );
    expect(row.root.findAllByType('header')).toHaveLength(0);
    expect(receiptButton(row).props['data-send-receipt']).toBe('read');
    expect(receiptButton(row).props['aria-label']).toBe('Read, sent 13:58:44');
  });

  test('prefers the row’s own instant over the label’s printed clock', () => {
    const at = new Date(2026, 6, 31, 9, 8, 7).getTime();
    const row = render(
      <TranscriptRow entry={{ at, id: 'u', kind: 'user', text: 'ship it', label: 'You · 13:58:44' }} />,
    );
    expect(row.root.findByType('time').props.title).toBe('09:08:07');
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
