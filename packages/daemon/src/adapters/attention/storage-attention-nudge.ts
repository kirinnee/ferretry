import type { AttentionTurnNudge, NudgeSubject } from '../../lib/attention/index.ts';
import { isTurnEnd } from '../../lib/attention/index.ts';
import { jsonObject } from '../../lib/json.ts';
import { tryParseSessionId } from '../../lib/session-id.ts';
import type { TranscriptHarness } from '../../lib/transcript/types.ts';
import type { DaemonStorage } from '../storage/session-storage.ts';

/** The journal entry a nudge leaves, with the asks it named: the audit of what the owner was spared. */
export const ATTENTION_NUDGED_EVENT = 'attention.nudged';

/**
 * The session facts the turn-end check reads, from the session's own configuration document: whether it
 * has a parent, its mode and its harness. Read raw rather than through the whole session schema, so a
 * document a newer field made unparseable elsewhere still answers these three — and a document that does
 * not say answers nothing.
 */
export class StorageAttentionNudgeSessions {
  /** `agenda` reads whether agenda mode is on for a session (the launch setting); absent, it is off. */
  constructor(
    private readonly storage: Pick<DaemonStorage, 'readConfig' | 'append'>,
    private readonly agenda?: { read(sessionId: string): Promise<boolean> },
  ) {}

  async subject(sessionId: string): Promise<(NudgeSubject & { readonly harness: TranscriptHarness }) | undefined> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return undefined;
    const config = jsonObject(await this.storage.readConfig(id).catch(() => undefined));
    if (config === undefined) return undefined;
    const harness = config.harness === 'codex' ? 'codex' : config.harness === 'claude' ? 'claude' : undefined;
    if (harness === undefined) return undefined;
    return {
      parent: typeof config.parent === 'string' && config.parent !== '',
      mode: config.mode === 'interactive' ? 'interactive' : 'auto',
      agenda: (await this.agenda?.read(sessionId).catch(() => false)) ?? false,
      harness,
    };
  }

  async record(sessionId: string, asks: readonly string[]): Promise<void> {
    const id = tryParseSessionId(sessionId);
    if (id !== undefined) await this.storage.append(id, ATTENTION_NUDGED_EVENT, { asks: [...asks] });
  }
}

/** How a check is put off until the transcript has settled; the composition root's timer. */
export type NudgeScheduler = (run: () => void, delayMs: number) => void;

/**
 * Runs the turn-end check on every turn end the journal records, after `settleMs`: the end of a turn can
 * be seen on the pane before its last words reach the transcript file. One check per session at a time —
 * a turn end seen while one is running is dropped, because the running check reads the same reply.
 * A listener must never throw into the journal's append path, and a check that fails says nothing.
 * Returns the unsubscribe.
 */
export function armAttentionNudge(
  storage: Pick<DaemonStorage, 'subscribeEvents'>,
  nudge: Pick<AttentionTurnNudge, 'check'>,
  settleMs: number,
  schedule: NudgeScheduler,
): () => void {
  const running = new Set<string>();
  return storage.subscribeEvents(event => {
    if (!isTurnEnd(event.type, event.data)) return;
    const sessionId = event.sessionId;
    if (running.has(sessionId)) return;
    running.add(sessionId);
    schedule(() => {
      void nudge
        .check(sessionId)
        .catch(() => false)
        .finally(() => running.delete(sessionId));
    }, settleMs);
  });
}
