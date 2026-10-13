import { describe, it } from 'bun:test';
import should from 'should';
import {
  type CapabilityGuard,
  type CapabilityPresentation,
  NO_GOVERNED_ROUTES_GUARD,
  NO_STEP_UP_WITNESS,
} from '../../../src/lib/api/capability.ts';
import { ApiError } from '../../../src/lib/api/error.ts';
import type { CredentialMinimum } from '../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import {
  ApiSocketDispatcher,
  admitPendingSocketFrame,
  SOCKET_CLOSES,
  SOCKET_MAX_FRAME_BYTES,
  SOCKET_MAX_PENDING_FRAMES,
  type SocketAttachment,
  type SocketDownstream,
  type SocketHandler,
  type SocketRoute,
} from '../../../src/lib/api/socket.ts';
import {
  TERMINAL_MAX_CONTROL_FRAME_BYTES,
  TERMINAL_MAX_INPUT_FRAME_BYTES,
} from '../../../src/lib/terminal/stream-policy.ts';
import { jsonBody, request } from './support.ts';

const CREDENTIALS = { admin: 'admin-secret', warden: 'warden-secret', devices: { has: () => true } } as const;

const human = { authorization: `Bearer ${CREDENTIALS.admin}` } as const;

/** A handler that records nothing: these cases are about the upgrade, not about what drives it. */
const inertHandler: SocketHandler = {
  open: async () => undefined,
  fromClient: () => undefined,
  close: () => undefined,
};

/** A socket route that accepts, unless told to refuse with the given error. */
function streamRoute(refusal?: unknown, minimum: CredentialMinimum = 'operator'): SocketRoute {
  return {
    method: 'GET',
    path: '/v1/sessions/:sessionId/stream',
    minimum,
    accept: async context => {
      if (refusal !== undefined) throw refusal;
      const attachment: SocketAttachment = async (downstream: SocketDownstream) => {
        // Named in the frame so a case can prove the attachment is bound to the request that was
        // authorized, rather than to whatever the socket later claims to be.
        downstream.send(new TextEncoder().encode(context.params.get('sessionId') ?? ''));
        return inertHandler;
      };
      return attachment;
    },
  };
}

