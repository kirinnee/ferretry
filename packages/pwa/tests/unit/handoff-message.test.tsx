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

describe('a ferret’s message handed over through a file', () => {
  /** The owner's report: Tanna's turn file, as the older daemon wrote it. */
  const TANNA_TURN = [
    '[peer message from teammate tomi (session mveq0r0r-ddd75d7b) — not from the human lead]',
    'No reply is required; tomi has carried on. Reply with `fy send tomi "…"` if useful.',
    '',
    'Hello from home-manager-fd (the user asked me to say hi).',
  ].join('\n');
  const fromTomi: SessionHandoff = { name: 'turn-008', message: TANNA_TURN, attachments: [] };

  it('renders as a message FROM that ferret, body only, never as the reader’s own bubble', async () => {
    const handoffs = source();
    const view = await mount(inSession(handoffs.value));
    await interact(() => handoffs.pending[0]?.resolve(fromTomi));

    const row = must(view.container.querySelector<HTMLElement>('.fy-message-peer'), 'the peer row');
    expect(row.dataset['peer']).toBe('tomi');
    expect(view.container.querySelector('.fy-message-user')).toBeNull();
    const text = view.container.textContent ?? '';
    expect(text).toContain('Hello from home-manager-fd (the user asked me to say hi).');
    for (const boilerplate of ['peer message', 'human lead', 'mveq0r0r', 'fy send', 'via turn file'])
      expect(text).not.toContain(boilerplate);
    await view.unmount();
  });

  it('reads the current banner, its kind and the files under it', async () => {
    const handoffs = source();
    const view = await mount(inSession(handoffs.value));
    await interact(() =>
      handoffs.pending[0]?.resolve({
        name: 'turn-008',
        message:
          '[question from ferret tomi (session mveq0r0r-ddd75d7b) — not from the owner]\n' +
          'tomi is waiting for your answer. Reply with: fy send tomi "<reply>"\n\nIs CI green?',
        attachments: [{ filename: 'log.txt', mime: 'text/plain' }],
      }),
    );
    const row = must(view.container.querySelector<HTMLElement>('.fy-message-peer'), 'the peer row');
    expect(row.dataset['peerKind']).toBe('question');
    expect(row.textContent).toContain('Is CI green?');
    expect(row.textContent).toContain('log.txt');
    expect(row.textContent).not.toContain('Reply with');
    await view.unmount();
  });

  it('is a ferret’s message from the first frame when its delivered send names the sender', async () => {
    const handoffs = source();
    const send = {
      sendId: 'send-8',
      acceptedAt: '2026-10-18T02:45:00.000Z',
      message: 'x',
      attachmentIds: [],
      fate: 'delivered' as const,
      turn: 8,
      from: 'mveq0r0r-ddd75d7b',
      fromName: 'tomi',
      replyExpected: true as const,
    };
    const view = await mount(inSession(handoffs.value, entry({ send })));
    const pending = must(view.container.querySelector<HTMLElement>('.fy-message-peer'), 'the pending peer row');
    expect(pending.dataset['peerKind']).toBe('question');
    expect(pending.textContent).toContain('Opening the message…');
    expect(pending.textContent).not.toContain('via turn file');

    // A document that cannot be read still says whose message it was.
    await interact(() => handoffs.pending[0]?.reject(new Error('gone')));
    expect(
      must(view.container.querySelector<HTMLElement>('.fy-message-peer'), 'the gone peer row').dataset['peer'],
    ).toBe('tomi');
    expect(view.container.querySelector('[data-handoff-note="gone"]')).not.toBeNull();

    // A send with no name and no question still names its session.
    const { fromName: _name, replyExpected: _ask, ...bare } = send;
    const later = source();
    await view.render(inSession(later.value, entry({ id: 'u3', send: bare })));
    const plain = must(view.container.querySelector<HTMLElement>('.fy-message-peer'), 'the unnamed peer row');
    expect(plain.dataset['peer']).toBe('mveq0r0r-ddd75d7b');
    expect(plain.dataset['peerKind']).toBe('message');
    await view.unmount();
  });
});

describe('the delivery note shares the foot’s one line', () => {
  it('puts "via turn file" on the same row as the time, with its explanation under the row', async () => {
    const handoffs = source();
    const view = await mount(inSession(handoffs.value));
    await interact(() => handoffs.pending[0]?.resolve(HANDOFF));

    const line = must(view.container.querySelector<HTMLElement>('[data-message-footer]'), 'the foot');
    const via = must(line.querySelector<HTMLButtonElement>('.fy-handoff-via-button'), 'via turn file');
    expect(line.querySelector('time')).not.toBeNull();
    expect(view.container.querySelectorAll('[data-message-footer]')).toHaveLength(1);
    expect(line.firstElementChild).toBe(via);
    expect(via.getAttribute('aria-expanded')).toBe('false');

    await interact(() => via.click());
    expect(via.getAttribute('aria-expanded')).toBe('true');
    expect(line.nextElementSibling?.getAttribute('data-handoff-note')).toBe('explained');
    await view.unmount();
  });
});

