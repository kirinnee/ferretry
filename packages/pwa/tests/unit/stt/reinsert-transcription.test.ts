/**
 * The request a Settings panel makes of a composer: announced as a cancelable event, taken by
 * `preventDefault()`, read back through a parse.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  REINSERT_TRANSCRIPTION_EVENT,
  reinsertTranscriptionText,
  requestReinsert,
} from '../../../src/lib/stt/reinsert-transcription.ts';

describe('requestReinsert', () => {
  it('should report the words as taken when a listener calls preventDefault', () => {
    // Arrange
    const target = new EventTarget();
    const seen: unknown[] = [];
    target.addEventListener(REINSERT_TRANSCRIPTION_EVENT, event => {
      event.preventDefault();
      seen.push((event as CustomEvent).detail);
    });

    // Act
    const taken = requestReinsert(target, { sessionId: 's1', text: 'hello' });

    // Assert
    should(taken).be.true();
    should(seen).deepEqual([{ sessionId: 's1', text: 'hello' }]);
  });

  it('should report the words as not taken when no listener answers', () => {
    // Arrange
    const target = new EventTarget();
    target.addEventListener(REINSERT_TRANSCRIPTION_EVENT, () => undefined);

    // Act
    const taken = requestReinsert(target, { text: 'hello' });

    // Assert
    should(taken).be.false();
  });

  it('should report the words as not taken when nothing is listening at all', () => {
    // Act
    const taken = requestReinsert(new EventTarget(), { sessionId: undefined, text: 'hello' });

    // Assert
    should(taken).be.false();
  });
});

describe('reinsertTranscriptionText', () => {
  const detailed = (detail: unknown): Event => new CustomEvent(REINSERT_TRANSCRIPTION_EVENT, { detail });

  it('should return the words of a well-formed event, with or without a session', () => {
    // Act
    const withSession = reinsertTranscriptionText(detailed({ sessionId: 's1', text: 'one' }));
    const without = reinsertTranscriptionText(detailed({ text: 'two' }));

    // Assert
    should(withSession).equal('one');
    should(without).equal('two');
  });

  it('should return nothing for empty words, a malformed detail or a plain event', () => {
    // Act
    const results = [
      reinsertTranscriptionText(detailed({ text: '' })),
      reinsertTranscriptionText(detailed({ text: 7 })),
      reinsertTranscriptionText(detailed({ sessionId: 3, text: 'x' })),
      reinsertTranscriptionText(detailed(null)),
      reinsertTranscriptionText(new Event(REINSERT_TRANSCRIPTION_EVENT)),
    ];

    // Assert
    should(results).deepEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});
