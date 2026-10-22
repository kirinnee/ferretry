import { describe, it } from 'bun:test';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiRouter } from '../../../../src/lib/api/index.ts';
import { ApiSocketDispatcher, type SocketDownstream, type SocketHandler } from '../../../../src/lib/api/socket.ts';
import { fleetEventSocketRoutes } from '../../../../src/lib/runtime/index.ts';
import type { FleetEventStreamSubsystem } from '../../../../src/lib/runtime/mounts/fleet-events.ts';
import { FLEET_EVENT_BACKLOG_LIMIT, type FleetEventStreamScope } from '../../../../src/lib/session/events/index.ts';
import { request } from '../../api/support.ts';
import { CREDENTIALS, human, sessionDirectory, sessionView } from './support.ts';

/**
 * The handshake half of the live event feed.
 *
 * Everything a client can be told with a STATUS has to be settled before the protocol switches. A
 * socket that upgraded and then closed cannot say whether the session was unknown, the cursor was
 * unusable or the daemon broke — and a client watching how fast each socket died could map which
 * sessions exist. So an unknown session is a 404 on the handshake, and every query the daemon cannot
 * honour is a stated refusal rather than a quietly different subscription.
 *
 * The fleet cursor is the refusal worth reading twice. There is no global sequence domain across
 * sessions, so `?after=N` without a session id cannot be honoured by anything: accepting it would
 * hand back a bounded recent tail while the caller believed it had resumed exactly where it stopped.
 */

