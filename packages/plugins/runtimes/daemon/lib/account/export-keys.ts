/**
 * Origin keys — `<FY_HOME>/fleet/setup/export-keys.json` (docs/design/account-model.md §3.8).
 *
 * A copy of a setup has to tell a RENAMED item from a NEW one, or the next copy would duplicate
 * everything the person tidied since the last. So the source gives every item it exports a random
 * key the first time, remembers it here, and sends it in the bundle; it keeps the key through a rename
 * and mints a fresh one for anything genuinely new.
 *
 * Pure: the file is read and written by the caller, randomness is injected, and what this decides is a
 * value a test can assert on.
 *
 * - A key is 16 random bytes in base32. Nothing about the item can be read from it.
 * - A runtime's key is its id from `ids.json` (§3.5 R6) written the same way, so the key a runtime has
 *   is the one id it already has: no second thing to keep in step, and a rename already keeps it.
 * - Rename inheritance: a name that is new, whose digest equals the last digest of a name that has
 *   vanished, inherits that name's key. Renamed AND edited gets a new key — this is the only guess made,
 *   and it errs towards "new item", which a target shows rather than overwrites.
 * - Entries for items that are gone are dropped, so the file never outgrows the setup.
 * - The file is bookkeeping in STATE and never in the configuration. A file that does not parse is not
 *   an error: its keys are simply minted again.
 */
import { type OriginKey, OriginKeySchema } from '../../../contract/index.ts';
import type { CloneBundleDraft } from './clone-parts.ts';
import { type CloneDigestKind, cloneItemDigest } from '../clone-digest.ts';
import { z } from 'zod';

/** Directly under the fleet directory. */
export const EXPORT_KEYS_FILE = 'setup/export-keys.json';

export const EXPORT_KEYS_VERSION = 1 as const;

export const ExportKeysSchema = z.strictObject({
  version: z.literal(EXPORT_KEYS_VERSION),
  /** `<kind>/<name>`, `profile/<name>` or `login/<id>` → the key it was given and what it held then. */
  items: z.record(
    z.string().min(1),
    z.strictObject({ key: OriginKeySchema, digest: z.string().regex(/^[0-9a-f]{64}$/u) }),
  ),
});
export type ExportKeys = z.infer<typeof ExportKeysSchema>;

export const EMPTY_EXPORT_KEYS: ExportKeys = { version: EXPORT_KEYS_VERSION, items: {} };

/** The stored keys, or none when the text is absent or cannot be read: then every key is minted again. */
export function parseExportKeys(text: string | undefined): ExportKeys {
  if (text === undefined) return EMPTY_EXPORT_KEYS;
  try {
    const parsed = ExportKeysSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : EMPTY_EXPORT_KEYS;
  } catch {
    return EMPTY_EXPORT_KEYS;
  }
}

/** The file's text, items in order, so writing an unchanged file is byte-identical. */
export function serializeExportKeys(keys: ExportKeys): string {
  const items = Object.fromEntries(
    Object.keys(keys.items)
      .toSorted()
      .map(name => [name, keys.items[name]]),
  );
  return `${JSON.stringify({ version: keys.version, items }, null, 2)}\n`;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Bytes as lower-case base32 without padding. 16 bytes are 26 characters. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let held = 0;
  let out = '';
  for (const byte of bytes) {
    held = (held << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(held >>> (bits - 5)) & 31];
      bits -= 5;
    }
    held &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(held << (5 - bits)) & 31];
  return out;
}

/** A runtime id (a UUID) as the origin key it stands for: the same 16 bytes, written the same way. */
export function originKeyOfId(id: string): OriginKey | undefined {
  const hex = id.replaceAll('-', '');
  if (!/^[0-9a-fA-F]{32}$/u.test(hex)) return undefined;
  return base32(
    Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)),
  );
}

export interface OriginKeyInput {
  /** The bundle as built (v1 shape); every digest is taken from it, as the target will take it. */
  readonly bundle: CloneBundleDraft;
  readonly previous: ExportKeys;
  /** Each runtime's id by name (`ids.json`). A runtime with none is given a key that is not kept. */
  readonly runtimeIds: Readonly<Record<string, string>>;
  /** 16 random bytes. */
  randomBytes(length: number): Uint8Array;
}

