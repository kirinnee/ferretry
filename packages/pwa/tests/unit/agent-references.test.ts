import type { SessionView } from '@ferretry/protocol';
import { describe, test } from 'bun:test';
import should from 'should';
import { agentReferenceIdentityKey, createAgentReferenceResolver } from '../../src/lib/agent-references.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';

const daemonA = 'daemon-a' as DaemonId;
const daemonB = 'daemon-b' as DaemonId;

const NOW = Date.parse('2026-08-01T00:00:00.000Z');
const recently = new Date(NOW - 60_000).toISOString();
const longAgo = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString();

/** Only the identity fields the resolver reads are populated. */
const view = (id: string, teammate: string | undefined, createdAt = recently): SessionView =>
  ({ config: { id, teammate, createdAt } }) as unknown as SessionView;

describe('createAgentReferenceResolver', () => {
  test('should resolve a bare callsign to its session, stamped with the daemon', () => {
    // Arrange
    const resolve = createAgentReferenceResolver(daemonA, [view('s1', 'zelda')], NOW);

    // Act
    const actual = resolve({ name: 'zelda' });

    // Assert
    should(actual).deepEqual({ daemonId: daemonA, sessionId: 's1', name: 'zelda' });
  });

  test('should resolve a callsign case-insensitively', () => {
    // Arrange
    const resolve = createAgentReferenceResolver(daemonA, [view('s1', 'Zelda')], NOW);

    // Assert
    should(resolve({ name: 'ZELDA' })?.sessionId).equal('s1');
  });

  test('should never answer with another daemon identity', () => {
    // Arrange — the same callsign and session id exist on two daemons.
    const first = createAgentReferenceResolver(daemonA, [view('same-id', 'zelda')], NOW);
    const second = createAgentReferenceResolver(daemonB, [view('same-id', 'zelda')], NOW);

    // Assert
    should(first({ name: 'zelda' })?.daemonId).equal(daemonA);
    should(second({ name: 'zelda' })?.daemonId).equal(daemonB);
  });

  test('should give a reused callsign to its newest holder', () => {
    // Arrange
    const older = view('old', 'zelda', new Date(NOW - 2 * 60 * 60 * 1000).toISOString());
    const newer = view('new', 'zelda', recently);

    // Assert — order of the fleet list must not decide it.
    should(createAgentReferenceResolver(daemonA, [older, newer], NOW)({ name: 'zelda' })?.sessionId).equal('new');
    should(createAgentReferenceResolver(daemonA, [newer, older], NOW)({ name: 'zelda' })?.sessionId).equal('new');
  });

  test('should stop resolving a bare callsign once its holder falls outside the name window', () => {
    // Arrange
    const resolve = createAgentReferenceResolver(daemonA, [view('s1', 'zelda', longAgo)], NOW);

    // Assert
    should(resolve({ name: 'zelda' })).be.null();
  });

  test('should still resolve an exact session id for the whole retained fleet', () => {
    // Arrange — an old finished transcript stays referenceable by id.
    const resolve = createAgentReferenceResolver(daemonA, [view('s1', 'zelda', longAgo)], NOW);

    // Assert
    should(resolve({ sessionId: 's1' })).deepEqual({ daemonId: daemonA, sessionId: 's1', name: 'zelda' });
  });

  test('should answer nothing for an unknown session id or callsign', () => {
    // Arrange
    const resolve = createAgentReferenceResolver(daemonA, [view('s1', 'zelda')], NOW);

    // Assert
    should(resolve({ sessionId: 'absent' })).be.null();
    should(resolve({ name: 'link' })).be.null();
    should(resolve({})).be.null();
  });

  test('should skip a session with no callsign or an unusable one', () => {
    // Arrange
    const resolve = createAgentReferenceResolver(
      daemonA,
      [view('none', undefined), view('bad', '1nope'), view('spaced', '  ')],
      NOW,
    );

    // Assert
    should(resolve({ sessionId: 'none' })).be.null();
    should(resolve({ sessionId: 'bad' })).be.null();
    should(resolve({ sessionId: 'spaced' })).be.null();
  });

  test('should skip a session whose id could not be used as a path segment', () => {
    // Arrange
    const resolve = createAgentReferenceResolver(daemonA, [view('..', 'zelda'), view('.', 'link')], NOW);

    // Assert
    should(resolve({ name: 'zelda' })).be.null();
    should(resolve({ name: 'link' })).be.null();
  });

  test('should treat an unparseable creation time as the epoch rather than throwing', () => {
    // Arrange
    const resolve = createAgentReferenceResolver(daemonA, [view('s1', 'zelda', 'not-a-date')], NOW);

    // Assert — outside the name window, but still resolvable by exact id.
    should(resolve({ name: 'zelda' })).be.null();
    should(resolve({ sessionId: 's1' })?.sessionId).equal('s1');
  });

  test('should default its clock to now', () => {
    // Arrange — created a minute ago against the real clock.
    const resolve = createAgentReferenceResolver(daemonA, [
      view('s1', 'zelda', new Date(Date.now() - 60_000).toISOString()),
    ]);

    // Assert
    should(resolve({ name: 'zelda' })?.sessionId).equal('s1');
  });
});

describe('agentReferenceIdentityKey', () => {
  test('should not change when only status or activity churns', () => {
    // Arrange — the resolver copies id, callsign and creation time and nothing else.
    const before = agentReferenceIdentityKey(daemonA, [view('s1', 'zelda')]);
    const after = agentReferenceIdentityKey(daemonA, [
      { config: { id: 's1', teammate: 'zelda', createdAt: recently }, state: { health: 'thinking' } } as SessionView,
    ]);

    // Assert
    should(after).equal(before);
  });

  test('should change when a callsign is renamed or a session joins', () => {
    // Arrange
    const base = agentReferenceIdentityKey(daemonA, [view('s1', 'zelda')]);

    // Assert
    should(agentReferenceIdentityKey(daemonA, [view('s1', 'link')])).not.equal(base);
    should(agentReferenceIdentityKey(daemonA, [view('s1', 'zelda'), view('s2', 'link')])).not.equal(base);
  });

  test('should differ between two daemons carrying identical fleets', () => {
    // Assert
    should(agentReferenceIdentityKey(daemonA, [view('s1', 'zelda')])).not.equal(
      agentReferenceIdentityKey(daemonB, [view('s1', 'zelda')]),
    );
  });

  test('should ignore a session that could never be resolved', () => {
    // Assert
    should(agentReferenceIdentityKey(daemonA, [view('s1', 'zelda'), view('s2', undefined)])).equal(
      agentReferenceIdentityKey(daemonA, [view('s1', 'zelda')]),
    );
  });
});
