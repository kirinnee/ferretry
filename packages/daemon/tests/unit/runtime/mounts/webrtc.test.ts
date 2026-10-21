import { describe, it } from 'bun:test';
import { WebRtcOfferAnswerSchema } from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import type { SessionDevice } from '../../../../src/lib/api/http.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { webrtcRoutes } from '../../../../src/lib/runtime/mounts/webrtc.ts';
import type { WebRtcOfferOutcome } from '../../../../src/lib/webrtc/index.ts';
import { request } from '../../api/support.ts';
import { CREDENTIALS } from './support.ts';

/**
 * The WebRTC offer, driven through the real router and the real authorization boundary.
 *
 * It proves the route's own decisions: who may ask (a paired device, inside its session), what an
 * offer must look like before the engine sees it, and that each refusal reaches the device as the
 * machine code it can state — never as a generic failure.
 */

const DEVICE: SessionDevice = { deviceId: 'device-1', appSession: 'app-one' };
const pwa = { 'x-ferretry-client': 'pwa', 'content-type': 'application/json' } as const;

function dispatcher(outcome: WebRtcOfferOutcome, asked: Array<{ sdp: string; device: SessionDevice }> = []) {
  return new ApiDispatcher(
    new ApiRouter(
      webrtcRoutes({
        offer: async (sdp, device) => {
          asked.push({ sdp, device });
          return outcome;
        },
      }),
    ),
    CREDENTIALS,
    NO_GOVERNED_ROUTES_GUARD,
  );
}

const offer = (body: string, device: SessionDevice | null = DEVICE, headers: Record<string, string> = pwa) =>
  request({
    method: 'POST',
    path: '/v1/webrtc/offer',
    headers,
    body,
    ...(device === null ? {} : { device }),
  });

describe('the WebRTC offer mount', () => {
  it('should hand a paired device’s offer to the carrier and answer with the carrier’s answer, uncached', async () => {
    // Arrange
    const asked: Array<{ sdp: string; device: SessionDevice }> = [];
    const subject = dispatcher({ kind: 'answered', sdp: 'v=0 answer' }, asked);

    // Act
    const response = await subject.dispatch(offer(JSON.stringify({ sdp: 'v=0 offer' })));

    // Assert
    should(response.status).equal(200);
    should(WebRtcOfferAnswerSchema.parse(JSON.parse(response.body))).deepEqual({ sdp: 'v=0 answer' });
    should(response.headers.get('cache-control')).match(/no-store/u);
    should(asked).deepEqual([{ sdp: 'v=0 offer', device: DEVICE }]);
  });

  it.each<[WebRtcOfferOutcome & { readonly kind: 'refused' }]>([
    [{ kind: 'refused', status: 503, code: 'webrtc_disabled', reason: 'switched off in daemon.json' }],
    [{ kind: 'refused', status: 503, code: 'webrtc_unavailable', reason: 'the engine could not be loaded' }],
    [{ kind: 'refused', status: 429, code: 'webrtc_busy', reason: 'as many peers as it carries' }],
    [{ kind: 'refused', status: 400, code: 'webrtc_offer_invalid', reason: 'could not use that offer' }],
  ])('should carry the refusal %j to the device as its own status and code', async outcome => {
    // Arrange
    const subject = dispatcher(outcome);

    // Act
    const response = await subject.dispatch(offer(JSON.stringify({ sdp: 'v=0' })));

    // Assert
    should(response.status).equal(outcome.status);
    should(JSON.parse(response.body)).match({ code: outcome.code, error: outcome.reason });
  });

  it('should refuse a credentialed caller that is not a device in a session, before the carrier is asked', async () => {
    // Arrange — the host admin token on loopback: a real credential, but no running copy of the app.
    const asked: Array<{ sdp: string; device: SessionDevice }> = [];
    const subject = dispatcher({ kind: 'answered', sdp: 'unused' }, asked);
    const admin = { ...pwa, authorization: `Bearer ${CREDENTIALS.admin}`, 'x-ferretry-client': 'cli' };

    // Act
    const response = await subject.dispatch(offer(JSON.stringify({ sdp: 'v=0' }), null, admin));

    // Assert
    should(response.status).equal(403);
    should(JSON.parse(response.body)).match({ code: 'webrtc_device_only' });
    should(asked).be.empty();
  });

  it.each([
    ['not JSON', '{'],
    ['no sdp', '{}'],
    ['an extra key', JSON.stringify({ sdp: 'v=0', iceServers: ['turn:x'] })],
    ['an empty sdp', JSON.stringify({ sdp: '' })],
  ])('should refuse a body with %s before the carrier is asked', async (_name, body) => {
    // Arrange
    const asked: Array<{ sdp: string; device: SessionDevice }> = [];
    const subject = dispatcher({ kind: 'answered', sdp: 'unused' }, asked);

    // Act
    const response = await subject.dispatch(offer(body));

    // Assert
    should(response.status).equal(400);
    should(asked).be.empty();
  });
});
