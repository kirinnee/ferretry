import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type SessionHandoff, turnFileInstruction } from '@ferretry/protocol';
import { AttachmentGalleryProvider } from '../../src/components/attachment-gallery.tsx';
import {
  type HandoffSource,
  HandoffSourceProvider,
  TURN_FILE_EXPLANATION,
} from '../../src/components/handoff-message.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

const daemon = daemonConnection({
  daemonId: 'handoff-daemon',
  baseUrl: 'https://handoff.example.test',
  deviceId: 'handoff-device',
});

const POINTER = turnFileInstruction('/home/kirin/.ferretry/state/sessions/s1/turns/turn-008.md');

const entry = (overrides: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  id: 'u1',
  kind: 'user',
  text: POINTER,
  label: 'You',
  at: Date.UTC(2026, 9, 18, 2, 45, 0),
  handoff: {
    kind: 'turn',
    name: 'turn-008',
    turn: 8,
    path: '/home/kirin/.ferretry/state/sessions/s1/turns/turn-008.md',
  },
  ...overrides,
});

const HANDOFF: SessionHandoff = {
  name: 'turn-008',
  message: 'Is this **legit**?\n\nSee the screenshot.',
  attachments: [
    { attachmentId: 'att_1', filename: 'screen.png', mime: 'image/png' },
    { filename: 'elsewhere.pdf', mime: 'application/pdf' },
  ],
};

/** A source whose reads a test settles by hand, and counts. */
const source = (sessionId = 's1') => {
  const reads: string[] = [];
  const pending: { resolve: (value: SessionHandoff) => void; reject: (error: Error) => void }[] = [];
  const value: HandoffSource = {
    daemon,
    sessionId,
    read: name => {
      reads.push(name);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  return { value, reads, pending };
};

/** An observer that never intersects, so no attachment bytes are ever asked for. */
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

const inSession = (handoffs: HandoffSource, row: TranscriptEntry = entry()) => (
  <AttachmentGalleryProvider load={async () => new Blob()}>
    <HandoffSourceProvider source={handoffs}>
      <TranscriptRow answered entry={row} key={row.id} />
    </HandoffSourceProvider>
  </AttachmentGalleryProvider>
);

const handoffOf = (view: Mounted): HTMLElement =>
  must(view.container.querySelector<HTMLElement>('.fy-handoff'), 'the hand-off');

describe('a message handed to the agent through a file', () => {
  it('shows what the person sent — Markdown and attachments — never the pointer, with the ticks on it', async () => {
    const handoffs = source();
    const view = await mount(
      inSession(
        handoffs.value,
        entry({
          send: {
            sendId: 'send-8',
            acceptedAt: '2026-10-18T02:45:00.000Z',
            message: 'x',
            attachmentIds: [],
            fate: 'delivered',
            turn: 8,
          },
        }),
      ),
    );
    expect(handoffOf(view).dataset['handoffState']).toBe('reading');
    expect(view.container.textContent).toContain('Opening the message…');

    await interact(() => handoffs.pending[0]?.resolve(HANDOFF));

    const text = view.container.textContent ?? '';
    expect(handoffs.reads).toEqual(['turn-008']);
    expect(handoffOf(view).dataset['handoffState']).toBe('read');
    expect(text).not.toContain('Read the file');
    expect(must(view.container.querySelector('.fy-handoff-text strong'), 'the bold word').textContent).toBe('legit');
    expect(text).toContain('See the screenshot.');
    // The session's own attachment becomes a thumbnail; a file that is not its own stays a named chip.
    expect(view.container.querySelectorAll('.fy-handoff-files > div > *')).toHaveLength(1);
    expect(must(view.container.querySelector('.fy-handoff-chip'), 'the plain chip').textContent).toBe('elsewhere.pdf');
    // The receipt from the send ledger rides on the same bubble.
    expect(view.container.querySelector('[data-send-receipt="answered"]')).not.toBeNull();

    const via = must(view.container.querySelector<HTMLButtonElement>('.fy-handoff-via-button'), 'via turn file');
    expect(via.title).toBe(TURN_FILE_EXPLANATION);
    expect(via.textContent).toBe('via turn file');
    expect(view.container.querySelector('[data-handoff-note]')).toBeNull();
    await interact(() => via.click());
    expect(must(view.container.querySelector('[data-handoff-note="explained"]'), 'the note').textContent).toBe(
      TURN_FILE_EXPLANATION,
    );
    await interact(() => via.click());
    expect(view.container.querySelector('[data-handoff-note]')).toBeNull();
    await view.unmount();
  });

  it('shows only the files when the person sent no words', async () => {
    const handoffs = source();
    const view = await mount(inSession(handoffs.value));
    await interact(() =>
      handoffs.pending[0]?.resolve({
        name: 'turn-008',
        message: '  ',
        attachments: [{ filename: 'a.txt', mime: 'text/plain' }],
      }),
    );
    expect(view.container.querySelector('.fy-handoff-text')).toBeNull();
    expect(view.container.querySelector('.fy-handoff-files')).toBeNull();
    expect(view.container.textContent).toContain('a.txt');
    await view.unmount();
  });

  it('shows the pointer faded, explained, when the file cannot be read — and asks again next time', async () => {
    const handoffs = source();
    const view = await mount(inSession(handoffs.value));
    await interact(() => handoffs.pending[0]?.reject(new Error('no hand-off document turn-008')));

    expect(handoffOf(view).dataset['handoffState']).toBe('gone');
    expect(must(view.container.querySelector('.fy-handoff-pointer'), 'the faded pointer').textContent).toBe(POINTER);
    expect(must(view.container.querySelector('[data-handoff-note="gone"]'), 'the note').textContent).toContain(
      TURN_FILE_EXPLANATION,
    );
    expect(view.container.querySelector('.fy-handoff-via-button')).toBeNull();

    // A failed read is not kept: the same provider asks again for a row mounted later.
    await view.render(inSession(handoffs.value, entry({ id: 'u2' })));
    expect(handoffs.reads).toEqual(['turn-008', 'turn-008']);
    await view.unmount();
  });

  it('reads a document once per session, however many times its row mounts', async () => {
    const handoffs = source();
    const view = await mount(inSession(handoffs.value));
    await interact(() => handoffs.pending[0]?.resolve(HANDOFF));
    // A re-render with a NEW source object for the same session keeps the cache.
    await view.render(inSession({ ...handoffs.value }, entry({ id: 'u2' })));
    expect(handoffs.reads).toEqual(['turn-008']);
    expect(handoffOf(view).dataset['handoffState']).toBe('read');

    // Another session is another cache.
    const other = source('s2');
    await view.render(inSession(other.value));
    expect(other.reads).toEqual(['turn-008']);
    await view.unmount();
  });

  it('ignores an answer that arrives after the row has gone', async () => {
    const handoffs = source();
    const view = await mount(inSession(handoffs.value));
    await view.unmount();
    await interact(() => handoffs.pending[0]?.resolve(HANDOFF));
    const failed = source();
    const second = await mount(inSession(failed.value));
    await second.unmount();
    await interact(() => failed.pending[0]?.reject(new Error('late')));
    expect(failed.reads).toEqual(['turn-008']);
  });

  it('degrades to the faded pointer outside a session, where nothing can be read', async () => {
    const view = await mount(<TranscriptRow entry={entry()} />);
    expect(handoffOf(view).dataset['handoffState']).toBe('gone');
    expect(view.container.textContent).toContain(POINTER);
    await view.unmount();
  });
});
