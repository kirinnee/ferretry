/**
 * What the text of the published fleet manifest is, decided without touching a disk.
 *
 * The manifest is DERIVED: every apply rebuilds it from the configuration (runtimes, logins). So a file that no longer
 * parses against the strict shape the daemon WRITES — an older or newer version's shape, a truncated write — is not
 * evidence to refuse over: it is a stale copy of something the daemon can write again. This is the one decision about
 * it, shared by the publishing side (rebuild it) and the readers (retry while it is rebuilt).
 *
 * Generic on purpose: no key of an earlier or later version is named anywhere. The schema stays strict for what is written.
 */
import { type FleetManifest, FleetManifestSchema } from './manifest.ts';

/** The manifest's text, judged: nothing there, a manifest, or something that is not one. */
export type ManifestReading =
  | { readonly kind: 'absent' }
  | { readonly kind: 'readable'; readonly manifest: FleetManifest }
  | { readonly kind: 'unreadable' };

/** `undefined` text is no file; anything that is not valid JSON, or not the manifest shape, is unreadable. */
export function readManifestText(text: string | undefined): ManifestReading {
  if (text === undefined) return { kind: 'absent' };
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { kind: 'unreadable' };
  }
  const parsed = FleetManifestSchema.safeParse(payload);
  return parsed.success ? { kind: 'readable', manifest: parsed.data } : { kind: 'unreadable' };
}

/** What follows the manifest's own file name in the name of a copy kept aside: only files with this infix are ever pruned. */
export const KEPT_MANIFEST_INFIX = '.unreadable-';

/** How many copies of unreadable manifests stay aside: the most recent few. Older damage is evidence nobody asked to keep. */
export const MAX_KEPT_UNREADABLE_MANIFESTS = 3;

/** How many hex digits of the contents' SHA-256 end a kept copy's name. */
export const KEPT_DIGEST_LENGTH = 12;

/** The name an unreadable manifest is kept under: the file's own name and a short digest of what it held, so it is kept once. */
export function keptManifestName(manifestPath: string, digest: string): string {
  return `${manifestPath}${KEPT_MANIFEST_INFIX}${digest.slice(0, KEPT_DIGEST_LENGTH)}`;
}

/**
 * The digest a name carries when it has EXACTLY the shape {@link keptManifestName} writes (`prefix` and then
 * {@link KEPT_DIGEST_LENGTH} lowercase hex digits, nothing after), else `undefined`. This is half of "a copy we made":
 * the other half is that the file's contents hash to that digest (see {@link surplusKeptCopies}'s caller), since the
 * name IS the digest of the contents. A note a person named `manifest.json.unreadable-owner-notes` is neither.
 */
export function keptCopyDigest(name: string, prefix: string): string | undefined {
  if (!name.startsWith(prefix)) return undefined;
  const digest = name.slice(prefix.length);
  return new RegExp(`^[0-9a-f]{${KEPT_DIGEST_LENGTH}}$`).test(digest) ? digest : undefined;
}

/**
 * The names (of `candidates`, the regular files of the fleet folder whose contents were already proved to hash to the
 * digest in their name) to remove so that at most {@link MAX_KEPT_UNREADABLE_MANIFESTS} copies stay: those named
 * exactly as this writer names them ({@link keptCopyDigest}) and holding their only name (`links === 1`), oldest first.
 * The copy just kept (`protect`) is never among them. Anything else — another spelling, a second hard link — is neither
 * chosen nor counted, so nothing the person or another version put there is touched.
 */
export function surplusKeptCopies(
  candidates: readonly { readonly name: string; readonly modified: string; readonly links: number }[],
  prefix: string,
  protect: string | undefined,
  limit: number = MAX_KEPT_UNREADABLE_MANIFESTS,
): readonly string[] {
  const others = candidates
    .filter(entry => keptCopyDigest(entry.name, prefix) !== undefined && entry.links === 1 && entry.name !== protect)
    .toSorted((left, right) =>
      left.modified === right.modified ? left.name.localeCompare(right.name) : left.modified < right.modified ? 1 : -1,
    )
    .map(entry => entry.name);
  // The protected copy takes one of the places; the newest of the others fill the rest.
  const room = Math.max(0, protect === undefined ? limit : limit - 1);
  return others.slice(room);
}

/** The manifest exists and is not one. Retryable: the daemon rebuilds it. The message names the file, never its contents. */
export class FleetManifestUnreadableError extends Error {
  constructor(readonly path: string) {
    super(manifestUnreadableSentence(path));
    this.name = 'FleetManifestUnreadableError';
  }
}

/** One plain line for the log: the file is named, its contents never are. */
export function manifestRebuiltSentence(manifestPath: string, keptAt: string | undefined): string {
  const kept =
    keptAt === undefined ? 'the old file could not be kept aside' : `the old file is kept at ${keptAt} (owner-only)`;
  return `The fleet manifest at ${manifestPath} could not be read, so it is being rebuilt from the configuration; ${kept}.`;
}

/** What a reader that needs the launch inventory says while the manifest cannot be read: retryable, not permanent. */
export function manifestUnreadableSentence(manifestPath: string): string {
  return `The fleet manifest at ${manifestPath} could not be read. The daemon rebuilds it from the configuration when it starts and on every fleet change: try again in a moment, and restart the daemon if this stays.`;
}