const wardenToken = { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' } as const;

/** Records the scope each accepted socket was bound to, instead of following a journal. */
class RecordingFleetEvents implements FleetEventStreamSubsystem {
  readonly scopes: FleetEventStreamScope[] = [];

  handler(scope: FleetEventStreamScope, downstream: SocketDownstream): SocketHandler {
    this.scopes.push(scope);
    return {
      open: async () => {
        downstream.send(JSON.stringify(scope));
      },
      fromClient: () => undefined,
      close: () => undefined,
    };
  }
}

/** Counts the configuration streams it was asked for, instead of following a ledger. */
class RecordingConfigChanges {
  opened = 0;

  handler(downstream: SocketDownstream): SocketHandler {
    this.opened += 1;
    return {
      open: async () => {
        downstream.send('config');
      },
      fromClient: () => undefined,
      close: () => undefined,
    };
  }
}

function fixture(events: RecordingFleetEvents = new RecordingFleetEvents()) {
  const configChanges = new RecordingConfigChanges();
  const dispatcher = new ApiSocketDispatcher(
    new ApiRouter([...fleetEventSocketRoutes(events, sessionDirectory([sessionView('s1')]), configChanges)]),
    CREDENTIALS,
    NO_GOVERNED_ROUTES_GUARD,
  );
  return { events, dispatcher, configChanges };
}

/** A socket that discards, for cases interested in the scope the attachment was bound to. */
const discarding: SocketDownstream = { send: () => 1, close: () => undefined, bufferedBytes: () => 0 };

/**
 * Binds an accepted upgrade to a socket.
 *
 * The scope is decided during `accept`, on the handshake, but no handler exists until the transport
 * actually supplies a socket — which is what keeps a refused upgrade from ever holding a journal
 * subscription. So a case asserting the scope has to attach.
 */
async function attach(decision: Awaited<ReturnType<ApiSocketDispatcher['upgrade']>>): Promise<void> {
  if (decision.outcome === 'accepted') await decision.attach(discarding);
}

/** The status a refused upgrade carried, or zero when the upgrade was accepted. */
function refusedStatus(decision: Awaited<ReturnType<ApiSocketDispatcher['upgrade']>>): number {
  return decision.outcome === 'refused' ? decision.response.status : 0;
}

/** The error code a refused upgrade carried. */
function refusedCode(decision: Awaited<ReturnType<ApiSocketDispatcher['upgrade']>>): string | undefined {
  if (decision.outcome !== 'refused') return undefined;
  return (JSON.parse(decision.response.body) as { readonly code?: string }).code;
}

describe('the mounted fleet event feed', () => {
  it('should open the configuration stream for the config topic, and no session stream', async () => {
    // Arrange
    const { events, dispatcher, configChanges } = fixture();
    const sent: string[] = [];
    const downstream: SocketDownstream = {
      send: frame => sent.push(String(frame)),
      close: () => undefined,
      bufferedBytes: () => 0,
    };

    // Act
    const decision = await dispatcher.upgrade(
      request({ path: '/v1/events', query: [['topic', 'config']], headers: human }),
    );
    if (decision.outcome === 'accepted') await (await decision.attach(downstream)).open();

    // Assert — the topic is its own stream: no session or fleet tail is replayed into it.
    should(decision.outcome).equal('accepted');
    should(configChanges.opened).equal(1);
    should(sent).deepEqual(['config']);
    should(events.scopes).be.empty();
  });

  it('should refuse a topic it does not serve, and a config topic with a session filter', async () => {
    // Arrange
    const { dispatcher, configChanges } = fixture();

    // Act
    const unknown = await dispatcher.upgrade(
      request({ path: '/v1/events', query: [['topic', 'sessions']], headers: human }),
    );
    const filtered = await dispatcher.upgrade(
      request({
        path: '/v1/events',
        query: [
          ['topic', 'config'],
          ['sessionId', 's1'],
        ],
        headers: human,
      }),
    );
    const twice = await dispatcher.upgrade(
      request({
        path: '/v1/events',
        query: [
          ['topic', 'config'],
          ['topic', 'config'],
        ],
        headers: human,
      }),
    );

    // Assert — a filter the configuration stream ignores would promise something it does not do.
    should([unknown, filtered, twice].map(refusedStatus)).deepEqual([400, 400, 400]);
    should(new Set([unknown, filtered, twice].map(refusedCode))).deepEqual(new Set(['invalid_query']));
    should(configChanges.opened).equal(0);
  });

  it('should follow the whole fleet when no session is named', async () => {
    // Arrange
    const { events, dispatcher } = fixture();

    // Act
    const decision = await dispatcher.upgrade(request({ path: '/v1/events', headers: human }));
    await attach(decision);

    // Assert
    should(decision.outcome).equal('accepted');
    should(events.scopes).deepEqual([{ kind: 'fleet' }]);
  });

  it('should follow one session at the cursor the caller gave', async () => {
    // Arrange
    const { events, dispatcher } = fixture();

    // Act
    const decision = await dispatcher.upgrade(
      request({
        path: '/v1/events',
        query: [
          ['sessionId', 's1'],
          ['after', '17'],
        ],
        headers: human,
      }),
    );
    await attach(decision);

    // Assert — the cursor reaches the handler, so a follower resuming after a disconnect is not
    // silently replayed from the beginning of the session.
    should(decision.outcome).equal('accepted');
    should(events.scopes).deepEqual([{ kind: 'session', sessionId: 's1', after: 17 }]);
  });

  it('should bind the accepted upgrade to the socket it actually got', async () => {
    // Arrange
    const { dispatcher } = fixture();
    const sent: string[] = [];
    const downstream: SocketDownstream = {
      send: frame => sent.push(typeof frame === 'string' ? frame : new TextDecoder().decode(frame)),
      close: () => undefined,
      bufferedBytes: () => 0,
    };

    // Act
    const decision = await dispatcher.upgrade(
      request({ path: '/v1/events', query: [['sessionId', 's1']], headers: human }),
    );
    if (decision.outcome === 'accepted') await (await decision.attach(downstream)).open();

    // Assert
    should(sent).deepEqual([JSON.stringify({ kind: 'session', sessionId: 's1', after: 0 })]);
  });

  it('should refuse a fleet cursor it has no global sequence for', async () => {
    // Arrange
    const { events, dispatcher } = fixture();

    // Act
    const decision = await dispatcher.upgrade(request({ path: '/v1/events', query: [['after', '5']], headers: human }));

    // Assert — honouring it would answer a bounded recent tail to a caller that believed it resumed.
    should(refusedStatus(decision)).equal(400);
    should(refusedCode(decision)).equal('fleet_cursor_unavailable');
    should(events.scopes).be.empty();
  });

  it('should accept an explicit zero cursor on a fleet stream', async () => {
    // Arrange — `--after 0` is "from whatever you have", which the bounded tail genuinely answers.
    const { events, dispatcher } = fixture();

    // Act
    const decision = await dispatcher.upgrade(request({ path: '/v1/events', query: [['after', '0']], headers: human }));
    await attach(decision);

    // Assert
    should(decision.outcome).equal('accepted');
    should(events.scopes).deepEqual([{ kind: 'fleet' }]);
  });

  it('should bound a fleet stream by the tail the caller named, zero and the ceiling included', async () => {
    // Arrange — `tail=0` is the reader that has just read the list and wants only what happens next.
    const { events, dispatcher } = fixture();

    // Act
    for (const tail of ['0', '25', String(FLEET_EVENT_BACKLOG_LIMIT)])
      await attach(await dispatcher.upgrade(request({ path: '/v1/events', query: [['tail', tail]], headers: human })));

    // Assert
    should(events.scopes).deepEqual([
      { kind: 'fleet', tail: 0 },
      { kind: 'fleet', tail: 25 },
      { kind: 'fleet', tail: FLEET_EVENT_BACKLOG_LIMIT },
    ]);
  });

  it('should refuse a tail that is not a plain integer within the bound', async () => {
    // Arrange
    const { events, dispatcher } = fixture();

    // Act
    const decisions = [];
    for (const value of ['', 'all', '-1', '1.5', '1e3', ' 4', String(FLEET_EVENT_BACKLOG_LIMIT + 1)])
      decisions.push(
        await dispatcher.upgrade(request({ path: '/v1/events', query: [['tail', value]], headers: human })),
      );
    decisions.push(
      await dispatcher.upgrade(
        request({
          path: '/v1/events',
          query: [
            ['tail', '0'],
            ['tail', '1'],
          ],
          headers: human,
        }),
      ),
    );

    // Assert — a tail past the bound would be a promise of history the daemon does not replay.
    should(decisions.map(refusedStatus)).deepEqual([400, 400, 400, 400, 400, 400, 400, 400]);
    should(new Set(decisions.map(refusedCode))).deepEqual(new Set(['invalid_query']));
    should(events.scopes).be.empty();
  });

  it('should refuse a tail on a session stream, which resumes from its own cursor', async () => {
    // Arrange
    const { events, dispatcher } = fixture();

    // Act
    const decision = await dispatcher.upgrade(
      request({
        path: '/v1/events',
        query: [
          ['sessionId', 's1'],
          ['tail', '0'],
        ],
        headers: human,
      }),
    );

    // Assert
    should(refusedStatus(decision)).equal(400);
    should(refusedCode(decision)).equal('tail_needs_fleet');
    should(events.scopes).be.empty();
  });

  it('should refuse a cursor that is not a plain non-negative integer', async () => {
    // Arrange
    const { dispatcher } = fixture();

    // Act
    const decisions = [];
    for (const value of ['latest', '-1', '1.5', '1e3', ' 4', '0x10'])
      decisions.push(
        await dispatcher.upgrade(
          request({
            path: '/v1/events',
            query: [
              ['sessionId', 's1'],
              ['after', value],
            ],
            headers: human,
          }),
        ),
      );

    // Assert — falling back to the default would resume a follower at the start of the session.
    should(decisions.map(refusedStatus)).deepEqual([400, 400, 400, 400, 400, 400]);
    should(new Set(decisions.map(refusedCode))).deepEqual(new Set(['invalid_query']));
  });

  it('should refuse a parameter given twice rather than picking one', async () => {
    // Arrange
    const { dispatcher } = fixture();

    // Act
    const decision = await dispatcher.upgrade(
      request({
        path: '/v1/events',
        query: [
          ['after', '1'],
          ['after', '2'],
        ],
        headers: human,
      }),
    );

    // Assert — two cursors is a client mistake, and choosing silently makes the resume wrong.
    should(refusedStatus(decision)).equal(400);
    should(refusedCode(decision)).equal('invalid_query');
  });

  it('should hand a live readout request to the one session it follows', async () => {
    // Arrange
    const { events, dispatcher } = fixture();

    // Act
    const decision = await dispatcher.upgrade(
      request({
        path: '/v1/events',
        query: [
          ['sessionId', 's1'],
          ['live', '1'],
        ],
        headers: human,
      }),
    );
    await attach(decision);

    // Assert — the flag reaches the handler, and a stream that did not ask carries no `live` key at all.
    should(decision.outcome).equal('accepted');
    should(events.scopes).deepEqual([{ kind: 'session', sessionId: 's1', after: 0, live: true }]);
  });

  it('should refuse a live value other than the flag, rather than guess what was meant', async () => {
    // Arrange
    const { events, dispatcher } = fixture();

    // Act
    const decisions = [];
    for (const value of ['0', 'true', '', '2'])
      decisions.push(
        await dispatcher.upgrade(
          request({
            path: '/v1/events',
            query: [
              ['sessionId', 's1'],
              ['live', value],
            ],
            headers: human,
          }),
        ),
      );

    // Assert
    should(decisions.map(refusedStatus)).deepEqual([400, 400, 400, 400]);
    should(new Set(decisions.map(refusedCode))).deepEqual(new Set(['invalid_query']));
    should(events.scopes).be.empty();
  });

  it('should refuse a live readout on the fleet stream, which has no one turn to read', async () => {
    // Arrange
    const { events, dispatcher } = fixture();

    // Act
    const decision = await dispatcher.upgrade(request({ path: '/v1/events', query: [['live', '1']], headers: human }));

    // Assert — named distinctly from a malformed query, so a client can tell which mistake it made.
    should(refusedStatus(decision)).equal(400);
    should(refusedCode(decision)).equal('live_needs_session');
    should(events.scopes).be.empty();
  });

  it('should refuse a live flag given twice', async () => {
    // Arrange
    const { dispatcher } = fixture();

    // Act
    const decision = await dispatcher.upgrade(
      request({
        path: '/v1/events',
        query: [
          ['sessionId', 's1'],
          ['live', '1'],
          ['live', '1'],
        ],
        headers: human,
      }),
    );

    // Assert
    should(refusedStatus(decision)).equal(400);
    should(refusedCode(decision)).equal('invalid_query');
  });

  it('should refuse a query parameter it does not understand', async () => {
    // Arrange
    const { dispatcher } = fixture();

    // Act
    const decision = await dispatcher.upgrade(
      request({ path: '/v1/events', query: [['limit', '10']], headers: human }),
    );

    // Assert — a filter the daemon ignores would give a caller a stream it did not ask for.
    should(refusedStatus(decision)).equal(400);
    should(refusedCode(decision)).equal('invalid_query');
  });

  it('should authenticate a LOOPBACK handshake by its query token alone', async () => {
    // Arrange — a browser `WebSocket` cannot carry an authorization header, so the token arrives as
    // a query parameter. That credential is honoured for loopback peers ONLY, and the route has to
    // tolerate the parameter as well: refusing it as an unknown query would make the feed
    // unreachable from every browser. A REMOTE browser presents a ticket instead — see the cases
    // below — because a durable token in a URL is a durable token in an access log.
    const { dispatcher } = fixture();
    const query = [['token', CREDENTIALS.admin]] as const;

    // Act — no authorization header at all in either case; only the peer differs.
    const local = await dispatcher.upgrade(request({ path: '/v1/events', query, loopback: true }));
    const remote = await dispatcher.upgrade(request({ path: '/v1/events', query }));

    // Assert
    should(local.outcome).equal('accepted');
    should(refusedStatus(remote)).equal(401);
  });

  it('should refuse a session id the layout would never produce', async () => {
    // Arrange
    const { events, dispatcher } = fixture();

    // Act
    const decision = await dispatcher.upgrade(
      request({ path: '/v1/events', query: [['sessionId', '../escape']], headers: human }),
    );

    // Assert
    should(refusedStatus(decision)).equal(400);
    should(refusedCode(decision)).equal('invalid_session_id');
    should(events.scopes).be.empty();
  });

  it('should settle an unknown session on the handshake rather than in a close frame', async () => {
    // Arrange
    const { events, dispatcher } = fixture();

    // Act
    const decision = await dispatcher.upgrade(
      request({ path: '/v1/events', query: [['sessionId', 'ghost']], headers: human }),
    );

    // Assert — a socket that opened and died could not tell "no such session" from "the daemon broke".
    should(refusedStatus(decision)).equal(404);
    should(refusedCode(decision)).equal('not-found');
    should(events.scopes).be.empty();
  });

  it('should never let an unauthorized peer hold the feed', async () => {
    // Arrange
    const { events, dispatcher } = fixture();

    // Act
    const anonymous = await dispatcher.upgrade(request({ path: '/v1/events' }));
    const warden = await dispatcher.upgrade(request({ path: '/v1/events', headers: wardenToken }));

    // Assert — the fleet feed carries every session's lifecycle events, which is the operator's own
    // authority; the warden scope exists precisely so a supervisor cannot read all of it.
    should([refusedStatus(anonymous), refusedStatus(warden)]).deepEqual([401, 403]);
    should(events.scopes).be.empty();
  });

  it('should let a remote paired device hold the feed through its session', async () => {
    // Arrange — this is the case the feed exists for: a phone is not loopback, and it opens the feed as
    // a stream session whose device the tunnel proved, so it needs no ticket and no header at all.
    const { events, dispatcher } = fixture();

    // Act
    const decision = await dispatcher.upgrade(
      request({ path: '/v1/events', device: { deviceId: 'device-1', appSession: 'app-one' } }),
    );
    await attach(decision);

    // Assert — accepted, attributed to that device, and in the scope the caller asked for.
    should(decision.outcome).equal('accepted');
    should(events.scopes).deepEqual([{ kind: 'fleet' }]);
  });

  it('should claim only its own path', () => {
    // Arrange
    const { dispatcher } = fixture();

    // Act / Assert — asked before authentication, so an ordinary HTTP route arriving with a stray
    // upgrade header is still served as HTTP.
    should(dispatcher.claims(request({ path: '/v1/events' }))).be.true();
    should(dispatcher.claims(request({ path: '/v1/sessions/s1/events' }))).be.false();
  });
});
