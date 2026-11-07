/**
 * Minimal local copies of small names other subsystems own, kept here so this library imports nothing from another
 * plugin's `daemon/` (a half imports only its own files, its manifest and contracts). Each is marked with its owner:
 * when that owner's contract grows the name, the copy is deleted and the import repointed.
 */
import { createHash } from 'node:crypto';
import { type SecretName, SecretNameSchema } from '@ferretry/core-vault/contract';

// ─── hashing (GAP(mcp): `sha256Hex` was in today's `mcp-oauth.ts`; Node's hash gives the same digest) ──────────────

/** SHA-256 of `text` as lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ─── MCP sign-in secret names (GAP(mcp): owner is the mcp plugin's daemon/lib; its contract does not carry it) ─────

/** The server address, canonical: no fragment, no trailing slash on a bare path. */
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
 * The secret names for one component's tokens AT ONE SERVER: upper-cased stem plus 64 bits of SHA-256 over the exact
 * component name and the server's canonical address, so a token is bound to the server it was issued for.
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

// ─── loopback host spelling (GAP(kernel): today's `protocol/src/lib/address.ts`; no contract carries it yet) ────────

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

/** Whether a host SPELLING, as an operator writes one, names this computer itself. */
export function isLoopbackHost(host: string): boolean {
  const bare = bareHost(host);
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  if (LOOPBACK_IPV4_BLOCK.test(bare)) return true;
  const groups = ipv6Groups(bare);
  if (groups === undefined) return false;
  return groups.every((group, index) => group === (index === IPV6_GROUP_COUNT - 1 ? 1 : 0));
}

// ─── agenda and ferret launch names (GAP(agenda), GAP(ferrets): not in any contract yet) ──────────────────────────

/** The one line a ferret's prompt carries about agenda kinds (today's `AGENDA_SHAPE_LINE`). */
export const AGENDA_SHAPE_LINE =
  'Kinds: choice=ONE question+2–3 `-o "Label: why"`, `--recommend`; reply=open or several asks (one `-q` each); form=several structured answers (`--field`); todo=`--step`s; info=Got it; permission=Approve/Deny.';

/** The sections of the one appended system prompt, by name. */
export type LaunchInstructionSectionId =
  | 'tools'
  | 'settings'
  | 'notify'
  | 'board'
  | 'sub-ferret'
  | 'hypermedia'
  | 'pack'
  | 'agenda'
  | 'learning';

/** What one launch was told: its sections by name and size (never the text), its mode, and whether it may ask. */
export interface SessionLaunchInstructions {
  readonly sections: readonly { readonly id: LaunchInstructionSectionId; readonly chars: number; readonly digest?: string }[];
  readonly mode: 'interactive' | 'auto';
  readonly questions: boolean;
}

// ─── the launch variable that names a runtime's login (GAP(logins): today's `usage.ts`) ────────────────────────────

/** The variable a wrapper sets to the login its runtime spends. */
export const CREDENTIAL_ENV = 'FY_CREDENTIAL';
