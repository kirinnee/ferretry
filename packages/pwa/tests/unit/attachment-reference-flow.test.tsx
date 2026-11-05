import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { SessionHandoff } from '@ferretry/protocol';
import type { ReactElement } from 'react';
import {
  AttachmentGalleryProvider,
  REFERENCE_DISABLED_COPY,
  REFERENCE_SENDING_COPY,
  TranscriptAttachmentGallery,
} from '../../src/components/attachment-gallery.tsx';
import { AttachmentReferences } from '../../src/components/attachment-reference-surface.tsx';
import { AttachmentReferenceTarget } from '../../src/components/attachment-reference-target.tsx';
import { Composer } from '../../src/components/composer.tsx';
import { HandoffBody, type HandoffSource, HandoffSourceProvider } from '../../src/components/handoff-message.tsx';
import { Markdown } from '../../src/components/markdown.tsx';
import type { StoredTranscriptAttachment, TranscriptImage } from '../../src/lib/attachments.ts';
import { referenceAttachmentInComposer } from '../../src/lib/composer-references.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { type ComposerQuoteTarget, composerQuoteTarget, registerComposerQuoteTarget } from '../../src/lib/quote.ts';
import { interact, mount, must } from '../support/dom.ts';

// The Plain textarea: the live editors have their own suites.
beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

const daemon = daemonConnection({
  daemonId: 'ref-daemon',
  baseUrl: 'https://ref.example.test',
  deviceId: 'ref-device',
});
const scope = daemonSessionScope(daemon, 'ref-session');

const stored = (overrides: Partial<StoredTranscriptAttachment> = {}): StoredTranscriptAttachment => ({
  kind: 'attachment',
  sessionId: 'ref-session',
  attachmentId: 'att_1',
  filename: 'shot.png',
  mime: 'image/png',
  size: 2_048,
  ...overrides,
});

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

