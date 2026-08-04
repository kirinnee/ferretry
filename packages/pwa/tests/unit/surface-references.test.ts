import { describe, test } from 'bun:test';
import type { TerminalListView, TerminalView } from '@ferretry/protocol';
import should from 'should';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  createSurfaceReferenceResolver,
  describeSurfaceOwnership,
  sessionSurfaces,
  surfaceReferenceIdentityKey,
} from '../../src/lib/surface-references.ts';

const daemonA = 'daemon-a' as DaemonId;
const daemonB = 'daemon-b' as DaemonId;
const connection = (daemonId: DaemonId) => ({ daemonId }) as unknown as Parameters<typeof daemonSessionScope>[0];
const scopeA = daemonSessionScope(connection(daemonA), 'sess-1');
const scopeB = daemonSessionScope(connection(daemonB), 'sess-1');

const FIRST = 'a1b2c3d4e5f6';
const SECOND = '0f0e0d0c0b0a';

const terminal = (id: string, title: string, viewers = 1): TerminalView =>
  ({
    id,
    sessionId: 'sess-1',
    title,
    state: 'running',
    cols: 80,
    rows: 24,
    viewers,
    createdAt: '2026-08-01T10:00:00.000Z',
    lastActivityAt: '2026-08-01T10:05:00.000Z',
  }) satisfies TerminalView;

const listing = (terminals: readonly TerminalView[], sessionId = 'sess-1'): TerminalListView =>
  ({
    sessionId,
    terminals: [...terminals],
    limits: {
      perSession: 6,
      global: 24,
      runningGlobal: terminals.length,
      idleTimeoutSeconds: 900,
      scrollbackLines: 5_000,
    },
  }) satisfies TerminalListView;

describe('sessionSurfaces', () => {
  test('should project each terminal into an addressable row carrying its canonical token', () => {
    // Act
    const actual = sessionSurfaces(scopeA, listing([terminal(FIRST, 'build')]));

    // Assert
    should(actual).deepEqual([
      {
        surface: 'terminal',
        key: FIRST,
        token: `%terminal:${FIRST}`,
        title: 'build',
        ownership: { by: 'unrecorded' },
        viewers: 1,
        lastActivityAt: '2026-08-01T10:05:00.000Z',
      },
    ]);
  });

  test('should carry the opener the daemon attested, and absence as absence', () => {
    // Act
    const owned = sessionSurfaces(scopeA, listing([{ ...terminal(FIRST, 'build'), openedBy: { by: 'local' } }]));
    const silent = sessionSurfaces(scopeA, listing([terminal(SECOND, 'logs')]));

    // Assert
    should(owned[0]?.ownership).deepEqual({ by: 'local' });
    // A daemon that recorded nothing is reported as having recorded nothing.
    // Defaulting to the reader's own device here would tell them nobody else is
    // in a shell an agent may be driving.
    should(silent[0]?.ownership).deepEqual({ by: 'unrecorded' });
  });

  test('should keep the daemon listing order rather than resorting under the reader', () => {
    // Act
    const actual = sessionSurfaces(scopeA, listing([terminal(SECOND, 'second'), terminal(FIRST, 'first')]));

    // Assert
    should(actual.map(row => row.key)).deepEqual([SECOND, FIRST]);
  });

  test('should offer nothing at all without a listing', () => {
    // Assert
    should(sessionSurfaces(scopeA, null)).deepEqual([]);
    should(sessionSurfaces(scopeA, undefined)).deepEqual([]);
  });

  test('should refuse to read another session listing as this session', () => {
    // Assert
    should(sessionSurfaces(scopeA, listing([terminal(FIRST, 'build')], 'sess-2'))).deepEqual([]);
  });
});

