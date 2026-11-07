/**
 * Connections' wire (§2.1), copied field for field from today's `packages/protocol/src/lib/{carriers,tunnel,webrtc,
 * address}.ts` and the carrier entries of `daemon/src/lib/runtime/{carriers,config}.ts`. Carriers move sealed bytes
 * only: nothing here opens, seals or proves a session (that is the kernel's session layer).
 */
import { z } from 'zod';

// ─── addresses ────────────────────────────────────────────────────────────────────────────────────────────────────

const LOOPBACK_IPV4_BLOCK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/u;
const IPV6_GROUP_COUNT = 8;

function bareHost(host: string): string {
  const lowered = host.trim().toLowerCase();
  return lowered.startsWith('[') && lowered.endsWith(']') ? lowered.slice(1, -1) : lowered;
}

function ipv6GroupsOf(half: string): readonly number[] | undefined {
  if (half === '') return [];
  const groups = half.split(':').map(group => (IPV6_GROUP.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  return groups.some(Number.isNaN) ? undefined : groups;
}

function ipv6Groups(host: string): readonly number[] | undefined {
  if (!host.includes(':')) return undefined;
  const halves = host.split('::');
  if (halves.length > 2) return undefined;
  const head = ipv6GroupsOf(halves[0] ?? '');
  const tail = ipv6GroupsOf(halves[1] ?? '');
  if (head === undefined || tail === undefined) return undefined;
  if (halves.length === 1) return head.length === IPV6_GROUP_COUNT ? head : undefined;
  const elided = IPV6_GROUP_COUNT - head.length - tail.length;
  return elided < 1 ? undefined : [...head, ...new Array<number>(elided).fill(0), ...tail];
}

/** Whether a host names this computer itself. Used to judge an ADDRESS, never to decide how a call arrived. */
export function isLoopbackHost(host: string): boolean {
  const bare = bareHost(host);
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  if (LOOPBACK_IPV4_BLOCK.test(bare)) return true;
  const groups = ipv6Groups(bare);
  if (groups === undefined) return false;
  return groups.every((group, index) => group === (index === IPV6_GROUP_COUNT - 1 ? 1 : 0));
}

/** A rendezvous endpoint: wss/https everywhere, ws/http only on loopback, no query or fragment. */
export const SocketEndpointSchema = z
  .string()
  .max(2048)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'endpoint is not a URL' });
      return z.NEVER;
    }
    const loopback = isLoopbackHost(url.hostname);
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    const insecure = url.protocol === 'http:' || url.protocol === 'ws:';
    if (!secure && !(insecure && loopback)) {
      context.addIssue({ code: 'custom', message: 'endpoint must be wss/https, or ws/http on loopback' });
      return z.NEVER;
    }
    if (url.search !== '' || url.hash !== '') {
      context.addIssue({ code: 'custom', message: 'endpoint carries a query or fragment' });
      return z.NEVER;
    }
    return url.toString().replace(/\/$/u, '');
  });

/** A direct daemon address: an http(s) origin with no credentials, path, query or fragment. */
export const DaemonOriginSchema = z
  .string()
  .max(2048)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'daemon address is not a URL' });
      return z.NEVER;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      context.addIssue({ code: 'custom', message: 'daemon address must use http or https' });
      return z.NEVER;
    }
    if (url.username !== '' || url.password !== '') {
      context.addIssue({ code: 'custom', message: 'daemon address may not carry credentials' });
      return z.NEVER;
    }
    if (url.search !== '' || url.hash !== '' || url.pathname !== '/') {
      context.addIssue({
        code: 'custom',
        message: 'daemon address must be an origin without a path, query or fragment',
      });
      return z.NEVER;
    }
    return url.origin;
  });

/** A tunnel address: a bare https origin that is not this computer. */
export const TunnelOriginSchema = z
  .string()
  .max(2048)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'tunnel address is not a URL' });
      return z.NEVER;
    }
    if (url.protocol !== 'https:') {
      context.addIssue({ code: 'custom', message: 'tunnel address must use https' });
      return z.NEVER;
    }
    if (isLoopbackHost(url.hostname)) {
      context.addIssue({ code: 'custom', message: 'tunnel address may not be a loopback host' });
      return z.NEVER;
    }
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname !== '/') {
      context.addIssue({ code: 'custom', message: 'tunnel address must be a bare https origin' });
      return z.NEVER;
    }
    return url.origin;
  });

// ─── published carriers (`GET /v1/carriers`) ───────────────────────────────────────────────────────────────────────

export const CARRIER_KINDS = ['direct', 'relay', 'tunnel', 'webrtc'] as const;
export const CarrierKindSchema = z.enum(CARRIER_KINDS);
export type CarrierKind = z.infer<typeof CarrierKindSchema>;

export const MAX_PUBLISHED_CARRIERS = 8;

/** One way a device may dial this daemon. WebRTC is not published: it is signalled inside a session. */
export const PublishedCarrierSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('direct'), url: DaemonOriginSchema }),
  z.strictObject({ kind: z.literal('relay'), url: SocketEndpointSchema }),
  z.strictObject({ kind: z.literal('tunnel'), url: TunnelOriginSchema }),
]);
export type PublishedCarrier = z.infer<typeof PublishedCarrierSchema>;

