import { describe, it } from 'bun:test';
import should from 'should';
import {
  ARCHIVE_AFTER_MS_DEFAULT,
  ARCHIVE_AFTER_VARIABLE,
  type ArchiveFacts,
  type ArchiveSession,
  childrenStaying,
  decideArchive,
  parseArchiveAfter,
  selfKeepReason,
  unknownLineageBlocks,
} from '../../../../src/lib/session/archive/policy.ts';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(NOW - hours * HOUR).toISOString();

function facts(overrides: Partial<ArchiveFacts> = {}): ArchiveFacts {
  return { nowMs: NOW, afterMs: 24 * HOUR, kept: new Map(), limit: 1_000, ...overrides };
}

function session(id: string, overrides: Partial<ArchiveSession> = {}): ArchiveSession {
  return { id, mode: 'auto', status: 'completed', finishedAt: ago(48), parent: undefined, ...overrides };
}

describe('session archive policy', () => {
  it('should archive an autonomous session that ended more than a day ago', () => {
    should(decideArchive([session('a')], facts()).archive).deepEqual(['a']);
  });

  it('should never touch an interactive session, however old', () => {
    const old = session('a', { mode: 'interactive', finishedAt: ago(24 * 365) });
    should(decideArchive([old], facts()).archive).deepEqual([]);
    should(selfKeepReason(old, facts())).equal('interactive');
  });

  it('should keep a session whose mode is not known', () => {
    should(selfKeepReason(session('a', { mode: undefined }), facts())).equal('interactive');
  });

  it('should keep a session that has not ended', () => {
    for (const status of ['running', 'thinking', 'waiting', 'kill_failed', 'unknown'])
      should(selfKeepReason(session('a', { status }), facts())).equal('running');
  });

  it('should archive each of the four ended statuses', () => {
    for (const status of ['completed', 'failed', 'stalled', 'stopped'])
      should(selfKeepReason(session('a', { status }), facts())).be.undefined();
  });

  it('should keep an ended session whose end time is missing or unreadable', () => {
    should(selfKeepReason(session('a', { finishedAt: undefined }), facts())).equal('no-end-time');
    should(selfKeepReason(session('a', { finishedAt: 'yesterday' }), facts())).equal('no-end-time');
  });

  it('should keep a session that ended inside the window and take it once the window passes', () => {
    should(selfKeepReason(session('a', { finishedAt: ago(23) }), facts())).equal('too-recent');
    should(selfKeepReason(session('a', { finishedAt: ago(24) }), facts())).be.undefined();
  });

  it('should keep a session something outside it keeps, and say why', () => {
    const kept = new Map([['a', 'pinned']]);
    should(decideArchive([session('a'), session('b')], facts({ kept })).archive).deepEqual(['b']);
    should(selfKeepReason(session('a'), facts({ kept }))).equal('kept-by-signal');
  });

  it('should keep a lead while any of its sub-ferrets is live', () => {
    const lead = session('lead');
    const running = session('child', { parent: 'lead', status: 'running', finishedAt: undefined });
    should(decideArchive([lead, running], facts()).archive).deepEqual([]);
  });

  it('should keep a lead whose child is interactive, recent, kept or unreadable', () => {
    for (const child of [
      session('child', { parent: 'lead', mode: 'interactive' }),
      session('child', { parent: 'lead', finishedAt: ago(1) }),
      session('child', { parent: 'lead', mode: undefined, status: 'unknown', finishedAt: undefined }),
    ])
      should(decideArchive([session('lead'), child], facts()).archive).deepEqual([]);
    const kept = new Map([['child', 'pinned']]);
    should(decideArchive([session('lead'), session('child', { parent: 'lead' })], facts({ kept })).archive).deepEqual(
      [],
    );
  });

  it('should archive a lead together with children that are all archivable, children first', () => {
    const sessions = [
      session('lead', { finishedAt: ago(30) }),
      session('one', { parent: 'lead', finishedAt: ago(50) }),
      session('two', { parent: 'lead', finishedAt: ago(40) }),
    ];
    should(decideArchive(sessions, facts()).archive).deepEqual(['one', 'two', 'lead']);
  });

  it('should keep a lead past its own end while a grandchild is live', () => {
    const sessions = [
      session('lead'),
      session('mid', { parent: 'lead' }),
      session('leaf', { parent: 'mid', status: 'running', finishedAt: undefined }),
    ];
    should(decideArchive(sessions, facts()).archive).deepEqual([]);
  });

  it('should ignore a parent that names no live session and one that names itself', () => {
    const sessions = [session('a', { parent: 'long-gone' }), session('b', { parent: 'b' })];
    should([...decideArchive(sessions, facts()).archive].sort()).deepEqual(['a', 'b']);
  });

  it('should survive a lineage loop by keeping both ends', () => {
    const sessions = [session('a', { parent: 'b' }), session('b', { parent: 'a' })];
    should(decideArchive(sessions, facts()).archive).deepEqual([]);
  });

  it('should bound a pass, oldest first and children before their lead, and say how many wait', () => {
    const sessions = [
      session('new', { finishedAt: ago(30) }),
      session('old', { finishedAt: ago(90) }),
      session('mid', { finishedAt: ago(60) }),
    ];
    const decision = decideArchive(sessions, facts({ limit: 2 }));
    should(decision.archive).deepEqual(['old', 'mid']);
    should(decision.deferred).equal(1);
  });

  it('should never cut a lead in without the children that come before it', () => {
    const sessions = [
      session('lead', { finishedAt: ago(100) }),
      session('one', { parent: 'lead', finishedAt: ago(30) }),
      session('two', { parent: 'lead', finishedAt: ago(31) }),
    ];
    // The lead ended first, but it can only follow its children out.
    should(decideArchive(sessions, facts({ limit: 2 })).archive).deepEqual(['two', 'one']);
  });

  it('should archive nothing at a limit of zero', () => {
    should(decideArchive([session('a')], facts({ limit: 0 }))).deepEqual({ archive: [], deferred: 1 });
  });
});

