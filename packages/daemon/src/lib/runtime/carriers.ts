/**
 * EVERY WAY THIS DAEMON MAY BE REACHED, AS ONE LIST AN OPERATOR WRITES.
 *
 * The document used to spell three unrelated-looking things — `host`, `port` and a `relay` block — for
 * one question: how does anything get to this daemon? The consequence was structural rather than
 * cosmetic. There was room for exactly ONE rendezvous, so a device pointed at a second one found an
 * empty room while both halves reported themselves healthy, and the hosted default had to be a
 * BRANCH — "ask the directory only when no block was written" — rather than an entry in a list.
 *
 * ## A BIND AND A RELAY ARE NOT TWO ROWS OF ONE TABLE
 *
 * The `kind` carries a consequence, which is why this is a discriminated union and not a uniform
 * record with a type field:
 *
 * - a **bind** LISTENS. It is inbound surface, and widening it is how a machine gets reached by
 *   somebody who was never invited.
 * - a **relay** DIALS OUT. It adds no inbound surface at all, because nothing can connect to a socket
 *   this daemon opened from behind its own NAT.
 *
 * That asymmetry is the entire reason the two bounds differ: **at most one bind, at most four relays.**
 * One bind because a daemon has one listening socket and more is a different feature. Four relays
 * because each is a dial-out that costs nothing but a socket — generous on purpose, bounded anyway, so
 * "expose it somewhere else too" is never free. A UI or CLI that rendered these as two identical rows
 * would make exposure the easy default; the union is what stops it.
 *
 * ## THE HOSTED DEFAULT IS AN ORDINARY ENTRY
 *
 * `{ kind: 'relay', source: 'discovery' }` is a relay whose ADDRESS is read at runtime instead of
 * written down. That subsumes the branch: there is no longer a rule about when the directory is asked,
 * only an entry that says to ask it. An operator who wants the hosted carrier AND their own writes both
 * entries, which was previously unrepresentable.
 *
 * ## NOTHING DERIVED IS PERSISTED, AND THE BIND PROVES WHY
 *
 * A bind's address moves: a first boot may take a different port and write it down, `--port` may claim
 * one for a single run. So the effective list is DERIVED on every read from the document plus whatever
 * the boot has since decided, exactly like `bindUrl` and `publicUrl`, and never written back. A
 * `carriers` array baked out to disk with yesterday's port is the same defect as a frozen `publicUrl`
 * — the operator edits one field and the daemon appears to ignore it.
 *
 * ## PRECEDENCE, AND WHY IT IS PRECEDENCE RATHER THAN A REFUSAL
 *
 * `host`, `port` and `relay` remain readable as the LEGACY SPELLING of a one-bind, one-relay list. When
 * `carriers` says nothing about a kind, the legacy keys are read as that kind's entry. When `carriers`
 * DOES name a kind, it wins and the legacy spelling of that same kind is superseded — reported, never
 * silent, because a key an operator edited with no effect is the worst outcome this file exists to
 * prevent. It is precedence rather than a refusal for a reason worth stating: `host` carries a default,
 * so a parsed document cannot tell "the operator wrote loopback" from "nobody said anything", and a
 * refusal built on that difference would refuse boots nobody misconfigured.
 */

import { SocketEndpointSchema } from '@ferretry/protocol';
import { z } from 'zod';

/** A host as an operator writes one: a name or an address, never empty. */
export const HostSchema = z.string().trim().min(1).max(255);
export const PortSchema = z.number().int().min(1).max(65_535);

/** How many of each kind one daemon may declare. See the module note: the asymmetry is the point. */
export const MAX_BIND_CARRIERS = 1;
export const MAX_RELAY_CARRIERS = 4;

/**
 * How long to wait before dialling a rendezvous again after a socket ends.
 *
 * A rendezvous holds the incumbent daemon's slot until its dead socket is swept — at most 45 seconds —
 * so a redial faster than the sweep is refused with `4409` rather than being granted early.
 */
const ReconnectSecondsSchema = z.number().int().positive().max(3_600).default(5);

/** Whether to dial or listen at all. A configured carrier switched off stays readable rather than
 *  having to be deleted and retyped, and switching one off is a decision rather than an omission. */
const EnabledSchema = z.boolean().default(true);

