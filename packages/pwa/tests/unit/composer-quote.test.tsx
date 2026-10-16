import { afterEach, beforeEach, describe, it } from 'bun:test';
import should from 'should';
import { Composer } from '../../src/components/composer.tsx';
import { liveOffset } from '../../src/components/live-markdown-editor.tsx';
import { addReferenceToComposer } from '../../src/lib/composer-references.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { composerQuoteTarget, quoteSelectionIntoComposer } from '../../src/lib/quote.ts';
import { interact, mount, must } from '../support/dom.ts';

// The general composer behaviour is one key arbitration for every editor style; these suites drive it
// through the Plain textarea. The live editor (Markdown and Rich text) has its own suites.
beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

/**
 * The composer's half of transcript quoting, mounted in a real DOM.
 *
 * A quote is only delivered if the mounted composer actually publishes itself for
 * its own `(daemonId, sessionId)`, takes the composed draft, and moves focus so
 * the reader can type straight after the block. None of that is a
 * renderable-tree fact, so it is asserted against happy-dom rather than a shallow
 * tree.
 */

const daemonA = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon-a.example.test',
  deviceId: 'token-a',
});
const daemonB = daemonConnection({
  daemonId: 'daemon-b',
  baseUrl: 'https://daemon-b.example.test',
  deviceId: 'token-b',
});

/** Drafts must not leak between cases through a shared browser store. */
const memoryStorage = (): DraftStorage => {
  const entries = new Map<string, string>();
  return {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
};

const api = { send: async () => ({}) as never };

const textareaOf = (container: HTMLElement): HTMLTextAreaElement =>
  must(container.querySelector('textarea'), 'the composer textarea');

describe('Composer quote target', () => {
  it('should take a quoted selection, focus itself and leave the caret at the end', async () => {
    // Arrange
    const composer = await mount(
      <Composer
        api={api}
        daemon={daemonA}
        draftStore={new DaemonDraftStore(memoryStorage())}
        sessionId="quote-session"
      />,
    );
    const textarea = textareaOf(composer.container);

    // Act
    await interact(() =>
      quoteSelectionIntoComposer('the quoted line', { daemonId: daemonA.daemonId, sessionId: 'quote-session' }),
    );

    // Assert
    should(textarea.value).equal('> the quoted line\n\n');
    should(document.activeElement).equal(textarea);
    should(textarea.selectionStart).equal(textarea.value.length);
    await composer.unmount();
  });

  it('should append a second quote after the draft it already holds', async () => {
    // Arrange
    const composer = await mount(
      <Composer api={api} daemon={daemonA} draftStore={new DaemonDraftStore(memoryStorage())} sessionId="append" />,
    );
    const scope = { daemonId: daemonA.daemonId, sessionId: 'append' };

    // Act
    await interact(() => quoteSelectionIntoComposer('first', scope));
    await interact(() => quoteSelectionIntoComposer('second', scope));

    // Assert
    should(textareaOf(composer.container).value).equal('> first\n\n> second\n\n');
    await composer.unmount();
  });

  it('should publish itself per daemon so the same session id on two daemons stays separate', async () => {
    // Arrange
    const first = await mount(
      <Composer api={api} daemon={daemonA} draftStore={new DaemonDraftStore(memoryStorage())} sessionId="same-id" />,
    );
    const second = await mount(
      <Composer api={api} daemon={daemonB} draftStore={new DaemonDraftStore(memoryStorage())} sessionId="same-id" />,
    );

    // Act
    await interact(() =>
      quoteSelectionIntoComposer('only for b', { daemonId: daemonB.daemonId, sessionId: 'same-id' }),
    );

    // Assert
    should(textareaOf(first.container).value).equal('');
    should(textareaOf(second.container).value).equal('> only for b\n\n');
    await first.unmount();
    await second.unmount();
  });

  it('should withdraw its registration when it unmounts', async () => {
    // Arrange
    const composer = await mount(
      <Composer api={api} daemon={daemonA} draftStore={new DaemonDraftStore(memoryStorage())} sessionId="gone" />,
    );
    const scope = { daemonId: daemonA.daemonId, sessionId: 'gone' };
    should(composerQuoteTarget(scope)).not.be.null();

    // Act
    await composer.unmount();

    // Assert
    should(composerQuoteTarget(scope)).be.null();
    should(quoteSelectionIntoComposer('nowhere to go', scope)).equal('no-composer');
  });
});

/** The caret of the live editor, as a draft offset. */
const liveCaret = (editor: HTMLElement): number => {
  const range = must(document.getSelection()?.getRangeAt(0), 'a selection in the live editor');
  return liveOffset(editor, range.startContainer, range.startOffset);
};

describe('Composer quote target in the live editor (Markdown and Rich text)', () => {
  for (const style of ['on', 'rich'] as const) {
    it(`should leave the ${style} editor's caret AFTER a delivered reference, not where the old draft ended`, async () => {
      // Arrange — a draft the reader was editing mid-sentence, then left for another surface.
      writeMdComposePref(style);
      const storage = memoryStorage();
      const scope = { daemonId: daemonA.daemonId, sessionId: `live-${style}` };
      new DaemonDraftStore(storage).save(scope, 'hello world');
      const composer = await mount(
        <Composer api={api} daemon={daemonA} draftStore={new DaemonDraftStore(storage)} sessionId={scope.sessionId} />,
      );
      const editor = must(composer.container.querySelector<HTMLElement>('[data-live-editor]'), 'the live editor');

      // Act
      let outcome: string | undefined;
      await interact(() => {
        outcome = addReferenceToComposer({ kind: 'task', id: 'F12' }, scope);
      });

      // Assert — the draft is appended, focus is in the editor and the caret follows the token.
      should(outcome).equal('added');
      should(editor.textContent).equal('hello world &F12 ');
      should(document.activeElement).equal(editor);
      should(liveCaret(editor)).equal('hello world &F12 '.length);
      await composer.unmount();
    });
  }
});

describe('Composer quote target given the draft it already holds', () => {
  it('should still focus and put the caret at the end, with no render to wait for', async () => {
    // Arrange
    const composer = await mount(
      <Composer api={api} daemon={daemonA} draftStore={new DaemonDraftStore(memoryStorage())} sessionId="same" />,
    );
    const scope = { daemonId: daemonA.daemonId, sessionId: 'same' };
    await interact(() => quoteSelectionIntoComposer('kept', scope));
    const textarea = textareaOf(composer.container);
    textarea.blur();
    textarea.setSelectionRange(0, 0);
    const target = must(composerQuoteTarget(scope), 'the registered composer');

    // Act
    await interact(() => target.replaceDraft(target.draft()));

    // Assert
    should(textarea.value).equal('> kept\n\n');
    should(document.activeElement).equal(textarea);
    should(textarea.selectionStart).equal(textarea.value.length);
    await composer.unmount();
  });
});
