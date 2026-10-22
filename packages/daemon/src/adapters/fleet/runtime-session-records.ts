/**
 * The session records a runtime removal or rename reads and re-points, over the daemon's own session
 * storage (docs/account-model.md "Renaming a runtime").
 *
 * Reading is tolerant: a record that cannot be read, or whose fields are not what a session record
 * holds, is left out rather than failing the confirm card that asked. Re-pointing goes through the
 * storage's locked read-modify-write, the same one a migration uses, so a writer queued behind it reads
 * the new name and one queued ahead of it is what it reads.
 */
import { SessionStateSchema } from '@ferretry/protocol';
import {
  type RuntimeSessionRecord,
  renamedSessionConfig,
  type SessionRuntimeRename,
} from '../../lib/fleet/runtime-sessions.ts';
import type { DaemonStorage } from '../storage/session-storage.ts';

/** What this needs of the session storage. */
export type RuntimeSessionStorage = Pick<DaemonStorage, 'listSessions' | 'readConfig' | 'readState' | 'updateConfig'>;

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** One stored session as a runtime change needs it, or `undefined` when its documents do not say. */
function recordOf(id: string, config: unknown, state: unknown): RuntimeSessionRecord | undefined {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined;
  const fields = config as Readonly<Record<string, unknown>>;
  const agent = text(fields.agent);
  const harness = fields.harness;
  const status = SessionStateSchema.safeParse(state);
  if (agent === undefined || (harness !== 'claude' && harness !== 'codex') || !status.success) return undefined;
  const executable = Array.isArray(fields.command) ? text(fields.command[0]) : undefined;
  return {
    id,
    name: text(fields.teammate) ?? text(fields.name) ?? id,
    harness,
    agent,
    ...(executable === undefined ? {} : { executable }),
    status: status.data.status,
  };
}

export class RuntimeSessionRecords {
  constructor(private readonly storage: RuntimeSessionStorage) {}

  /** Every session this daemon keeps that can be read, ended ones included. */
  async sessionRecords(): Promise<readonly RuntimeSessionRecord[]> {
    const records = await Promise.all(
      this.storage.listSessions().map(async ({ id }) => {
        try {
          return recordOf(id, await this.storage.readConfig(id), await this.storage.readState(id));
        } catch {
          return undefined;
        }
      }),
    );
    return records.filter(record => record !== undefined);
  }

  /** Re-point every record on the old runtime at the new one. Answers how many moved. */
  async renameSessions(rename: SessionRuntimeRename): Promise<number> {
    let moved = 0;
    for (const { id } of this.storage.listSessions()) {
      try {
        // Read first, outside the lock, so a record that does not name the old runtime is never rewritten.
        if (renamedSessionConfig(await this.storage.readConfig(id), rename) === undefined) continue;
        await this.storage.updateConfig(id, current => renamedSessionConfig(current, rename) ?? current);
        moved += 1;
      } catch {
        // One record that cannot be rewritten still resolves through ids.json; the rest still move.
      }
    }
    return moved;
  }
}