const memoryStorage = (): DraftStorage => {
  const entries = new Map<string, string>();
  return {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
};

const plusOf = (container: HTMLElement): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('button[data-attachment-add]');

/** A stand-in composer that records what the + asks of it. */
const fakeComposer = (overrides: Partial<ComposerQuoteTarget> = {}) => {
  const calls: string[] = [];
  const dispose = registerComposerQuoteTarget({
    ...scope,
    draft: () => '',
    replaceDraft: () => undefined,
    insertAtCaret: text => {
      calls.push(`insert ${text}`);
    },
    attachExisting: file => {
      calls.push(`attach ${file.id}`);
      return 'added';
    },
    ...overrides,
  });
  return { calls, dispose };
};

describe('the + on an attachment tile', () => {
  it('writes the token and attaches the file by its id when tapped', async () => {
    const composer = fakeComposer();
    const view = await mount(
      <AttachmentReferenceTarget scope={scope}>
        <TranscriptAttachmentGallery daemon={daemon} images={[stored()]} />
      </AttachmentReferenceTarget>,
    );
    const plus = must(plusOf(view.container), 'the + button');
    expect(plus.getAttribute('aria-label')).toBe('Reference shot.png in your message');
    expect(plus.disabled).toBe(false);

    await interact(() => plus.click());

    expect(composer.calls).toEqual(['attach att_1', 'insert %attachment:shot.png']);
    expect(view.container.querySelector('[role="status"].sr-only')?.textContent).toBe('Added shot.png to your message');
    await interact(() => composer.dispose());
    await view.unmount();
  });

  it('says the file could not be attached again when the message box refuses the chip, yet still wrote the token', async () => {
    const composer = fakeComposer({
      attachExisting: file => {
        composer.calls.push(`attach ${file.id}`);
        return 'refused';
      },
    });
    const view = await mount(
      <AttachmentReferenceTarget scope={scope}>
        <TranscriptAttachmentGallery daemon={daemon} images={[stored()]} />
      </AttachmentReferenceTarget>,
    );

    await interact(() => must(plusOf(view.container), 'the + button').click());

    expect(composer.calls).toEqual(['attach att_1', 'insert %attachment:shot.png']);
    expect(view.container.querySelector('[role="status"].sr-only')?.textContent).toBe(
      'Referenced shot.png; it could not be attached again',
    );
    await interact(() => composer.dispose());
    await view.unmount();
  });

  it('says the file is already attached when the chip was there, and says it again on a second identical tap', async () => {
    const composer = fakeComposer({ attachExisting: () => 'present' });
    const view = await mount(
      <AttachmentReferenceTarget scope={scope}>
        <TranscriptAttachmentGallery daemon={daemon} images={[stored()]} />
      </AttachmentReferenceTarget>,
    );
    const status = must(view.container.querySelector('[role="status"].sr-only'), 'the live text');
    // The live text must pass through empty between two taps, or a screen reader hears nothing the second time.
    const heard: string[] = [];
    // What each change wrote: the text node it added, or nothing when it emptied the region.
    const watch = new MutationObserver(records => {
      for (const record of records) heard.push([...record.addedNodes].map(node => node.textContent).join(''));
    });
    watch.observe(status, { childList: true, characterData: true, subtree: true });

    await interact(() => must(plusOf(view.container), 'the + button').click());
    await interact(() => must(plusOf(view.container), 'the + button').click());
    const said = 'shot.png is already attached to your message';

    expect(status.textContent).toBe(said);
    expect(heard.filter(text => text === said)).toHaveLength(2);
    expect(heard.filter(text => text === '').length).toBeGreaterThanOrEqual(1);
    watch.disconnect();
    await interact(() => composer.dispose());
    await view.unmount();
  });

  it('does not claim the file was added when the message box cannot attach files at all', async () => {
    const composer = fakeComposer({ attachExisting: undefined as unknown as ComposerQuoteTarget['attachExisting'] });
    const view = await mount(
      <AttachmentReferenceTarget scope={scope}>
        <TranscriptAttachmentGallery daemon={daemon} images={[stored()]} />
      </AttachmentReferenceTarget>,
    );

    await interact(() => must(plusOf(view.container), 'the + button').click());

    expect(composer.calls).toEqual(['insert %attachment:shot.png']);
    expect(view.container.querySelector('[role="status"].sr-only')?.textContent).toBe(
      'Referenced shot.png; it could not be attached again',
    );
    await interact(() => composer.dispose());
    await view.unmount();
  });

  it('is disabled, with the reason, while no message box is open — and wakes when one mounts', async () => {
    const view = await mount(
      <AttachmentReferenceTarget scope={scope}>
        <TranscriptAttachmentGallery daemon={daemon} images={[stored()]} />
      </AttachmentReferenceTarget>,
    );
    const plus = must(plusOf(view.container), 'the + button');
    expect(plus.disabled).toBe(true);
    expect(plus.title).toBe("Open this session's message box to reference this file");

    let dispose = (): void => undefined;
    await interact(() => {
      dispose = fakeComposer().dispose;
    });
    expect(must(plusOf(view.container), 'the + button').disabled).toBe(false);
    await interact(() => dispose());
    await view.unmount();
  });

  it('is absent outside a composer scope, and for pictures that have no stored id', async () => {
    const inline: TranscriptImage = { kind: 'inline', src: 'data:image/png;base64,AA', alt: 'chart' };
    const record: TranscriptImage = { kind: 'transcript', sessionId: 'ref-session', handle: '1.2.3', alt: 'tool shot' };
    const bare = await mount(<TranscriptAttachmentGallery daemon={daemon} images={[stored()]} />);
    expect(plusOf(bare.container)).toBeNull();
    await bare.unmount();

    const view = await mount(
      <AttachmentReferenceTarget scope={scope}>
        <TranscriptAttachmentGallery daemon={daemon} images={[inline, record, stored({ filename: 'my shot.png' })]} />
      </AttachmentReferenceTarget>,
    );
    // A name the grammar cannot write has no token to insert, so it has no + either.
    expect(plusOf(view.container)).toBeNull();
    expect(view.container.querySelectorAll('[data-attachment-id]')).toHaveLength(1);
    await view.unmount();
  });

  it('is on a document card as well, and carries the id a reference scrolls to', async () => {
    const composer = fakeComposer();
    const view = await mount(
      <AttachmentReferenceTarget scope={scope}>
        <TranscriptAttachmentGallery
          daemon={daemon}
          images={[stored({ attachmentId: 'att_pdf', filename: 'spec.pdf', mime: 'application/pdf' })]}
        />
      </AttachmentReferenceTarget>,
    );
    expect(view.container.querySelector('[data-attachment-id="att_pdf"].fy-attachment-tile--card')).not.toBeNull();
    await interact(() => must(plusOf(view.container), 'the + button').click());
    expect(composer.calls).toEqual(['attach att_pdf', 'insert %attachment:spec.pdf']);
    await interact(() => composer.dispose());
    await view.unmount();
  });
});

describe('the + against a real composer', () => {
  const api = { send: async () => ({}) as never };
  const mountComposer = (sessionId = 'ref-session') =>
    mount(
      <Composer api={api} daemon={daemon} draftStore={new DaemonDraftStore(memoryStorage())} sessionId={sessionId} />,
    );
  const file = { id: 'att_1', filename: 'shot.png', mime: 'image/png', size: 2_048 };
  const textarea = (container: HTMLElement): HTMLTextAreaElement =>
    must(container.querySelector('textarea'), 'the textarea');

  it('attaches the file once and writes the token at the caret, in the middle of a sentence', async () => {
    const composer = await mountComposer();
    const input = textarea(composer.container);
    await interact(() => composerQuoteTarget(scope)?.replaceDraft('look at the now'));
    input.setSelectionRange(11, 11);

    await interact(() => referenceAttachmentInComposer(file, scope));

    expect(input.value).toBe('look at the %attachment:shot.png now');
    expect(document.activeElement).toBe(input);
    // A space already followed the caret, so the caret sits right after the token rather than after a second one.
    expect(input.selectionStart).toBe('look at the %attachment:shot.png'.length);
    expect(composer.container.querySelectorAll('span[title="shot.png"]')).toHaveLength(1);
    // The tile knew the size (2 KB) and the chip says so; a file with no known size would state none, never "0 B".
    expect(composer.container.textContent).toContain('2.0 KB');
    await composer.unmount();
  });

  it('shows no size at all for a stored file whose size the tile did not know', async () => {
    const composer = await mountComposer();
    await interact(() =>
      referenceAttachmentInComposer({ id: 'att_9', filename: 'x.pdf', mime: 'application/pdf' }, scope),
    );
    expect(composer.container.querySelectorAll('span[title="x.pdf"]')).toHaveLength(1);
    expect(composer.container.textContent).not.toContain('0 B');
    await composer.unmount();
  });

  it('adds the chip only once when the same file is referenced twice, and writes the token each time', async () => {
    const composer = await mountComposer();
    const outcomes: string[] = [];

    await interact(() => {
      const first = referenceAttachmentInComposer(file, scope);
      outcomes.push(first.state === 'referenced' ? first.chip : first.state);
    });
    await interact(() => {
      const second = referenceAttachmentInComposer(file, scope);
      outcomes.push(second.state === 'referenced' ? second.chip : second.state);
    });

    expect(outcomes).toEqual(['added', 'present']);
    expect(textarea(composer.container).value).toBe('%attachment:shot.png %attachment:shot.png ');
    expect(composer.container.querySelectorAll('span[title="shot.png"]')).toHaveLength(1);
    await composer.unmount();
  });

  describe('while the composer is mounted but not writable', () => {
    const pending = (): { readonly send: () => Promise<never>; readonly finish: () => void } => {
      let finish: () => void = () => undefined;
      const gate = new Promise<void>(resolve => {
        finish = resolve;
      });
      return { send: async () => (await gate) as never, finish };
    };
    const withTile = (composer: ReactElement) => (
      <AttachmentReferenceTarget scope={scope}>
        <TranscriptAttachmentGallery daemon={daemon} images={[stored()]} />
        {composer}
      </AttachmentReferenceTarget>
    );
    const chips = (container: HTMLElement) => container.querySelectorAll('span[title="shot.png"]');

    it('disables the + with the reason, refuses the reference, and leaves the draft alone — then wakes when enabled', async () => {
      const store = new DaemonDraftStore(memoryStorage());
      const view = await mount(
        withTile(<Composer api={api} daemon={daemon} disabled draftStore={store} sessionId="ref-session" />),
      );
      const plus = (): HTMLButtonElement => must(plusOf(view.container), 'the + button');
      expect(plus().disabled).toBe(true);
      expect(plus().title).toBe(REFERENCE_DISABLED_COPY);

      expect(referenceAttachmentInComposer(file, scope)).toEqual({ state: 'no-composer' });
      // Reached around the + (a stale handle): the composer itself refuses to take the file or the words.
      composerQuoteTarget(scope)?.insertAtCaret?.('%attachment:shot.png');
      expect(composerQuoteTarget(scope)?.attachExisting?.(file)).toBe('refused');
      expect(textarea(view.container).value).toBe('');
      expect(chips(view.container)).toHaveLength(0);

      await view.render(withTile(<Composer api={api} daemon={daemon} draftStore={store} sessionId="ref-session" />));
      expect(plus().disabled).toBe(false);
      await interact(() => plus().click());
      expect(textarea(view.container).value).toBe('%attachment:shot.png ');
      expect(chips(view.container)).toHaveLength(1);
      await view.unmount();
    });

    it('disables the + while a send is in flight, keeps the draft and chips untouched, and wakes when it lands', async () => {
      const gate = pending();
      const view = await mount(
        withTile(
          <Composer
            api={{ send: gate.send }}
            connectionLive
            daemon={daemon}
            draftStore={new DaemonDraftStore(memoryStorage())}
            sessionId="ref-session"
          />,
        ),
      );
      const plus = (): HTMLButtonElement => must(plusOf(view.container), 'the + button');
      await interact(() => composerQuoteTarget(scope)?.replaceDraft('hello'));
      expect(plus().disabled).toBe(false);

      await interact(() => {
        must(view.container.querySelector('form'), 'the form').dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      });
      expect(must(view.container.querySelector('[data-composer-send]'), 'send').getAttribute('data-sending')).toBe('');
      expect(plus().disabled).toBe(true);
      expect(plus().title).toBe(REFERENCE_SENDING_COPY);

      expect(referenceAttachmentInComposer(file, scope)).toEqual({ state: 'no-composer' });
      expect(composerQuoteTarget(scope)?.attachExisting?.(file)).toBe('refused');
      expect(chips(view.container)).toHaveLength(0);

      await interact(async () => gate.finish());
      expect(plus().disabled).toBe(false);
      await view.unmount();
    });
  });

  it('answers that there is no composer for a session that has none open', async () => {
    expect(referenceAttachmentInComposer(file, daemonSessionScope(daemon, 'nobody-home'))).toEqual({
      state: 'no-composer',
    });
    expect(referenceAttachmentInComposer({ ...file, filename: 'bad name.png' }, scope)).toEqual({ state: 'rejected' });
  });
});

describe('a proved %attachment: in a message', () => {
  const HANDOFF: SessionHandoff = {
    name: 'turn-008',
    message: 'Compare with %attachment:shot.png and %attachment:gone.png.',
    attachments: [{ attachmentId: 'att_1', filename: 'shot.png', mime: 'image/png' }],
  };
  const handoffs: HandoffSource = { daemon, sessionId: 'ref-session', read: async () => HANDOFF };

  const inSession = (handoff: SessionHandoff) => (
    <AttachmentGalleryProvider load={async () => new Blob()}>
      <HandoffSourceProvider source={handoffs}>
        <AttachmentReferences daemonId={daemon.daemonId} sessionId="ref-session">
          <HandoffBody handoff={handoff} source={handoffs} />
        </AttachmentReferences>
      </HandoffSourceProvider>
    </AttachmentGalleryProvider>
  );

  it('is a file chip that scrolls to and rings the tile; an unproved name stays text', async () => {
    const view = await mount(inSession(HANDOFF));
    const chip = must(view.container.querySelector<HTMLAnchorElement>('a[data-fy-attachment-ref]'), 'the chip');
    expect(chip.textContent).toBe('%attachment:shot.png');
    expect(chip.querySelector('svg')).not.toBeNull();
    // gone.png carries no file in this transcript, so it is not a link.
    expect(view.container.querySelectorAll('a[data-fy-attachment-ref]')).toHaveLength(1);
    expect(view.container.textContent).toContain('%attachment:gone.png');
    const tile = must(view.container.querySelector<HTMLElement>('[data-attachment-id="att_1"]'), 'the tile');
    let scrolled = 0;
    tile.scrollIntoView = () => {
      scrolled += 1;
    };

    await interact(() => chip.click());

    expect(scrolled).toBe(1);
    expect(tile.hasAttribute('data-attachment-flash')).toBe(true);
    await view.unmount();
  });

  it('leaves the token as text where nothing proves it', async () => {
    const view = await mount(<Markdown text="see %attachment:shot.png" />);
    expect(view.container.querySelector('a')).toBeNull();
    expect(view.container.textContent).toContain('%attachment:shot.png');
    await view.unmount();
  });

  it("proves every part of a combined delivery against the turn's own file, though the tile is drawn once", async () => {
    // One delivery (turn-003) holds two peer parts and one shot.png; a NEWER turn then sent another shot.png.
    const turn: SessionHandoff = {
      name: 'turn-003',
      message: '',
      attachments: [{ attachmentId: 'att_turn', filename: 'shot.png', mime: 'image/png' }],
    };
    const newer: SessionHandoff = {
      name: 'turn-009',
      message: '',
      attachments: [{ attachmentId: 'att_newer', filename: 'shot.png', mime: 'image/png' }],
    };
    const view = await mount(
      <AttachmentGalleryProvider load={async () => new Blob()}>
        <HandoffSourceProvider source={handoffs}>
          <AttachmentReferences daemonId={daemon.daemonId} sessionId="ref-session">
            <HandoffBody
              at={1}
              handoff={{ ...turn, message: 'first part: %attachment:shot.png' }}
              showFiles={false}
              source={handoffs}
            />
            <HandoffBody at={1} handoff={{ ...turn, message: 'last part' }} source={handoffs} />
            <HandoffBody at={9} handoff={newer} source={handoffs} />
          </AttachmentReferences>
        </HandoffSourceProvider>
      </AttachmentGalleryProvider>,
    );
    // Tiles: the turn's file once (not once per part) and the newer turn's.
    expect(view.container.querySelectorAll('[data-attachment-id="att_turn"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-attachment-id="att_newer"]')).toHaveLength(1);
    const chip = must(view.container.querySelector<HTMLAnchorElement>('a[data-fy-attachment-ref]'), 'the chip');
    expect(chip.getAttribute('href')).toContain('att_turn');
    expect(chip.getAttribute('href')).not.toContain('att_newer');
    await view.unmount();
  });

  it("scrolls to the combined part's own tile, not to a later message that carries the same file id", async () => {
    // One delivery (turn-003) split in two parts; the tile sits under the last. A LATER turn names the same
    // attachment id (the same file sent again), and its tile is the newest in the document.
    const same = [{ attachmentId: 'att_1', filename: 'shot.png', mime: 'image/png' }];
    const first: SessionHandoff = { name: 'turn-003', message: 'part one: %attachment:shot.png', attachments: same };
    const last: SessionHandoff = { name: 'turn-003', message: 'part two', attachments: same };
    const later: SessionHandoff = { name: 'turn-009', message: 'again', attachments: same };
    const view = await mount(
      <AttachmentGalleryProvider load={async () => new Blob()}>
        <HandoffSourceProvider source={handoffs}>
          <AttachmentReferences daemonId={daemon.daemonId} sessionId="ref-session">
            <HandoffBody at={1} handoff={first} showFiles={false} source={handoffs} />
            <HandoffBody at={1} handoff={last} source={handoffs} />
            <HandoffBody at={9} handoff={later} source={handoffs} />
          </AttachmentReferences>
        </HandoffSourceProvider>
      </AttachmentGalleryProvider>,
    );
    const tiles = [...view.container.querySelectorAll<HTMLElement>('[data-attachment-id="att_1"]')];
    expect(tiles).toHaveLength(2);
    const chip = must(view.container.querySelector<HTMLAnchorElement>('a[data-fy-attachment-ref]'), 'the chip');

    await interact(() => chip.click());

    expect(tiles[0]?.hasAttribute('data-attachment-flash')).toBe(true);
    expect(tiles[1]?.hasAttribute('data-attachment-flash')).toBe(false);
    await view.unmount();
  });

  it("proves a reference in a LATER message against an earlier message's file", async () => {
    const later: SessionHandoff = { name: 'turn-009', message: 'again %attachment:shot.png', attachments: [] };
    const view = await mount(
      <AttachmentGalleryProvider load={async () => new Blob()}>
        <HandoffSourceProvider source={handoffs}>
          <AttachmentReferences daemonId={daemon.daemonId} sessionId="ref-session">
            <HandoffBody handoff={HANDOFF} source={handoffs} />
            <HandoffBody handoff={later} source={handoffs} />
          </AttachmentReferences>
        </HandoffSourceProvider>
      </AttachmentGalleryProvider>,
    );
    // The earlier message recorded its file while mounting, so the later one proves on the next paint.
    expect(view.container.querySelectorAll('a[data-fy-attachment-ref]')).toHaveLength(2);
    await view.unmount();
  });
});
