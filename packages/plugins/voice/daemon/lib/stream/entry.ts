/**
 * THE ENTRY MESSAGE OF A PHONE'S OWN VOICE MODE. When voice mode runs on a phone's own speech there is no stream to carry the
 * entry message, so the phone asks the machine to send it (`POST /v1/voice/entry`). The machine decides, from the same claim the
 * stream uses (the registry's, one per chat), whether this call is the one that tells the ferret: a chat whose voice mode
 * another tab, device or engine already announced gets nothing sent. The phone calls it again every
 * {@link ENTRY_RENEW_MS} to keep the claim live while it is on.
 */
import {
  VOICE_ENTRY_MESSAGE,
  VoiceEntryRequestSchema,
  type VoiceEntryResult,
  entrySendId,
} from '../../../contract/index.ts';
import type { StreamRegistry } from './registry.ts';
import type { StreamParts } from './session.ts';

export interface VoiceEntryDeps {
  readonly registry: StreamRegistry;
  readonly clock: Pick<StreamParts['clock'], 'nowMs'>;
  /** Read at each call, so Conversation loading or unloading later is seen. `undefined` = Conversation is off. */
  readonly send: () => StreamParts['send'];
  readonly resolveFerret: StreamParts['resolveFerret'];
  readonly log: StreamParts['log'];
}

/** The refusals of the route, as the route turns them into statuses. */
export class VoiceEntryRefused extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Claims the chat's entry and, when this call holds it, sends the one message. `sent` says whether this call did. */
export async function enterVoiceChat(deps: VoiceEntryDeps, body: unknown): Promise<VoiceEntryResult> {
  const parsed = VoiceEntryRequestSchema.safeParse(body);
  if (!parsed.success)
    throw new VoiceEntryRefused(400, 'The entry request names a ferret and a voice session.', 'bad_request');
  const send = deps.send();
  if (send === undefined)
    throw new VoiceEntryRefused(409, 'Voice mode needs Conversation on this machine.', 'voice_unavailable');
  let ferretId: string | undefined;
  try {
    ferretId = await deps.resolveFerret(parsed.data.ferretId);
  } catch {
    ferretId = undefined;
  }
  if (ferretId === undefined)
    throw new VoiceEntryRefused(404, 'No ferret here answers to that name.', 'ferret_unknown');
  if (!deps.registry.enterVoice(ferretId, deps.clock.nowMs())) return { sent: false };
  let accepted = false;
  try {
    accepted = (await send(ferretId, VOICE_ENTRY_MESSAGE, entrySendId(parsed.data.session))).ok;
  } catch {
    accepted = false;
  }
  if (!accepted) deps.registry.leaveVoice(ferretId);
  deps.log.info(accepted ? 'voice.entry.entered' : 'voice.entry.refused', {});
  return { sent: accepted };
}
