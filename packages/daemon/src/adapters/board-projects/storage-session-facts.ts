import { BoardProjectIdSchema } from '@ferretry/protocol';
import { z } from 'zod';
import type { SessionProjectFactSource, SessionProjectFacts } from '../../lib/board-projects/index.ts';
import { type SessionId, tryParseSessionId } from '../../lib/session-id.ts';

const FactsSchema = z.object({
  cwd: z.string().min(1),
  parent: z.string().optional(),
  projectId: BoardProjectIdSchema.optional(),
});

/** Reads a session's board facts from its stored config, leaving the config as it is. */
export class StorageSessionFacts implements SessionProjectFactSource {
  constructor(private readonly storage: { readConfig(id: SessionId): Promise<unknown> }) {}

  async read(sessionId: string): Promise<SessionProjectFacts | null> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return null;
    const config = await this.storage.readConfig(id).catch(() => undefined);
    const parsed = FactsSchema.safeParse(config);
    if (!parsed.success) return null;
    const { cwd, parent, projectId } = parsed.data;
    return {
      cwd,
      ...(parent === undefined ? {} : { parent }),
      ...(projectId === undefined ? {} : { projectId }),
    };
  }
}
