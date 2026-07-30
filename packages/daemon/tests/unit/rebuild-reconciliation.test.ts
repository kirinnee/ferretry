import { describe, it } from 'bun:test';
import should from 'should';
import {
  createSessionEvent,
  encodeSessionEvent,
  type IndexedSession,
  type JournalFingerprint,
  parseSessionId,
  planIndexRebuild,
  planReconciliation,
  type SessionSource,
  scanJournal,
} from '../../src/lib/index.ts';

const fingerprint = (overrides: Partial<JournalFingerprint> = {}): JournalFingerprint => ({
  device: '1',
  inode: '2',
  size: 100,
  modifiedAtMs: 200,
  ...overrides,
});

describe('index rebuild planning', () => {
  it('should derive lean session metadata and event pointers from authoritative files', () => {
    // Arrange
    const id = parseSessionId('session-a');
    const event = createSessionEvent(id, 0, '2026-07-30T12:00:01.000Z', 'session.started', { payload: 'files-only' });
    const journalFile = '/home/state/sessions/session-a/events.jsonl';
    const journalBytes = Buffer.from(`${encodeSessionEvent(event)}\n`);
    const input: SessionSource[] = [
      {
        id,
        marker: { file: '/home/state/sessions/session-a/session-version', text: '1\n' },
        config: {
          file: '/home/state/sessions/session-a/config.json',
          text: JSON.stringify({ createdAt: '2026-07-30T12:00:00.000Z', updatedAt: '2026-07-30T12:00:02.000Z' }),
        },
        state: { file: '/home/state/sessions/session-a/state.json', text: JSON.stringify({ status: 'running' }) },
        journal: {
          file: journalFile,
          scan: {
            ...scanJournal(journalBytes, { file: journalFile, sessionId: id }),
            lineAtOffset: 2,
          },
          fingerprint: fingerprint({ size: journalBytes.byteLength }),
        },
      },
    ];

    // Act
    const actual = planIndexRebuild(input);

    // Assert
    should(actual.sessions).deepEqual([
      {
        id: 'session-a',
        status: 'running',
        createdAt: '2026-07-30T12:00:00.000Z',
        updatedAt: '2026-07-30T12:00:02.000Z',
        lastSequence: 1,
        journalLine: 2,
        journal: input[0]?.journal?.fingerprint,
      },
    ]);
    should(actual.sessions[0]).not.have.property('config');
    should(actual.sessions[0]).not.have.property('state');
    should(actual.events).have.length(1);
    should(actual.events[0]).not.have.property('data');
    should(actual.problems).deepEqual([]);
  });

  it('should isolate unsupported markers and malformed documents as problems', () => {
    // Arrange
    const input: SessionSource[] = [
      {
        id: parseSessionId('a-session'),
        marker: { file: '/sessions/a/session-version', text: '2' },
      },
      {
        id: parseSessionId('b-session'),
        marker: { file: '/sessions/b/session-version', text: '1' },
        config: { file: '/sessions/b/config.json', text: '{bad' },
        state: { file: '/sessions/b/state.json', text: JSON.stringify({ status: 'stopped', finishedAt: 'bad-time' }) },
      },
    ];

    // Act
    const actual = planIndexRebuild(input);

    // Assert
    should(actual.sessions.map(session => session.id)).deepEqual(['b-session']);
    should(actual.problems.map(problem => problem.message)).deepEqual([
      'unsupported session marker',
      'invalid JSON',
      'finishedAt must be an ISO 8601 instant',
    ]);
  });

  it('should be deterministic and report duplicate sources', () => {
    // Arrange
    const id = parseSessionId('same-session');
    const input: SessionSource[] = [
      {
        id,
        marker: { file: '/z/session-version', text: '1' },
        state: { file: '/z/state.json', text: '{"status":"z"}' },
      },
      {
        id,
        marker: { file: '/a/session-version', text: '1' },
        state: { file: '/a/state.json', text: '{"status":"a"}' },
      },
    ];

    // Act
    const actual = planIndexRebuild(input);
    const reordered = planIndexRebuild([...input].reverse());

    // Assert
    should(actual.sessions[0]?.status).equal('a');
    should(actual.problems).have.length(1);
    should(actual.problems[0]?.message).equal('duplicate session same-session');
    should(reordered).deepEqual(actual);
  });
});

