import { describe, expect, test } from 'bun:test';
import { decodeControlMessage, encodeControlMessage } from '../../../daemon/lib/relay/control.ts';

describe('rendezvous control messages', () => {
  test('a message survives the trip through its bytes', () => {
    for (const message of [
      { t: 'probe' },
      { t: 'held' },
      { t: 'open' },
      { t: 'closed', code: 4410, reason: 'gone' },
    ] as const)
      expect(decodeControlMessage(encodeControlMessage(message))).toEqual(message);
  });

  test('bytes that are not UTF-8, text that is not JSON and JSON of another shape are all refused', () => {
    expect(decodeControlMessage(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(decodeControlMessage(new TextEncoder().encode('{nope'))).toBeNull();
    expect(decodeControlMessage(new TextEncoder().encode('{"t":"subscribe"}'))).toBeNull();
    expect(decodeControlMessage(new TextEncoder().encode('{"t":"open","extra":1}'))).toBeNull();
  });
});
