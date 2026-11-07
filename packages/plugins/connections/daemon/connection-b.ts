import { ApiError, jsonResponse, type RouteHandler, type SessionLayer } from '@ferretry/kernel/contract';
import { TunnelChangeSchema, TunnelStatusViewSchema, WebRtcOfferRequestSchema } from '../contract/index.ts';
import { TunnelCarrier, type TunnelCarrierDependencies } from './lib/tunnel/carrier.ts';
import { TunnelCarrierSwitch, type TunnelEntryStorePort } from './lib/tunnel/switch.ts';
import { WebRtcCarrier, type SessionDevice, type WebRtcCarrierDependencies } from './lib/webrtc/carrier.ts';
import { sealedWebRtcSessions } from './lib/webrtc/session.ts';
import type { z } from 'zod';

/** Today's JSON/body refusals, with the same issue paths and without submitted values. */
async function parseBody<Schema extends z.ZodType>(
  request: Parameters<RouteHandler>[0]['request'],
  schema: Schema,
): Promise<z.output<Schema>> {
  let text: string;
  try {
    text = await request.text(Math.ceil((32 * 1024 * 1024) / 3) * 4 + 4 * 1024 * 1024);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === 'BodyTooLargeError')
      throw new ApiError(413, error.message, 'body_too_large');
    throw new ApiError(400, 'the request body could not be read', 'unreadable_body');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not valid JSON', 'invalid_json');
  }
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map(issue => `${issue.path.join('.') === '' ? 'body' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new ApiError(400, `the request body is invalid — ${detail}`, 'invalid_request', result.error.issues);
}

/** TODO(kernel contract): appSession is stamped from the mode's verified credential by the kernel fill-in. */
export function verifiedWebRtcDevice(call: Parameters<RouteHandler>[0]): SessionDevice | undefined {
  const principal = call.request.principal;
  if (principal?.kind !== 'device') return undefined;
  const appSession = (principal as typeof principal & { readonly appSession?: string }).appSession;
  if (typeof appSession !== 'string' || appSession === '') return undefined;
  return { deviceId: principal.holder, appSession };
}

/** B's copied lifecycles; Connections A composes these into the package's daemon half. */
export function createConnectionB(deps: {
  readonly tunnel: TunnelCarrierDependencies;
  readonly tunnelStore: TunnelEntryStorePort;
  readonly webrtc: Omit<WebRtcCarrierDependencies, 'sessions'>;
  readonly sessionLayer: SessionLayer;
  /** Derive the page-lifetime id from the kernel-verified call, never the offer body. */
  readonly device: (call: Parameters<RouteHandler>[0]) => SessionDevice | undefined;
  readonly onStop: (stop: () => Promise<void>) => void;
}) {
  const tunnel = new TunnelCarrierSwitch({
    entry: deps.tunnel.entry,
    explicit: deps.tunnel.explicit,
    store: deps.tunnelStore,
  });
  const webrtc = new WebRtcCarrier({
    ...deps.webrtc,
    sessions: sealedWebRtcSessions(deps.sessionLayer, deps.webrtc.scheduler, length =>
      globalThis.crypto.getRandomValues(new Uint8Array(length)),
    ),
  });
  deps.onStop(async () => {
    webrtc.close();
    await tunnel.stop();
  });
  const routes = {
    'GET /v1/tunnel': async () => jsonResponse(TunnelStatusViewSchema.parse(tunnel.view())),
    'PUT /v1/tunnel': async ({ request }) => {
      const change = await parseBody(request, TunnelChangeSchema);
      return jsonResponse(TunnelStatusViewSchema.parse(await tunnel.change(change.enabled)));
    },
    'POST /v1/webrtc/offer': async call => {
      const device = deps.device(call);
      if (call.request.principal?.kind !== 'device' || device === undefined)
        throw new ApiError(
          403,
          'a peer-to-peer connection is offered to a paired device inside its own session',
          'webrtc_device_only',
        );
      const offer = await parseBody(call.request, WebRtcOfferRequestSchema);
      const outcome = await webrtc.offer(offer.sdp, device);
      if (outcome.kind === 'refused') throw new ApiError(outcome.status, outcome.reason, outcome.code);
      return jsonResponse({ sdp: outcome.sdp });
    },
  } satisfies Record<string, RouteHandler>;
  return {
    tunnel,
    webrtc,
    routes,
    startTunnel: () => tunnel.start((entry, explicit) => new TunnelCarrier({ ...deps.tunnel, entry, explicit })),
  };
}
