import { err, ok, type Result } from '@ferretry/std';
import type {
  Harness,
  HarnessKey,
  LaunchSpec,
  PackedConversation,
  StartFailure,
  StartRequest,
} from '../../../contract/index.ts';

const failed = (code: StartFailure['code'], reason: string): Result<never, StartFailure> => err({ code, reason });

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

/** The existing resume probe/refusal, kept beside moved-conversation admission to keep the lifecycle class bounded. */
export async function conversationForLaunch(
  harness: Pick<Harness, 'hasConversation'>,
  spec: LaunchSpec,
  original: string | undefined,
  named: string | undefined,
  required: boolean,
): Promise<Result<{ readonly conversation: string | undefined; readonly missing?: string }, StartFailure>> {
  const conversation =
    named === undefined || harness.hasConversation === undefined
      ? original
      : (await harness.hasConversation(spec, named).catch(() => undefined)) === false
        ? undefined
        : named;
  if (named !== undefined && conversation === undefined) {
    if (required)
      return failed(
        'refused',
        `the ${spec.harness} conversation ${named} was not found, so the ferret was not started (only the owner's start copies one in from this computer, and only while the Conversations plugin is on)`,
      );
    return ok({ conversation, missing: named });
  }
  return ok({ conversation });
}
