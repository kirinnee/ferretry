import { join } from 'node:path';
import type { CgroupConfig } from '@ferretry/protocol';
import {
  type CgroupApplyStatus,
  type CgroupApplyStatusStore,
  type CgroupConfigStore,
  CgroupDocumentReadFailure,
} from '../../lib/cgroups/index.ts';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';

/** The directory and the two files this subject owns inside the state home. */
export const CGROUP_DIRECTORY = 'cgroups';
export const CGROUP_CONFIG_FILENAME = 'config.json';
export const CGROUP_APPLY_STATUS_FILENAME = 'apply-status.json';

/** Where an operator's saved limits live, for a given state home. */
export function cgroupConfigPath(paths: FoundationPaths): string {
  return join(paths.home, CGROUP_DIRECTORY, CGROUP_CONFIG_FILENAME);
}

/** Where the record of what the last save could not apply lives. */
export function cgroupApplyStatusPath(paths: FoundationPaths): string {
  return join(paths.home, CGROUP_DIRECTORY, CGROUP_APPLY_STATUS_FILENAME);
}

/**
 * One stored document's parsed JSON, for both files this subject owns.
 *
 * ONE READER FOR BOTH, because the four answers it distinguishes — absent, read failure, invalid
 * JSON text, and parsed value — are one policy, and two copies of it would drift into two policies
 * about what a damaged document means.
 *
 * TEXT THAT IS NOT JSON COMES BACK AS THE TEXT, deliberately. Collapsing it to `undefined` would
 * make a hand-mangled document indistinguishable from a fresh state home, and the domain would then
 * apply its defaults in silence. A string reaches the schema, fails it, and becomes the warning
 * that says the document could not be read.
 */
async function readDocument(files: FileSystemPort, path: string): Promise<unknown> {
  let raw: string | undefined;
  try {
    raw = await files.readText(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    const message = error instanceof Error ? error.message : String(error);
    return new CgroupDocumentReadFailure(message, { cause: error });
  }
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * The operator's resource-limit configuration, in its own document rather than folded into
 * `config/daemon.json` — see `lib/cgroups/config.ts` for why.
 *
 * IT HANDS BACK RAW EVIDENCE. Deciding what an absent, read-failed or invalid document MEANS is a
 * domain question: GET uses safe defaults plus a warning, while PATCH rejects a read failure before
 * changing either document. An adapter that collapsed or parsed those cases would own a second
 * copy of that policy for the copy to drift from.
 *
 * IT WRITES ATOMICALLY, through the confined filesystem port, which creates the directory with
 * owner-only permissions on first save. A torn write here would leave a document that no longer
 * validates, and the loader would then quietly fall back to the defaults — turning an interrupted
 * save into silently unenforced limits.
 */
export class FileCgroupConfigStore implements CgroupConfigStore {
  private readonly path: string;

  constructor(
    private readonly files: FileSystemPort,
    paths: FoundationPaths,
  ) {
    this.path = cgroupConfigPath(paths);
  }

  /**
   * The document's parsed JSON. Absent and empty both read as `undefined` — a state home that has
   * never saved limits is the normal first-boot situation, not an error.
   */
  async read(): Promise<unknown> {
    return await readDocument(this.files, this.path);
  }

  async write(config: CgroupConfig): Promise<void> {
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(config, null, 2)}\n`);
  }
}

/**
 * The record of what the last save could not put into force, beside the configuration it is about.
 *
 * ITS OWN DOCUMENT, for the same reason the configuration is not folded into `config/daemon.json`:
 * the operator's numbers and this host's refusal have different writers and different lifetimes,
 * and one file holding both would make recording a host failure a read-modify-write of the intent.
 *
 * IT IS WRITTEN ON EVERY SAVE, including a save that applied cleanly. Beside enabled intent an
 * absent record is deliberately conservative rather than clean, so the exact-config clean record
 * is what proves completion and makes a later save SUPERSEDE an earlier refusal instead of leaving
 * it to be read forever.
 *
 * ATOMIC, through the same confined filesystem port. A torn record would fail validation, and the
 * domain reads that as "nothing about the last apply is established" — conservative, but it would
 * turn an interrupted write into a fleet-wide restart notice, so it is worth not tearing.
 */
export class FileCgroupApplyStatusStore implements CgroupApplyStatusStore {
  private readonly path: string;

  constructor(
    private readonly files: FileSystemPort,
    paths: FoundationPaths,
  ) {
    this.path = cgroupApplyStatusPath(paths);
  }

  async read(): Promise<unknown> {
    return await readDocument(this.files, this.path);
  }

  async write(status: CgroupApplyStatus): Promise<void> {
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(status, null, 2)}\n`);
  }
}
