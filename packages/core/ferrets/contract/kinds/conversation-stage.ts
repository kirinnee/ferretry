import type { Result } from '@ferretry/std';
import type { HarnessKey } from '../ids.ts';

/**
 * What a start that names a harness conversation asks of the owner of the machine's conversation index: put that
 * transcript where the harness will find it (the shared pool; a conversation already there needs nothing). Success means
 * a resume of `conversation` can find its transcript; a refusal is one plain sentence, a status and nothing else.
 */
export interface ConversationStageSource {
  stage(request: {
    readonly harness: HarnessKey;
    readonly conversation: string;
  }): Promise<Result<void, ConversationStageRefusal>>;
}

export interface ConversationStageRefusal {
  /** `not_found`: this machine holds no such conversation. `failed`: it is there but could not be staged. */
  readonly code: 'not_found' | 'failed';
  readonly reason: string;
}