function dispatcherFor(...routes: readonly SocketRoute[]): ApiSocketDispatcher {
  return new ApiSocketDispatcher(new ApiRouter(routes), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
}

describe('the socket frame cap', () => {
  it('should never be tighter than the largest frame the terminal stream calls legitimate', () => {
    // The transport refuses an oversized frame before the daemon holds it, so this cap is the real
    // ceiling. If it ever dropped below what the terminal policy admits, a legal paste or resize
    // would be killed by the transport and the policy's own limits would become unreachable fiction.
    // Act / Assert
    should(SOCKET_MAX_FRAME_BYTES).be.aboveOrEqual(TERMINAL_MAX_INPUT_FRAME_BYTES);
    should(SOCKET_MAX_FRAME_BYTES).be.aboveOrEqual(TERMINAL_MAX_CONTROL_FRAME_BYTES);
  });
});

describe('admitPendingSocketFrame', () => {
  it('should hold frames up to the handshake bound', () => {
    // Act / Assert
    should(admitPendingSocketFrame(0)).deepEqual({ outcome: 'queued' });
    should(admitPendingSocketFrame(SOCKET_MAX_PENDING_FRAMES - 1)).deepEqual({ outcome: 'queued' });
  });

  it('should refuse the socket once the handshake queue is full', () => {
    // Bounded, or a client that floods while its handler is being attached grows the daemon's heap
    // without limit — the frames have nowhere to go until the attachment resolves.
    // Act
    const refused = admitPendingSocketFrame(SOCKET_MAX_PENDING_FRAMES);

    // Assert
    should(refused).deepEqual({ outcome: 'rejected', close: SOCKET_CLOSES.handshakeOverflow });
  });

  it('should bound one socket‘s handshake memory to a megabyte', () => {
    // The count is only meaningful because the transport caps each frame; together they are a hard
    // byte ceiling, which is the number that actually matters.
    // Act / Assert
    should(SOCKET_MAX_PENDING_FRAMES * SOCKET_MAX_FRAME_BYTES).equal(1024 * 1024);
  });
});

describe('ApiSocketDispatcher', () => {
  it('should claim only the paths its own table holds', () => {
    // Asked before authentication, so a public HTTP route arriving with a stray `Upgrade` header is
    // still served as HTTP instead of being judged against a socket table it has nothing to do with.
    // Arrange
    const dispatcher = dispatcherFor(streamRoute());

    // Act / Assert
    should(dispatcher.claims(request({ path: '/v1/sessions/s1/stream' }))).be.true();
    should(dispatcher.claims(request({ path: '/healthz' }))).be.false();
  });

  it('should accept an authorized upgrade and bind the attachment to the authorized request', async () => {
    // Arrange
    const dispatcher = dispatcherFor(streamRoute());
    const sent: string[] = [];
    const downstream: SocketDownstream = {
      // The downstream carries text frames as well as bytes now, so a recorder that only decoded
      // bytes would no longer compile against the port the fleet event feed writes through.
      send: frame => sent.push(typeof frame === 'string' ? frame : new TextDecoder().decode(frame)),
      close: () => undefined,
      bufferedBytes: () => 0,
    };

    // Act
    const decision = await dispatcher.upgrade(request({ path: '/v1/sessions/s1/stream', headers: human }));
    if (decision.outcome === 'accepted') await decision.attach(downstream);

    // Assert
    should(decision.outcome).equal('accepted');
    should(sent).deepEqual(['s1']);
  });

  it('should accept a stream for the device its session proved, and for the host token', async () => {
    // The device is whoever its SESSION proved — the only way a device is ever a caller now — and that
    // session, not the transport, is what ends the stream when the device is unpaired.
    // Arrange
    const dispatcher = new ApiSocketDispatcher(new ApiRouter([streamRoute()]), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

    // Act
    const device = await dispatcher.upgrade(
      request({ path: '/v1/sessions/s1/stream', device: { deviceId: 'fy_device_id_phone', appSession: 'app-one' } }),
    );
    const host = await dispatcher.upgrade(request({ path: '/v1/sessions/s1/stream', headers: human }));

    // Assert
    should(device.outcome).equal('accepted');
    should(host.outcome).equal('accepted');
  });

  it('should answer again for an open stream without accepting anything', () => {
    // Arrange
    let accepted = 0;
    const route = streamRoute();
    const counting = {
      ...route,
      accept: async (context: Parameters<typeof route.accept>[0]) => {
        accepted += 1;
        return await route.accept(context);
      },
    };
    const dispatcher = dispatcherFor(counting);

    // Act + Assert — still allowed for its own caller, never for an anonymous one.
    should(dispatcher.reauthorize(request({ path: '/v1/sessions/s1/stream', headers: human }))).be.true();
    should(dispatcher.reauthorize(request({ path: '/v1/sessions/s1/stream' }))).be.false();
    should(accepted).equal(0);
  });

  it('should count the step-up an open stream was admitted with as standing when it is asked again', async () => {
    // A remote terminal is admitted on a live passkey step-up and then runs for hours. Re-checking it on
    // a lease renewal must not demand a step-up that has since lapsed, or every remote terminal would
    // die at its first renewal after the confirmation expired. Everything else is still re-decided.
    // Arrange
    const presented: CapabilityPresentation[] = [];
    const stepUpGuard: CapabilityGuard = {
      decide: (_demand, presentation) => {
        presented.push(presentation);
        return presentation.stepUp ? { allowed: true, refusal: 'granted' } : { allowed: false, refusal: 'step-up-required' };
      },
      governance: () => ({ governed: true, decide: () => ({ allowed: false, refusal: 'undetermined' }) }),
      explain: () => 'confirm with your passkey',
    };
    const terminal = { ...streamRoute(), capability: { capability: 'terminal', axis: 'use' } } as const;
    const dispatcher = new ApiSocketDispatcher(
      new ApiRouter([terminal]),
      CREDENTIALS,
      stepUpGuard,
      undefined,
      NO_STEP_UP_WITNESS,
    );
    const device = { deviceId: 'fy_device_id_phone', appSession: 'app-one' } as const;

    // Act
    const fresh = await dispatcher.upgrade(request({ path: '/v1/sessions/s1/stream', device }));
    const standing = dispatcher.reauthorize(request({ path: '/v1/sessions/s1/stream', device }));

    // Assert — a NEW stream with no live step-up is refused; the open one keeps going.
    should(fresh.outcome).equal('refused');
    should(standing).be.true();
    should(presented.map(presentation => presentation.stepUp)).eql([false, true]);
  });

  it('should refuse an unauthenticated upgrade before the route is ever accepted', async () => {
    // The whole point of deciding this on the handshake: an anonymous peer must never hold a socket,
    // not even briefly, and must never learn which sockets exist by watching how one dies.
    // Arrange
    const dispatcher = dispatcherFor(streamRoute());

    // Act
    const decision = await dispatcher.upgrade(request({ path: '/v1/sessions/s1/stream' }));

    // Assert
    should(decision.outcome).equal('refused');
    should(decision.outcome === 'refused' ? decision.response.status : 0).equal(401);
  });

  it('should refuse a warden-scoped token on an admin socket', async () => {
    // A terminal socket carries keystrokes into an unsupervised shell. A warden judges sessions; it
    // has no business typing into one, and the scope answer is the SAME boundary HTTP routes use.
    // Arrange
    const dispatcher = dispatcherFor(streamRoute());

    // Act
    const decision = await dispatcher.upgrade(
      request({ path: '/v1/sessions/s1/stream', headers: { authorization: `Bearer ${CREDENTIALS.warden}` } }),
    );

    // Assert
    should(decision.outcome).equal('refused');
    should(decision.outcome === 'refused' ? decision.response.status : 0).equal(403);
  });

  it('should honour a loopback query-parameter token, which is all a browser socket can carry', async () => {
    // A `WebSocket` constructor cannot set an `Authorization` header. The token is accepted from the
    // query string only for a loopback peer, which could already read the file it came from.
    // Arrange
    const dispatcher = dispatcherFor(streamRoute());

    // Act
    const loopback = await dispatcher.upgrade(
      request({ path: '/v1/sessions/s1/stream', query: [['token', CREDENTIALS.admin]], loopback: true }),
    );
    const remote = await dispatcher.upgrade(
      request({ path: '/v1/sessions/s1/stream', query: [['token', CREDENTIALS.admin]], loopback: false }),
    );

    // Assert
    should(loopback.outcome).equal('accepted');
    should(remote.outcome).equal('refused');
  });

  it('should refuse a wrong verb on a path its table does hold', async () => {
    // Arrange
    const dispatcher = dispatcherFor(streamRoute());

    // Act
    const decision = await dispatcher.upgrade(
      request({ method: 'POST', path: '/v1/sessions/s1/stream', headers: human }),
    );

    // Assert
    should(decision.outcome).equal('refused');
    should(decision.outcome === 'refused' ? decision.response.status : 0).equal(405);
  });

  it('should report a path no socket route holds as unclaimed rather than as missing', async () => {
    // `unclaimed` is not a 404: the request is an ordinary one and the HTTP surface still owns it.
    // Arrange
    const dispatcher = dispatcherFor(streamRoute());

    // Act
    const decision = await dispatcher.upgrade(request({ path: '/v1/usage', headers: human }));

    // Assert
    should(decision).deepEqual({ outcome: 'unclaimed' });
  });

  it('should report a refusal raised while accepting with the status the subsystem named', async () => {
    // Everything a client could be told with a status has to be proven BEFORE the switch: a socket
    // that opens and closes cannot say whether the terminal was missing or the daemon broke.
    // Arrange
    const dispatcher = dispatcherFor(streamRoute(new ApiError(404, 'terminal not found', 'not_found')));

    // Act
    const decision = await dispatcher.upgrade(request({ path: '/v1/sessions/s1/stream', headers: human }));

    // Assert
    should(decision.outcome).equal('refused');
    should(decision.outcome === 'refused' ? decision.response.status : 0).equal(404);
    should(decision.outcome === 'refused' ? jsonBody(decision.response) : {}).have.property('code', 'not_found');
  });

  it('should report a defect raised while accepting as the daemon‘s fault, not the caller‘s', async () => {
    // Arrange
    const dispatcher = dispatcherFor(streamRoute(new Error('the session index is closed')));

    // Act
    const decision = await dispatcher.upgrade(request({ path: '/v1/sessions/s1/stream', headers: human }));

    // Assert
    should(decision.outcome).equal('refused');
    should(decision.outcome === 'refused' ? decision.response.status : 0).equal(500);
    should(decision.outcome === 'refused' ? jsonBody(decision.response) : {}).have.property('code', 'internal_error');
  });

  it('should accept a public socket without asking for a token at all', async () => {
    // Scope travels with the route here exactly as it does for an `ApiRoute`, so the two tables
    // cannot disagree about what `public` means.
    // Arrange
    const dispatcher = dispatcherFor(streamRoute(undefined, 'none'));

    // Act
    const decision = await dispatcher.upgrade(request({ path: '/v1/sessions/s1/stream' }));

    // Assert
    should(decision.outcome).equal('accepted');
  });
});
