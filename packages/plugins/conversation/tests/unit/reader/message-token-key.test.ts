import { describe, expect, test } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import { err } from '@ferretry/std';
import { CONVERSATION_STATE } from '../../../contract/index.ts';
import {
  MESSAGE_TOKEN_KEY_BYTES,
  MessageTokenKeyError,
  messageTokenCodec,
} from '../../../daemon/reader/adapters/message-token-key.ts';
import { memoryStatePort } from '../../support/state.ts';

const KEY_PATH = 'message-token.key';
const input = new TextEncoder().encode('a cursor');

describe('the message-token key', () => {
  test('is minted at 32 bytes only when absent, written once, and signs the same after a restart', async () => {
    const state = memoryStatePort(CONVERSATION_STATE);
    const tag = await messageTokenCodec(state).tag(input);
    const written = state.bytes.get(KEY_PATH);
    expect(written?.byteLength).toBe(MESSAGE_TOKEN_KEY_BYTES);
    const again = messageTokenCodec(state);
    expect(await again.matches(input, tag)).toBe(true);
    expect(state.bytes.get(KEY_PATH)).toEqual(written as Uint8Array);
  });

  test('a key file that cannot be read is refused, never replaced', async () => {
    const state = memoryStatePort(CONVERSATION_STATE);
    state.bytes.set(KEY_PATH, new Uint8Array(MESSAGE_TOKEN_KEY_BYTES).fill(7));
    const writes: string[] = [];
    const damaged: Pick<StatePort, 'read' | 'write'> = {
      read: async () => err({ file: KEY_PATH, reason: 'io', sentence: 'the disk would not answer' }),
      write: async file => void writes.push(file.name),
    };
    const codec = messageTokenCodec(damaged);
    const refusal = await codec.tag(input).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(MessageTokenKeyError);
    expect(refusal).toMatchObject({ status: 500, code: 'message_token_key' });
    expect(writes).toEqual([]);
  });

  test('a key of the wrong width is refused and left as it was', async () => {
    const state = memoryStatePort(CONVERSATION_STATE);
    const short = new Uint8Array(16).fill(3);
    state.bytes.set(KEY_PATH, short);
    const codec = messageTokenCodec(state);
    await expect(codec.tag(input)).rejects.toThrow('is not exactly 32 bytes');
    await expect(codec.matches(input, new Uint8Array(32))).rejects.toThrow('is not exactly 32 bytes');
    expect(state.bytes.get(KEY_PATH)).toEqual(short);
  });

  test('a refused load is not kept: once the file is right again, the next read signs', async () => {
    const state = memoryStatePort(CONVERSATION_STATE);
    state.bytes.set(KEY_PATH, new Uint8Array(5));
    const codec = messageTokenCodec(state);
    await expect(codec.tag(input)).rejects.toThrow(MessageTokenKeyError);
    state.bytes.set(KEY_PATH, new Uint8Array(MESSAGE_TOKEN_KEY_BYTES).fill(9));
    expect((await codec.tag(input)).byteLength).toBe(32);
  });

  test('a mint that came out at the wrong width is never written', async () => {
    const state = memoryStatePort(CONVERSATION_STATE);
    const codec = messageTokenCodec(state, () => new Uint8Array(8));
    await expect(codec.tag(input)).rejects.toThrow('wrong width');
    expect(state.bytes.has(KEY_PATH)).toBe(false);
  });
});
