import type { AgentSessionDirectory } from '../../lib/agenda/index.ts';
import { jsonObject } from '../../lib/json.ts';
import type { DaemonStorage } from '../storage/session-storage.ts';

/**
 * The agent ferrets on this machine: every session whose own configuration document says `mode: 'auto'` — the
 * set the app's "Agents" filter lists. Read raw, like the nudge's session facts, so a document a newer field made
 * unparseable elsewhere still answers; a document that does not say `auto` (or cannot be read) is not an agent
 * here, because a clear must never reach a board it cannot prove is a worker's.
 */
export class StorageAgentSessions implements AgentSessionDirectory {
  constructor(private readonly storage: Pick<DaemonStorage, 'listSessions' | 'readConfig'>) {}

  async agentSessionIds(): Promise<readonly string[]> {
    const agents: string[] = [];
    for (const { id } of this.storage.listSessions()) {
      const config = jsonObject(await this.storage.readConfig(id).catch(() => undefined));
      if (config?.mode === 'auto') agents.push(id);
    }
    return agents;
  }
}
