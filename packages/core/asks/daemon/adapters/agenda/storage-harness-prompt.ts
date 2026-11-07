import { type PendingQuestion, PendingQuestionSchema, type StructuredQuestionAnswer } from '@ferretry/protocol';
import type { HarnessPromptJournal, HarnessQuestionAnswerer } from '../../lib/agenda/index.ts';
import { jsonObject } from '../../lib/json.ts';
import type { SessionAnswerSubsystem } from '../../lib/runtime/mounts/session-answer.ts';
import { tryParseSessionId } from '../../lib/session-id.ts';
import type { DaemonStorage } from '../storage/session-storage.ts';

/** The journal entry an answer that did not reach its question form leaves. */
export const HARNESS_ANSWER_FAILED_EVENT = 'agenda.harness_answer_failed';

/** A session's state document, read for the harness-prompt reconciliation; `undefined` when unreadable. */
export class StorageHarnessPromptStates {
  constructor(private readonly storage: Pick<DaemonStorage, 'readState'>) {}

  async read(sessionId: string): Promise<unknown> {
    const id = tryParseSessionId(sessionId);
    return id === undefined ? undefined : await this.storage.readState(id);
  }
}

/**
 * The question form a board answer is typed into: re-read from the state document, and driven through
 * the session answer subsystem — the same coordinator, receipts and driver the Console's answer uses.
 */
export class StorageHarnessQuestionAnswerer implements HarnessQuestionAnswerer {
  constructor(
    private readonly storage: Pick<DaemonStorage, 'readState'>,
    private readonly answers: Pick<SessionAnswerSubsystem, 'answer'>,
  ) {}

  async pending(sessionId: string): Promise<PendingQuestion | undefined> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return undefined;
    const parsed = PendingQuestionSchema.safeParse(jsonObject(await this.storage.readState(id))?.pendingQuestion);
    return parsed.success ? parsed.data : undefined;
  }

  async answer(
    sessionId: string,
    request: {
      readonly toolUseId: string;
      readonly answers: readonly StructuredQuestionAnswer[];
      readonly requestId: string;
    },
  ): Promise<void> {
    await this.answers.answer(sessionId, {
      toolUseId: request.toolUseId,
      labels: [],
      answers: request.answers,
      requestId: request.requestId,
    });
  }
}

/** An undelivered board answer, journalled on the session it was for. */
export class StorageHarnessPromptJournal implements HarnessPromptJournal {
  constructor(private readonly storage: Pick<DaemonStorage, 'append'>) {}

  async answerFailed(
    sessionId: string,
    failure: { readonly id: string; readonly toolUseId: string; readonly reason: string },
  ): Promise<void> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return;
    await this.storage.append(id, HARNESS_ANSWER_FAILED_EVENT, {
      id: failure.id,
      toolUseId: failure.toolUseId,
      reason: failure.reason.slice(0, 2_000),
    });
  }
}
