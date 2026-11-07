/**
 * THE SESSION STATUS TALLY: EVERY SESSION'S STATUS, READ ONCE AND THEN HEARD.
 *
 * A scripted read and clock stand in for the session storage, and the test plays the storage's state feed.
 * What must hold: callers share one read — concurrent ones the read in flight; a heard write moves the tally
 * with no read; a write heard while a read runs beats what the read found; an old tally is read again; and a
 * read that fails leaves the last tally standing and is tried again by the next caller.
 */
import { describe, it } from 'bun:test';
import type { SessionStatus } from '@ferretry/protocol';
import should from 'should';
import {
  SESSION_STATUS_TALLY_MAX_AGE_MS,
  SessionStatusTally,
} from '../../../src/lib/fleet-reading/session-status-tally.ts';

const NOW = 1_786_000_000_000;

/** The documents the tally reads, scripted: what they say, the clock, and reads the test can hold or fail. */
class Storage {
  documents = new Map<string, SessionStatus>([
    ['s1', 'running'],
    ['s2', 'waiting'],
    ['s3', 'stopped'],
  ]);
  now = NOW;
  reads = 0;
  fail = false;
  held: Array<() => void> = [];
  hold = false;

  tally(): SessionStatusTally {
    return new SessionStatusTally({
      read: async () => {
        this.reads += 1;
        const found = new Map(this.documents);
        if (this.hold) {
          const { promise, resolve } = Promise.withResolvers<void>();
          this.held.push(resolve);
          await promise;
        }
        if (this.fail) throw new Error('the index is closed');
        return found;
      },
      now: () => this.now,
      maxAgeMs: SESSION_STATUS_TALLY_MAX_AGE_MS,
    });
  }
}

const sorted = (statuses: readonly SessionStatus[]): readonly SessionStatus[] => [...statuses].toSorted();

describe('SessionStatusTally', () => {
  it('should answer every caller from one read while the tally is young', async () => {
    // Arrange
    const storage = new Storage();
    const subject = storage.tally();

    // Act
    const first = await subject.statuses();
    storage.documents.set('s4', 'running');
    storage.now = NOW + SESSION_STATUS_TALLY_MAX_AGE_MS - 1;
    const later = await subject.statuses();

    // Assert — the document nobody reported is not read until the tally is old.
    should(storage.reads).equal(1);
    should(sorted(first)).deepEqual(['running', 'stopped', 'waiting']);
    should(sorted(later)).deepEqual(['running', 'stopped', 'waiting']);
  });

  it('should share the read in flight with every caller that asks while it runs', async () => {
    // Arrange
    const storage = new Storage();
    storage.hold = true;
    const subject = storage.tally();

    // Act
    const asks = Array.from({ length: 23 }, async () => await subject.statuses());
    while (storage.held.length === 0) await Promise.resolve();
    for (const release of storage.held) release();
    const answers = await Promise.all(asks);

    // Assert
    should(storage.reads).equal(1);
    for (const answer of answers) should(sorted(answer)).deepEqual(['running', 'stopped', 'waiting']);
  });

  it('should move with every state it hears, with no read', async () => {
    // Arrange
    const storage = new Storage();
    const subject = storage.tally();
    await subject.statuses();

    // Act — one session stops, a new one starts, one is written with no status a reader can count.
    subject.heard('s1', 'stopped');
    subject.heard('s5', 'running');
    subject.heard('s2', undefined);
    const heard = await subject.statuses();

    // Assert
    should(storage.reads).equal(1);
    should(sorted(heard)).deepEqual(['running', 'stopped', 'stopped']);
  });

  it('should ignore what it hears before its first read, which finds every document anyway', async () => {
    // Arrange
    const storage = new Storage();
    const subject = storage.tally();

    // Act
    subject.heard('s9', 'running');
    const first = await subject.statuses();

    // Assert — only the documents: the heard session's state is on disk by the time a read runs.
    should(sorted(first)).deepEqual(['running', 'stopped', 'waiting']);
  });

  it('should let a write heard while a read runs beat what that read found', async () => {
    // Arrange — the read finds s1 running; s1 stops and s2 loses its status while the read is in flight.
    const storage = new Storage();
    storage.hold = true;
    const subject = storage.tally();
    const asked = subject.statuses();
    while (storage.held.length === 0) await Promise.resolve();

    // Act
    subject.heard('s1', 'stopped');
    subject.heard('s2', undefined);
    storage.held[0]?.();
    const answer = await asked;

    // Assert
    should(sorted(answer)).deepEqual(['stopped', 'stopped']);
  });

  it('should read every document again once the tally is as old as its bound', async () => {
    // Arrange — a document edited by hand: no write reports it.
    const storage = new Storage();
    const subject = storage.tally();
    await subject.statuses();
    storage.documents.set('s2', 'running');

    // Act
    storage.now = NOW + SESSION_STATUS_TALLY_MAX_AGE_MS;
    const old = await subject.statuses();

    // Assert
    should(storage.reads).equal(2);
    should(sorted(old)).deepEqual(['running', 'running', 'stopped']);
  });

  it('should answer no statuses when the first read fails, and read again on the next ask', async () => {
    // Arrange
    const storage = new Storage();
    storage.fail = true;
    const subject = storage.tally();

    // Act
    const failed = await subject.statuses();
    storage.fail = false;
    const recovered = await subject.statuses();

    // Assert
    should(failed).deepEqual([]);
    should(sorted(recovered)).deepEqual(['running', 'stopped', 'waiting']);
    should(storage.reads).equal(2);
  });

  it('should keep the last tally when a later read fails, and try again on the next ask', async () => {
    // Arrange
    const storage = new Storage();
    const subject = storage.tally();
    await subject.statuses();
    subject.heard('s2', 'running');

    // Act
    storage.now = NOW + SESSION_STATUS_TALLY_MAX_AGE_MS;
    storage.fail = true;
    const stale = await subject.statuses();
    storage.fail = false;
    const fresh = await subject.statuses();

    // Assert
    should(sorted(stale)).deepEqual(['running', 'running', 'stopped']);
    should(sorted(fresh)).deepEqual(['running', 'stopped', 'waiting']);
    should(storage.reads).equal(3);
  });
});