export const PublishedCarriersSchema = z.array(PublishedCarrierSchema).max(MAX_PUBLISHED_CARRIERS).readonly();
export type PublishedCarriers = z.infer<typeof PublishedCarriersSchema>;

export const CarriersViewSchema = z.strictObject({ carriers: PublishedCarriersSchema });
export type CarriersView = z.infer<typeof CarriersViewSchema>;

// ─── tunnel (`GET|PUT /v1/tunnel`) ────────────────────────────────────────────────────────────────────────────────

export const TunnelStateSchema = z.enum(['off', 'unavailable', 'provisioning', 'connecting', 'up']);
export type TunnelState = z.infer<typeof TunnelStateSchema>;

export const TunnelStatusViewSchema = z.strictObject({
  enabled: z.boolean(),
  explicit: z.boolean(),
  state: TunnelStateSchema,
  tunnelUrl: z.string().nullable(),
  sentence: z.string(),
});
export type TunnelStatusView = z.infer<typeof TunnelStatusViewSchema>;

export const TunnelChangeSchema = z.strictObject({ enabled: z.boolean() });
export type TunnelChange = z.infer<typeof TunnelChangeSchema>;

// ─── WebRTC (`POST /v1/webrtc/offer`, sealed inside a session) ────────────────────────────────────────────────────

export const MAX_WEBRTC_SDP_BYTES = 32 * 1024;
export const WEBRTC_GATHER_CAP_MS = 3_000;
export const WEBRTC_CONNECT_DEADLINE_MS = 8_000;
export const DEFAULT_WEBRTC_ICE_SERVERS: readonly string[] = ['stun:stun.cloudflare.com:3478'];

const SdpSchema = z
  .string()
  .min(1)
  .refine(sdp => new TextEncoder().encode(sdp).byteLength <= MAX_WEBRTC_SDP_BYTES, {
    message: `an SDP is at most ${MAX_WEBRTC_SDP_BYTES} bytes`,
  });

export const WebRtcOfferRequestSchema = z.strictObject({ sdp: SdpSchema });
export type WebRtcOfferRequest = z.infer<typeof WebRtcOfferRequestSchema>;
export const WebRtcOfferAnswerSchema = z.strictObject({ sdp: SdpSchema });
export type WebRtcOfferAnswer = z.infer<typeof WebRtcOfferAnswerSchema>;

export const WEBRTC_REFUSAL_CODES = [
  'webrtc_disabled',
  'webrtc_unavailable',
  'webrtc_busy',
  'webrtc_offer_invalid',
] as const;
export type WebRtcRefusalCode = (typeof WEBRTC_REFUSAL_CODES)[number];

// ─── config/connections.yaml ──────────────────────────────────────────────────────────────────────────────────────

const ReconnectSecondsSchema = z.number().int().positive().max(3_600).default(5);

/** Today's `carriers` block, one key per carrier. An explicit relay entry WINS and is never overwritten. */
export const ConnectionsConfigSchema = z.strictObject({
  direct: z
    .strictObject({
      host: z.string().trim().min(1).max(255),
      port: z.number().int().min(0).max(65_535).optional(),
    })
    .optional(),
  relay: z
    .union([
      /** Read the hosted relay from the runtime advertisement (the default). */
      z.strictObject({
        source: z.literal('discovery'),
        enabled: z.boolean().default(true),
        reconnectSeconds: ReconnectSecondsSchema,
      }),
      /** The expert path: your own rendezvous (`docs/cloudflare-relay-self-hosting.md`). */
      z.strictObject({
        url: SocketEndpointSchema,
        enabled: z.boolean().default(true),
        reconnectSeconds: ReconnectSecondsSchema,
      }),
    ])
    .optional(),
  tunnel: z.strictObject({ enabled: z.boolean().default(false) }).optional(),
  webrtc: z
    .strictObject({
      enabled: z.boolean().default(true),
      iceServers: z
        .array(
          z
            .string()
            .trim()
            .max(256)
            .regex(/^stuns?:[^\s/?#@]+$/u, 'an ICE server here is a stun: or stuns: address, host and optional port'),
        )
        .max(4)
        .readonly()
        .default(DEFAULT_WEBRTC_ICE_SERVERS),
    })
    .optional(),
});
export type ConnectionsConfig = z.infer<typeof ConnectionsConfigSchema>;

/** Turning a carrier on, or pointing the relay somewhere else, widens how this daemon is reached. */
export function connectionsLoosens(before: ConnectionsConfig | undefined, after: ConnectionsConfig): readonly string[] {
  const widened: string[] = [];
  const on = (entry: { readonly enabled?: boolean } | undefined, fallback: boolean) => entry?.enabled ?? fallback;
  if (on(after.relay, true) && !on(before?.relay, true)) widened.push('the relay is turned on');
  if (
    after.relay !== undefined &&
    'url' in after.relay &&
    JSON.stringify(after.relay) !== JSON.stringify(before?.relay)
  )
    widened.push('the relay points at a different rendezvous');
  if (on(after.tunnel, false) && !on(before?.tunnel, false)) widened.push('the tunnel is turned on');
  if (on(after.webrtc, true) && !on(before?.webrtc, true)) widened.push('WebRTC is turned on');
  if (after.direct !== undefined && JSON.stringify(after.direct) !== JSON.stringify(before?.direct))
    widened.push('the direct listener binds a different address');
  return widened;
}
