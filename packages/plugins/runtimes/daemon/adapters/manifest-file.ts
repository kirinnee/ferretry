/**
 * The published fleet manifest, read whole: the launch inventory's `accounts` rows AND the account
 * model's `runtimes` rows beside them.
 *
 * `ManifestAccountInventory` reads the same file for the launch path and keeps only the account rows;
 * the readers here need the runtime rows too — which runtime is on which credential — and a second
 * parser of the account rows would be a second opinion about the launch inventory. So this hands back
 * the fleet library's own parse, and the inventory stays the one reader of what can be launched.
 */
import { type FleetManifest, FleetManifestSchema } from '@ferretry/fleet';
import type { FileSystemPort } from '../../lib/index.ts';

/**
 * The manifest, or `undefined` when no apply has published one yet. Throws, naming the file, when it
 * exists and is not a manifest: an unreadable manifest is damaged evidence, never an empty fleet.
 */
export async function readFleetManifest(files: FileSystemPort, path: string): Promise<FleetManifest | undefined> {
  const text = await files.readText(path);
  if (text === undefined) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`the fleet manifest at ${path} is not valid JSON`);
  }
  const parsed = FleetManifestSchema.safeParse(payload);
  if (!parsed.success) throw new Error(`the fleet manifest at ${path} is not a fleet manifest`);
  return parsed.data;
}
