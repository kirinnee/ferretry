/** The capabilities warden supervision needs from the outside world. Every one
 *  is declared here and implemented in `adapters/`. */

export interface WardenFileInfo {
  readonly path: string;
  readonly mtimeMs: number;
}

/** The filesystem surface the report reader uses. Both reads answer with
 *  `undefined`/empty for a missing path rather than throwing: a state home that
 *  has never run a warden is a normal, empty situation, not an error. */
export interface WardenReportFileSystem {
  /** Files directly inside `directory`, with their modification times. Empty
   *  when the directory does not exist. */
  listFiles(directory: string): Promise<readonly WardenFileInfo[]>;
  /** File text, or `undefined` when the file does not exist. */
  readText(path: string): Promise<string | undefined>;
}
