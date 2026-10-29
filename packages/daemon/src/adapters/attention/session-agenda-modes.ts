import { AGENDA_ENV } from '@ferretry/fleet';
import type { AgendaModes } from '../../lib/attention/index.ts';
import { tryParseSessionId } from '../../lib/session-id.ts';
import type { SessionEnvironmentStore } from '../../lib/session/lifecycle/types.ts';

/** Whether a ferret works in agenda mode: the flag in its launch environment, which is also what its prompt reads. */
export class EnvironmentAgendaModes implements AgendaModes {
  constructor(private readonly environments: Pick<SessionEnvironmentStore, 'read'>) {}

  async enabled(sessionId: string): Promise<boolean> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return false;
    return (await this.environments.read(id).catch((): Readonly<Record<string, string>> => ({})))[AGENDA_ENV] === '1';
  }
}
