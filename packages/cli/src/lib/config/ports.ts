import type { config } from '@ferretry/kernel/host';

/** The other spelling of YAML's extension: never read, but listed so a check can name the file as ignored (v4 listed it too). */
export const MISSPELLED_EXTENSION = '.yml';

/** One configuration file as the disk holds it: its path under `config/`, and what reading it came to. */
export interface ConfigDiskFile {
  readonly path: string;
  readonly disk: config.DiskState;
}

/** What the daemon last put into effect for one path (`state/kernel/accepted-config/`), and for which plugin. */
export interface AcceptedRecord {
  readonly etag: string;
  readonly text: string;
  readonly plugin?: string;
}

/**
 * The configuration directory, read WITHOUT a daemon — so `fy config check` works on a machine whose daemon is
 * stopped, and an agent can check its own edit before anything else reads it. Read only: nothing here writes a file.
 */
export interface ConfigFilesPort {
  /** `<home>/config`, absolute. */
  readonly directory: string;
  /** Every `.yaml` file under it, a link or an over-size file named as unreadable, never followed. */
  list(): Promise<readonly ConfigDiskFile[]>;
  /** The daemon's accepted record, by path; empty when there is none yet. */
  accepted(): Promise<Readonly<Record<string, AcceptedRecord>>>;
  /** sha256 of the text's UTF-8 bytes, hex: a file's etag. */
  digest(text: string): string;
}
