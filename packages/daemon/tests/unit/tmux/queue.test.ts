import { describe, it } from 'bun:test';
import should from 'should';
import { needsQueueKey, queueAccepted } from '../../../src/lib/tmux/index.ts';

/**
 * What a frame proves about a message put into a BUSY pane's own queue.
 *
 * The inversion is the point: `delivery.ts` proves a payload LEFT the composer, and here leaving it
 * with nothing else to show for it is the failure — a queued message is supposed to stay visible,
 * held, until the turn it is queued behind ends.
 */

const TEXT = 'read the queued brief';
const WORKING = '✻ Lollygagging… (34s · ⚒ 2.1k tokens)';

describe('needsQueueKey', () => {
  it('should ask for the queue key when the pane offers it and still holds the payload', () => {
    // Codex mid-turn does not submit on Enter: it keeps the text and renders the hint.
    const frame = `${TEXT}\n  tab to queue message`;
    should(needsQueueKey(frame, TEXT, 'chars')).be.true();
  });

  it('should tolerate wording and spacing drift in the hint', () => {
    should(needsQueueKey(`${TEXT}\nTab  to  Queue message`, TEXT, 'chars')).be.true();
  });

  it('should never press a blind extra key at a frame that is not holding this payload', () => {
    // A stale or unrelated frame showing the hint is not permission to send a keystroke into a live
    // agent's terminal.
    should(needsQueueKey('  tab to queue message', TEXT, 'chars')).be.false();
    should(needsQueueKey(`${TEXT}\n${WORKING}`, TEXT, 'chars')).be.false();
  });

  it('should read a collapsed paste by its placeholder rather than its characters', () => {
    const frame = '[Pasted text #1 +18 lines]\n tab to queue message';
    should(needsQueueKey(frame, TEXT, 'placeholder')).be.true();
    // The same frame proves nothing when the payload landed as characters: none of them are there.
    should(needsQueueKey(frame, TEXT, 'chars')).be.false();
  });
});

describe('queueAccepted', () => {
  it('should accept a frame that still shows the payload', () => {
    should(queueAccepted(`❯ ${TEXT}`, TEXT, 'chars')).be.true();
    should(queueAccepted('[Pasted text #1 +18 lines]', TEXT, 'placeholder')).be.true();
  });

  it('should accept a pane that is visibly working and about to consume it', () => {
    should(queueAccepted(WORKING, TEXT, 'chars')).be.true();
  });

  it('should refuse a frame with neither, which is a message that is simply gone', () => {
    // Reporting this as queued would tell a caller their message is waiting at a turn boundary the
    // harness passed — or never saw — seconds earlier.
    should(queueAccepted('❯ ', TEXT, 'chars')).be.false();
  });
});
