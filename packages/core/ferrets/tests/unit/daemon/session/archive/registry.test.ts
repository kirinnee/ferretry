import { describe, it } from 'bun:test';
import should from 'should';
import {
  type ArchivedSession,
  parseArchiveRegistry,
  serializeArchiveRegistry,
} from '../../../../../daemon/lib/session/archive/registry.ts';
import { parseSessionId, type SessionId } from '../../../../../daemon/lib/session-id.ts';

const entry = (id: string, overrides: Partial<ArchivedSession['indexed']> = {}): [SessionId, ArchivedSession] => [
  parseSessionId(id),
  {
    archivedAt: '2026-11-06T12:00:00.000Z',
    indexed: {
      id: parseSessionId(id),
      status: 'completed',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
      lastSequence: 7,
      journalLine: 8,
      journal: { device: '1', inode: '2', size: 300, modifiedAtMs: 1_700_000_000_000 },
      ...overrides,
    },
  },
];

describe('the archive registry document', () => {
  it('should round-trip every archived session with the index row it had', () => {
    const named = entry('b-1');
    const sessions = new Map([
      [
        named[0],
        {
          ...named[1],
          name: 'mika',
          configTimes: { createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' },
        },
      ],
      entry('a-1', { journal: null, status: undefined }),
    ]);

    const parsed = parseArchiveRegistry(serializeArchiveRegistry(sessions));

    should(parsed).not.be.undefined();
    should([...(parsed ?? [])].map(([id]) => id)).deepEqual(['a-1', 'b-1']);
    should(parsed?.get(parseSessionId('b-1'))).deepEqual(sessions.get(parseSessionId('b-1')));
    should(parsed?.get(parseSessionId('b-1'))?.name).equal('mika');
    should(parsed?.get(parseSessionId('b-1'))?.configTimes).deepEqual({
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    });
    should(parsed?.get(parseSessionId('a-1'))?.name).be.undefined();
    should(parsed?.get(parseSessionId('a-1'))?.configTimes).be.undefined();
    should(parsed?.get(parseSessionId('a-1'))?.indexed.journal).be.null();
    should(parsed?.get(parseSessionId('a-1'))?.indexed.status).be.undefined();
  });

  it('should write the same bytes for the same set whatever order it was built in', () => {
    const forwards = serializeArchiveRegistry(new Map([entry('a-1'), entry('b-1')]));
    const backwards = serializeArchiveRegistry(new Map([entry('b-1'), entry('a-1')]));
    should(forwards).equal(backwards);
  });

  it('should read an absent document as an empty registry', () => {
    should(parseArchiveRegistry(undefined)?.size).equal(0);
  });

  it('should refuse a damaged document or one from a newer shape, so the caller starts empty', () => {
    should(parseArchiveRegistry('{not json')).be.undefined();
    should(parseArchiveRegistry('{"version":2,"sessions":{}}')).be.undefined();
    should(parseArchiveRegistry('{"version":1,"sessions":{"a":{"archivedAt":"nope"}}}')).be.undefined();
  });

  it('should skip an entry whose id could never be a session directory', () => {
    const text = serializeArchiveRegistry(new Map([entry('a-1')])).replace('"a-1"', '"../escape"');
    should(parseArchiveRegistry(text)?.size).equal(0);
  });
});
