import { describe, expect, test } from 'bun:test';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';
import {
  createSessionEvent,
  encodeSessionEvent,
  journalFingerprint,
  parseSessionEvent,
  scanJournal,
} from '../../../../daemon/lib/storage/journal.ts';
import { planIndexRebuild } from '../../../../daemon/lib/storage/rebuild.ts';

const ID = parseSessionId('ses-1');
const OTHER = parseSessionId('ses-2');
const AT = '2026-11-06T09:00:00.000Z';
const event = (sequence: number, sessionId = ID) =>
  createSessionEvent(sessionId, sequence - 1, AT, 'note', { n: sequence });

describe('a session journal event', () => {
  test('is the next sequence number, the session, the time, the type and its canonical data', () => {
    expect(createSessionEvent(ID, 4, AT, 'note', { b: 1, a: 2 })).toEqual({
      schemaVersion: 1,
      sequence: 5,
      sessionId: ID,
      time: AT,
      type: 'note',
      data: { a: 2, b: 1 },
    });
  });

  test('is read back only for the session it was written for', () => {
    expect(parseSessionEvent(event(1), ID)?.sequence).toBe(1);
    expect(parseSessionEvent(event(1), OTHER)).toBeUndefined();
    expect(parseSessionEvent({ nonsense: true }, ID)).toBeUndefined();
  });

  test('is refused when its encoded line is larger than one mebibyte, so a rebuild can never reject what was written', () => {
    const huge = createSessionEvent(ID, 0, AT, 'note', 'x'.repeat((1 << 20) + 16));
    let refusal: unknown;
    try {
      encodeSessionEvent(huge);
    } catch (error) {
      refusal = error;
    }
    expect((refusal as Error).name).toBe('JournalRecordTooLargeError');
    expect((refusal as Error).message).toMatch(/^journal record of \d+ bytes exceeds the maximum of 1048576 bytes$/u);
    expect((refusal as { byteLength: number }).byteLength).toBeGreaterThan(1 << 20);
    expect((refusal as { maxBytes: number }).maxBytes).toBe(1 << 20);
  });

  test('is encoded as itself when it fits', () => {
    expect(encodeSessionEvent(event(1))).toEqual(event(1));
  });
});

describe('a journal fingerprint', () => {
  test('is nothing for a journal with no lines and its length in lines otherwise', () => {
    expect(journalFingerprint(0)).toBeNull();
    expect(journalFingerprint(3)).toEqual({ device: 'state', inode: 'history', size: 3, modifiedAtMs: 0 });
  });
});

describe('scanning a journal', () => {
  test('keeps good events in order and reports every damaged, foreign or out-of-order line without stopping', () => {
    const scan = scanJournal(
      [
        { value: event(1) },
        { damaged: 'line is not JSON' },
        { value: { junk: true } },
        { value: event(1) },
        { value: event(2, OTHER) },
        { value: event(2) },
      ],
      { file: 'ses-1/history.jsonl', sessionId: ID },
    );
    expect(scan.events.map(entry => entry.sequence)).toEqual([1, 2]);
    expect(scan.pointers.map(pointer => [pointer.sequence, pointer.byteOffset, pointer.byteLength])).toEqual([
      [1, 0, 1],
      [2, 5, 1],
    ]);
    expect(scan.problems).toEqual([
      { file: 'ses-1/history.jsonl', line: 2, byteOffset: 1, message: 'line is not JSON' },
      { file: 'ses-1/history.jsonl', line: 3, byteOffset: 2, message: 'invalid event schema or session id' },
      { file: 'ses-1/history.jsonl', line: 4, byteOffset: 3, message: 'event sequence 1 is not greater than 1' },
      { file: 'ses-1/history.jsonl', line: 5, byteOffset: 4, message: 'invalid event schema or session id' },
    ]);
    expect(scan.scannedTo).toBe(6);
    expect(scan.lastSequence).toBe(2);
    expect(scan.lineAtOffset).toBe(7);
  });

  test('resumes after lines already read: positions continue from the base offset, line and sequence', () => {
    const scan = scanJournal([{ value: event(3) }, { value: event(3) }], {
      file: 'f',
      sessionId: ID,
      baseOffset: 10,
      firstLine: 11,
      previousSequence: 2,
    });
    expect(scan.pointers.map(pointer => pointer.byteOffset)).toEqual([10]);
    expect(scan.problems).toEqual([
      { file: 'f', line: 12, byteOffset: 11, message: 'event sequence 3 is not greater than 3' },
    ]);
    expect(scan.scannedTo).toBe(12);
    expect(scan.lineAtOffset).toBe(13);
    expect(scan.lastSequence).toBe(3);
  });

  test('an empty tail reads nothing and keeps the sequence it was given', () => {
    const scan = scanJournal([], { file: 'f', sessionId: ID, previousSequence: 7 });
    expect(scan).toMatchObject({ events: [], problems: [], scannedTo: 0, lastSequence: 7, lineAtOffset: 1 });
  });
});

