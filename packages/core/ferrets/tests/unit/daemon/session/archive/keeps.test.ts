import { describe, it } from 'bun:test';
import should from 'should';
import { type ArchiveKeepSources, sessionKeeps } from '../../../../../daemon/lib/session/archive/keeps.ts';

function sources(overrides: Partial<ArchiveKeepSources> = {}): ArchiveKeepSources {
  return {
    pinned: async () => new Set(),
    onOpenCards: async () => new Set(),
    hasOpenAgendaItem: async () => false,
    ...overrides,
  };
}

describe('what keeps a finished session live', () => {
  it('should keep nothing when nothing names the sessions', async () => {
    should([...(await sessionKeeps(sources(), ['a', 'b']))]).deepEqual([]);
  });

  it('should keep a pinned session, one on an open card and one with an open agenda item, each with its reason', async () => {
    const kept = await sessionKeeps(
      sources({
        pinned: async () => new Set(['a']),
        onOpenCards: async () => new Set(['b']),
        hasOpenAgendaItem: async id => id === 'c',
      }),
      ['a', 'b', 'c', 'd'],
    );
    should([...kept]).deepEqual([
      ['a', 'pinned'],
      ['b', 'on a card still in flight'],
      ['c', 'open agenda item'],
    ]);
  });

  it('should keep every session when the pins cannot be read', async () => {
    const kept = await sessionKeeps(
      sources({
        pinned: async () => {
          throw new Error('damaged');
        },
      }),
      ['a', 'b'],
    );
    should([...kept.values()]).deepEqual(['pins unreadable', 'pins unreadable']);
  });

  it('should keep every session when the board cannot be read', async () => {
    const kept = await sessionKeeps(
      sources({
        onOpenCards: async () => {
          throw new Error('quarantined');
        },
      }),
      ['a'],
    );
    should(kept.get('a')).equal('board unreadable');
  });

  it('should keep only the session whose agenda cannot be read', async () => {
    const kept = await sessionKeeps(
      sources({
        hasOpenAgendaItem: async id => {
          if (id === 'bad') throw new Error('torn file');
          return false;
        },
      }),
      ['ok', 'bad'],
    );
    should([...kept]).deepEqual([['bad', 'agenda unreadable']]);
  });

  it('should read agenda boards a few at a time, never all at once', async () => {
    let live = 0;
    let peak = 0;
    const ids = Array.from({ length: 40 }, (_, at) => `s${String(at)}`);
    await sessionKeeps(
      sources({
        hasOpenAgendaItem: async () => {
          live += 1;
          peak = Math.max(peak, live);
          await Promise.resolve();
          live -= 1;
          return false;
        },
      }),
      ids,
    );
    should(peak).be.belowOrEqual(8);
    should(peak).be.above(1);
  });
});
