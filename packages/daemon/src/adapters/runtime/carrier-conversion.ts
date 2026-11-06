import { type CarrierConversionOutcome, LEGACY_CARRIER_KEYS, planCarrierConversion } from '../../lib/index.ts';

/**
 * The three things the conversion needs from a filesystem, so the procedure stays independent of
 * `FileSystemPort` (the state home's confined filesystem). Only the state home's document is converted;
 * a `--config` file is never converted.
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

/** Where a conversion stands in the journal: written ahead of the document, then settled. */
type ConversionStatus = 'pending' | 'converted' | 'abandoned';

/** The conversions already recorded, or none: a journal this cannot read is replaced, never a reason to stop. */
async function recordedConversions(
  files: CarrierConversionFiles,
  journal: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const text = await files.readText(journal);
  if (text === undefined) return [];
  try {
    const document: unknown = JSON.parse(text);
    const conversions = (document as { readonly conversions?: unknown } | null)?.conversions;
    return Array.isArray(conversions)
      ? conversions.filter(
          (entry): entry is Readonly<Record<string, unknown>> =>
            typeof entry === 'object' && entry !== null && !Array.isArray(entry),
        )
      : [];
  } catch {
    return [];
  }
}

async function writeJournal(
  files: CarrierConversionFiles,
  journal: string,
  conversions: readonly Readonly<Record<string, unknown>>[],
): Promise<void> {
  await files.writeAtomic(journal, `${JSON.stringify({ v: 1, conversions }, undefined, 2)}\n`, PRIVATE_MODE);
}

/** Whether a document's text is a JSON object that spells none of the legacy keys — the sign the replacement happened. */
function isConverted(text: string | undefined): boolean {
  if (text === undefined) return false;
  try {
    const document: unknown = JSON.parse(text);
    return (
      typeof document === 'object' &&
      document !== null &&
      !Array.isArray(document) &&
      !LEGACY_CARRIER_KEYS.some(key => Object.hasOwn(document, key))
    );
  } catch {
    return false;
  }
}

/**
 * Settles every conversion of this file that was written ahead and never finished.
 *
 * A `pending` entry means the process stopped (or a write failed) somewhere between the entry and the
 * journal rewrite that follows the document. The document says which: with none of the legacy keys left
 * the replacement happened, so the conversion is `converted`; with any left it did not, so the entry is
 * `abandoned`. A document that can no longer be read as a JSON object is `abandoned` too, since nothing
 * proves it was ours. The backup is kept either way. Entries for other files are not this call's to judge.
 */
async function reconcilePending(
  files: CarrierConversionFiles,
  target: CarrierConversionTarget,
  current: string | undefined,
): Promise<void> {
  const conversions = await recordedConversions(files, target.journal);
  const isPending = (entry: Readonly<Record<string, unknown>>): boolean =>
    entry.status === 'pending' && entry.file === target.file;
  if (!conversions.some(isPending)) return;
  const settled: ConversionStatus = isConverted(current) ? 'converted' : 'abandoned';
  await writeJournal(
    files,
    target.journal,
    conversions.map(entry => (isPending(entry) ? { ...entry, status: settled } : entry)),
  );
}

/**
 * Rewrites the legacy `host`, `port` and `relay` keys of one document into `carriers` entries.
 *
 * THE ORDER IS BACKUP, THEN A `pending` JOURNAL ENTRY, THEN DOCUMENT, THEN THE ENTRY BECOMES `converted`,
 * and each step is only reached when the one before it finished. The entry is written AHEAD of the
 * document so that no interruption can leave a converted document the journal knows nothing about: a
 * failure before the document is replaced leaves it untouched, and a failure after leaves a converted
 * document with its backup and an entry the next call settles (`reconcilePending`) — so the record is
 * never lost and a conversion is never done twice. The original is kept byte for byte with its own
 * permission bits, because the one thing this must never do is make the previous state unreachable.
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
  await reconcilePending(files, target, original);
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
  const entry = { at, file: target.file, backup, removedKeys: plan.removedKeys, addedEntries: plan.addedEntries };
  await writeJournal(files, target.journal, [
    ...(await recordedConversions(files, target.journal)),
    { status: 'pending' satisfies ConversionStatus, ...entry },
  ]);
  await files.writeAtomic(target.file, `${JSON.stringify(plan.document, null, 2)}\n`, PRIVATE_MODE);
  await writeJournal(
    files,
    target.journal,
    (await recordedConversions(files, target.journal)).map(recorded =>
      recorded.status === 'pending' && recorded.backup === backup
        ? { ...recorded, status: 'converted' satisfies ConversionStatus }
        : recorded,
    ),
  );
  return {
    kind: 'converted',
    file: target.file,
    backup,
    removedKeys: plan.removedKeys,
    addedEntries: plan.addedEntries,
  };
}
