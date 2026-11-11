import type { SessionId } from '../../../lib/session-id.ts';
import type { LiveLaunchCommands } from './file-launch-overlay.ts';

/** What the live commands are read from: the daemon's session storage, structurally. */
export interface SessionCommandSource {
  listSessions(): readonly { readonly id: SessionId; readonly status?: string }[];
  readConfig(id: SessionId): Promise<unknown>;
}

/** The statuses of a session that has ended: its recorded command is no longer one a revive starts from. */
const ENDED = new Set(['completed', 'failed', 'stopped']);

/**
 * The recorded commands of every session that has not ended, read from the session documents.
 *
 * Bound late: the launch files are built with the world, the storage they read is opened after it. Until it is bound
 * (or when a read fails) the answer is a raise, which the sweep reads as "nothing may be removed", never as "nothing
 * is alive".
 */
export class BoundLiveLaunchCommands implements LiveLaunchCommands {
  #source: SessionCommandSource | undefined;

  bind(source: SessionCommandSource): void {
    this.#source = source;
  }

  async commands(): Promise<readonly (readonly string[])[]> {
    const source = this.#source;
    if (source === undefined) throw new Error('the session storage is not open yet, so live sessions cannot be listed');
    const found = await Promise.all(
      source
        .listSessions()
        .filter(session => session.status === undefined || !ENDED.has(session.status))
        .map(async session => {
          const config = (await source.readConfig(session.id)) as { command?: unknown } | undefined;
          const command = config?.command;
          return Array.isArray(command) ? command.filter((part): part is string => typeof part === 'string') : [];
        }),
    );
    return found;
  }
}
