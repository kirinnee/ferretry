import { describe, it } from 'bun:test';
import should from 'should';
import { Composer } from '../../src/components/composer.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { composerQuoteTarget, quoteSelectionIntoComposer } from '../../src/lib/quote.ts';
import { interact, mount, must } from '../support/dom.ts';

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
  deviceToken: 'token-a',
});
const daemonB = daemonConnection({
  daemonId: 'daemon-b',
  baseUrl: 'https://daemon-b.example.test',
  deviceToken: 'token-b',
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
