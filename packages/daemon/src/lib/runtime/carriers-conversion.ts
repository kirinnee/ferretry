/**
 * THE LEGACY `host`, `port` AND `relay` KEYS, REWRITTEN AS `carriers` ENTRIES — decided here, done by an
 * adapter, and refused whenever the rewrite could change what the daemon does.
 *
 * `carriers` is the one spelling of how this daemon is reached (`carriers.ts`). A document an older
 * release wrote still says it with three top-level keys, which are read forever as the legacy spelling
 * of a one-bind, one-relay list. This file turns that document into the new spelling ONCE, at boot, so
 * that nothing on disk is in the old one.
 *
 * ## WHAT IT WRITES IS WHAT THE OPERATOR WROTE
 *
 * The conversion adds no value. Every field of an entry is a field the operator typed, in the spelling
 * they typed it (`host` as a string they chose, `port` only if they wrote one, a relay block with exactly
 * its written fields, `enabled: false` included). Nothing derived is persisted — `carriers.ts` explains
 * why that is the invariant — so this is a new spelling of the same statement, not a new statement.
 * That also keeps an unwritten `port` meaning "this boot may choose, once, and record".
 *
 * ## NO RELAY BLOCK WRITTEN MEANS NO RELAY ENTRY ADDED
 *
 * A document with no `relay` block and no relay carrier resolves to `[DISCOVERED_RELAY_CARRIER]`
 * (`resolveDaemonCarriers`): the hosted discovery relay. That is true before the rewrite and, because
 * the rewrite adds no relay entry, true after it — so omission already means the hosted relay and the
 * owner's machine, which has no relay block, keeps dialling exactly the rendezvous it dials today. Writing
 * a discovery entry for it would be a new statement the operator never made.
 *
 * ## THE GUARD IS WHY THIS IS SAFE TO RUN AT BOOT
 *
 * A wrong rewrite of this file locks somebody out of their own machine, so the rewrite is not trusted:
 * the candidate must parse with the full configuration schema and must READ THE SAME as the original —
 * every value the configuration derives, the listener, the carrier set and the addresses included. Anything
 * else is a refusal that writes nothing. Two relay URL schemas exist (the legacy block validates with
 * `@ferretry/relay`, a carrier with `@ferretry/protocol`), and a URL one accepts and the other does not
 * is exactly the case this exists for: it ends in a refusal with a sentence, never in a crash or a file
 * the next boot refuses.
 *
 * It is total over any JSON value, and idempotent: a document with none of the three keys is `none`, and
 * the output of a conversion has none.
 */

import { declaredBind } from '@ferretry/protocol';
import { documentWithCarrierEntries, isCarrierOfKind, legacyBindEntry } from './carriers.ts';
import { type DaemonConfig, parseDaemonConfig } from './config.ts';

/** The three top-level keys that spell, in the legacy way, how this daemon is reached. */
const LEGACY_CARRIER_KEYS = ['host', 'port', 'relay'] as const;

export type CarrierConversion =
  /** Nothing to do: none of the legacy keys is written. */
  | { readonly kind: 'none' }
  /** The document to write, and what changed — key names and entry shapes, never anything else. */
  | {
      readonly kind: 'convert';
      readonly document: Readonly<Record<string, unknown>>;
      readonly removedKeys: readonly string[];
      readonly addedEntries: readonly Readonly<Record<string, unknown>>[];
    }
  /** Left exactly as it is, with a sentence saying why. */
  | { readonly kind: 'refuse'; readonly reason: string };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** How a document is read into a configuration: the real schema, unless a test needs to force a disagreement. */
type ReadConfiguration = (document: unknown) => DaemonConfig;

function parsed(read: ReadConfiguration, document: Readonly<Record<string, unknown>>): DaemonConfig | string {
  try {
    return read(document);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Everything the configuration reads out of a document EXCEPT the two raw spellings being rewritten.
 *
 * `relay` and `carriers` are the keys the rewrite changes on purpose; their MEANING is in `carrierSet`,
 * `host`, `port` and the addresses, all of which stay in. Serialised so that equality is structural and
 * the comparison cannot depend on a field it was not written to know about: a future derived field is
 * compared automatically.
 */
function effectiveReading(config: DaemonConfig): string {
  const { relay: _relay, carriers: _carriers, ...rest } = config;
  return canonical(rest);
}

/**
 * JSON with every object's keys in sorted order, so two readings that hold the same values compare equal
 * however their keys happened to be inserted: the transform that derives a reading puts `port` in a
 * different place depending on whether the document wrote one.
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      : inner,
  );
}

/**
 * The rewrite of a RAW document (JSON-parsed, never schema-parsed: key PRESENCE is what says what was
 * written, and a parsed document says `host` whether or not anybody typed it).
 *
 * `read` is the configuration parse the guard compares with; it is a parameter only so the refusal can be
 * exercised, since no real input is known that the two readings disagree on.
 */
export function planCarrierConversion(
  rawDocument: unknown,
  read: ReadConfiguration = parseDaemonConfig,
): CarrierConversion {
  if (!isRecord(rawDocument)) return { kind: 'none' };
  const written = (key: string): boolean => Object.hasOwn(rawDocument, key);
  const removedKeys = LEGACY_CARRIER_KEYS.filter(written);
  if (removedKeys.length === 0) return { kind: 'none' };

  if (written('carriers') && !Array.isArray(rawDocument.carriers))
    return { kind: 'refuse', reason: 'its "carriers" value is not a list, so there is nowhere to put the entries' };

  const entries: unknown[] = Array.isArray(rawDocument.carriers) ? rawDocument.carriers : [];
  const added: Record<string, unknown>[] = [];

  // PER KIND, as the reader is: a declared bind already supersedes host and port, and a declared relay
  // already supersedes the relay block — those keys only need to go.
  const hasBind = declaredBind(rawDocument) !== rawDocument;
  if (!hasBind && (written('host') || written('port'))) added.push(legacyBindEntry(rawDocument));

  const hasRelay = entries.some(entry => isCarrierOfKind(entry, 'relay'));
  if (!hasRelay && written('relay')) {
    if (!isRecord(rawDocument.relay))
      return { kind: 'refuse', reason: 'its "relay" value is not an object, so it cannot become a carrier entry' };
    added.push({ kind: 'relay', ...rawDocument.relay });
  }

  const document = documentWithCarrierEntries(rawDocument, removedKeys, added);

  const before = parsed(read, rawDocument);
  if (typeof before === 'string')
    return { kind: 'refuse', reason: `the document does not parse as it stands (${before})` };
  const after = parsed(read, document);
  if (typeof after === 'string') return { kind: 'refuse', reason: `the converted document would not parse (${after})` };
  if (effectiveReading(before) !== effectiveReading(after))
    return {
      kind: 'refuse',
      reason:
        'the converted document would not read the same as the original (the listener, carriers or addresses differ)',
    };

  return { kind: 'convert', document, removedKeys, addedEntries: added };
}