export const DaemonBindCarrierSchema = z.strictObject({
  kind: z.literal('bind'),
  host: HostSchema,
  /** Absent means this daemon may choose, once, and write the answer down — the same meaning the
   *  legacy `port` key has, because it is the same fact. */
  port: PortSchema.optional(),
});
export type DaemonBindCarrier = z.output<typeof DaemonBindCarrierSchema>;

/** The hosted carrier as an ordinary entry: an address read at runtime rather than written down. */
export const DiscoveredRelayCarrierSchema = z.strictObject({
  kind: z.literal('relay'),
  source: z.literal('discovery'),
  enabled: EnabledSchema,
  reconnectSeconds: ReconnectSecondsSchema,
});

/**
 * A rendezvous whose address the operator supplied.
 *
 * `url` IS PART OF THE SIGNATURE. The claim transcript covers the host the daemon believes it is
 * talking to, so this string has to be the one the rendezvous serves itself as; a daemon refuses to
 * sign a host it did not configure.
 */
export const ConfiguredRelayCarrierSchema = z.strictObject({
  kind: z.literal('relay'),
  url: SocketEndpointSchema,
  enabled: EnabledSchema,
  reconnectSeconds: ReconnectSecondsSchema,
});

export const DaemonRelayCarrierSchema = z.union([DiscoveredRelayCarrierSchema, ConfiguredRelayCarrierSchema]);
export type DaemonRelayCarrierEntry = z.output<typeof DaemonRelayCarrierSchema>;

/**
 * What a document that declares no rendezvous at all means: ask the directory.
 *
 * THIS IS THE HOSTED FALLBACK, AND IT IS NOW AN ENTRY RATHER THAN A BRANCH. The behaviour is exactly
 * what it already was — a fresh install with nothing configured reads Ferretry's runtime advertisement,
 * because a daemon that dialled nowhere was reachable from nothing but its own host. What changes is
 * that "when is the directory asked" stopped being a rule somewhere and became a member of a list.
 *
 * Saying "no relay, and I mean it" is therefore `{ kind: 'relay', source: 'discovery', enabled: false }`
 * — an explicit decision, which is the one thing an omission can never be.
 */
export const DISCOVERED_RELAY_CARRIER: DaemonRelayCarrierEntry = Object.freeze(
  DiscoveredRelayCarrierSchema.parse({ kind: 'relay', source: 'discovery' }),
);

/** Whether this entry's address is written down, as opposed to read from the directory at runtime. */
export function relayCarrierIsConfigured(
  relay: DaemonRelayCarrierEntry,
): relay is z.output<typeof ConfiguredRelayCarrierSchema> {
  return 'url' in relay;
}

export const DaemonCarrierEntrySchema = z.union([DaemonBindCarrierSchema, DaemonRelayCarrierSchema]);
export type DaemonCarrierEntry = z.output<typeof DaemonCarrierEntrySchema>;

/**
 * The operator's list, bounded per kind.
 *
 * THE BOUNDS ARE CHECKED HERE rather than by the surfaces that add entries, so a hand-edited document
 * is held to the same limit a command is. An over-long list refuses the boot: an operator who declared
 * five rendezvous meant something by the fifth, and quietly serving four of them is a daemon lying
 * about its own reach.
 */
export const DaemonCarriersDocumentSchema = z
  .array(DaemonCarrierEntrySchema)
  .readonly()
  .default([])
  .superRefine((carriers, context) => {
    const binds = carriers.filter(carrier => carrier.kind === 'bind').length;
    const relays = carriers.length - binds;
    if (binds > MAX_BIND_CARRIERS) {
      context.addIssue({
        code: 'custom',
        message: `a daemon has one listening socket, so at most ${String(MAX_BIND_CARRIERS)} "bind" carrier may be declared`,
      });
    }
    if (relays > MAX_RELAY_CARRIERS) {
      context.addIssue({
        code: 'custom',
        message: `at most ${String(MAX_RELAY_CARRIERS)} "relay" carriers may be declared`,
      });
    }
    const addresses = new Set<string>();
    for (const [index, carrier] of carriers.entries()) {
      if (carrier.kind !== 'relay') continue;
      const address = 'url' in carrier ? carrier.url : 'discovery';
      if (addresses.has(address)) {
        context.addIssue({ code: 'custom', path: [index], message: 'this rendezvous is already declared' });
      }
      addresses.add(address);
    }
  });

