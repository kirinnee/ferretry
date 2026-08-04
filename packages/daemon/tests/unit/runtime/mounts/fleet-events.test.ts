import { describe, it } from 'bun:test';
import should from 'should';
import { ApiRouter } from '../../../../src/lib/api/index.ts';
import { ApiSocketDispatcher, type SocketDownstream, type SocketHandler } from '../../../../src/lib/api/socket.ts';
import { SocketTicketRegistry } from '../../../../src/lib/api/socket-ticket.ts';
import { fleetEventSocketRoutes } from '../../../../src/lib/runtime/index.ts';
import type { FleetEventStreamSubsystem } from '../../../../src/lib/runtime/mounts/fleet-events.ts';
import type { FleetEventStreamScope } from '../../../../src/lib/session/events/index.ts';
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

function fixture(events: RecordingFleetEvents = new RecordingFleetEvents()) {
  // A real registry, not a stub: a browser cannot put a header on a `WebSocket`, so the ticket IS how
  // a paired phone reaches this feed and the handshake cases must exercise the credential it uses.
  const tickets = new SocketTicketRegistry({ now: () => 1_000 }, { ticket: () => `fy_ticket_${'t'.repeat(43)}` });
  const dispatcher = new ApiSocketDispatcher(
    new ApiRouter([...fleetEventSocketRoutes(events, sessionDirectory([sessionView('s1')]))]),
    CREDENTIALS,
    tickets,
  );
  return { events, dispatcher, tickets };
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

  it('should let a remote paired device hold the feed on a ticket', async () => {
    // Arrange — this is the case the feed existed for and could not serve: a phone is not loopback and
    // its `WebSocket` cannot carry a header, so before the ticket it had no way to authenticate here
    // at all.
    const { events, dispatcher, tickets } = fixture();
    const { ticket } = tickets.issue(
      { kind: 'authenticated', tokenClass: 'device', deviceId: 'device-1' },
      '/v1/events',
    );

    // Act
    const decision = await dispatcher.upgrade(request({ path: '/v1/events', query: [['ticket', ticket]] }));
    await attach(decision);

    // Assert — accepted, and the ticket parameter did not disturb the scope the caller asked for.
    should(decision.outcome).equal('accepted');
    should(events.scopes).deepEqual([{ kind: 'fleet' }]);
  });

  it('should let a ticket carry the cursor the caller asked for', async () => {
    // Arrange
    const { events, dispatcher, tickets } = fixture();
    const { ticket } = tickets.issue(
      { kind: 'authenticated', tokenClass: 'device', deviceId: 'device-1' },
      '/v1/events',
    );

    // Act
    const decision = await dispatcher.upgrade(
      request({
        path: '/v1/events',
        query: [
          ['ticket', ticket],
          ['sessionId', 's1'],
          ['after', '9'],
        ],
      }),
    );
    await attach(decision);

    // Assert
    should(events.scopes).deepEqual([{ kind: 'session', sessionId: 's1', after: 9 }]);
  });

  it('should spend the ticket, so a captured URL cannot reopen the feed', async () => {
    // Arrange — the URL reaches every proxy log on the path, so replay is the threat that matters.
    const { events, dispatcher, tickets } = fixture();
    const { ticket } = tickets.issue({ kind: 'authenticated', tokenClass: 'admin' }, '/v1/events');
    const url = () => request({ path: '/v1/events', query: [['ticket', ticket]] });

    // Act
    const first = await dispatcher.upgrade(url());
    await attach(first);
    const replayed = await dispatcher.upgrade(url());

    // Assert
    should(first.outcome).equal('accepted');
    should(refusedStatus(replayed)).equal(401);
    should(events.scopes).have.length(1);
  });

  it('should refuse a ticket nobody issued, and say nothing about why', async () => {
    // Arrange
    const { events, dispatcher } = fixture();

    // Act — a guess, and a blank one.
    const guessed = await dispatcher.upgrade(
      request({ path: '/v1/events', query: [['ticket', `fy_ticket_${'z'.repeat(43)}`]] }),
    );
    const blank = await dispatcher.upgrade(request({ path: '/v1/events', query: [['ticket', '']] }));

    // Assert — the same 401 an unauthenticated caller gets, with no hint that a ticket surface exists.
    should([refusedStatus(guessed), refusedStatus(blank)]).deepEqual([401, 401]);
    should(refusedCode(guessed)).equal('unauthorized');
    should(refusedCode(blank)).equal('unauthorized');
    should(events.scopes).be.empty();
  });

  it('should never let a ticket relax the scope its buyer had', async () => {
    // Arrange — a warden may not read the whole fleet's lifecycle, and buying a ticket must not be a
    // way around that. The refusal is a 403, exactly as it is for the bearer itself.
    const { events, dispatcher, tickets } = fixture();
    const { ticket } = tickets.issue({ kind: 'authenticated', tokenClass: 'warden' }, '/v1/events');

    // Act
    const decision = await dispatcher.upgrade(request({ path: '/v1/events', query: [['ticket', ticket]] }));

    // Assert
    should(refusedStatus(decision)).equal(403);
    should(events.scopes).be.empty();
  });

  it('should prefer a presented bearer over a ticket, so a real credential never spends one', async () => {
    // Arrange
    const { dispatcher, tickets } = fixture();
    const { ticket } = tickets.issue({ kind: 'authenticated', tokenClass: 'admin' }, '/v1/events');

    // Act — the CLI holds a header AND happens to carry a ticket in the URL.
    const decision = await dispatcher.upgrade(
      request({ path: '/v1/events', query: [['ticket', ticket]], headers: human }),
    );

    // Assert — accepted on the header, and the ticket is still unspent afterwards.
    should(decision.outcome).equal('accepted');
    should(tickets.redeem(ticket, '/v1/events')).deepEqual({ kind: 'authenticated', tokenClass: 'admin' });
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
