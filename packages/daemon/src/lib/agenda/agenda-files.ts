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