describe('a Ferretry notice handed over through a file', () => {
  const NOTICE: SessionHandoff = {
    name: 'turn-008',
    message:
      '[ferretry] Restarted mid-turn — 1 command was interrupted.\n\n' +
      'This notice is from Ferretry, not from the owner. Before re-running anything, read /state/migration-inflight.md.',
    attachments: [],
  };

  it('is a system row with its headline, never the owner’s bubble, and the agent text behind details', async () => {
    const handoffs = source();
    const view = await mount(inSession(handoffs.value));
    await interact(() => handoffs.pending[0]?.resolve(NOTICE));

    const row = must(view.container.querySelector<HTMLElement>('[data-system-notice]'), 'the notice row');
    expect(view.container.querySelector('.fy-message-user')).toBeNull();
    expect(row.textContent).toContain('Restarted mid-turn — 1 command was interrupted.');
    expect(row.textContent).not.toContain('not from the owner');
    expect(row.querySelector('[data-system-detail]')).toBeNull();

    const details = must(row.querySelector<HTMLButtonElement>('.fy-system-details'), 'details');
    await interact(() => details.click());
    expect(must(row.querySelector('[data-system-detail]'), 'the detail').textContent).toContain('not from the owner');
    await interact(() => details.click());
    expect(row.querySelector('[data-system-detail]')).toBeNull();
    await view.unmount();
  });

  it('has no details control when the notice is only its headline', async () => {
    const handoffs = source();
    const view = await mount(inSession(handoffs.value));
    await interact(() =>
      handoffs.pending[0]?.resolve({ ...NOTICE, message: '[ferretry] Your message did not arrive.' }),
    );
    const row = must(view.container.querySelector<HTMLElement>('[data-system-notice]'), 'the notice row');
    expect(row.textContent).toContain('Your message did not arrive.');
    expect(row.querySelector('.fy-system-details')).toBeNull();
    await view.unmount();
  });

  it('shows a board nudge that travelled as a file as the Board row, before and after it is read', async () => {
    const handoffs = source();
    const nudge = entry({
      text: '&F209 PR #1087 CI is red.',
      send: {
        sendId: 'send-9',
        senderKind: 'daemon',
        acceptedAt: '2026-10-18T02:45:00.000Z',
        message: 'x',
        attachmentIds: [],
        fate: 'delivered',
        by: { kind: 'ferretry', feature: 'Board' },
      },
    });
    const view = await mount(inSession(handoffs.value, nudge));
    const waiting = must(view.container.querySelector<HTMLElement>('[data-board-nudge]'), 'the Board row');
    expect(waiting.textContent).toContain('Board');
    expect(waiting.textContent).toContain('CI is red.');
    expect(view.container.querySelector('.fy-handoff')).toBeNull();

    await interact(() =>
      handoffs.pending[0]?.resolve({ name: 'turn-008', message: '&F412 has had no activity for 3h.', attachments: [] }),
    );
    const read = must(view.container.querySelector<HTMLElement>('[data-board-nudge]'), 'the Board row once read');
    expect(read.textContent).toContain('has had no activity for 3h.');
    await view.unmount();
  });

  it('shows a Warden nudge that travelled as a file as the Ferretry row once it is read', async () => {
    const handoffs = source();
    const nudge = entry({
      text: 'x',
      send: {
        sendId: 'send-10',
        senderKind: 'daemon',
        acceptedAt: '2026-10-18T02:45:00.000Z',
        message: 'x',
        attachmentIds: [],
        fate: 'delivered',
        by: { kind: 'ferretry', feature: 'Warden' },
      },
    });
    const view = await mount(inSession(handoffs.value, nudge));
    await interact(() =>
      handoffs.pending[0]?.resolve({
        name: 'turn-008',
        message: 'You went quiet.\n\nSay what you are on.',
        attachments: [],
      }),
    );
    const row = must(view.container.querySelector<HTMLElement>('[data-ferretry-message="Warden"]'), 'the Warden row');
    expect(row.textContent).toContain('You went quiet.');
    expect(view.container.querySelector('.fy-message-user')).toBeNull();
    await view.unmount();
  });
});
