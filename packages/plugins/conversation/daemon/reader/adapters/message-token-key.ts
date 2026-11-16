import { ApiError, type StatePort } from '@ferretry/kernel/contract';
import { MESSAGE_TOKEN_KEY_STATE } from '../../../contract/index.ts';
import type { SessionTranscriptMessageTokenCodec } from '../lib/session/message-token.ts';

/** 256 bits, the same width every other daemon-minted secret is drawn at. */
export const MESSAGE_TOKEN_KEY_BYTES = 32;

/**
 * A key file this daemon will not sign with: unreadable, damaged, or not exactly {@link MESSAGE_TOKEN_KEY_BYTES}. It is
 * never repaired and never replaced, because a key is created once and every outstanding cursor and selection binding
 * depends on it; the read that needed it answers 500 and the file is left as evidence.
 */
export class MessageTokenKeyError extends ApiError {
  constructor(why: string) {
    super(500, `The message-token key ${why}; it was not replaced. Move it aside to start again.`, 'message_token_key');
    this.name = 'MessageTokenKeyError';
  }
}

/** The bytes in a buffer the platform's crypto accepts. */
const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
};

/**
 * The daemon-private MAC for message tokens (today's `file-message-token-codec.ts`): two operations, never the key
 * bytes. IT FAILS CLOSED: a key that cannot be read, is damaged, or is the wrong width refuses, and there is no
 * process-local fallback key, because a fallback would issue tags that verify now and are refused for ever after. A
 * key is minted only when the file is absent; the kernel writes it atomically at `0600`. A refused load is not kept,
 * so the next read tries the file again.
 */
export function messageTokenCodec(
  state: Pick<StatePort, 'read' | 'write'>,
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = bytes => crypto.getRandomValues(bytes),
): SessionTranscriptMessageTokenCodec {
  let key: Promise<CryptoKey> | undefined;
  const load = async (): Promise<CryptoKey> => {
    const read = await state.read(MESSAGE_TOKEN_KEY_STATE);
    if (!read.ok) throw new MessageTokenKeyError(`could not be read (${read.error.reason})`);
    let bytes = read.value;
    if (bytes === undefined) {
      bytes = random(new Uint8Array(MESSAGE_TOKEN_KEY_BYTES));
      if (bytes.byteLength !== MESSAGE_TOKEN_KEY_BYTES)
        throw new MessageTokenKeyError('was minted at the wrong width, so it was never written');
      await state.write(MESSAGE_TOKEN_KEY_STATE, bytes);
    } else if (bytes.byteLength !== MESSAGE_TOKEN_KEY_BYTES)
      throw new MessageTokenKeyError(`is not exactly ${MESSAGE_TOKEN_KEY_BYTES} bytes, so it is damaged or not ours`);
    return await crypto.subtle.importKey('raw', own(bytes), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
  };
  const keyed = (): Promise<CryptoKey> =>
    (key ??= load().catch((error: unknown) => {
      key = undefined;
      throw error;
    }));
  return {
    tag: async input => new Uint8Array(await crypto.subtle.sign('HMAC', await keyed(), own(input))),
    matches: async (input, tag) => await crypto.subtle.verify('HMAC', await keyed(), own(tag), own(input)),
  };
}
