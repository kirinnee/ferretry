/**
 * Re-labelling a sealed document's envelope, never its contents.
 *
 * v5's Vault keeps today's sealing byte for byte (spine D16) and changes one thing: the envelope's `"v": 1` becomes
 * `"format": 1` (`packages/core/vault/contract/store.ts`: "the out-of-product converter renames one key"). So this is
 * the one place the tool parses a sealed file: it reads the JSON envelope, checks it is today's shape, and copies each
 * entry's `iv`, `ciphertext` (and, for stamped documents, `createdAt`/`updatedAt`) as the same strings. Nothing is
 * decrypted — the key is never read here — and nothing from the file is printed, logged or put in an error: a
 * failure names the file and, at most, an entry NAME (a secret's name is not its value).
 */
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { z } from 'zod';

const CIPHER = 'AES-256-GCM';

export interface RewrapSpec<Shape> {
  /** v4 entries carry createdAt/updatedAt (the vault-shaped documents) or not (catalog link keys). */
  readonly stamped: boolean;
  /** The v5 schema the result must pass, from the owner's contract. */
  readonly schema: z.ZodType<Shape>;
}

export interface Rewrapped {
  readonly to: string;
  readonly entries: number;
  /** The entry NAMES moved (a name is not its value), so a step can check them against the index that names them. */
  readonly names: readonly string[];
}

export class SealedEnvelopeError extends Error {
  override readonly name = 'SealedEnvelopeError';
}

export async function rewrapSealed<Shape>(from: string, to: string, spec: RewrapSpec<Shape>): Promise<Rewrapped> {
  const source = await lstat(from);
  if (!source.isFile()) throw new SealedEnvelopeError(`sealed source is not a regular file: ${from}`);
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(from, 'utf8'));
  } catch {
    throw new SealedEnvelopeError(`${from} is not JSON`);
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded))
    throw new SealedEnvelopeError(`${from} is not a sealed document`);
  const envelope = decoded as Record<string, unknown>;
  if (envelope.v !== 1) throw new SealedEnvelopeError(`${from} is not a version-1 sealed document`);
  if (envelope.cipher !== CIPHER) throw new SealedEnvelopeError(`${from} is not sealed with ${CIPHER}`);
  const entries = envelope.entries;
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries))
    throw new SealedEnvelopeError(`${from} has no entry table`);

  const fields = spec.stamped
    ? (['iv', 'ciphertext', 'createdAt', 'updatedAt'] as const)
    : (['iv', 'ciphertext'] as const);
  const copied: Record<string, Record<string, string>> = {};
  for (const [entryName, entry] of Object.entries(entries as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
      throw new SealedEnvelopeError(`${from}: entry ${entryName} is not an object`);
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== fields.length || !fields.every(field => typeof record[field] === 'string'))
      throw new SealedEnvelopeError(`${from}: entry ${entryName} is not today's sealed shape`);
    copied[entryName] = Object.fromEntries(fields.map(field => [field, record[field] as string]));
  }

  const result = spec.schema.safeParse({ format: 1, cipher: CIPHER, entries: copied });
  if (!result.success) {
    // Only the paths of the failing fields; zod's own messages may quote a received value.
    const where = result.error.issues.map(issue => issue.path.join('.')).join(', ');
    throw new SealedEnvelopeError(`${from} does not fit the v5 schema at: ${where || '(root)'}`);
  }
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  await writeFile(to, `${JSON.stringify(result.data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { to, entries: Object.keys(copied).length, names: Object.keys(copied) };
}
