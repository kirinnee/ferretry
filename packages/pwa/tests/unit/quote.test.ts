import { describe, test } from 'bun:test';
import should from 'should';
import { clearForegroundPinScope, setForegroundPinScope } from '../../src/lib/pin-bridge.ts';
import {
  type ComposerQuoteTarget,
  composeQuotedDraft,
  composerQuoteTarget,
  quoteSelectionIntoComposer,
  registerComposerQuoteTarget,
  toBlockquote,
} from '../../src/lib/quote.ts';

/** A composer stand-in that records what the quote action handed it. */
const fakeTarget = (
  daemonId: string,
  sessionId: string,
  initial = '',
): ComposerQuoteTarget & { readonly value: () => string } => {
  let draft = initial;
  return {
    daemonId: daemonId as ComposerQuoteTarget['daemonId'],
    sessionId,
    draft: () => draft,
    replaceDraft: next => {
      draft = next;
    },
    value: () => draft,
  };
};

describe('toBlockquote', () => {
  test('should prefix a single line', () => {
    // Assert
    should(toBlockquote('hello world')).equal('> hello world');
  });

  test('should prefix every line of a multi-line selection', () => {
    // Assert
    should(toBlockquote('one\ntwo\nthree')).equal('> one\n> two\n> three');
  });

  test('should reduce a blank interior line to a bare marker', () => {
    // Assert
    should(toBlockquote('a\n\nb')).equal('> a\n>\n> b');
  });

  test('should trim trailing whitespace before quoting', () => {
    // Assert
    should(toBlockquote('line\n\n   ')).equal('> line');
  });

  test('should yield an empty string for an empty or whitespace-only selection', () => {
    // Assert
    should(toBlockquote('')).equal('');
    should(toBlockquote('   \n  \t')).equal('');
  });

  test('should preserve indentation inside a line after the marker', () => {
    // Assert
    should(toBlockquote('  indented')).equal('>   indented');
  });
});

describe('composeQuotedDraft', () => {
  test('should leave a trailing blank line after the block in an empty draft', () => {
    // Assert
    should(composeQuotedDraft('', 'quote me')).equal('> quote me\n\n');
  });

  test('should treat a whitespace-only draft as empty', () => {
    // Assert
    should(composeQuotedDraft('   \n', 'quote me')).equal('> quote me\n\n');
  });

  test('should append after an existing draft rather than clobber it', () => {
    // Assert
    should(composeQuotedDraft('my reply', 'quoted')).equal('my reply\n\n> quoted\n\n');
  });

  test('should collapse the existing trailing whitespace into exactly one blank line', () => {
    // Assert
    should(composeQuotedDraft('reply\n\n\n', 'quoted')).equal('reply\n\n> quoted\n\n');
  });

  test('should leave the draft untouched for an empty selection', () => {
    // Assert
    should(composeQuotedDraft('keep me', '   ')).equal('keep me');
    should(composeQuotedDraft('', '')).equal('');
  });

  test('should quote a multi-line selection as one block below the draft', () => {
    // Assert
    should(composeQuotedDraft('hi', 'a\nb')).equal('hi\n\n> a\n> b\n\n');
  });
});

describe('quoteSelectionIntoComposer', () => {
  test('should deliver the quote to the composer registered for that scope', () => {
    // Arrange
    const target = fakeTarget('daemon-a', 'session-1', 'my reply');
    const dispose = registerComposerQuoteTarget(target);

    // Act
    const outcome = quoteSelectionIntoComposer('quoted', { daemonId: target.daemonId, sessionId: 'session-1' });

    // Assert
    should(outcome).equal('quoted');
    should(target.value()).equal('my reply\n\n> quoted\n\n');
    dispose();
  });

  test('should never deliver another daemon session the quote', () => {
    // Arrange — same session id on two daemons, which is the collision that matters.
    const first = fakeTarget('daemon-a', 'session-1');
    const second = fakeTarget('daemon-b', 'session-1');
    const disposeFirst = registerComposerQuoteTarget(first);
    const disposeSecond = registerComposerQuoteTarget(second);

    // Act
    quoteSelectionIntoComposer('for b', { daemonId: second.daemonId, sessionId: 'session-1' });

    // Assert
    should(first.value()).equal('');
    should(second.value()).equal('> for b\n\n');
    disposeFirst();
    disposeSecond();
  });

  test('should report no-composer when nothing is registered for the scope', () => {
    // Act
    const outcome = quoteSelectionIntoComposer('text', {
      daemonId: 'daemon-a' as ComposerQuoteTarget['daemonId'],
      sessionId: 'absent',
    });

    // Assert
    should(outcome).equal('no-composer');
  });

  test('should report no-composer when no pane has been declared foreground', () => {
    // Act
    const outcome = quoteSelectionIntoComposer('text', null);

    // Assert
    should(outcome).equal('no-composer');
  });

  test('should report empty when the selection would not change the draft', () => {
    // Arrange
    const target = fakeTarget('daemon-a', 'session-2', 'keep me');
    const dispose = registerComposerQuoteTarget(target);

    // Act
    const outcome = quoteSelectionIntoComposer('   ', { daemonId: target.daemonId, sessionId: 'session-2' });

    // Assert
    should(outcome).equal('empty');
    should(target.value()).equal('keep me');
    dispose();
  });

  test('should default to the declared foreground pane', () => {
    // Arrange
    const scope = { daemonId: 'daemon-a' as ComposerQuoteTarget['daemonId'], sessionId: 'session-3' };
    const target = fakeTarget('daemon-a', 'session-3');
    const dispose = registerComposerQuoteTarget(target);
    setForegroundPinScope(scope);

    // Act
    const outcome = quoteSelectionIntoComposer('foreground');

    // Assert
    should(outcome).equal('quoted');
    should(target.value()).equal('> foreground\n\n');
    clearForegroundPinScope(scope);
    dispose();
  });
});

describe('registerComposerQuoteTarget', () => {
  test('should expose the registered target for its scope and remove it on dispose', () => {
    // Arrange
    const target = fakeTarget('daemon-a', 'session-4');
    const scope = { daemonId: target.daemonId, sessionId: 'session-4' };

    // Act
    const dispose = registerComposerQuoteTarget(target);

    // Assert
    should(composerQuoteTarget(scope)).equal(target);
    dispose();
    should(composerQuoteTarget(scope)).be.null();
  });

  test('should let a replacement survive the departing composer disposing after it', () => {
    // Arrange — a remount registers before the old instance's cleanup runs.
    const outgoing = fakeTarget('daemon-a', 'session-5');
    const incoming = fakeTarget('daemon-a', 'session-5');
    const scope = { daemonId: outgoing.daemonId, sessionId: 'session-5' };
    const disposeOutgoing = registerComposerQuoteTarget(outgoing);
    const disposeIncoming = registerComposerQuoteTarget(incoming);

    // Act
    disposeOutgoing();

    // Assert
    should(composerQuoteTarget(scope)).equal(incoming);
    disposeIncoming();
  });
});
