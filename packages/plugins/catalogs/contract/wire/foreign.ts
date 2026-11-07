/**
 * The pure pieces of OTHER subsystems' wire that Catalogs' wire reads, byte-copied from today's
 * `packages/protocol/src/lib/{common,pairing,address,session-base,session-mcp,fleet-clone-review}.ts` and from
 * Connections' contract (`packages/plugins/connections/contract/wire.ts`).
 *
 * TODO(contract): a plugin may import another plugin's contract only on the two allowed edges (Usage→Logins,
 * Packs→Runtimes), so these are copies, not imports. Each names its owner; replace a copy with the owner's contract
 * export when the lead allows the edge (Access: the link-fragment codec and daemon id/name; Connections: the published
 * carriers; MCP: the raw-key rule; Ferrets: the harness names; Skills/Packs: the asset-path rule).
 *
 * Core contracts are imported directly: Vault's secret names and Gate's passkey assertion.
 */
import { z } from 'zod';

// ─── common (today's `common.ts`) ─────────────────────────────────────────────────────────────────────────────────

/**
 * Today's protocol instant: an offset-bearing ISO text kept AS WRITTEN. Not std's canonicalising `InstantSchema`:
 * a signed catalog document carries instants, and re-spelling one would change the bytes its signature covers.
 */
export const InstantSchema = z.iso.datetime({ offset: true });

// ─── daemon identity and the link-fragment codec (Access; today's `pairing.ts`) ───────────────────────────────────

const PAIRING_DEVICE_NAME_MAX_LENGTH = 100 as const;

/** A daemon id is the SHA-256 fingerprint of its persisted Ed25519 public key. */
export const DaemonIdSchema = z.string().regex(/^fy_daemon_[A-Za-z0-9_-]{43}$/u, 'invalid daemon id');
export type DaemonId = z.infer<typeof DaemonIdSchema>;

/** A daemon name is also rendered into remote browser UI, so it obeys the same text safety bound. */
export const DaemonNameSchema = z
  .string()
  .refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), 'daemon name contains a control character')
  .transform(value => value.trim())
  .pipe(z.string().min(1).max(PAIRING_DEVICE_NAME_MAX_LENGTH));

/**
 * The `name=value` fields of a `v1` link fragment, decoded, or the reason the whole fragment is unreadable.
 *
 * ONE READER FOR EVERY LINK THAT CARRIES A CREDENTIAL IN ITS FRAGMENT — a pairing link and a share link
 * (`catalog-member.ts`) — so the two cannot come to hold different opinions about one string. Its rules: the
 * version must be `v1`; a field is `name=value`, percent-decoded; a REPEATED name is refused, because two
 * values for one name is a real ambiguity; an unrecognised name is kept for the caller to ignore. `link`
 * names the link in each sentence ("pairing link", "share link").
 */
export function readLinkFragmentFields(fragment: string, link: string): ReadonlyMap<string, string> {
  const pieces = (fragment.startsWith('#') ? fragment.slice(1) : fragment).split(';');
  if (pieces.shift() !== 'v1') throw new Error(`${link} version is not recognised`);
  const fields = new Map<string, string>();
  for (const piece of pieces) {
    const separator = piece.indexOf('=');
    if (separator <= 0) throw new Error(`${link} field is not name=value`);
    const name = piece.slice(0, separator);
    if (fields.has(name)) throw new Error(`${link} repeats ${name}`);
    try {
      fields.set(name, decodeURIComponent(piece.slice(separator + 1)));
    } catch {
      throw new Error(`${link} field ${name} is not decodable`);
    }
  }
  return fields;
}

/**
 * Whether a link's daemon address is one this app may dial: a parseable `http:` or `https:` URL. Any other
 * scheme (`javascript:`, `file:`, `ws:`) is refused, because the address came from whoever made the link.
 */
export function isDialableLinkAddress(address: string): boolean {
  try {
    const protocol = new URL(address).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// ─── addresses and published carriers (Connections' contract) ─────────────────────────────────────────────────────

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

/**
 * Whether a link's address names "this computer itself". From any other device it reaches nothing, so a
 * browser opening such a link goes to the rendezvous it discovered and does not dial the address at all, instead
 * of stalling on (and possibly being asked permission for) its own loopback. Anything unreadable is not loopback.
 */
export function isLoopbackLinkAddress(daemonUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(daemonUrl).hostname);
  } catch {
    return false;
  }
}

/** A rendezvous endpoint: wss/https everywhere, ws/http only on loopback, no query or fragment. */
const SocketEndpointSchema = z
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
const DaemonOriginSchema = z
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
const TunnelOriginSchema = z
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

const MAX_PUBLISHED_CARRIERS = 8;

/** One way a device may dial this daemon. WebRTC is not published: it is signalled inside a session. */
const PublishedCarrierSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('direct'), url: DaemonOriginSchema }),
  z.strictObject({ kind: z.literal('relay'), url: SocketEndpointSchema }),
  z.strictObject({ kind: z.literal('tunnel'), url: TunnelOriginSchema }),
]);

