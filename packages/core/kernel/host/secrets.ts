/**
 * `kernel.secrets` for one plugin (lead decision J). The order is the contract: the manifest names it, the plugin's
 * own configuration in effect names it as a `${secret:NAME}` reference, and only then is the Vault asked, through the
 * kernel-only {@link SecretResolver}. Nothing a caller sends is read: the reference set comes from the config
 * service, the name list from the manifest.
 *
 * `send` (K-secrets, design #9) is today's `OutboundProviderAuthorizer.send` held by the kernel: the same three-step
 * rule, today's destination / placement / echo rules, and the value lives only in this function's frame for the one
 * call. Read `docs/secrets.md` before changing it.
 */
import type { SecretResolver } from '../contract/bound.ts';
import type { Log } from '../contract/ports.ts';
import {
  allowedDestination,
  type CredentialPlacement,
  CredentialPlacementSchema,
  type OutboundSecretOutcome,
  type OutboundSecretRefusal,
  OutboundSecretRequestSchema,
  OwnSecret,
  type OwnSecretRefusal,
  SECRET_REFERENCE_SOURCE,
  type SecretsPort,
} from '../contract/secrets.ts';
import type { PermissionEntry } from '../manifest/types.ts';
import { WILDCARD } from '../manifest/reach.ts';
import type { OutboundSecretTransport } from './adapters/outbound-secret.ts';

const WHOLE_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

/** Every `${secret:NAME}` named by any string anywhere in a configuration value. */
export function secretReferencesIn(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(new RegExp(SECRET_REFERENCE_SOURCE, 'gu')))
      if (match[1] !== undefined) into.add(match[1]);
  } else if (Array.isArray(value)) for (const item of value) secretReferencesIn(item, into);
  else if (value !== null && typeof value === 'object')
    for (const item of Object.values(value as Record<string, unknown>)) secretReferencesIn(item, into);
  return into;
}

/**
 * The sentence for each `${secret:NAME}` that `after` names and `before` (what is in effect) does not: adding one is
 * the OWNER's to do, so an edit that adds one waits for the owner (NN2), whatever the file's own `loosens` says.
 */
export function addedSecretReferenceSentences(before: unknown, after: unknown): readonly string[] {
  const had = secretReferencesIn(before);
  return [...secretReferencesIn(after)]
    .filter(name => !had.has(name))
    .sort()
    .map(name => `names the secret ${name}, which only the owner may add to a configuration`);
}

/**
 * The hosts a secret may be SENT to: the plain host entries of the plugin's effective `permissions.network` (a
 * non-core `'*'` is already dropped by `effectivePermissions`). A wildcard, `'*'`, an `{ items }` or a `{ resolver }`
 * entry names no exact host, so it lets no key out.
 */
export function exactNetworkHosts(declared: readonly PermissionEntry[]): readonly string[] {
  return declared.flatMap(entry =>
    typeof entry === 'string' && entry !== WILDCARD && !entry.includes('*') ? [entry.toLowerCase()] : [],
  );
}

/** What `send` needs beyond `resolve`: this plugin's own guarded fetch, its exact hosts and its log. */
export interface OwnSecretSending {
  /** The exact hosts ({@link exactNetworkHosts}) of this plugin's effective `permissions.network`. */
  readonly hosts: readonly string[];
  /** The same host check this plugin's `kernel.fetch` makes, asked first so a refusal is a refusal, never `network`. */
  readonly mayReach: (hostname: string, host: string) => boolean;
  /** Over this plugin's OWN `kernel.fetch` (`host/adapters/outbound-secret.ts`). */
  readonly transport: OutboundSecretTransport;
  /** This plugin's log: a send is logged by secret name and host, never more. */
  readonly log: Log;
}

const DEFAULT_PLACEMENT: CredentialPlacement = { header: 'authorization', scheme: 'Bearer' };

