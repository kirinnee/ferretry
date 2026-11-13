import { describe, expect, test } from 'bun:test';
import { combinedDelivery } from '../../../../contract/index.ts';
import type { ReactTestInstance } from 'react-test-renderer';
import { SystemNoticeRow } from '../../../../app/transcript/agent-message-rows.tsx';
import { LedgerMessage } from '../../../../app/chat/ledger-message.tsx';
import { chipFromSender, ferretryChip, stripFraming } from '../../../../app/chat/message-framing.ts';
import type { LedgerSendRecord } from '../../../../app/chat/send-ledger.ts';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';
import { render } from '@ferretry/app/testing';

const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : textOf(child))).join('');

const noop = async (): Promise<boolean> => true;
const handlers = { onCancel: noop, onRetry: noop, onSubmit: noop, write: async () => {} };

const record = (message: string, extra: Partial<LedgerSendRecord> = {}): LedgerSendRecord => ({
  sendId: 's-1',
  acceptedAt: '2026-07-31T10:00:00.000Z',
  message,
  attachmentIds: [],
  fate: 'delivered',
  ...extra,
});

const bubble = (message: string, extra: Partial<LedgerSendRecord> = {}) => {
  const r = render(<LedgerMessage {...handlers} record={record(message, extra)} />);
  const chip = r.root.findAll(node => node.props['data-sender-chip'] !== undefined && typeof node.type === 'string');
  return { text: textOf(r.root), chip: chip[0] === undefined ? undefined : textOf(chip[0]) };
};

const FOOTER = 'No reply needed. To reply: fy send sada "<reply>"';
const PEER = `[message from ferret sada (session mvuzx42l-a9f7db82) — not from the owner]\n${FOOTER}\n\nthe build is green`;

const ONE_LINE = '— not from the owner] To reply: fy send sada "<reply>"';
const ONE_LINE_PEER = `[message from ferret sada (session mvuzx42l-a9f7db82) ${ONE_LINE}\nthe build is green`;
const LABELLED_PEER = `[message · fyi from ferret sada (session mvuzx42l-a9f7db82) ${ONE_LINE}\nthe build is green`;

const shapes: readonly (readonly [string, string, string | undefined, string])[] = [
  ['board', '[ferretry] [board] Task F12 moved to review', 'Ferretry · Board', 'Task F12 moved to review'],
  ['warden', '[ferretry] [warden] Blocked a push', 'Ferretry · Warden', 'Blocked a push'],
  ['agenda reply', '[re !A12 — Ship it?] yes, ship', 'Agenda', 'yes, ship'],
  ['peer', PEER, 'Sada', 'the build is green'],
  ['one-line peer', ONE_LINE_PEER, 'Sada', 'the build is green'],
  ['labelled peer', LABELLED_PEER, 'Sada', 'the build is green'],
];

describe('no bubble shows framing', () => {
  for (const [name, raw, chip, body] of shapes) {
    test(`${name}: body only, sender as a chip`, () => {
      const shown = bubble(raw);
      expect(shown.text).toContain(body);
      expect(shown.text).not.toMatch(/\[(ferretry|board|warden|agenda|re |message from)/iu);
      expect(shown.text).not.toContain('No reply needed');
      if (name !== 'agenda reply')
        expect(shown.chip?.toLowerCase()).toContain((chip ?? '').toLowerCase().split(' ').pop());
    });
  }

  test('a Ferretry notice row draws the chip and not the tags', () => {
    const entry = {
      kind: 'user',
      text: '[ferretry] [board] Moved to review',
      at: '2026-07-31T10:00:00.000Z',
    } as unknown as TranscriptEntry;
    const r = render(<SystemNoticeRow entry={entry} rhythm={{} as never} />);
    expect(textOf(r.root)).toContain('Ferretry · Board');
    expect(textOf(r.root)).not.toContain('[');
  });

  test('the owner’s own words get no chip', () => {
    expect(bubble('hello there').chip).toBeUndefined();
  });
});

describe("a delivery of several ferrets' messages", () => {
  const combined = combinedDelivery(
    [
      { sender: { name: 'sada', sessionId: 's-sada', kind: 'message', label: 'action' }, body: 'the build is green' },
      { sender: { name: 'rhett', sessionId: 's-rhett', kind: 'message', label: 'fyi' }, body: 'also, lint is clean' },
    ],
    'fy',
  );

  test("is never framed as the owner's own words: the first sender is the chip and no banner shows", () => {
    const shown = bubble(combined);
    expect(shown.chip?.toLowerCase()).toContain('sada');
    expect(shown.text).toContain('the build is green');
    expect(shown.text).not.toMatch(/\[(\d+\/\d+|\d+ messages)/u);
    expect(shown.text).not.toContain('not from the owner');
  });
});

describe('stripFraming', () => {
  test('strips stacked tags and a trailing footer', () => {
    expect(stripFraming(`[ferretry] [board] hi\n\n${FOOTER}`)).toEqual({
      body: 'hi',
      feature: 'Board',
      ferretry: true,
    });
  });
  test('answer-to and agenda tags name the agenda', () => {
    expect(stripFraming('[answer to !A3 x] ok').feature).toBe('Agenda');
    expect(stripFraming('[agenda] ok')).toEqual({ body: 'ok', feature: 'Agenda', ferretry: false });
  });
  test('plain text is untouched', () => {
    expect(stripFraming('[not a tag] x')).toEqual({ body: '[not a tag] x', ferretry: false });
  });
  test('chip text', () => {
    expect(ferretryChip({ body: '', ferretry: true })).toBe('Ferretry');
    expect(ferretryChip({ body: '', ferretry: true, feature: 'Board' })).toBe('Ferretry · Board');
  });
});

describe('chipFromSender', () => {
  const name = (n: string): string => n.toUpperCase();
  test('the daemon’s word on the sender', () => {
    expect(chipFromSender(undefined, name)).toBeUndefined();
    expect(chipFromSender({ kind: 'owner' }, name)).toBeUndefined();
    expect(chipFromSender({ kind: 'ferret' }, name)).toBeUndefined();
    expect(chipFromSender({ kind: 'ferret', name: 'sada' }, name)).toBe('SADA');
    expect(chipFromSender({ kind: 'ferretry', feature: 'Board' }, name)).toBe('Ferretry · Board');
    expect(chipFromSender({ kind: 'ferretry' }, name)).toBe('Ferretry');
  });
  test('a queued row wears the queue’s sender over the text', () => {
    const shown = bubble('plain words', {
      queue: {
        state: 'queued',
        stateAt: '2026-07-31T10:00:00.000Z',
        revision: 1,
        by: { kind: 'ferretry', feature: 'Board' },
      },
    });
    expect(shown.chip).toBe('Ferretry · Board');
  });
});
