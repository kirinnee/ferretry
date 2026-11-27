import { err, ok, type Result } from '@ferretry/std';
import type {
  ConversationSource,
  ConversationStageSource,
  HarnessKey,
  StagedConversation,
  StartFailure,
} from '../../../contract/index.ts';

/** Only a person's start can copy host history. The reservation stays held until its caller records an owner or fails. */
export async function stageConversation(
  source: ConversationStageSource | undefined,
  harness: HarnessKey,
  conversation: string | undefined,
  selected: ConversationSource | undefined,
  person: boolean,
): Promise<Result<StagedConversation | undefined, StartFailure>> {
  if (conversation === undefined || !person || source === undefined) return ok(undefined);
  const staged = await source
    .stage({ harness, conversation, ...(selected === undefined ? {} : { source: selected }) })
    .catch(() => err({ code: 'failed' as const, reason: 'the conversation could not be staged' }));
  return staged.ok
    ? staged
    : err({
        code: 'refused',
        reason: `${staged.error.reason} The ferret was not started, so nothing was resumed.`,
      });
}