/** The one rule both members share, in its order; the Vault is asked only after the name is declared and configured. */
type Owned = { readonly value: string } | { readonly refused: OwnSecretRefusal } | { readonly damaged: true };

function carriesHeader(headers: Readonly<Record<string, string>>, header: string): boolean {
  return Object.keys(headers).some(name => name.toLowerCase() === header.toLowerCase());
}

/** Whether a parsed reply contains the credential anywhere in its serialisation. */
function echoes(payload: unknown, value: string): boolean {
  return JSON.stringify(payload ?? null).includes(value);
}

const refused = (why: OutboundSecretRefusal): OutboundSecretOutcome => ({ kind: 'refused', refused: why });

export function ownSecretsPort(
  declared: readonly string[],
  references: () => ReadonlySet<string> | Promise<ReadonlySet<string>>,
  resolver: () => SecretResolver | undefined,
  sending?: OwnSecretSending,
): SecretsPort {
  const names = new Set(declared);
  const isDeclared = (name: string): boolean => WHOLE_NAME.test(name) && names.has(name);
  const isConfigured = async (name: string): Promise<boolean> => {
    try {
      return (await references()).has(name);
    } catch {
      return false;
    }
  };
  const owned = async (name: string): Promise<Owned> => {
    if (!isDeclared(name)) return { refused: 'not_declared' };
    if (!(await isConfigured(name))) return { refused: 'not_configured' };
    const vault = resolver();
    if (vault === undefined) return { refused: 'unknown' };
    try {
      const value = await vault.resolve(name);
      return value === undefined ? { refused: 'unknown' } : { value };
    } catch {
      return { damaged: true };
    }
  };

  const send = async (name: string, asked: unknown, placementAsked?: unknown): Promise<OutboundSecretOutcome> => {
    // What the caller passed is PARSED once into plain data of our own, and only that copy is checked and sent (S162).
    const parsedRequest = OutboundSecretRequestSchema.safeParse(asked);
    if (!parsedRequest.success) return refused('destination');
    const parsedPlacement = CredentialPlacementSchema.safeParse(placementAsked ?? DEFAULT_PLACEMENT);
    if (!parsedPlacement.success) return refused('placement');
    const request = parsedRequest.data;
    const placement = parsedPlacement.data;
    const secret = String(name);
    if (!isDeclared(secret)) return refused('not_declared');
    if (sending === undefined || !allowedDestination(request.url, sending.hosts)) return refused('destination');
    const url = new URL(request.url);
    if (!sending.mayReach(url.hostname, url.host)) return refused('destination');
    if (carriesHeader(request.headers, placement.header)) return refused('placement');
    const found = await owned(secret);
    if ('refused' in found) return refused(found.refused);
    if ('damaged' in found) return { kind: 'vault_damaged' };
    const value = found.value.trim();
    if (value.length === 0) return refused('unknown');

    let outcome: OutboundSecretOutcome;
    try {
      const credential = placement.scheme === undefined ? value : `${placement.scheme} ${value}`;
      outcome = await sending.transport.send({
        ...request,
        headers: { ...request.headers, [placement.header]: credential },
      });
      if (outcome.kind === 'completion' && echoes(outcome.payload, value)) outcome = { kind: 'unreadable' };
    } catch {
      // Whatever threw is mapped to a kind: its message never leaves, so it cannot carry the value.
      outcome = { kind: 'network' };
    }
    sending.log.info('a secret was placed on a request', { secret, host: url.host, outcome: outcome.kind });
    return outcome;
  };

  return Object.freeze({
    resolve: async (name: string) => {
      const found = await owned(name);
      if ('refused' in found) return { refused: found.refused };
      // A store that cannot be opened is `unknown` here, as it always was.
      if ('damaged' in found) return { refused: 'unknown' as const };
      return new OwnSecret(name, found.value);
    },
    send: async (name: string, request: unknown, placement?: unknown) => await send(name, request, placement),
  });
}
