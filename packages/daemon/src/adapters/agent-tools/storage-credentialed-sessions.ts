import { SessionConfigSchema, SessionStateSchema } from '@ferretry/protocol';
import { z } from 'zod';
import type { CredentialedSession } from '../../lib/agent-tools/policy.ts';
import { readTaskBoardFleet } from '../../lib/tasks/fleet-read.ts';
import { isTerminalStatus, type WardenSessionStatus } from '../../lib/warden/types.ts';

/**
 * The one lifecycle-owned field the identity resolver needs, read on its own.
 *
 * NOT `SessionLifecycleConfigSchema`: the stored configuration is a protocol envelope with the
 * lifecycle's fields merged over it, and the two disagree about `agent`. Parsing the whole document
 * with the lifecycle schema would fail a well-formed session and drop its credential.
 */
const CapabilityHashDocumentSchema = z.object({
  sessionCapabilityHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
});

/** The documents this adapter reads, behind the narrowest port that answers the question. */
export interface CredentialedSessionSource {
  /** Every session id the daemon's index holds. */
  sessionIds(): readonly string[];
  readConfig(id: string): Promise<unknown>;
  readState(id: string): Promise<unknown>;
}

/**
 * Every session that holds a credential, projected from the daemon's own documents.
 *
 * A session with no `sessionCapabilityHash` (one started before the credential existed) or with an
 * unreadable configuration is omitted: no presented credential could ever name it. `active` is the
 * warden's own answer to "has this status been left for good", and a session whose state document
 * cannot be read is not assumed live — "I cannot tell" answers no.
 *
 * The walk goes through {@link readTaskBoardFleet}, which limits SESSIONS in flight; this adapter
 * starts TWO document reads per session, so the peak is 64 sessions and 128 open documents.
 */
export class StorageCredentialedSessions {
  constructor(private readonly source: CredentialedSessionSource) {}

  async snapshot(): Promise<readonly CredentialedSession[]> {
    const sessions = await readTaskBoardFleet(this.source.sessionIds(), async id => await this.session(id));
    return sessions.filter((session): session is CredentialedSession => session !== undefined);
  }

  private async session(id: string): Promise<CredentialedSession | undefined> {
    const [rawConfig, rawState] = await Promise.all([this.source.readConfig(id), this.source.readState(id)]);
    const config = SessionConfigSchema.safeParse(rawConfig);
    const credential = CapabilityHashDocumentSchema.safeParse(rawConfig);
    if (!config.success || !credential.success) return undefined;
    const hash = credential.data.sessionCapabilityHash;
    if (hash === undefined) return undefined;
    const state = SessionStateSchema.safeParse(rawState);
    const status = state.success ? (state.data.status as WardenSessionStatus) : undefined;
    return {
      id: config.data.id,
      name: config.data.name,
      teammate: config.data.teammate ?? null,
      active: status !== undefined && !isTerminalStatus(status),
      sessionCapabilityHash: hash,
    };
  }
}
