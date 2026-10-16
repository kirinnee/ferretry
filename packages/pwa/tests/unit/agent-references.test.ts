import type { SessionView } from '@ferretry/protocol';
import { describe, test } from 'bun:test';
import should from 'should';
import { agentReferenceIdentityKey, createAgentReferenceResolver } from '../../src/lib/agent-references.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';

const daemonA = 'daemon-a' as DaemonId;
const daemonB = 'daemon-b' as DaemonId;

/** Only the identity fields the resolver reads are populated. */
const view = (id: string, teammate: string | undefined, status = 'running'): SessionView =>
  ({ config: { id, teammate }, state: { status } }) as unknown as SessionView;

describe('createAgentReferenceResolver', () => {
  test('should resolve a bare callsign to its session, stamped with the daemon', () => {
    // Arrange
    const resolve = createAgentReferenceResolver(daemonA, [view('s1', 'zelda')]);

    // Act
    const actual = resolve({ name: 'zelda' });

    // Assert
    should(actual).deepEqual({ daemonId: daemonA, sessionId: 's1', name: 'zelda' });
  });

  test('should resolve a callsign case-insensitively', () => {
    // Arrange
    const resolve = createAgentReferenceResolver(daemonA, [view('s1', 'Zelda')]);

    // Assert
    should(resolve({ name: 'ZELDA' })?.sessionId).equal('s1');
  });

  test('should never answer with another daemon identity', () => {
    // Arrange — the same callsign and session id exist on two daemons.
    const first = createAgentReferenceResolver(daemonA, [view('same-id', 'zelda')]);
    const second = createAgentReferenceResolver(daemonB, [view('same-id', 'zelda')]);

    // Assert
    should(first({ name: 'zelda' })?.daemonId).equal(daemonA);
    should(second({ name: 'zelda' })?.daemonId).equal(daemonB);
  });

  test('should give a reused callsign to its live holder, whatever the fleet order', () => {
    // Arrange — the rule the daemon applies to `fy send zelda`, so a link and a send agree.
    const old = view('old', 'zelda', 'stopped');
    const live = view('new', 'zelda', 'waiting');

    // Assert
    should(createAgentReferenceResolver(daemonA, [old, live])({ name: 'zelda' })?.sessionId).equal('new');
    should(createAgentReferenceResolver(daemonA, [live, old])({ name: 'zelda' })?.sessionId).equal('new');
  });

  test('should resolve a lone dormant holder, and prove nothing for a tie', () => {
    // Arrange
    const lone = createAgentReferenceResolver(daemonA, [view('s1', 'zelda', 'completed')]);
    const tie = createAgentReferenceResolver(daemonA, [view('s1', 'zelda'), view('s2', 'Zelda')]);

    // Assert — an ambiguous name stays prose rather than linking to a guess.
    should(lone({ name: 'zelda' })?.sessionId).equal('s1');
    should(tie({ name: 'zelda' })).be.null();
  });

  test('should still resolve an exact session id for the whole retained fleet', () => {
    // Arrange — an old finished transcript stays referenceable by id.
    const resolve = createAgentReferenceResolver(daemonA, [view('s1', 'zelda', 'stopped')]);

    // Assert
    should(resolve({ sessionId: 's1' })).deepEqual({ daemonId: daemonA, sessionId: 's1', name: 'zelda' });
  });

  test('should answer nothing for an unknown session id or callsign', () => {
    // Arrange
    const resolve = createAgentReferenceResolver(daemonA, [view('s1', 'zelda')]);

    // Assert
    should(resolve({ sessionId: 'absent' })).be.null();
    should(resolve({ name: 'link' })).be.null();
    should(resolve({})).be.null();
  });

  test('should skip a session with no callsign or an unusable one', () => {
    // Arrange
    const resolve = createAgentReferenceResolver(daemonA, [
      view('none', undefined),
      view('bad', '1nope'),
      view('spaced', '  '),
    ]);

    // Assert
    should(resolve({ sessionId: 'none' })).be.null();
    should(resolve({ sessionId: 'bad' })).be.null();
    should(resolve({ sessionId: 'spaced' })).be.null();
  });

  test('should skip a session whose id could not be used as a path segment', () => {
    // Arrange
    const resolve = createAgentReferenceResolver(daemonA, [view('..', 'zelda'), view('.', 'link')]);

    // Assert
    should(resolve({ name: 'zelda' })).be.null();
    should(resolve({ name: 'link' })).be.null();
  });

  test('should read a snapshot that carries no state as a dormant holder', () => {
    // Arrange
    const partial = { config: { id: 's1', teammate: 'zelda' } } as unknown as SessionView;

    // Assert
    should(createAgentReferenceResolver(daemonA, [partial])({ name: 'zelda' })?.sessionId).equal('s1');
  });
});

describe('agentReferenceIdentityKey', () => {
  test('should not change when only status or activity churns', () => {
    // Arrange — the resolver copies id, callsign and liveness and nothing else.
    const before = agentReferenceIdentityKey(daemonA, [view('s1', 'zelda', 'running')]);
    const after = agentReferenceIdentityKey(daemonA, [view('s1', 'zelda', 'thinking')]);

    // Assert
    should(after).equal(before);
  });

  test('should change when a holder goes dormant, because that can move the name', () => {
    // Assert
    should(agentReferenceIdentityKey(daemonA, [view('s1', 'zelda', 'stopped')])).not.equal(
      agentReferenceIdentityKey(daemonA, [view('s1', 'zelda', 'running')]),
    );
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
