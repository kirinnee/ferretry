import { describe, it } from 'bun:test';
import should from 'should';
import {
  coalesceAll,
  coalesceIndexWrites,
  type EventPointer,
  type IndexedSession,
  type IndexWrite,
  parseSessionId,
} from '../../src/lib/index.ts';

const A = parseSessionId('session-a');
const B = parseSessionId('session-b');

function session(id = A, lastSequence = 1): IndexedSession {
  return { id, lastSequence, journalLine: lastSequence + 1, journal: null };
}

function pointer(sequence: number, id = A): EventPointer {
  return {
    sessionId: id,
    sequence,
    time: '2026-10-29T06:00:00.000Z',
    type: 'session.output',
    byteOffset: sequence * 10,
    byteLength: 10,
  };
}

const replace = (id = A, sequences: readonly number[] = [1], last = 1): IndexWrite => ({
  kind: 'replace-session',
  session: session(id, last),
  events: sequences.map(sequence => pointer(sequence, id)),
});
const append = (id = A, sequences: readonly number[] = [2], last = 2): IndexWrite => ({
  kind: 'append-events',
  session: session(id, last),
  events: sequences.map(sequence => pointer(sequence, id)),
});
const refresh = (id = A, last = 1): IndexWrite => ({ kind: 'refresh-session', session: session(id, last) });
const remove = (id = A): IndexWrite => ({ kind: 'remove-session', id });
const replaceAll: IndexWrite = { kind: 'replace-all', sessions: [session(B)], events: [pointer(1, B)] };

describe('coalesceIndexWrites', () => {
  it('should queue a session’s first write as it is', () => {
    // Arrange
    const next = replace();

    // Act
    const actual = coalesceIndexWrites([], next);

    // Assert
    should(actual).deepEqual([next]);
  });

  it('should drop everything queued before a replace-all', () => {
    // Arrange
    const pending = [replace(A), append(B)];

    // Act
    const actual = coalesceIndexWrites(pending, replaceAll);

    // Assert
    should(actual).deepEqual([replaceAll]);
  });

  it.each([
    ['a replacement', replace(A, [1, 2], 2)],
    ['a removal', remove(A)],
  ])('should let %s supersede the session’s queued write', (_name, next) => {
    // Arrange
    const pending = [append(A), refresh(B)];

    // Act
    const actual = coalesceIndexWrites(pending, next);

    // Assert — moved behind the other session's write, which commutes with it.
    should(actual).deepEqual([refresh(B), next]);
  });

  it('should fold a refresh into a queued replacement, keeping its pointers', () => {
    // Act
    const actual = coalesceIndexWrites([replace(A, [1], 1)], refresh(A, 5));

    // Assert
    should(actual).deepEqual([{ kind: 'replace-session', session: session(A, 5), events: [pointer(1)] }]);
  });

  it('should let a refresh replace a queued refresh', () => {
    // Act
    const actual = coalesceIndexWrites([refresh(A, 1)], refresh(A, 2));

    // Assert
    should(actual).deepEqual([refresh(A, 2)]);
  });

  it('should let an append replace a queued refresh, since it upserts the metadata too', () => {
    // Act
    const actual = coalesceIndexWrites([refresh(A, 1)], append(A, [2], 2));

    // Assert
    should(actual).deepEqual([append(A, [2], 2)]);
  });

  it.each([
    ['replacement', replace(A, [1], 1), 'replace-session'],
    ['append', append(A, [2], 2), 'append-events'],
  ] as const)('should add an append’s pointers to a queued %s', (_name, previous, kind) => {
    // Act
    const actual = coalesceIndexWrites([previous], append(A, [3], 3));

    // Assert
    should(actual).deepEqual([
      {
        kind,
        session: session(A, 3),
        events: [...(previous as unknown as { events: EventPointer[] }).events, pointer(3)],
      },
    ]);
  });

  it.each([
    ['an append', append(A, [1, 2], 2), [pointer(1), pointer(2)]],
    ['a refresh', refresh(A, 0), []],
  ])('should turn %s after a queued removal into the replacement it amounts to', (_name, next, events) => {
    // Act
    const actual = coalesceIndexWrites([remove(A)], next);

    // Assert
    should(actual).deepEqual([
      { kind: 'replace-session', session: (next as unknown as { session: IndexedSession }).session, events },
    ]);
  });

  it('should never merge across a replace-all', () => {
    // Arrange
    const pending = [replaceAll];

    // Act
    const actual = coalesceIndexWrites(pending, append(B, [2], 2));

    // Assert
    should(actual).deepEqual([replaceAll, append(B, [2], 2)]);
  });
});

describe('coalesceAll', () => {
  it('should put a failed batch back in front of what queued behind it, merging where it can', () => {
    // Arrange
    const failed = [replace(A, [1], 1), refresh(B, 1)];
    const queuedBehind = [append(A, [2], 2)];

    // Act
    const actual = coalesceAll(failed, queuedBehind);

    // Assert
    should(actual).deepEqual([refresh(B, 1), { ...replace(A, [1, 2], 2) }]);
  });
});
