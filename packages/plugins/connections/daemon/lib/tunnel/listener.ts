/**
 * HOW A TUNNEL ARRIVAL IS KEYED — `docs/relay-protocol.md` §15.
 *
 * `cloudflared` forwards from this daemon's own host, so everything that comes through a tunnel arrives
 * from a loopback peer. The tunnel therefore never points at the daemon's API listener: it points at the
 * KERNEL'S carrier listener (`kernel.carrierListener`, an ephemeral `127.0.0.1` port — the `originPort` it
 * provisions with), which serves ONLY this plugin's declared `GET /v1/rendezvous/<daemonId>/client`, answers
 * `404` to everything else, and stamps every arrival `{ kind: 'carried', carrier: 'tunnel' }` — never local
 * (G15, G16) — so nothing inside a tunnelled session reaches a `privilegedOnly` route and its requests are
 * governed by grants exactly as a relayed device's are.
 *
 * What stays here is the one thing only this carrier knows: the per-peer admission bounds of §4 key by
 * `CF-Connecting-IP` — the address Cloudflare's edge saw — and fall back to ONE shared key when it is
 * absent or not an address, so a caller that hides it shares a bucket rather than escaping one. The
 * edge's ingress forwards only that one path too (`tunnelIngress`), so the kernel's listener is the
 * inner of two walls rather than the only one.
 */

import type { ApiRequest } from '@ferretry/kernel/contract';
type ApiHeaders = ApiRequest['headers'];

/** The header Cloudflare's edge sets to the address it accepted the connection from. */
export const TUNNEL_PEER_HEADER = 'cf-connecting-ip';

/** The one bucket every tunnel arrival without a usable `CF-Connecting-IP` shares. */
export const TUNNEL_SHARED_PEER = 'tunnel';

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;
const HEXTET = /^[0-9A-Fa-f]{1,4}$/u;

/**
 * An IPv6 address as its /64 network, or nothing when it is not one.
 *
 * ONE SUBSCRIBER IS ONE /64. A single IPv6 customer is routinely given a whole /64 — 2^64 addresses —
 * so keying by the full address would hand one caller that many buckets and the per-peer bounds of §4
 * would bound nobody. An IPv4-mapped address is read as the IPv4 address it carries.
 */
function ipv6Network(value: string): string | undefined {
  if (value.includes('.')) {
    const mapped = /^::ffff:(.+)$/iu.exec(value)?.[1];
    return mapped !== undefined && IPV4.test(mapped) ? mapped : undefined;
  }
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] === '' ? [] : (halves[0] ?? '').split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? (halves[1] ?? '').split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (!groups.every(group => HEXTET.test(group))) return undefined;
  return `${groups
    .slice(0, 4)
    .map(group => Number.parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * The rate-limit identity of one tunnel arrival: an IPv4 address whole, an IPv6 address by its /64, and
 * one shared bucket for anything else — so a caller that hides or garbles the header shares a bucket
 * rather than escaping one.
 */
export function tunnelPeer(headers: ApiHeaders): string {
  const value = headers.get(TUNNEL_PEER_HEADER)?.trim();
  if (value === undefined || value.length > 45) return TUNNEL_SHARED_PEER;
  if (IPV4.test(value)) return value;
  return (value.includes(':') ? ipv6Network(value) : undefined) ?? TUNNEL_SHARED_PEER;
}
