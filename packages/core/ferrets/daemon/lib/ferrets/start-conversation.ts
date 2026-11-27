import { err, ok, type Result } from '@ferretry/std';
import type {
  ConversationStageSource,
  Harness,
  HarnessKey,
  LaunchSpec,
  PackedConversation,
  StartFailure,
  StartRequest,
} from '../../../contract/index.ts';

const failed = (code: StartFailure['code'], reason: string): Result<never, StartFailure> => err({ code, reason });

/**
 * "Continue a past conversation": the transcript a start names is put where the harness finds it (the one
 * `conversation.stage` provider: the existing indexed copy-on-link); a refusal refuses the start with its reason. With NO
 * provider nothing is copied: a pooled transcript is resumed, and the launch refuses one the harness proves absent (E17).
 * ONLY THE OWNER'S start stages: the transcript comes from the owner's own computer, and a ferret (or a pack, board or
 * warden) must never be able to pull a host conversation into the pool by naming it. Any other asker resumes a
 * conversation the pool already holds, and the launch refuses one it does not.
 */
export async function stageConversation(
  provider: ConversationStageSource | undefined,
  harness: HarnessKey,
  conversation: string | undefined,
  by: StartRequest['by'],
): Promise<Result<void, StartFailure>> {
  const source = conversation === undefined || by !== 'owner' ? undefined : provider;
  if (conversation === undefined || source === undefined) return ok(undefined);
  const staged = await source
    .stage({ harness, conversation })
    .catch(
      (): Awaited<ReturnType<ConversationStageSource['stage']>> =>
        err({ code: 'failed', reason: 'the conversation could not be staged' }),
    );
  return staged.ok
    ? ok(undefined)
    : failed('refused', `${staged.error.reason} The ferret was not started, so nothing was resumed.`);
}

/**
 * A conversation that came from another machine (`StartRequest.relocated`, C-45) is the owner's alone, never beside another
 * conversation, and needs a harness that can unpack it. Judged before the first write of a start, so a refusal leaves nothing.
 */
export function relocatedRefusal(
  request: StartRequest,
  harness: Pick<Harness, 'unpackConversation'> | undefined,
  key: HarnessKey,
): Result<never, StartFailure> | undefined {
  if (request.relocated === undefined) return undefined;
  if (request.by !== 'owner' || request.harnessConversation !== undefined)
    return failed(
      'refused',
      'a moved conversation is started by the owner alone, and never beside another conversation',
    );
  if (harness?.unpackConversation === undefined)
    return failed(
      'refused',
      `the ${key} harness cannot take a conversation moved from another machine, so nothing was started`,
    );
  return undefined;
}

/**
 * Writes the moved conversation into THIS ferret's own home (the home exists by now) and names the conversation the launch
 * resumes. The harness refuses with one sentence and writes nothing when it cannot (an untested version, a pack that is not
 * a whole conversation); the launch then fails as any other does.
 */
export async function unpackRelocated(
  harness: Pick<Harness, 'unpackConversation'>,
  spec: LaunchSpec,
  packed: PackedConversation,
): Promise<Result<{ readonly spec: LaunchSpec; readonly conversation: string }, StartFailure>> {
  const unpacked = await harness.unpackConversation?.(spec, packed).catch((): undefined => undefined);
  if (unpacked === undefined)
    return failed('refused', 'the moved conversation could not be written into this ferret’s home');
  if (!unpacked.ok) return failed('refused', unpacked.error.reason);
  return ok({
    spec: { ...spec, harnessConversation: unpacked.value.conversation },
    conversation: unpacked.value.conversation,
  });
}