describe('createSurfaceReferenceResolver', () => {
  test('should prove a listed terminal and stamp it with this daemon and session', () => {
    // Arrange
    const resolve = createSurfaceReferenceResolver(scopeA, listing([terminal(FIRST, 'build')]));

    // Act
    const actual = resolve({ kind: 'surface', surface: 'terminal', key: FIRST });

    // Assert
    should(actual).deepEqual({
      state: 'open',
      daemonId: daemonA,
      sessionId: 'sess-1',
      surface: 'terminal',
      key: FIRST,
    });
  });

  test('should report a terminal missing from the complete listing as closed', () => {
    // Arrange
    const resolve = createSurfaceReferenceResolver(scopeA, listing([terminal(FIRST, 'build')]));

    // Assert
    should(resolve({ kind: 'surface', surface: 'terminal', key: SECOND })).deepEqual({ state: 'closed' });
  });

  test('should report every terminal as closed once the session holds none', () => {
    // Arrange — an empty listing is still authoritative evidence.
    const resolve = createSurfaceReferenceResolver(scopeA, listing([]));

    // Assert
    should(resolve({ kind: 'surface', surface: 'terminal', key: FIRST })).deepEqual({ state: 'closed' });
  });

  test('should answer nothing at all when no listing has been fetched', () => {
    // Assert — damaged state is not empty state: no evidence proves nothing.
    should(
      createSurfaceReferenceResolver(scopeA, null)({ kind: 'surface', surface: 'terminal', key: FIRST }),
    ).be.undefined();
    should(
      createSurfaceReferenceResolver(scopeA, undefined)({ kind: 'surface', surface: 'terminal', key: FIRST }),
    ).be.undefined();
  });

  test('should never answer from another session listing, in either direction', () => {
    // Arrange — the same terminal id, listed under a different session.
    const resolve = createSurfaceReferenceResolver(scopeA, listing([terminal(FIRST, 'build')], 'sess-2'));

    // Assert
    should(resolve({ kind: 'surface', surface: 'terminal', key: FIRST })).be.undefined();
  });

  test('should never leak one daemon terminal into another daemon answer', () => {
    // Arrange — two daemons, one session id, one terminal id.
    const first = createSurfaceReferenceResolver(scopeA, listing([terminal(FIRST, 'build')]));
    const second = createSurfaceReferenceResolver(scopeB, listing([terminal(FIRST, 'build')]));

    // Assert
    should(first({ kind: 'surface', surface: 'terminal', key: FIRST })).have.property('daemonId', daemonA);
    should(second({ kind: 'surface', surface: 'terminal', key: FIRST })).have.property('daemonId', daemonB);
  });

  test('should leave a browser page unproved rather than calling it closed', () => {
    // Arrange — there is no browser worker, so this module holds no page evidence.
    const resolve = createSurfaceReferenceResolver(scopeA, listing([terminal(FIRST, 'build')]));

    // Assert
    should(resolve({ kind: 'surface', surface: 'browser', key: 'page-1' })).be.undefined();
  });
});

describe('surfaceReferenceIdentityKey', () => {
  test('should change when a terminal opens or closes', () => {
    // Arrange
    const one = surfaceReferenceIdentityKey(scopeA, listing([terminal(FIRST, 'build')]));

    // Assert
    should(
      surfaceReferenceIdentityKey(scopeA, listing([terminal(FIRST, 'build'), terminal(SECOND, 'test')])),
    ).not.equal(one);
    should(surfaceReferenceIdentityKey(scopeA, listing([]))).not.equal(one);
  });

  test('should not change when only activity or titles churn', () => {
    // Assert — a retitled terminal is the same referenceable surface.
    should(surfaceReferenceIdentityKey(scopeA, listing([terminal(FIRST, 'renamed', 3)]))).equal(
      surfaceReferenceIdentityKey(scopeA, listing([terminal(FIRST, 'build')])),
    );
  });

  test('should distinguish an absent listing from an empty one', () => {
    // Assert
    should(surfaceReferenceIdentityKey(scopeA, null)).not.equal(surfaceReferenceIdentityKey(scopeA, listing([])));
    should(surfaceReferenceIdentityKey(scopeA, listing([terminal(FIRST, 'x')], 'sess-2'))).equal(
      surfaceReferenceIdentityKey(scopeA, null),
    );
  });

  test('should distinguish two daemons holding identical terminals', () => {
    // Assert
    should(surfaceReferenceIdentityKey(scopeA, listing([terminal(FIRST, 'x')]))).not.equal(
      surfaceReferenceIdentityKey(scopeB, listing([terminal(FIRST, 'x')])),
    );
  });
});

describe('describeSurfaceOwnership', () => {
  test('should reserve the warning tone for a shell an agent is driving', () => {
    // The tone is the fast read. Colouring "unrecorded" like a hazard would
    // teach the reader to ignore the colour that actually means "something else
    // is typing in here".
    // Act
    const agent = describeSurfaceOwnership({ by: 'agent', sessionId: 'mse7wwti' });
    const device = describeSurfaceOwnership({ by: 'human', deviceId: 'device-7f3a' });
    const host = describeSurfaceOwnership({ by: 'local' });
    const silent = describeSurfaceOwnership({ by: 'unrecorded' });

    // Assert
    should(agent).deepEqual({ text: 'Opened by an agent', tone: 'warn', detail: 'agent session mse7wwti' });
    should(device).deepEqual({
      text: 'Opened from a paired device',
      tone: 'accent',
      detail: 'device device-7f3a',
    });
    should(host).deepEqual({ text: 'Opened on the daemon host', tone: 'accent' });
    should(silent).deepEqual({ text: 'Owner unrecorded', tone: 'pend' });
  });

  test('should offer no identity detail for the classes that have none', () => {
    // Assert — a detail invented for `local` or `unrecorded` would be a claim
    // about an identity the daemon never attested.
    should(describeSurfaceOwnership({ by: 'local' }).detail).be.undefined();
    should(describeSurfaceOwnership({ by: 'unrecorded' }).detail).be.undefined();
  });
});
