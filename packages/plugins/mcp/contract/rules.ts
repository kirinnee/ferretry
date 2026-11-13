/**
 * The rules both ends run, copied back next to the schemas they guard (wire.ts stripped them): the secret NAMES a
 * sign-in files its tokens under (one owner for the spelling, so the launch environment and the store agree to the
 * bit), the project-server subject, and the one refusal both MCP-add routes and the app run on a value that looks like
 * a raw key (G180). Pure and synchronous.
 */
import {
  MCP_OAUTH_CALLBACK_PATH,
  MCP_PROJECT_SUBJECT_SEPARATOR,
  type SessionMcpScope,
  type SessionMcpServer,
  SecretNameSchema,
} from './wire.ts';

type SecretName = ReturnType<typeof SecretNameSchema.parse>;

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

/**
 * SHA-256 (FIPS 180-4) as lowercase hex, synchronously, with no dependency. Synchronous because the fleet
 * materialiser that names a secret is pure and synchronous, and it must agree with the daemon to the bit.
 */
export function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text);
  const length = Math.ceil((data.length + 9) / 64) * 64;
  const padded = new Uint8Array(length);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(length - 8, Math.floor((data.length * 8) / 0x100000000));
  view.setUint32(length - 4, (data.length * 8) >>> 0);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < length; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const a = w[index - 15] as number;
      const b = w[index - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[index] = ((w[index - 16] as number) + s0 + (w[index - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as unknown as number[];
    for (let index = 0; index < 64; index += 1) {
      const t1 =
        ((h as number) +
          (rotr(e as number, 6) ^ rotr(e as number, 11) ^ rotr(e as number, 25)) +
          (((e as number) & (f as number)) ^ (~(e as number) & (g as number))) +
          (K[index] as number) +
          (w[index] as number)) >>>
        0;
      const t2 =
        ((rotr(a as number, 2) ^ rotr(a as number, 13) ^ rotr(a as number, 22)) +
          (((a as number) & (b as number)) ^ ((a as number) & (c as number)) ^ ((b as number) & (c as number)))) >>>
        0;
      h = g;
      g = f;
      f = e;
      e = ((d as number) + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h] as number[];
    for (let index = 0; index < 8; index += 1) hash[index] = ((hash[index] as number) + (next[index] as number)) >>> 0;
  }
  return [...hash].map(word => word.toString(16).padStart(8, '0')).join('');
}

/**
 * A server's canonical address (the MCP spec's "canonical server URI"): no fragment, and no trailing
 * slash on a path that has one. The one spelling a token's binding is computed from.
 */
export function mcpOAuthServerKey(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = '';
  const text = url.toString();
  return url.search === '' && url.pathname !== '/' ? text.replace(/\/+$/u, '') : text;
}

/** The longest stem a component name contributes to a secret name. */
const NAME_STEM_LENGTH = 16;

/** The secrets and the variable one MCP component's sign-in lives under. */
export interface McpOAuthSecretNames {
  readonly access: SecretName;
  /** Held in the daemon-internal store, never the ordinary one: nothing but the sign-in reads it. */
  readonly refresh: SecretName;
  /** The launch-environment variable a harness reads the access token from. Not a secret NAME. */
  readonly variable: string;
}

/**
 * The secret names for one component's tokens AT ONE SERVER.
 *
 * Upper-cased, every other character an `_`, cut to {@link NAME_STEM_LENGTH}, and followed by 64 bits
 * of SHA-256 over the EXACT component name AND the server's canonical address. So `my-server` and
 * `my_server` never share a token, and — the property that matters — **a token is bound to the server
 * it was issued for**: change a component's `url` and the materialiser names a secret the store does not
 * hold, so the launch is refused rather than sending the old server's token to the new one.
 */
export function mcpOAuthSecretNames(component: string, serverUrl: string): McpOAuthSecretNames {
  const stem = component
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, NAME_STEM_LENGTH)
    .replace(/_+$/u, '');
  const binding = sha256Hex(`${component}\n${mcpOAuthServerKey(serverUrl)}`)
    .slice(0, 16)
    .toUpperCase();
  const base = `MCP_${stem === '' ? '' : `${stem}_`}${binding}`;
  return {
    access: SecretNameSchema.parse(`${base}_ACCESS`),
    refresh: SecretNameSchema.parse(`${base}_REFRESH`),
    variable: `FY_${base}_TOKEN`,
  };
}

/**
 * Whether a secret's name is one a sign-in filed itself: an MCP server's OAuth access token.
 *
 * It is the SHAPE {@link mcpOAuthSecretNames} writes (`MCP_<stem>_<16 hex>_ACCESS`), so it answers for
 * every name that function can produce and for no name a person would choose. A secret copy refuses
 * these: the token is half of a sign-in whose refresh half cannot travel, and a copy would be a
 * login that is dead on the other machine within the hour (docs/secrets.md).
 */
export function isSignInSecretName(name: string): boolean {
  return new RegExp(`^(?:${SIGN_IN_SECRET_NAME})$`, 'u').test(name);
}

/** The pattern of {@link isSignInSecretName}, unanchored: what MCP's manifest declares it mints in the Vault. */
export const SIGN_IN_SECRET_NAME = 'MCP_(?:[A-Z0-9_]+_)?[0-9A-F]{16}_ACCESS';

/**
 * One authorization server's own callback path (OAuth Security BCP §4.4.2, the per-AS redirect mix-up
 * defence): a code one provider sends back can only ever arrive at the path of a flow with THAT provider.
 */
export function mcpOAuthRedirectPath(issuer: string): string {
  return `${MCP_OAUTH_CALLBACK_PATH}/${sha256Hex(issuer.replace(/\/+$/u, '')).slice(0, 16)}`;
}

/** The short digest naming a project in a subject: lower-case hex. */
const PROJECT_KEY = /^[0-9a-f]{8,64}$/u;

/**
 * The subject a project server's sign-in is filed under: its name, then the project it belongs to.
 * `projectKey` is the daemon's short digest of the project's root, so every worktree of one project
 * shares the sign-in, and two projects with a same-named server do not.
 */
export const mcpProjectSubject = (name: string, projectKey: string): string =>
  `${name}${MCP_PROJECT_SUBJECT_SEPARATOR}${projectKey}`;

/** The name and project key in a project subject, or null for anything else (a component name). */
export const parseMcpProjectSubject = (
  subject: string,
): { readonly name: string; readonly projectKey: string } | null => {
  const at = subject.lastIndexOf(MCP_PROJECT_SUBJECT_SEPARATOR);
  if (at <= 0) return null;
  const projectKey = subject.slice(at + MCP_PROJECT_SUBJECT_SEPARATOR.length);
  return PROJECT_KEY.test(projectKey) ? { name: subject.slice(0, at), projectKey } : null;
};

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

// ── Loopback host spelling (today's `address.ts`, copied: the sign-in's https rule reads it) ──
const LOOPBACK_IPV4_BLOCK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;

/** One group of an IPv6 spelling, which is where an all-zero or all-but-one-zero address is read. */
const IPV6_GROUP = /^[0-9a-f]{1,4}$/u;

/** The number of groups a whole IPv6 address has, and the index of the one loopback sets. */
const IPV6_GROUP_COUNT = 8;
/**
 * A host spelling with the decorations an operator's spelling may carry taken off.
 *
 * Case is not meaningful in a host name and brackets are not part of one — they are how an authority
 * carries a raw IPv6 address, and `daemonAddress` above puts them on. Taking both off once, here, is
 * what keeps the predicates below from being a list of spellings somebody must remember to extend.
 */
function bareHost(host: string): string {
  const lowered = host.trim().toLowerCase();
  return lowered.startsWith('[') && lowered.endsWith(']') ? lowered.slice(1, -1) : lowered;
}

/**
 * The eight groups of an IPv6 spelling, or `undefined` when the host is not one.
 *
 * READ RATHER THAN LISTED, because `::`, `::0` and `0:0:0:0:0:0:0:0` are one address and a set that
 * held only the first called the other two routable. A daemon bound to every interface under either
 * of the other two spellings therefore had an advertisement derived from a bind instruction, and the
 * phone was handed a link that fails with nothing to explain it. Reading the groups leaves no
 * spelling of an all-zero address unrecognised, which no list of them can promise.
 *
 * The IPv4-mapped form is deliberately NOT read here. It is what a socket reports and never what an
 * operator writes, so it belongs to `isLoopbackPeer` below and to nothing in this domain.
 */
function ipv6Groups(host: string): readonly number[] | undefined {
  if (!host.includes(':')) return undefined;
  const halves = host.split('::');
  if (halves.length > 2) return undefined;
  const head = ipv6GroupsOf(halves[0] ?? '');
  const tail = ipv6GroupsOf(halves[1] ?? '');
  if (head === undefined || tail === undefined) return undefined;
  if (halves.length === 1) return head.length === IPV6_GROUP_COUNT ? head : undefined;
  // `::` stands for at least one elided group, so a spelling that leaves none is not an address.
  const elided = IPV6_GROUP_COUNT - head.length - tail.length;
  return elided < 1 ? undefined : [...head, ...new Array<number>(elided).fill(0), ...tail];
}

/** The groups on one side of a `::`, or `undefined` when any of them is not a group at all. */
function ipv6GroupsOf(half: string): readonly number[] | undefined {
  if (half === '') return [];
  const groups = half.split(':').map(group => (IPV6_GROUP.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  return groups.some(Number.isNaN) ? undefined : groups;
}

/** A host SPELLING, as an operator writes one: names included. */
export function isLoopbackHost(host: string): boolean {
  const bare = bareHost(host);
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  if (LOOPBACK_IPV4_BLOCK.test(bare)) return true;
  const groups = ipv6Groups(bare);
  if (groups === undefined) return false;
  return groups.every((group, index) => group === (index === IPV6_GROUP_COUNT - 1 ? 1 : 0));
}