describe('planning an index rebuild', () => {
  const journal = (lastSequence: number) => ({
    file: 'j',
    scan: { pointers: [], problems: [], scannedTo: 4, lastSequence, lineAtOffset: 5 },
    fingerprint: { device: 'state', inode: 'history', size: 4, modifiedAtMs: 0 },
  });

  test('indexes each session once, in id order, with its status, dates, last sequence and journal fingerprint', () => {
    const plan = planIndexRebuild([
      {
        id: OTHER,
        config: { file: 'c2', value: { createdAt: AT, updatedAt: '2026-11-06T10:00:00.000Z' } },
        state: { file: 's2', value: { status: 'running' } },
        journal: journal(4),
      },
      {
        id: ID,
        state: { file: 's1', value: { status: 'stopped', startedAt: AT, finishedAt: '2026-11-06T11:00:00.000Z' } },
      },
    ]);
    expect(plan.problems).toEqual([]);
    expect(plan.sessions).toEqual([
      {
        id: ID,
        status: 'stopped',
        createdAt: AT,
        updatedAt: '2026-11-06T11:00:00.000Z',
        lastSequence: 0,
        journalLine: 1,
        journal: null,
      },
      {
        id: OTHER,
        status: 'running',
        createdAt: AT,
        updatedAt: '2026-11-06T10:00:00.000Z',
        lastSequence: 4,
        journalLine: 5,
        journal: { device: 'state', inode: 'history', size: 4, modifiedAtMs: 0 },
      },
    ]);
  });

  test('falls back to the last activity and then to the creation date for the update date', () => {
    const [byActivity, byCreation] = planIndexRebuild([
      { id: ID, state: { file: 's1', value: { startedAt: AT, lastActivityAt: '2026-11-06T12:00:00.000Z' } } },
      { id: OTHER, config: { file: 'c2', value: { createdAt: AT } } },
    ]).sessions;
    expect(byActivity?.updatedAt).toBe('2026-11-06T12:00:00.000Z');
    expect(byCreation?.updatedAt).toBe(AT);
    expect(byCreation?.status).toBeUndefined();
  });

  test('reports a duplicate session once and keeps the first', () => {
    const plan = planIndexRebuild([
      { id: ID, state: { file: 'first', value: { status: 'running' } } },
      { id: ID, state: { file: 'second', value: { status: 'stopped' } } },
    ]);
    expect(plan.sessions.map(session => session.status)).toEqual(['running']);
    expect(plan.problems).toEqual([{ file: ID, line: 1, byteOffset: 0, message: `duplicate session ${ID}` }]);
  });

  test('reports an unreadable document and a date that is not an instant, and goes on without them', () => {
    const plan = planIndexRebuild([
      {
        id: ID,
        config: { file: 'config.json', problem: 'config.json is not valid JSON' },
        state: { file: 'state.json', value: { status: 'running', startedAt: 'yesterday' } },
      },
    ]);
    expect(plan.problems).toEqual([
      { file: 'config.json', line: 1, byteOffset: 0, message: 'config.json is not valid JSON' },
      { file: 'state.json', line: 1, byteOffset: 0, message: 'startedAt must be an ISO 8601 instant' },
    ]);
    expect(plan.sessions[0]).toMatchObject({ status: 'running', createdAt: undefined, updatedAt: undefined });
  });

  test('carries the problems and pointers a journal scan found', () => {
    const scanned = scanJournal([{ damaged: 'bad' }, { value: event(1) }], { file: 'j', sessionId: ID });
    const plan = planIndexRebuild([
      {
        id: ID,
        journal: {
          file: 'j',
          scan: scanned,
          fingerprint: { device: 'state', inode: 'history', size: 2, modifiedAtMs: 0 },
        },
      },
    ]);
    expect(plan.events).toEqual(scanned.pointers);
    expect(plan.problems).toEqual(scanned.problems);
    expect(plan.sessions[0]).toMatchObject({ lastSequence: 1, journalLine: 3 });
  });
});