export interface OriginKeyResult {
  /** Every exported item's key, as the bundle carries it. */
  readonly keys: Readonly<Record<string, OriginKey>>;
  /** What to remember for the next export. */
  readonly stored: ExportKeys;
}

interface Item {
  readonly reference: string;
  readonly kind: CloneDigestKind;
  readonly value: Readonly<Record<string, unknown>>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const itemsOf = (bundle: CloneBundleDraft): readonly Item[] => [
  ...Object.entries(bundle.components).flatMap(([kind, entries]) =>
    Object.entries(entries).flatMap(([name, value]) =>
      isRecord(value) ? [{ reference: `${kind}/${name}`, kind: kind as CloneDigestKind, value }] : [],
    ),
  ),
  ...Object.entries(bundle.profiles).flatMap(([name, value]) =>
    isRecord(value) ? [{ reference: `profile/${name}`, kind: 'profile' as const, value }] : [],
  ),
  ...bundle.credentials.map(credential => ({
    reference: `login/${credential.id}`,
    kind: 'login' as const,
    value: credential as unknown as Readonly<Record<string, unknown>>,
  })),
  ...Object.entries(bundle.runtimes).flatMap(([name, value]) =>
    isRecord(value) ? [{ reference: `runtime/${name}`, kind: 'runtime' as const, value }] : [],
  ),
];

/** The kind a reference lives in: inheritance never crosses one (`mcp/a` can not become `skills/a`). */
const namespaceOf = (reference: string): string => reference.slice(0, reference.indexOf('/'));

export function assignOriginKeys(input: OriginKeyInput): OriginKeyResult {
  const items = new Map(itemsOf(input.bundle).map(item => [item.reference, item]));
  const minted = (): OriginKey => base32(input.randomBytes(16));
  const keys = new Map<string, OriginKey>();
  const digests = new Map<string, string>();
  const resolving = new Set<string>();

  const vanished = Object.entries(input.previous.items)
    .filter(([reference]) => !items.has(reference))
    .toSorted(([left], [right]) => (left < right ? -1 : 1));
  const inherited = new Set<string>();

  const keyOf = (reference: string): OriginKey => {
    const known = keys.get(reference);
    if (known !== undefined) return known;
    const item = items.get(reference) as Item;
    if (item.kind === 'runtime') {
      const key = originKeyOfId(input.runtimeIds[reference.slice('runtime/'.length)] ?? '') ?? minted();
      keys.set(reference, key);
      return key;
    }
    resolving.add(reference);
    try {
      const digest = digestOf(reference);
      let key = input.previous.items[reference]?.key;
      if (key === undefined) {
        const heir = vanished.find(
          ([name, entry]) =>
            !inherited.has(name) && entry.digest === digest && namespaceOf(name) === namespaceOf(reference),
        );
        if (heir !== undefined) {
          inherited.add(heir[0]);
          key = heir[1].key;
        }
      }
      const chosen = key ?? minted();
      keys.set(reference, chosen);
      return chosen;
    } finally {
      resolving.delete(reference);
    }
  };

  // A layer or login names its subject by key; a reference in the middle of being keyed (a profile loop)
  // or one the bundle does not hold is named as it is written.
  const identityOf = (reference: string): string =>
    !items.has(reference) || resolving.has(reference) ? reference : keyOf(reference);

  const digestOf = (reference: string): string => {
    const known = digests.get(reference);
    if (known !== undefined) return known;
    const item = items.get(reference) as Item;
    const digest = cloneItemDigest({ kind: item.kind, value: item.value }, input.bundle.files, identityOf);
    digests.set(reference, digest);
    return digest;
  };

  for (const reference of [...items.keys()].toSorted()) keyOf(reference);

  const stored: Record<string, { key: OriginKey; digest: string }> = {};
  for (const [reference, item] of items) {
    if (item.kind === 'runtime') continue;
    stored[reference] = { key: keys.get(reference) as OriginKey, digest: digestOf(reference) };
  }
  return { keys: Object.fromEntries(keys), stored: { version: EXPORT_KEYS_VERSION, items: stored } };
}
