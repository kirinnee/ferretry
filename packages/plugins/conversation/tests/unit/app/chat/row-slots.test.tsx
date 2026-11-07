import { afterEach, describe, expect, test } from 'bun:test';
import { PanelSlot } from '@ferretry/app';
import { ensureDom, render, run } from '@ferretry/app/testing';
import { RowSlot, RowSlotProvider, rowSlotEntry } from '../../../../app/chat/row-slots.tsx';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';
import { CONVERSATION_ROW_ACTIONS_SLOT, CONVERSATION_ROW_SLOT } from '../../../../contract/index.ts';

ensureDom();

/**
 * THE SLOTS' PRIVACY RULE: a plugin that contributes to a Conversation slot sees ONLY the promised row fields, built from
 * what the daemon read (and masked), and never a row that exists only on this device.
 */

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  for (const page of mounted.splice(0)) run(() => page.unmount());
});

const SECRET = 'sk-live-pasted-secret';

/** A send the machine refused: it stays in this device's outbox, so its text is what was typed, unmasked. */
const refusedSend = {
  id: 'send:refused-1',
  kind: 'ledger',
  text: `here is my key ${SECRET}`,
  at: 100,
  label: 'You',
  ledger: {
    sendId: 'refused-1',
    acceptedAt: '2026-11-04T11:00:00.000Z',
    message: `here is my key ${SECRET}`,
    attachmentIds: [],
    fate: 'refused',
    outbox: { phase: 'refused' },
  },
  placement: 'chronological',
} as unknown as TranscriptEntry;

/** A row with fields beyond the promised ones, as a delivered user row of the daemon's log is. */
const delivered = {
  id: 'row-1',
  kind: 'user',
  text: 'a daemon-read message',
  at: 200,
  label: 'You',
  send: { sendId: 'delivered-1', message: SECRET, attachmentIds: [] },
  peer: { name: 'another-ferret' },
  tools: [],
} as unknown as TranscriptEntry;

const draw = (entry: TranscriptEntry, slot: 'conversation.row' | 'conversation.row-actions') => {
  const page = render(
    <RowSlotProvider daemon="alpha" ferret="shared">
      <RowSlot entry={entry} slot={slot} />
    </RowSlotProvider>,
  );
  mounted.push(page);
  return page;
};

describe('the transcript row slots', () => {
  test('a refused send in the device outbox reaches no conversation.row panel', () => {
    expect(draw(refusedSend, CONVERSATION_ROW_SLOT).root.findAllByType(PanelSlot)).toHaveLength(0);
  });

  test('a refused send in the device outbox reaches no conversation.row-actions panel', () => {
    expect(draw(refusedSend, CONVERSATION_ROW_ACTIONS_SLOT).root.findAllByType(PanelSlot)).toHaveLength(0);
  });

  test.each([
    ['conversation.row', CONVERSATION_ROW_SLOT],
    ['conversation.row-actions', CONVERSATION_ROW_ACTIONS_SLOT],
  ] as const)('%s props carry only the promised fields, and the ferret as the subject', (_name, slot) => {
    const [offered] = draw(delivered, slot).root.findAllByType(PanelSlot);
    expect(offered?.props.slot).toBe(slot);
    expect(offered?.props.subject).toBe('shared');
    expect(offered?.props.props).toEqual({
      entry: { id: 'row-1', kind: 'user', text: 'a daemon-read message', at: 200, label: 'You' },
    });
    expect(JSON.stringify(offered?.props.props)).not.toContain(SECRET);
  });

  test('a row with no time or label offers neither key', () => {
    expect(rowSlotEntry({ id: 'a', kind: 'assistant', text: 'hi' })).toEqual({
      id: 'a',
      kind: 'assistant',
      text: 'hi',
    });
  });

  test('every row that came from the daemon is offered, and only a device-local ledger row is not', () => {
    for (const kind of ['user', 'assistant', 'tool', 'command', 'notice', 'system'] as const) {
      expect(rowSlotEntry({ id: kind, kind, text: 't' })?.kind).toBe(kind);
    }
    expect(rowSlotEntry(refusedSend)).toBeNull();
  });

  test('outside a chat that said which ferret it draws, the slots draw nothing', () => {
    const page = render(<RowSlot entry={delivered} slot={CONVERSATION_ROW_SLOT} />);
    mounted.push(page);
    expect(page.root.findAllByType(PanelSlot)).toHaveLength(0);
  });
});
