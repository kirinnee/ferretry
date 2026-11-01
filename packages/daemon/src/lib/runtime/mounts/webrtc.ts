/**
 * ANOTHER WAY TO REACH THIS DAEMON, ASKED FOR INSIDE A WAY THAT ALREADY WORKS.
 *
 * `POST /v1/webrtc/offer` is the WebRTC carrier's signalling (`docs/relay-protocol.md` §16): a paired
 * device that reached this daemon over the relay (or directly) sends its offer here and gets an answer
 * back, both sealed in the session that carried them, and then opens its sessions peer-to-peer.
 *
 * ## `authenticated`, AND ONLY FROM A DEVICE
 *
 * Any paired device may ask for a shorter path to its own daemon, exactly as any may refresh the
 * carrier set (`carriers.ts` says why that is not one class higher). But it must BE a device: a peer
 * connection is keyed to the running copy of the app that asked for it — one per copy, so a phone that
 * changed networks replaces its stranded peer rather than adding one — and a host admin token has no
 * running copy of anything. That caller is on the machine already and needs no path to it.
 *
 * ## NOT CAPABILITY-GATED, AND NOT `privilegedOnly`
 *
 * A carrier is a pipe, not an act. Every session that crosses the data channel proves its device again
 * and every request on it meets the same route table, authorization boundary and per-capability guard
 * as anywhere else, with an arrival that is never local. So the only new thing a caller gains here is a
 * path — and an operator who switched a capability off has switched it off on that path too.
 *
 * ## A REFUSAL IS AN ANSWER THE DEVICE STATES
 *
 * A switched-off carrier, an engine that would not load, a daemon at its peer bound and an offer the
 * engine could not use each carry their own machine code, so the browser can say which one instead of
 * "WebRTC failed" — and none of them demotes the session the request arrived on.
 */

import { WebRtcOfferRequestSchema } from '@ferretry/protocol';
import type { SessionDevice } from '../../api/http.ts';
import { ApiError, type ApiRoute, jsonResponse, parseBody } from '../../api/index.ts';
import type { WebRtcOfferOutcome } from '../../webrtc/index.ts';

/** The one thing this mount asks of the carrier. */
export interface WebRtcSignallingSubsystem {
  offer(offerSdp: string, device: SessionDevice): Promise<WebRtcOfferOutcome>;
}

export function webrtcRoutes(webrtc: WebRtcSignallingSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/webrtc/offer',
      minimum: 'authenticated',
      caller: 'any',
      // An answer names this machine's candidate addresses and the DTLS certificate fingerprint for one
      // connection; it is good for that connection only and must never be served again.
      noStore: true,
      handle: async ({ request }) => {
        if (request.device === undefined) {
          throw new ApiError(
            403,
            'a peer-to-peer connection is offered to a paired device inside its own session',
            'webrtc_device_only',
          );
        }
        const offer = await parseBody(request, WebRtcOfferRequestSchema);
        const outcome = await webrtc.offer(offer.sdp, request.device);
        if (outcome.kind === 'refused') throw new ApiError(outcome.status, outcome.reason, outcome.code);
        return jsonResponse({ sdp: outcome.sdp });
      },
    },
  ];
}
