import { type SessionConfig, sessionAgendaEnabled } from '@ferretry/protocol';
import type { AgendaModes } from '../../lib/attention/index.ts';
import { tryParseSessionId } from '../../lib/session-id.ts';

/** Whether a ferret works in agenda mode: the switch recorded on its session document (`config.agenda`), default off. */
export class SessionConfigAgendaModes implements AgendaModes {
  constructor(
    private readonly sessions: { get(id: string): Promise<{ readonly config: SessionConfig } | undefined> },
  ) {}

  async enabled(sessionId: string): Promise<boolean> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return false;
    const view = await this.sessions.get(id).catch(() => undefined);
    return view !== undefined && sessionAgendaEnabled(view.config);
  }
}
