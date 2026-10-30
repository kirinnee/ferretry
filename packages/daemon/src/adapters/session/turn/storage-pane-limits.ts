import { SessionConfigSchema, SessionStateSchema } from '@ferretry/protocol';
import { type PaneLimit, type PaneLimitSession, sessionPaneLimits } from '../../../lib/index.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

/**
 * The limits live sessions' panes prove, read from the session documents: only a session the index
 * already lists as `rate_limited` is opened, so an idle fleet costs one pass over the index.
 * A document that cannot be read or parsed proves nothing and is skipped.
 */
export async function storagePaneLimits(
  storage: Pick<DaemonStorage, 'listSessions' | 'readConfig' | 'readState'>,
  nowMs: number,
): Promise<ReadonlyMap<string, PaneLimit>> {
  const limited = storage.listSessions().filter(session => session.status === 'rate_limited');
  const read = await Promise.all(
    limited.map(async ({ id }): Promise<PaneLimitSession | undefined> => {
      const [config, state] = await Promise.all([
        storage.readConfig(id).catch(() => undefined),
        storage.readState(id).catch(() => undefined),
      ]);
      const parsedConfig = SessionConfigSchema.safeParse(config);
      const parsedState = SessionStateSchema.safeParse(state);
      if (!parsedConfig.success || !parsedState.success) return undefined;
      return {
        agent: parsedConfig.data.agent,
        status: parsedState.data.status,
        quota: parsedState.data.quota,
        harnessDialog: parsedState.data.harnessDialog,
      };
    }),
  );
  return sessionPaneLimits(
    read.filter((session): session is PaneLimitSession => session !== undefined),
    nowMs,
  );
}
