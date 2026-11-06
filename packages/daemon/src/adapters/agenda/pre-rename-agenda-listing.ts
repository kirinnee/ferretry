import { join } from 'node:path';
import { MACHINE_AGENDA_ID } from '@ferretry/protocol';
import type { AgendaDirectoryEntries, AgendaDirectoryListing } from '../../lib/agenda/index.ts';
import type { FileSystemPort } from '../../lib/ports.ts';

/**
 * Every session directory under the sessions root — including ones the session index no longer lists —
 * and the machine agenda's directory, each read once by name.
 */
export class FileSystemAgendaDirectoryListing implements AgendaDirectoryListing {
  constructor(
    private readonly files: Pick<FileSystemPort, 'listDirectory'>,
    private readonly sessions: string,
    private readonly state: string,
  ) {}

  async list(): Promise<readonly AgendaDirectoryEntries[]> {
    const directories = [
      ...(await this.files.listDirectory(this.sessions))
        .filter(entry => entry.directory)
        .map(entry => join(this.sessions, entry.name)),
      join(this.state, MACHINE_AGENDA_ID),
    ];
    return await Promise.all(
      directories.map(async path => ({
        path,
        names: (await this.files.listDirectory(path)).map(entry => entry.name),
      })),
    );
  }
}
