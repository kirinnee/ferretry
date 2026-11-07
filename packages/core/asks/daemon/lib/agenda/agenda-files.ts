/** The two documents a ferret's session directory holds for its agenda. */
export type AgendaFileKind = 'ledger' | 'outbox';

/** What each is called. */
export const AGENDA_FILES: Readonly<Record<AgendaFileKind, string>> = {
  ledger: 'agenda.json',
  outbox: 'agenda-replies.json',
};

/** The one place a session's agenda files are touched, so a test can stand in for the disk. */
export interface AgendaFileStore {
  /** The file's text, or `undefined` when there is no such file. Any other failure rejects. */
  read(sessionId: string, name: string): Promise<string | undefined>;
  /** Replaces the file whole: a temporary file renamed over it. */
  writeAtomic(sessionId: string, name: string, text: string): Promise<void>;
  rename(sessionId: string, from: string, to: string): Promise<void>;
  /** Removes the file; a file already gone is not a failure. */
  remove(sessionId: string, name: string): Promise<void>;
  /**
   * What the file is now — a value that changes whenever the file does, whoever changes it — or `undefined`
   * when there is no such file. A store without it is read whole on every read.
   */
  identity?(sessionId: string, name: string): Promise<string | undefined>;
  /** The file's text and the identity of the very file it was read from, or `undefined` when there is none. */
  readIdentified?(
    sessionId: string,
    name: string,
  ): Promise<{ readonly text: string; readonly identity: string } | undefined>;
}

/**
 * The names a ferret's agenda files carried before the agenda rename (`attention.json`,
 * `attention-replies.json`). No reader opens them: they exist only so a home that still holds one is
 * REFUSED at start. Read as empty, such a home would silently lose its agenda, and the next raise would
 * write a fresh `agenda.json` over the hidden items.
 */
export const PRE_RENAME_AGENDA_FILES: readonly string[] = ['attention.json', 'attention-replies.json'];

/** One directory that may hold agenda files, and the names directly inside it. */
export interface AgendaDirectoryEntries {
  readonly path: string;
  readonly names: readonly string[];
}

/** Every directory that may hold agenda files — each session directory, however the index lists it, and the machine's. */
export interface AgendaDirectoryListing {
  /** One directory read per directory; no file is opened. */
  list(): Promise<readonly AgendaDirectoryEntries[]>;
}

/** How many offending paths the refusal names before it only counts the rest. */
const NAMED_PRE_RENAME_PATHS = 5;

/** The start refusal for a home that still holds agenda files under their pre-rename names. */
export class PreRenameAgendaFilesError extends Error {
  constructor(readonly found: readonly string[]) {
    const named = found.slice(0, NAMED_PRE_RENAME_PATHS).join(', ');
    const more = found.length > NAMED_PRE_RENAME_PATHS ? ', …' : '';
    super(
      `these sessions still hold agenda files from before the agenda rename: ${named}${more} (${String(found.length)} in all). ` +
        'Back these directories up first. Then, in each, rename attention.json → agenda.json and ' +
        'attention-replies.json → agenda-replies.json only where the new name does not exist yet; ' +
        'where both names exist, merge the old file into the new-named one by hand, then rename the old file to ' +
        '<name>.migrated so it is ignored. Every Ferretry release from 4.116.0 up to, but excluding, the release ' +
        'that removed this move attempted it on start, but only for sessions in the index and only while the home ' +
        'lacked agenda-files-migration.json (written only once no session failed, so failures were retried on ' +
        'later starts); it never covered the machine agenda. Then start again.',
    );
    this.name = 'PreRenameAgendaFilesError';
  }
}

/** Refuses (rejects with {@link PreRenameAgendaFilesError}) when any listed directory holds a pre-rename agenda file. */
export async function refusePreRenameAgendaFiles(listing: AgendaDirectoryListing): Promise<void> {
  const found = (await listing.list()).flatMap(directory =>
    PRE_RENAME_AGENDA_FILES.filter(name => directory.names.includes(name)).map(name => `${directory.path}/${name}`),
  );
  if (found.length > 0) throw new PreRenameAgendaFilesError(found);
}
