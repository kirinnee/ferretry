import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, type PlacedPanel, WithSlotPanels } from '@ferretry/app/testing';
import type { ReactElement, ReactNode } from 'react';
import { RowBodySlot, RowSlotProvider } from '../../../../app/chat/row-slots.tsx';
import { Transcript } from '../../../../app/chat/transcript.tsx';
import { HandoffView } from '../../../../app/chat/handoff-message.tsx';
import type { LedgerSendRecord } from '../../../../app/chat/send-ledger.ts';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';
import { AttachmentGalleryProvider } from '../../../../app/composer/attachment-gallery.tsx';
import { CONVERSATION_ROW_BODY_SLOT, type ConversationRowBodyProps } from '../../../../contract/index.ts';

/**
 * `conversation.row-body`: a contributed card STANDS IN for a person's own words (it does not sit beside them), the
 * plain words are what it is handed as `fallback`, and a panel that cannot draw leaves the words as they were.
 */

type Seen = ConversationRowBodyProps & { readonly subject?: string };

/** A panel in the shape Agenda's is: a card for what it recognises, the plain words for everything else. */
const cardPanel = (seen: Seen[]): PlacedPanel => ({
  plugin: 'cards',
  id: 'card',
  view: props => {
    const row = props as unknown as Seen;
    seen.push(row);
    return row.entry.text.startsWith('[card]') ? (
      <section data-card={row.onItsWay === true ? 'on-its-way' : 'landed'}>{row.entry.text.slice(6)}</section>
    ) : (
      <>{row.fallback as ReactNode}</>
    );
  },
});

const throwing: PlacedPanel = {
  plugin: 'broken',
  id: 'throws',
  view: () => {
    throw new Error('this panel cannot draw');
  },
};

const SENT = '2026-10-21T09:00:00.000Z';
const record = (message: string): LedgerSendRecord => ({
  sendId: 'send-1',
  acceptedAt: SENT,
  message,
  attachmentIds: [],
  fate: 'accepted',
  path: 'direct',
});
const landed = (text: string): TranscriptEntry => ({ id: 'row-1', kind: 'user', text, at: Date.parse(SENT) });
const travelling = (message: string): TranscriptEntry => ({
  id: 'send:send-1',
  kind: 'ledger',
  text: message,
  ledger: record(message),
  placement: 'chronological',
});

let restoreObserver: () => void = () => undefined;
beforeEach(() => {
  const original = globalThis.IntersectionObserver;
  class Blind {
    observe(): void {}
    disconnect(): void {}
  }
  globalThis.IntersectionObserver = Blind as unknown as typeof IntersectionObserver;
  restoreObserver = () => {
    globalThis.IntersectionObserver = original;
  };
});
afterEach(() => restoreObserver());

const inChat = (panels: readonly PlacedPanel[], entries: readonly TranscriptEntry[]): ReactElement => (
  <WithSlotPanels slots={{ [CONVERSATION_ROW_BODY_SLOT]: panels }}>
    <RowSlotProvider daemon="alpha" ferret="shared">
      <AttachmentGalleryProvider load={async () => new Blob()}>
        <Transcript
          daemonId="alpha"
          entries={entries}
          onCancel={async () => true}
          onRetry={async () => true}
          onSubmit={async () => true}
          sessionId="shared"
        />
      </AttachmentGalleryProvider>
    </RowSlotProvider>
  </WithSlotPanels>
);

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});
const show = async (node: ReactElement): Promise<Mounted> => {
  const view = await mount(node);
  mounted.push(view);
  return view;
};

describe('the conversation.row-body slot', () => {
  it('a card takes the place of the words of a person’s own message, and nothing repeats them', async () => {
    const seen: Seen[] = [];
    const view = await show(inChat([cardPanel(seen)], [landed('[card]Answered A45')]));
    const bubble = view.container.querySelector('[data-transcript-kind="user"]');
    expect(bubble?.querySelector('[data-card="landed"]')?.textContent).toBe('Answered A45');
    // The plain words are not drawn beside it, and the slot adds no box of its own.
    expect(bubble?.textContent).not.toContain('[card]');
    expect(bubble?.querySelector('.fy-slot, .fy-panel')).toBeNull();
    // The panel saw the ferret, and only the row's id, kind and words.
    expect(seen[0]?.entry).toEqual({ id: 'row-1', kind: 'user', text: '[card]Answered A45' });
    expect(seen[0]?.onItsWay).toBeUndefined();
    expect(seen[0]?.subject).toBe('shared');
  });

  it('a message the panel does not recognise keeps its plain words', async () => {
    const view = await show(inChat([cardPanel([])], [landed('just a note')]));
    expect(view.container.querySelector('[data-transcript-kind="user"] p')?.textContent).toBe('just a note');
    expect(view.container.querySelector('[data-card]')).toBeNull();
  });

  it('a send still on its way is offered with what was typed, marked as on its way', async () => {
    const seen: Seen[] = [];
    const view = await show(inChat([cardPanel(seen)], [travelling('[card]Answered A45')]));
    expect(view.container.querySelector('[data-send-row="travelling"] [data-card="on-its-way"]')?.textContent).toBe(
      'Answered A45',
    );
    expect(seen[0]?.entry).toEqual({ id: 'send:send-1', kind: 'user', text: '[card]Answered A45' });
    expect(seen[0]?.onItsWay).toBe(true);
  });

  it('a panel that throws leaves the plain words, and the chat stays readable', async () => {
    const view = await show(inChat([throwing, cardPanel([])], [landed('still readable')]));
    expect(view.container.querySelector('[data-transcript-kind="user"] p')?.textContent).toBe('still readable');
    expect(view.container.textContent).not.toContain('stopped working');
  });

  it('with no panel contributed the plain words are drawn directly', async () => {
    const view = await show(inChat([], [landed('hello')]));
    expect(view.container.querySelector('[data-transcript-kind="user"] p')?.textContent).toBe('hello');
  });

  it('a handed-over message is offered as the one hand-overs are (named `handoff`); its own draft is on its way', async () => {
    const seen: Seen[] = [];
    const view = await show(
      <WithSlotPanels slots={{ [CONVERSATION_ROW_BODY_SLOT]: [cardPanel(seen)] }}>
        <RowSlotProvider daemon="alpha" ferret="shared">
          <HandoffView
            draft={{ message: '[card]Answered A45', files: [] }}
            pointerText=""
            reading={{ state: 'reading' }}
            source={null}
          />
        </RowSlotProvider>
      </WithSlotPanels>,
    );
    expect(view.container.querySelector('[data-card="on-its-way"]')?.textContent).toBe('Answered A45');
    expect(seen[0]?.entry.id).toBe('handoff');
    await interact(() => undefined);
  });

  it('outside a chat that said which ferret it draws, the plain words are all there is', async () => {
    const seen: Seen[] = [];
    const view = await show(
      <WithSlotPanels slots={{ [CONVERSATION_ROW_BODY_SLOT]: [cardPanel(seen)] }}>
        <RowBodySlot fallback={<p>plain</p>} id="x" text="[card]hi" />
      </WithSlotPanels>,
    );
    expect(view.container.innerHTML).toBe('<p>plain</p>');
    expect(seen).toHaveLength(0);
  });
});
