/**
 * HOW AN ARRIVAL AT THE CONNECTOR'S OWN LISTENER IS KEYED FOR RATE LIMITS (docs/mcp-connector.md "Where it listens").
 *
 * The operator's own `cloudflared` forwards from this host, so every arrival comes from a loopback peer; the address
 * Cloudflare's edge saw is `CF-Connecting-IP`. It is a RATE-LIMIT IDENTITY ONLY — never authority: nothing here can make an
 * arrival local, and a caller that hides or garbles the header shares ONE bucket rather than escaping one. An IPv6
 * address is keyed by its /64 (one subscriber is routinely a whole /64, so the full address would hand them 2^64 buckets).
 * The built-in tunnel keys the same way (Connections' `tunnelPeer`).
 */
import type { ApiHeaders } from '@ferretry/kernel/contract';

const PEER_HEADER = 'cf-connecting-ip';
/** The one bucket every arrival without a usable `CF-Connecting-IP` shares. */
const SHARED_PEER = 'door';

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;
const HEXTET = /^[0-9A-Fa-f]{1,4}$/u;

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

export function doorPeer(headers: ApiHeaders): string {
  const value = headers.get(PEER_HEADER)?.trim();
  if (value === undefined || value.length > 45) return SHARED_PEER;
  if (IPV4.test(value)) return value;
  return (value.includes(':') ? ipv6Network(value) : undefined) ?? SHARED_PEER;
}
