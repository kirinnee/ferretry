/**
 * The published fleet manifest, read whole: the launch inventory's `accounts` rows AND the account
 * model's `runtimes` rows beside them.
 *
 * `ManifestAccountInventory` reads the same file for the launch path and keeps only the account rows;
 * the readers here need the runtime rows too — which runtime is on which credential — and a second
 * parser of the account rows would be a second opinion about the launch inventory. So this hands back
 * the fleet library's own parse, and the inventory stays the one reader of what can be launched.
 *
 * The manifest is derived from the configuration, so a file that does not parse is rebuilt, never fatal
 * (`lib/manifest-reading.ts`): the publishing side reads it with {@link readPublishedManifest} (unreadable
 * counts as not published, so the next publish writes it again), and the readers of the launch inventory
 * get a typed, retryable {@link FleetManifestUnreadableError} until it has been.
 */
import type { FleetManifest } from '../lib/manifest.ts';
import { manifestUnreadableSentence, readManifestText } from '../lib/manifest-reading.ts';
import type { HostFiles } from './ports.ts';

/** The manifest exists and is not one. Retryable: the daemon rebuilds it. The message names the file, never its contents. */
export class FleetManifestUnreadableError extends Error {
  constructor(readonly path: string) {
    super(manifestUnreadableSentence(path));
    this.name = 'FleetManifestUnreadableError';
  }
}

/**
 * The manifest, or `undefined` when no apply has published one yet. Throws {@link FleetManifestUnreadableError}, naming
 * the file, when it exists and is not a manifest: a reader never takes damage for an empty fleet.
 */
export async function readFleetManifest(
  files: Pick<HostFiles, 'readText'>,
  path: string,
): Promise<FleetManifest | undefined> {
  const reading = readManifestText(await files.readText(path));
  if (reading.kind === 'unreadable') throw new FleetManifestUnreadableError(path);
  return reading.kind === 'readable' ? reading.manifest : undefined;
}

/**
 * The manifest as the PUBLISHING side sees it: `undefined` when none is published or the one there cannot be read,
 * because either way the next publish writes it. Never throws for damage, so a republish cannot be refused by the very
 * file it is about to replace.
 */
export async function readPublishedManifest(
  files: Pick<HostFiles, 'readText'>,
  path: string,
): Promise<FleetManifest | undefined> {
  const reading = readManifestText(await files.readText(path));
  return reading.kind === 'readable' ? reading.manifest : undefined;
}

/** Whether a manifest is there and cannot be read: what the boot repair asks before it republishes. */
export async function manifestIsUnreadable(files: Pick<HostFiles, 'readText'>, path: string): Promise<boolean> {
  return readManifestText(await files.readText(path)).kind === 'unreadable';
}
