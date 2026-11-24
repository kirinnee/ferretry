/**
 * How the phone hands a spoken turn to the ferret when the machine is not the one sending.
 *
 * On the machine's engine the MACHINE sends each utterance (`(voice) <words>`, a stable send id). On the phone's engine the
 * phone does the same thing through the ordinary send route, with the same shape: the `(voice) ` prefix the ferret was
 * taught to read (`instructions/voice.md`), and a send id of its own that makes a repeat of one call ONE message (the send route's `sendId`):
 * the id is minted once per turn and a retry reuses it.
 */
import type { VoicePluginClient } from '../../shell-voice.ts';

const SPOKEN_PREFIX = '(voice) ';
const SEND_ROUTE = 'POST /v1/ferrets/:ferretId/send';

/** One id for this voice session, so no two sessions (or devices) ever share a send id. */
export const newSessionKey = (): string => `phone-${globalThis.crypto.randomUUID()}`;

/** The send id of the nth turn of a session. At most 128 characters, which the route enforces. */
export const sendIdOf = (sessionKey: string, turn: number): string => `${sessionKey}:${turn}`;

export type PhoneSendResult = { readonly ok: true } | { readonly ok: false; readonly sentence: string };

/**
 * Sends one turn. A failure is tried once more with the SAME id, so a lost answer after the machine accepted the message
 * never sends it twice. A refusal comes back as a sentence the panel can say; no transcript is in it.
 */
export async function sendSpoken(
  client: Pick<VoicePluginClient, 'call'>,
  ferretId: string,
  text: string,
  sendId: string,
): Promise<PhoneSendResult> {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await client.call(SEND_ROUTE, {
        params: { ferretId },
        body: { message: `${SPOKEN_PREFIX}${text}`, sendId },
        // The route refuses a send without it, and one whose body names another id.
        headers: { 'x-fy-request-id': sendId },
      });
      return { ok: true };
    } catch (error) {
      failure = error;
    }
  }
  const message = (failure as { message?: unknown } | null)?.message;
  return {
    ok: false,
    sentence: typeof message === 'string' && message !== '' ? message : 'The machine did not answer.',
  };
}
