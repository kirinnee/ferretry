/**
 * THE SESSION ROSTER: EVERY SESSION'S (RUNTIME, TRANSCRIPT), READ ONCE PER CHANGE.
 *
 * A scripted stamp, read and clock stand in for the session storage. What must hold: callers asking while
 * the stamp holds share one read — concurrent ones the read in flight — and each read is a new generation;
 * a moved stamp or an old roster is read again; and a read that fails answers no sessions and is not kept.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { CredentialSessionRecord } from '../../../src/lib/fleet/credentials-service.ts';
import { SESSION_ROSTER_MAX_AGE_MS, SessionRoster } from '../../../src/lib/fleet-reading/session-roster.ts';

const NOW = 1_786_000_000_000;
const SESSIONS: readonly CredentialSessionRecord[] = [
  { agent: 'codex-runtime', transcript: { home: '/codex', file: '/codex/rollout-1.jsonl' } },
];

/** The storage the roster reads, scripted: its stamp, its clock, and reads the test can hold or fail. */
class Storage {
  stamp = '0:1';
  now = NOW;
  reads = 0;
  fail = false;
  held: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  hold = false;

  roster(): SessionRoster {
    return new SessionRoster({
      stamp: () => this.stamp,
      read: async () => {
        this.reads += 1;
        if (this.hold) {
          const { promise, resolve, reject } = Promise.withResolvers<void>();
          this.held.push({ resolve, reject });
          await promise;
        }
        if (this.fail) throw new Error('the index is closed');
        return SESSIONS;
      },
      now: () => this.now,
      maxAgeMs: SESSION_ROSTER_MAX_AGE_MS,
    });
  }
}

describe('SessionRoster', () => {
  it('should answer every caller from one read while the stamp holds', async () => {
    // Arrange
    const storage = new Storage();
    const subject = storage.roster();

    // Act
    const first = await subject.current();
    const again = await subject.current();
    storage.now = NOW + SESSION_ROSTER_MAX_AGE_MS - 1;
    const later = await subject.current();

    // Assert
    should(storage.reads).equal(1);
    should(first).deepEqual({ generation: 1, sessions: SESSIONS });
    should(again).equal(first);
    should(later).equal(first);
  });

  it('should share the read in flight with every caller that asks while it runs', async () => {
    // Arrange
    const storage = new Storage();
    storage.hold = true;
    const subject = storage.roster();

    // Act
    const asks = Array.from({ length: 7 }, async () => await subject.current());
    await Promise.resolve();
    for (const held of storage.held) held.resolve();
    const answers = await Promise.all(asks);

    // Assert
    should(storage.reads).equal(1);
    should(new Set(answers.map(answer => answer.generation))).deepEqual(new Set([1]));
  });

  it('should read again, as a new generation, when the stamp moves or the roster grows old', async () => {
    // Arrange
    const storage = new Storage();
    const subject = storage.roster();
    await subject.current();

    // Act
    storage.stamp = '1:1';
    const moved = await subject.current();
    storage.now = NOW + SESSION_ROSTER_MAX_AGE_MS;
    const old = await subject.current();

    // Assert
    should(storage.reads).equal(3);
    should(moved.generation).equal(2);
    should(old.generation).equal(3);
  });

  it('should answer no sessions when the read fails, and read again on the next ask', async () => {
    // Arrange
    const storage = new Storage();
    storage.fail = true;
    const subject = storage.roster();

    // Act
    const failed = await subject.current();
    storage.fail = false;
    const recovered = await subject.current();

    // Assert
    should(failed).deepEqual({ generation: 1, sessions: [] });
    should(recovered).deepEqual({ generation: 2, sessions: SESSIONS });
    should(storage.reads).equal(2);
  });

  it('should keep a newer read when an older one fails after it was replaced', async () => {
    // Arrange — a read is in flight when the stamp moves and a second read starts.
    const storage = new Storage();
    storage.hold = true;
    const subject = storage.roster();
    const older = subject.current();
    await Promise.resolve();
    storage.stamp = '1:1';
    const newer = subject.current();
    await Promise.resolve();

    // Act — the older read fails; the newer one lands.
    storage.held[0]?.reject(new Error('the index is closed'));
    const failed = await older;
    storage.held[1]?.resolve();
    const landed = await newer;
    const kept = await subject.current();

    // Assert — the failure did not drop the newer read.
    should(failed).deepEqual({ generation: 1, sessions: [] });
    should(landed.generation).equal(2);
    should(kept).equal(landed);
    should(storage.reads).equal(2);
  });
});
