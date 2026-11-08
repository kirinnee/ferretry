/**
 * `packs.yaml` through the shell's configuration-file port (docs/config-files.md): read the file as text with its digest,
 * write it back against that digest. The configuration-file routes are the daemon's generic ones — they are in no plugin's
 * manifest, so this half cannot name them (`contract-consumes`); the shell offers them as `ConfigFiles` (PENDING.md)
 * together with the YAML editor that keeps comments and key order.
 *
 * An edit that LOOSENS what a ferret may do or spend — Pack on, Jev decides, a limit or Jev's cap raised — is held by the
 * daemon until the owner confirms it; the answer says so (`outcome: 'pending'`) rather than pretending it applied.
 */

import type { ConfigText } from './config-text.ts';

/** The file's address in the configuration-file routes. */
const PACKS_FILE = 'packs.yaml';

/** A configuration file as it is on disk, with the digest to edit against. */
export interface ConfigFileView {
  readonly text: string;
  readonly etag: string;
}

export interface ConfigFilePutResult {
  readonly outcome: 'applied' | 'pending';
  /** What waits for the owner's confirmation, in words. */
  readonly changes?: readonly string[];
}

/** What the shell offers for configuration files: the two routes and the comment-preserving YAML editor. */
export interface ConfigFiles {
  readonly text: ConfigText;
  read(path: string): Promise<ConfigFileView>;
  write(path: string, text: string, etag: string): Promise<ConfigFilePutResult>;
}

export const readPacksText = async (files: ConfigFiles): Promise<ConfigFileView> => await files.read(PACKS_FILE);

export const writePacksText = async (files: ConfigFiles, text: string, etag: string): Promise<ConfigFilePutResult> =>
  await files.write(PACKS_FILE, text, etag);
