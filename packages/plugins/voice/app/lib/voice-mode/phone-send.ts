/**
 * How the phone hands a spoken turn to the ferret when the machine is not the one sending.
 *
 * On the machine's engine the MACHINE sends each utterance (`(voice) <words>`, a stable send id). On the phone's engine the
 * phone does the same thing through the ordinary send route, with the same shape: the `(voice) ` prefix the ferret was
 * taught to read (`instructions/voice.md`), and a send id of its own that makes a repeat of one call ONE message (the send route's `sendId`):
 * the id is minted once per turn and a retry reuses it.
 */
import { ENTRY_RENEW_MS, type VoiceEntryRequest } from '../../../contract/index.ts';
import type { VoicePluginClient } from '../../shell-voice.ts';

const SPOKEN_PREFIX = '(voice) ';
const SEND_ROUTE = 'POST /v1/ferrets/:ferretId/send';
const ENTRY_ROUTE = 'POST /v1/voice/entry';

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
  return await post(client, ferretId, `${SPOKEN_PREFIX}${text}`, sendId);
}

/**
 * Voice mode is on, on this phone's own engine: asks the MACHINE to tell the ferret, which it does once per chat however many
 * tabs, devices or engines are in voice mode there (the chat's claim is the machine's, not this tab's). Called again every
 * {@link ENTRY_RENEW_MS} to keep the claim live. A failure is not shown: the person can still talk, and the ferret was taught
 * the grammar in its static instruction either way.
 */
export async function enterVoice(
  client: Pick<VoicePluginClient, 'call'>,
  ferretId: string,
  session: string,
): Promise<void> {
  const body: VoiceEntryRequest = { ferretId, session };
  try {
    await client.call(ENTRY_ROUTE, { body });
  } catch {
    // Not shown: see above.
  }
}

async function post(
  client: Pick<VoicePluginClient, 'call'>,
  ferretId: string,
  words: string,
  sendId: string,
): Promise<PhoneSendResult> {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await client.call(SEND_ROUTE, {
        params: { ferretId },
        body: { message: words, sendId },
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
