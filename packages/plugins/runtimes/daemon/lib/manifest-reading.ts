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
import { z } from 'zod';
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

/** What follows the manifest's own file name in the name of the ONE file a damaged manifest is kept aside in. */
export const KEPT_ASIDE_SUFFIX = '.unreadable';

/** The largest damaged manifest that is kept aside: a bigger one is not kept (and the manifest is still rebuilt). */
export const MAX_KEPT_DAMAGE_BYTES = 4 * 1024 * 1024;

/** The fixed name the damaged manifest is kept under: ONE file per manifest, created once, never replaced or deleted. */
export function keptAsideName(manifestPath: string): string {
  return `${manifestPath}${KEPT_ASIDE_SUFFIX}`;
}

/**
 * What the aside file holds: a self-describing envelope that says whose it is, so a later repair can tell its own file
 * from anything a person or another program put at the name. `bytes` is the damaged file, base64: it is data for a
 * person to recover from, and is never logged or printed.
 */
export const KeptAsideSchema = z.strictObject({
  keptBy: z.literal('ferretry'),
  kind: z.literal('unreadable-fleet-manifest'),
  keptAt: z.iso.datetime(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.base64(),
});

export type KeptAside = z.infer<typeof KeptAsideSchema>;

/** The text of the aside file for a damaged manifest: the envelope, pretty-printed, one trailing newline. */
export function keptAsideText(damaged: Uint8Array, sha256: string, keptAt: Date): string {
  const envelope: KeptAside = {
    keptBy: 'ferretry',
    kind: 'unreadable-fleet-manifest',
    keptAt: keptAt.toISOString(),
    sha256,
    bytes: Buffer.from(damaged).toString('base64'),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/** The envelope a text holds when it is OURS (strict shape, every field), else `undefined`. A foreign or damaged file is not. */
export function readKeptAside(text: string): KeptAside | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = KeptAsideSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

/** The manifest exists and is not one. Retryable: the daemon rebuilds it. The message names the file, never its contents. */
export class FleetManifestUnreadableError extends Error {
  constructor(readonly path: string) {
    super(manifestUnreadableSentence(path));
    this.name = 'FleetManifestUnreadableError';
  }
}

/** One plain line for the log: the file is named, its contents never are. */
export function manifestRebuiltSentence(manifestPath: string, aside: string, kept: boolean): string {
  const note = kept
    ? `the old file is kept at ${aside} (owner-only)`
    : `the old file could not be kept aside at ${aside} (a file is already there, or it could not be written)`;
  return `The fleet manifest at ${manifestPath} could not be read, so it is being rebuilt from the configuration; ${note}.`;
}

/** What a reader that needs the launch inventory says while the manifest cannot be read: retryable, not permanent. */
export function manifestUnreadableSentence(manifestPath: string): string {
  return `The fleet manifest at ${manifestPath} could not be read. The daemon rebuilds it from the configuration when it starts and on every fleet change: try again in a moment, and restart the daemon if this stays.`;
}
