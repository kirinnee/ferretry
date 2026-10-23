import type { SessionAttentionSummary } from '@ferretry/protocol';
import type { AttentionBoardChange, SessionAttentionState } from '../../lib/attention/index.ts';
import { type FrozenJsonValue, jsonObject } from '../../lib/json.ts';
import { tryParseSessionId } from '../../lib/session-id.ts';
import type { DaemonStorage } from '../storage/session-storage.ts';

/** The journal entry a board change leaves: what makes the fleet feed re-read the session list. */
export const ATTENTION_CHANGED_EVENT = 'attention.changed';

function sameSummary(left: FrozenJsonValue | undefined, right: SessionAttentionSummary | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * `state.attention` in the session's own state document — the document the list and the single read
 * already serve — and one journal entry per board change, which is what the fleet feed watches.
 *
 * CLEARED MEANS ABSENT, NOT `null`, for the reason `StorageSignalRepository` gives: the protocol
 * declares the field an optional object, and a `null` would make the whole document fail to parse.
 * A summary that did not move is not rewritten, but the change is still journalled: an answered item
 * that leaves another one open moves the board even when the oldest open item is the same.
 */
export class StorageSessionAttentionState implements SessionAttentionState {
  constructor(private readonly storage: Pick<DaemonStorage, 'updateState' | 'readState' | 'append'>) {}

  async write(
    sessionId: string,
    summary: SessionAttentionSummary | undefined,
    change: AttentionBoardChange | undefined,
  ): Promise<void> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return;
    const current = jsonObject(await this.storage.readState(id));
    if (current === undefined) return;
    const moved = !sameSummary(current.attention, summary);
    if (moved) {
      await this.storage.updateState(id, latest => {
        const next: Record<string, FrozenJsonValue> = { ...(jsonObject(latest) ?? {}) };
        if (summary === undefined) delete next.attention;
        else next.attention = { ...summary };
        return next;
      });
    }
    if (change === undefined && !moved) return;
    const itemId = change?.addressed?.id ?? change?.item?.id;
    await this.storage.append(id, ATTENTION_CHANGED_EVENT, {
      change: change?.change ?? 'reconciled',
      ...(itemId === undefined ? {} : { id: itemId }),
      open: summary?.open ?? 0,
    });
  }
}
