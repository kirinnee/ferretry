import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type SessionHandoff, turnFileInstruction } from '@ferretry/protocol';
import { AttachmentGalleryProvider } from '../../src/components/attachment-gallery.tsx';
import { type HandoffSource, HandoffSourceProvider, HandoffView } from '../../src/components/handoff-message.tsx';
import { OPEN_SEND_SETTLE_MS } from '../../src/components/ledger-message.tsx';
import { Transcript } from '../../src/components/transcript.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { placeLedgerRows } from '../../src/lib/ledger-placement.ts';
import { clockOfInstant } from '../../src/lib/message-clock.ts';
import type { LedgerSendRecord } from '../../src/lib/send-ledger.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

const daemon = daemonConnection({ daemonId: 'own-daemon', baseUrl: 'https://own.example.test', deviceId: 'd' });
const PATH = '/home/owner/.ferretry/state/sessions/s1/turns/turn-009.md';
const POINTER = turnFileInstruction(PATH);
const SENT = '2026-10-21T09:00:00.000Z';
const LONG = 'The **Continue** button is hidden';
const ATTACHED = `${LONG}\n\nAttached files — open them from these paths:\n- /s/attachments/att_1/onboarding.png (image/png)`;

const record = (overrides: Partial<LedgerSendRecord> = {}): LedgerSendRecord => ({
  sendId: 'send-1',
  acceptedAt: SENT,
  message: 'ship it',
  attachmentIds: [],
  fate: 'accepted',
  path: 'direct',
  ...overrides,
});
const travelling = (send: LedgerSendRecord): TranscriptEntry => ({
  id: `send:${send.sendId}`,
  kind: 'ledger',
  text: send.message,
  ledger: send,
  placement: 'chronological',
});
const landed = (send: LedgerSendRecord, overrides: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  id: `send:${send.sendId}`,
  kind: 'user',
  text: 'ship it',
  at: Date.parse(SENT) + 61_000,
  send,
  ...overrides,
});
const handoff = { kind: 'turn', name: 'turn-009', turn: 9, path: PATH } as const;

/** A source whose reads a test settles by hand. */
const source = () => {
  const pending: { resolve: (value: SessionHandoff) => void; reject: (error: Error) => void }[] = [];
  const value: HandoffSource = {
    daemon,
    sessionId: 's1',
    read: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  };
  return { value, pending };
};

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

const inSession = (handoffs: HandoffSource | null, entries: readonly TranscriptEntry[]) => {
  const transcript = (
    <Transcript
      daemonId="own-daemon"
      entries={entries}
      onCancel={async () => true}
      onRetry={async () => true}
      onSubmit={async () => true}
      sessionId="s1"
    />
  );
  return (
    <AttachmentGalleryProvider load={async () => new Blob()}>
      {handoffs === null ? transcript : <HandoffSourceProvider source={handoffs}>{transcript}</HandoffSourceProvider>}
    </AttachmentGalleryProvider>
  );
};

const bubbleOf = (view: Mounted): HTMLElement =>
  must(view.container.querySelector<HTMLElement>('[data-send-id="send-1"]'), 'the send’s bubble');

