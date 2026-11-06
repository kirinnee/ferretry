import { type CarrierConversionOutcome, planCarrierConversion } from '../../lib/index.ts';

/**
 * The three things the conversion needs from a filesystem, so the state-home adapter (confined, through
 * `FileSystemPort`) and the `--config` adapter (an operator's own path, through `node:fs`) share ONE
 * procedure and cannot drift into converting differently.
 */
export interface CarrierConversionFiles {
  readText(path: string): Promise<string | undefined>;
  /** The permission bits of a file that exists, `undefined` when it does not. */
  modeOf(path: string): Promise<number | undefined>;
  /** Replaces `path` atomically with `text`, leaving it with exactly `mode`. */
  writeAtomic(path: string, text: string, mode: number): Promise<void>;
}

/** Where a conversion reads and writes: the document, and the one-file record that it happened. */
export interface CarrierConversionTarget {
  readonly file: string;
  readonly journal: string;
}

const PRIVATE_MODE = 0o600;

/** A timestamp as a file name can carry it: the instant's own digits, with every separator made a dash. */
function filenameStamp(at: string): string {
  return at.replaceAll(/[^0-9A-Za-z]+/gu, '-');
}

/** The first backup name nothing occupies, so a second conversion in the same instant never overwrites the first. */
async function freeBackupPath(files: CarrierConversionFiles, file: string, at: string): Promise<string> {
  const base = `${file}.pre-carriers.${filenameStamp(at)}`;
  for (let attempt = 0; ; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${String(attempt)}`;
    if ((await files.readText(candidate)) === undefined) return candidate;
  }
}

/** The conversions already recorded, or none: a journal this cannot read is replaced, never a reason to stop. */
async function recordedConversions(files: CarrierConversionFiles, journal: string): Promise<readonly unknown[]> {
  const text = await files.readText(journal);
  if (text === undefined) return [];
  try {
    const document: unknown = JSON.parse(text);
    const conversions = (document as { readonly conversions?: unknown } | null)?.conversions;
    return Array.isArray(conversions) ? conversions : [];
  } catch {
    return [];
  }
}

/**
 * Rewrites the legacy `host`, `port` and `relay` keys of one document into `carriers` entries.
 *
 * THE ORDER IS BACKUP, THEN DOCUMENT, THEN JOURNAL, and each step is only reached when the one before it
 * finished. A failure before the document is written leaves it untouched; a failure after leaves a
 * converted document that has its backup, which is the recoverable half of every interruption. The
 * original is kept byte for byte with its own permission bits, because the one thing this must never do
 * is make the previous state unreachable.
 *
 * THE FILE'S CONTENT IS NEVER THE SUBJECT OF A MESSAGE: this reports key names and entry shapes. It holds
 * no secret, but a document is not something to copy into a log.
 *
 * It never throws over what the document SAYS — unreadable JSON, a shape it will not rewrite, a rewrite
 * that would read differently are all `refused`, with the file untouched — and throws only over what the
 * filesystem does.
 */
export async function convertLegacyCarrierKeysIn(
  files: CarrierConversionFiles,
  target: CarrierConversionTarget,
  at: string,
): Promise<CarrierConversionOutcome> {
  const original = await files.readText(target.file);
  if (original === undefined) return { kind: 'unchanged' };
  let raw: unknown;
  try {
    raw = JSON.parse(original);
  } catch {
    return { kind: 'refused', reason: 'it is not valid JSON' };
  }
  const plan = planCarrierConversion(raw);
  if (plan.kind === 'none') return { kind: 'unchanged' };
  if (plan.kind === 'refuse') return { kind: 'refused', reason: plan.reason };

  const backup = await freeBackupPath(files, target.file, at);
  await files.writeAtomic(backup, original, (await files.modeOf(target.file)) ?? PRIVATE_MODE);
  await files.writeAtomic(target.file, `${JSON.stringify(plan.document, null, 2)}\n`, PRIVATE_MODE);
  const conversions = await recordedConversions(files, target.journal);
  await files.writeAtomic(
    target.journal,
    `${JSON.stringify(
      {
        v: 1,
        conversions: [
          ...conversions,
          { at, file: target.file, backup, removedKeys: plan.removedKeys, addedEntries: plan.addedEntries },
        ],
      },
      undefined,
      2,
    )}\n`,
    PRIVATE_MODE,
  );
  return {
    kind: 'converted',
    file: target.file,
    backup,
    removedKeys: plan.removedKeys,
    addedEntries: plan.addedEntries,
  };
}