export const PublishedCarriersSchema = z.array(PublishedCarrierSchema).max(MAX_PUBLISHED_CARRIERS).readonly();
export type PublishedCarriers = z.infer<typeof PublishedCarriersSchema>;

// ─── harness names (Ferrets; today's `session-base.ts`) ───────────────────────────────────────────────────────────

export const HarnessSchema = z.enum(['claude', 'codex']);

// ─── the raw-key rule both ends run (MCP; today's `session-mcp.ts`) ───────────────────────────────────────────────

/**
 * A server's name, as both Claude Code's `.mcp.json` key and a fleet component name accept it: a letter
 * or digit, then letters, digits, `-` and `_`, at most 64 characters.
 */
export const SessionMcpNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u,
    'use letters, digits, - and _ (at most 64), starting with a letter or digit',
  );

/** An environment variable's name: upper case, digits and `_`, not starting with a digit. */
export const SessionMcpEnvNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/u, 'use NAME=value, with an upper-case NAME');

type SessionMcpScope = 'project' | 'login';

/** The two server shapes the rule reads (today's `SessionMcpServer`, the fields it touches). */
type SessionMcpServer =
  | {
      readonly transport: 'command';
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    }
  | { readonly transport: 'url'; readonly oauth: boolean };

/** Prefixes real providers put on their keys. */
export const RAW_KEY_PREFIXES =
  /^(?:sk-|sk_live_|sk_test_|rk_live_|AKIA|ASIA|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abposr]-|AIza|hf_|pk_live_)/u;
/** A name that announces a credential. */
const SECRET_SOUNDING_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/u;
/** A reference: Ferretry's secret store, or the environment. */
const SECRET_REFERENCE = /^\$\{secret:[A-Za-z0-9_.-]+\}$/u;
const ENV_REFERENCE = /^\$\{[A-Z_][A-Z0-9_]*(?::-[^}]*)?\}$/u;

/**
 * Why one environment value may not be written, or null when it may.
 *
 * - A `${secret:NAME}` reference is fine on a login and refused in a project file: the repo is shared
 *   and Claude Code reads the file itself, so nothing would ever fill it in.
 * - A value that looks like a raw key — a known provider prefix, or a long unbroken value under a name
 *   that says KEY / TOKEN / SECRET — is refused everywhere, with the way to store it instead.
 */
export const mcpEnvRefusal = (scope: SessionMcpScope, name: string, value: string): string | null => {
  const trimmed = value.trim();
  if (SECRET_REFERENCE.test(trimmed))
    return scope === 'project'
      ? `${name}: a project's .mcp.json is shared with the repo and read by Claude Code itself, so Ferretry cannot fill in \${secret:…} there. Use \${${name}} and give the ferret that variable, or add the server to This login.`
      : null;
  if (ENV_REFERENCE.test(trimmed)) return null;
  const looksRaw =
    RAW_KEY_PREFIXES.test(trimmed) ||
    (SECRET_SOUNDING_NAME.test(name) && trimmed.length >= 16 && !/[\s/]/u.test(trimmed));
  if (!looksRaw) return null;
  return scope === 'project'
    ? `${name} looks like a raw secret, and .mcp.json is shared with everyone on the repo. Use \${${name}} instead, or add the server to This login with \${secret:${name}}.`
    : `${name} looks like a raw secret. Run \`fy secret set ${name}\` and use \${secret:${name}} instead.`;
};

/** The first refusal over a whole server, or null. Arguments are checked for provider keys too. */
export const mcpServerRefusal = (scope: SessionMcpScope, server: SessionMcpServer): string | null => {
  if (server.transport === 'url')
    return scope === 'project' && server.oauth
      ? 'A project’s .mcp.json has no sign-in switch. Add the server, then sign in to it from its row in Tools: Ferretry keeps the token for this project and hands it to Claude Code.'
      : null;
  for (const [name, value] of Object.entries(server.env)) {
    const refusal = mcpEnvRefusal(scope, name, value);
    if (refusal !== null) return refusal;
  }
  for (const argument of server.args)
    if (RAW_KEY_PREFIXES.test(argument.trim()))
      return 'An argument looks like a raw secret. Put it in an environment variable that references the secret instead.';
  return null;
};

// ─── review text helpers (today's `fleet-clone-review.ts`) ────────────────────────────────────────────────────────

const asText = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

/** A command line as a person would type it: each argument with whitespace or quotes in it is quoted. */
export const commandLine = (command: string, args: readonly unknown[] = []): string =>
  [command, ...args.map(asText)]
    .map(part => (part === '' || /[\s"'\\$`]/u.test(part) ? JSON.stringify(part) : part))
    .join(' ');

/** A path inside the setup folder written exactly one way: no `.`/`..`/empty segment, no leading `/`, `~`, `$`, no `\`. */
export const isCanonicalAssetPath = (path: string): boolean =>
  path !== '' &&
  !path.startsWith('~') &&
  !path.startsWith('$') &&
  !path.includes('\\') &&
  path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