describe('the reader’s own send', () => {
  it('is ONE element from the moment it is sent until it is answered: only its mark moves', async () => {
    const view = await mount(inSession(null, [travelling(record())]));
    const bubble = bubbleOf(view);
    expect(bubble.tagName).toBe('ARTICLE');
    expect(bubble.dataset['sendRow']).toBe('travelling');
    expect(bubble.dataset['transcriptKind']).toBe('user');
    const words = must(bubble.querySelector('p'), 'its words');
    expect(words.textContent).toBe('ship it');
    expect(bubble.querySelector('time')?.textContent).toBe(clockOfInstant(SENT)?.short ?? '');

    await view.render(inSession(null, [landed(record())]));
    expect(bubbleOf(view)).toBe(bubble);
    expect(bubble.querySelector('p')).toBe(words);
    expect(bubble.dataset['sendRow']).toBe('landed');
    // Its time is when it was SENT, so it does not change as it lands a minute later.
    expect(bubble.querySelector('time')?.textContent).toBe(clockOfInstant(SENT)?.short ?? '');
    expect(bubble.querySelector('[data-ledger-more]')).toBeNull();

    await view.render(
      inSession(null, [landed(record({ fate: 'delivered' })), { id: 'r', kind: 'assistant', text: 'on it' }]),
    );
    expect(bubbleOf(view)).toBe(bubble);
    expect(bubble.querySelector('[data-send-receipt]')?.getAttribute('data-send-receipt')).toBe('answered');
    expect(view.container.querySelectorAll('[data-transcript-kind="user"]')).toHaveLength(1);
    await view.unmount();
  });

  it('keeps its way out hidden while it settles, and shows it once a send is slow', async () => {
    const view = await mount(
      inSession(null, [
        travelling(record({ acceptedAt: new Date(Date.now() - OPEN_SEND_SETTLE_MS + 60).toISOString() })),
      ]),
    );
    expect(view.container.querySelector('[data-ledger-more]')).toBeNull();
    await interact(() => new Promise(resolve => setTimeout(resolve, 120)));
    const more = must(view.container.querySelector<HTMLElement>('[data-ledger-more]'), 'the actions button');
    await interact(() => more.click());
    expect(
      [...view.container.querySelectorAll('[role="menuitem"]')].map(node => node.getAttribute('data-menu-key')),
    ).toEqual(['send-again', 'cancel', 'copy']);
    // The button sits inside the same bubble, on the status line.
    expect(bubbleOf(view).contains(more)).toBe(true);
    expect(more.closest('.fy-receipt-line')).not.toBeNull();
    await view.unmount();
  });

  it('offers Press Enter at once when the message sits typed in the agent’s composer', async () => {
    const view = await mount(
      inSession(null, [travelling(record({ acceptedAt: new Date().toISOString(), typedNotSent: true }))]),
    );
    const more = must(view.container.querySelector<HTMLElement>('[data-ledger-more]'), 'the actions button');
    await interact(() => more.click());
    expect(view.container.querySelector('[data-menu-key="enter"]')).not.toBeNull();
    await view.unmount();
  });

  it('reads the same through a turn file: its own copy while it travels and while the file is read', async () => {
    const handoffs = source();
    const send = record({ path: 'turn-file', turn: 9, message: ATTACHED, attachmentIds: ['att_1'] });
    const view = await mount(inSession(handoffs.value, [travelling(send)]));
    const bubble = bubbleOf(view);
    const draft = (): string =>
      must(bubble.querySelector('.fy-handoff-text strong'), 'the bold word').textContent ?? '';
    expect(draft()).toBe('Continue');
    expect(bubble.textContent).not.toContain('Attached files');
    expect(must(bubble.querySelector('.fy-handoff-chip'), 'the file').textContent).toBe('onboarding.png');
    expect(bubble.querySelector('.fy-handoff-via-button')).not.toBeNull();
    expect(handoffs.pending).toHaveLength(0);

    await view.render(inSession(handoffs.value, [landed(send, { text: POINTER, handoff })]));
    expect(bubbleOf(view)).toBe(bubble);
    // Reading the document, never "Opening the message…" and never a frame of the faded pointer.
    expect(must(bubble.querySelector<HTMLElement>('.fy-handoff'), 'the hand-off').dataset['handoffState']).toBe(
      'reading',
    );
    expect(bubble.textContent).not.toContain('Opening the message');
    expect(bubble.textContent).not.toContain('Read the file');
    expect(draft()).toBe('Continue');

    await interact(() =>
      handoffs.pending[0]?.resolve({
        name: 'turn-009',
        message: LONG,
        attachments: [{ filename: 'onboarding.png', mime: 'image/png' }],
      }),
    );
    expect(must(bubble.querySelector<HTMLElement>('.fy-handoff'), 'the hand-off').dataset['handoffState']).toBe('read');
    expect(draft()).toBe('Continue');
    await view.unmount();
  });

  it('shows the faded pointer, without the "via turn file" line, when the landed file cannot be read', async () => {
    const handoffs = source();
    const send = record({ path: 'turn-file', turn: 9, message: LONG, fate: 'delivered' });
    const view = await mount(inSession(handoffs.value, [landed(send, { text: POINTER, handoff })]));
    await interact(() => handoffs.pending[0]?.reject(new Error('gone')));
    expect(bubbleOf(view).querySelector('.fy-handoff-pointer')?.textContent).toBe(POINTER);
    expect(bubbleOf(view).querySelector('.fy-handoff-via-button')).toBeNull();
    await view.unmount();
  });

  it('opens a landed file of a send that did not say how it travelled the way it always did', async () => {
    const view = await mount(
      inSession(null, [landed(record({ path: undefined, turn: 9, fate: 'delivered' }), { text: POINTER, handoff })]),
    );
    expect(bubbleOf(view).querySelector('.fy-handoff-pointer')?.textContent).toBe(POINTER);
    await view.unmount();
  });

  it('says out loud when its bubble is only at the history boundary', async () => {
    const view = await mount(inSession(null, [{ ...travelling(record()), placement: 'after-loaded' }]));
    expect(must(view.container.querySelector('[data-ledger-boundary]'), 'the boundary').textContent).toContain(
      'newer than the loaded transcript',
    );
    await view.unmount();
  });
});