/** The legacy spelling of a one-relay list, as the document still carries it. */
export interface LegacyRelaySpelling {
  readonly url: string;
  readonly enabled: boolean;
  readonly reconnectSeconds: number;
}

export interface DaemonCarrierDocumentInput {
  readonly host: string;
  readonly port: number | undefined;
  readonly relay: LegacyRelaySpelling | undefined;
  readonly carriers: readonly DaemonCarrierEntry[];
}

/**
 * The one bind and the ordered relays this daemon has, as a shape where "exactly one bind" is a fact
 * of the TYPE rather than a rule a reader has to trust.
 *
 * A flat list would put the bound socket and the dial-outs back in one collection, and every consumer
 * would re-answer "which of these is the listener" — the shape of defect this whole module removes.
 */
export interface DaemonCarrierSet {
  readonly bind: DaemonBindCarrier;
  readonly relays: readonly DaemonRelayCarrierEntry[];
}

/**
 * The effective carriers: what `carriers` says, with the legacy keys read as the kinds it omits.
 *
 * A LEGACY KEY IS SUPERSEDED PER KIND, not wholesale. Somebody midway through moving to the new
 * spelling — a `carriers` array holding only relays, `host` and `port` still at the top — gets both
 * read, which is the only reading that does not silently change where their daemon listens.
 */
export function resolveDaemonCarriers(input: DaemonCarrierDocumentInput): DaemonCarrierSet {
  const declaredBind = input.carriers.find((carrier): carrier is DaemonBindCarrier => carrier.kind === 'bind');
  const declaredRelays = input.carriers.filter(
    (carrier): carrier is DaemonRelayCarrierEntry => carrier.kind === 'relay',
  );
  const bind =
    declaredBind ??
    DaemonBindCarrierSchema.parse({
      kind: 'bind',
      host: input.host,
      ...(input.port === undefined ? {} : { port: input.port }),
    });
  if (declaredRelays.length > 0) return { bind, relays: declaredRelays };
  const legacy = input.relay;
  const relay =
    legacy === undefined ? DISCOVERED_RELAY_CARRIER : ConfiguredRelayCarrierSchema.parse({ kind: 'relay', ...legacy });
  return { bind, relays: [relay] };
}

/**
 * What this report is READ FROM: the document as the operator typed it, before any schema put a
 * default in it.
 *
 * THE DISTINCTION IS THE WHOLE CORRECTNESS OF THE REPORT. `host` carries a default, so a parsed
 * document says `host: '127.0.0.1'` whether the operator wrote that line or wrote nothing at all.
 * Reading the parsed value would make this function announce "your `host` key was superseded" to
 * somebody who never typed a `host` key — telling them to go delete something that is not in their
 * file. Only key PRESENCE in the raw document distinguishes "written" from "defaulted", so only the
 * raw document is accepted here, and the field is named so that handing over the parsed one reads
 * as the mistake it is.
 */
export interface DaemonCarrierDocumentKeys {
  /** The document as parsed from JSON and NOT through a schema: no defaults, no coercions. */
  readonly rawDocument: Readonly<Record<string, unknown>>;
  /** The effective `carriers` list, which is what supersedes a legacy key in the first place. */
  readonly carriers: readonly DaemonCarrierEntry[];
}

/**
 * Which legacy keys an operator edited with no effect, so a boot can say so.
 *
 * A SUPERSEDED KEY IS REPORTED RATHER THAN REFUSED OR IGNORED. Ignoring it is how `port` became a field
 * that could be changed with no error, no message and no change in behaviour — the defect that started
 * all of this. Naming it is what lets somebody finish a migration they began.
 *
 * EACH KEY IS REPORTED ON ITS OWN. `host` and `port` are one bind between them but two lines in a
 * file, and somebody who wrote only `port` is told about `port` alone rather than being sent looking
 * for a `host` key that was never there.
 */
export function supersededCarrierKeys(input: DaemonCarrierDocumentKeys): readonly string[] {
  const written = (key: string): boolean => Object.hasOwn(input.rawDocument, key);
  const keys: string[] = [];
  if (input.carriers.some(carrier => carrier.kind === 'bind')) {
    if (written('host')) keys.push('host');
    if (written('port')) keys.push('port');
  }
  if (input.carriers.some(carrier => carrier.kind === 'relay') && written('relay')) keys.push('relay');
  return keys;
}
