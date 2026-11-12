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

/** The name an unreadable manifest is kept under: the file's own name and a short digest of what it held, so it is kept once. */
export function keptManifestName(manifestPath: string, digest: string): string {
  return `${manifestPath}.unreadable-${digest.slice(0, 12)}`;
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