describe('a send that is not the reader’s own', () => {
  it('keeps its own bubble shape on the way, and its own row once it lands', async () => {
    const peer = record({ fromName: 'torrey', from: 'mv-1', message: 'the rail landed' });
    const view = await mount(inSession(null, [travelling(peer)]));
    expect(view.container.querySelector('.kt-bubble-row')).not.toBeNull();
    expect(view.container.querySelector('[data-send-row]')).toBeNull();
    await view.render(
      inSession(null, [
        landed(peer, {
          text: 'the rail landed',
          peer: { name: 'torrey', sessionId: 'mv-1', kind: 'message', replyExpected: false, note: '' },
        }),
      ]),
    );
    expect(view.container.querySelector('[data-peer="torrey"]')).not.toBeNull();
    await view.unmount();
  });

  it('a teammate’s landed hand-off is still read for whose it is', async () => {
    const view = await mount(
      <TranscriptRow entry={landed(record({ from: 'mv-1', turn: 9 }), { text: POINTER, handoff })} />,
    );
    expect(view.container.querySelector('[data-send-row]')).toBeNull();
    await view.unmount();
  });
});

describe('HandoffView', () => {
  it('names a file by its path when the path has no name in it, and draws no words it was not given', async () => {
    const view = await mount(
      <HandoffView
        draft={{ message: '  ', files: [{ path: '/', mime: 'text/plain' }] }}
        pointerText=""
        reading={{ state: 'reading' }}
        source={null}
      />,
    );
    expect(view.container.querySelector('.fy-handoff-text')).toBeNull();
    expect(view.container.querySelector('.fy-handoff-chip')?.textContent).toBe('/');
    expect(view.container.querySelector('.fy-handoff')?.hasAttribute('data-handoff')).toBe(false);
    await view.unmount();
  });
});

describe('the transcript the page draws', () => {
  it('never shows a message twice while it lands, and keeps the bubble where it was', async () => {
    const sent = record();
    const prior: TranscriptEntry[] = [{ id: 'a', kind: 'assistant', text: 'ready', at: Date.parse(SENT) - 60_000 }];
    const view = await mount(inSession(null, placeLedgerRows(prior, [sent], Date.parse(SENT) + 1_000)));
    const bubble = bubbleOf(view);
    const row: TranscriptEntry = { id: 'log:1', kind: 'user', text: 'ship it', at: Date.parse(SENT) + 1_000 };
    await view.render(inSession(null, placeLedgerRows([...prior, row], [sent], Date.parse(SENT) + 2_000)));
    expect(view.container.querySelectorAll('[data-transcript-kind="user"]')).toHaveLength(1);
    expect(bubbleOf(view)).toBe(bubble);
    await view.unmount();
  });
});