describe('reconciliation planning', () => {
  const indexed = (
    id: string,
    journal: JournalFingerprint | null,
    lastSequence = 4,
    journalLine = lastSequence + 1,
  ): IndexedSession => ({
    id: parseSessionId(id),
    lastSequence,
    journalLine,
    journal,
  });

  it('should plan disk-only indexing and stale index removal deterministically', () => {
    // Arrange
    const disk = [{ id: parseSessionId('new-session'), journal: fingerprint(), lastIndexedEventMatches: true }];
    const index = [indexed('gone-session', fingerprint())];

    // Act
    const actual = planReconciliation(disk, index);

    // Assert
    should(actual).deepEqual([
      { kind: 'forget', id: 'gone-session' },
      { kind: 'rescan', id: 'new-session' },
    ]);
  });

  it.each([
    {
      name: 'unchanged journal',
      disk: fingerprint(),
      indexed: fingerprint(),
      matches: true,
      expected: { kind: 'refresh-metadata', id: 'session-a' },
    },
    {
      name: 'grown journal',
      disk: fingerprint({ size: 120, modifiedAtMs: 300 }),
      indexed: fingerprint({ size: 100, modifiedAtMs: 200 }),
      matches: true,
      expected: { kind: 'scan-tail', id: 'session-a', fromOffset: 100, fromSequence: 4, fromLine: 5 },
    },
    {
      name: 'grown journal with a mismatched last pointer',
      disk: fingerprint({ size: 120, modifiedAtMs: 300 }),
      indexed: fingerprint({ size: 100, modifiedAtMs: 200 }),
      matches: false,
      expected: { kind: 'rescan', id: 'session-a' },
    },
    {
      name: 'same-size rewrite',
      disk: fingerprint({ modifiedAtMs: 300 }),
      indexed: fingerprint(),
      matches: false,
      expected: { kind: 'rescan', id: 'session-a' },
    },
    {
      name: 'replaced inode',
      disk: fingerprint({ inode: '9' }),
      indexed: fingerprint(),
      matches: true,
      expected: { kind: 'rescan', id: 'session-a' },
    },
    {
      name: 'shrunk journal',
      disk: fingerprint({ size: 50 }),
      indexed: fingerprint(),
      matches: true,
      expected: { kind: 'rescan', id: 'session-a' },
    },
    {
      name: 'unchanged fingerprint with a mismatched last pointer',
      disk: fingerprint(),
      indexed: fingerprint(),
      matches: false,
      expected: { kind: 'rescan', id: 'session-a' },
    },
  ])('should plan $name', ({ disk, indexed: indexedJournal, matches, expected }) => {
    // Arrange
    const id = parseSessionId('session-a');

    // Act
    const actual = planReconciliation(
      [{ id, journal: disk, lastIndexedEventMatches: matches }],
      [indexed('session-a', indexedJournal)],
    );

    // Assert
    should(actual).deepEqual([expected]);
  });

  it.each([
    {
      name: 'both journals absent',
      disk: null,
      indexed: null,
      expected: { kind: 'refresh-metadata', id: 'session-a' },
    },
    {
      name: 'only the disk journal present',
      disk: fingerprint(),
      indexed: null,
      expected: { kind: 'rescan', id: 'session-a' },
    },
    {
      name: 'only the indexed journal present',
      disk: null,
      indexed: fingerprint(),
      expected: { kind: 'rescan', id: 'session-a' },
    },
  ])('should plan $name', ({ disk, indexed: indexedJournal, expected }) => {
    // Arrange
    const id = parseSessionId('session-a');

    // Act
    const actual = planReconciliation(
      [{ id, journal: disk, lastIndexedEventMatches: true }],
      [indexed('session-a', indexedJournal)],
    );

    // Assert
    should(actual).deepEqual([expected]);
  });
});
