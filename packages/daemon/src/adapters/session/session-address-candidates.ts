import type { AgentAddressCandidate } from '@ferretry/protocol';
import type { DaemonStorage } from '../storage/session-storage.ts';

const field = (document: unknown, key: string): string | undefined => {
  if (typeof document !== 'object' || document === null) return undefined;
  const value = (document as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

/**
 * Every session on this machine as a name could address it: its id, its agent name and its status.
 *
 * Read from the documents rather than the index, because the index carries neither a name nor a
 * status. A session whose documents cannot be read is still listed, by id alone — it can still be
 * addressed by its id, and a name nobody can read cannot be matched anyway.
 *
 * ONE READER for the send route's resolution, the sender attribution and the signal domain's peer
 * lookup, so the three cannot list different fleets and so reach different answers for one name.
 */
export async function sessionAddressCandidates(
  storage: Pick<DaemonStorage, 'listSessions' | 'readConfig' | 'readState'> &
    Partial<Pick<DaemonStorage, 'listArchivedSessions'>>,
): Promise<readonly AgentAddressCandidate[]> {
  // Archived sessions are still sessions a name can address: the registry kept the name each answered to, so
  // `fy send <name>` resumes one and `fy history <name>` finds it with no read of its documents.
  const archived: readonly AgentAddressCandidate[] = (storage.listArchivedSessions?.() ?? []).map(entry => ({
    id: entry.id,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    ...(entry.status === undefined ? {} : { status: entry.status }),
  }));
  const live = await Promise.all(
    storage.listSessions().map(async indexed => {
      const [config, state] = await Promise.all([
        storage.readConfig(indexed.id).catch(() => undefined),
        storage.readState(indexed.id).catch(() => undefined),
      ]);
      const name = field(config, 'teammate');
      const status = field(state, 'status');
      return {
        id: indexed.id,
        ...(name === undefined ? {} : { name }),
        ...(status === undefined ? {} : { status }),
      };
    }),
  );
  return [...live, ...archived];
}