describe('a session whose lineage is unknown', () => {
  it('should keep every lead live while a running session cannot say whose child it is', () => {
    const decision = decideArchive(
      [session('lead-1'), session('kid-1', { status: 'running', finishedAt: undefined, parentUnknown: true })],
      facts(),
    );

    should(decision.archive).deepEqual([]);
    should(decision.deferred).equal(1);
  });

  it('should keep every lead live while an unreadable session has no end time', () => {
    should(
      decideArchive(
        [
          session('lead-1'),
          session('torn-1', { mode: undefined, status: 'unknown', finishedAt: undefined, parentUnknown: true }),
        ],
        facts(),
      ).archive,
    ).deepEqual([]);
  });

  it('should keep leads live while an unreadable session ended too recently to have aged out', () => {
    should(unknownLineageBlocks([session('torn-1', { parentUnknown: true, finishedAt: ago(2) })])).be.true();
  });

  it('should keep possible leads while an unreadable ended session remains live', () => {
    const torn = session('torn-1', { mode: undefined, parentUnknown: true, finishedAt: ago(100) });

    should(unknownLineageBlocks([torn])).be.true();
    should(decideArchive([session('lead-1'), torn], facts()).archive).deepEqual([]);
  });

  it('should not block when every lineage is known', () => {
    should(unknownLineageBlocks([session('a'), session('b', { parent: 'a' })])).be.false();
  });
});

describe('the sessions that keep a lead live at the commit boundary', () => {
  const live = [
    session('lead-1'),
    session('kid-1', { parent: 'lead-1' }),
    session('kid-2', { parent: 'lead-1' }),
    session('other-1', { parent: 'else-1' }),
  ];

  it('should name every child that is not on its way out', () => {
    should(childrenStaying('lead-1', live, new Set(['kid-1']))).deepEqual(['kid-2']);
  });

  it('should name none once every child is leaving', () => {
    should(childrenStaying('lead-1', live, new Set(['kid-1', 'kid-2']))).deepEqual([]);
  });

  it('should not count a session as its own child', () => {
    should(childrenStaying('loop-1', [session('loop-1', { parent: 'loop-1' })], new Set())).deepEqual([]);
  });
});

describe('the archive age setting', () => {
  it('should default to off until explicitly enabled', () => {
    should(parseArchiveAfter(undefined)).be.undefined();
    should(parseArchiveAfter('  ')).be.undefined();
  });

  it('should take a whole number of hours', () => {
    should(parseArchiveAfter('24')).equal(ARCHIVE_AFTER_MS_DEFAULT);
    should(parseArchiveAfter('72')).equal(72 * HOUR);
  });

  it('should be switched off by "off"', () => {
    should(parseArchiveAfter('OFF')).be.undefined();
  });

  it('should refuse anything else, naming the variable', () => {
    for (const bad of ['0', '-3', '1.5', 'a day', '24h'])
      should(() => parseArchiveAfter(bad)).throw(new RegExp(ARCHIVE_AFTER_VARIABLE));
  });
});
