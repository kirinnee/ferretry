import { describe, expect, test } from 'bun:test';
import {
  CONTROLS,
  DOWNLINK_UNIT_BYTES,
  StreamProtocolError,
  type StreamControl,
  UNIT_SAMPLES,
  UPLINK_UNIT_BYTES,
  UnitAssembler,
  WordsAssembler,
  decodeDownlinkUnit,
  decodeUplinkUnit,
  encodeDownlinkUnit,
  encodeUplinkUnit,
  StreamStartSchema,
} from '../../../contract/index.ts';

describe('the voice stream units', () => {
  test('an uplink unit is always 1,344 bytes whatever it carries, and round-trips', () => {
    const pcm = Int16Array.from({ length: UNIT_SAMPLES }, (_, index) => (index % 2 === 0 ? 32767 : -32768));
    for (const control of Object.keys(CONTROLS) as StreamControl[]) {
      const bytes = encodeUplinkUnit({ pcm, control, echo: '0123456789abcdef' });
      expect(bytes.byteLength).toBe(UPLINK_UNIT_BYTES);
      expect(decodeUplinkUnit(bytes)).toEqual({ pcm, control, echo: '0123456789abcdef' });
    }
    expect(decodeUplinkUnit(encodeUplinkUnit({ pcm, control: 'none', echo: undefined })).echo).toBeUndefined();
  });

  test('an uplink unit that is the wrong size, has an unknown control or a dirty slot is malformed', () => {
    const good = encodeUplinkUnit({ pcm: new Int16Array(UNIT_SAMPLES), control: 'none', echo: undefined });
    expect(() => decodeUplinkUnit(good.slice(1))).toThrow(StreamProtocolError);
    const unknown = good.slice();
    unknown[UNIT_SAMPLES * 2] = 200;
    expect(() => decodeUplinkUnit(unknown)).toThrow(StreamProtocolError);
    const dirty = good.slice();
    dirty[UPLINK_UNIT_BYTES - 1] = 1;
    expect(() => decodeUplinkUnit(dirty)).toThrow(StreamProtocolError);
    expect(() => encodeUplinkUnit({ pcm: new Int16Array(10), control: 'none', echo: undefined })).toThrow(
      StreamProtocolError,
    );
    expect(() => encodeUplinkUnit({ pcm: new Int16Array(UNIT_SAMPLES), control: 'none', echo: 'nope' })).toThrow(
      StreamProtocolError,
    );
  });

  test('a downlink unit is always 1,024 bytes, parseable alone, and the sealed size never depends on its content', () => {
    const quiet = encodeDownlinkUnit({ v: 1, state: 'listening', nonce: '0123456789abcdef', turn: 0 });
    const busy = encodeDownlinkUnit({
      v: 1,
      state: 'hearing',
      nonce: 'fedcba9876543210',
      turn: 3,
      words: { turn: 3, rev: 2, offset: 0, total: 5, text: 'hello', final: false },
      last: { turn: 2, outcome: 'sent', sendId: 'abc:2' },
    });
    expect(quiet.byteLength).toBe(DOWNLINK_UNIT_BYTES);
    expect(busy.byteLength).toBe(DOWNLINK_UNIT_BYTES);
    expect(decodeDownlinkUnit(busy)).toMatchObject({ state: 'hearing', words: { text: 'hello' } });
  });

  test('a downlink unit with a length past its unit, no JSON, or an unknown field is malformed', () => {
    const good = encodeDownlinkUnit({ v: 1, state: 'listening', nonce: '0123456789abcdef', turn: 0 });
    const long = good.slice();
    new DataView(long.buffer).setUint16(0, 1023);
    expect(() => decodeDownlinkUnit(long)).toThrow(StreamProtocolError);
    expect(() => decodeDownlinkUnit(new Uint8Array(DOWNLINK_UNIT_BYTES))).toThrow(StreamProtocolError);
    const extra = new TextEncoder().encode(
      JSON.stringify({ v: 1, state: 'listening', nonce: '0123456789abcdef', turn: 0, secret: 1 }),
    );
    const bytes = new Uint8Array(DOWNLINK_UNIT_BYTES);
    new DataView(bytes.buffer).setUint16(0, extra.length);
    bytes.set(extra, 2);
    expect(() => decodeDownlinkUnit(bytes)).toThrow(StreamProtocolError);
  });

  test('a snapshot too big for its unit is refused, and a unit whose bytes are not JSON is malformed', () => {
    expect(() =>
      encodeDownlinkUnit({
        v: 1,
        state: 'hearing',
        nonce: '0123456789abcdef',
        turn: 1,
        words: { turn: 1, rev: 0, offset: 0, total: 2_000, text: 'x'.repeat(2_000), final: false },
      }),
    ).toThrow(StreamProtocolError);
    const bytes = new Uint8Array(DOWNLINK_UNIT_BYTES);
    new DataView(bytes.buffer).setUint16(0, 5);
    bytes.set(new TextEncoder().encode('{nope'), 2);
    expect(() => decodeDownlinkUnit(bytes)).toThrow(StreamProtocolError);
  });

  test('the assembler cuts fixed units out of any chunking and holds a partial one', () => {
    const assembler = new UnitAssembler(4);
    expect(assembler.push(Uint8Array.of(1, 2, 3))).toEqual([]);
    expect(assembler.pending).toBe(3);
    expect(assembler.push(Uint8Array.of(4, 5, 6, 7, 8, 9))).toEqual([
      Uint8Array.of(1, 2, 3, 4),
      Uint8Array.of(5, 6, 7, 8),
    ]);
    expect(assembler.pending).toBe(1);
  });

  test('words must arrive in order, from offset 0, with a steady total', () => {
    const words = new WordsAssembler();
    const piece = (offset: number, text: string, total = 6, rev = 0) => ({
      turn: 1,
      rev,
      offset,
      total,
      text,
      final: false,
    });
    expect(words.accept(piece(0, 'abc'))).toBeUndefined();
    expect(() => words.accept(piece(0, 'abc'))).toThrow(StreamProtocolError); // not the next one
    expect(words.accept(piece(3, 'def'))).toMatchObject({ text: 'abcdef' });
    expect(words.accept(piece(0, 'xy', 2, 1))).toMatchObject({ text: 'xy' }); // a newer revision replaces at once
    expect(() => new WordsAssembler().accept(piece(2, 'c'))).toThrow(StreamProtocolError);
    expect(() => words.accept(piece(2, 'zz', 9, 1))).toThrow(StreamProtocolError); // the total moved
  });

  test('the start record is one of two shapes and nothing else', () => {
    expect(StreamStartSchema.safeParse({ t: 'start', v: 1, purpose: 'test' }).success).toBe(true);
    expect(
      StreamStartSchema.safeParse({ t: 'start', v: 1, purpose: 'chat', ferretId: 'f1', style: 'quick' }).success,
    ).toBe(true);
    expect(StreamStartSchema.safeParse({ t: 'start', v: 1, purpose: 'chat' }).success).toBe(false);
    expect(StreamStartSchema.safeParse({ t: 'start', v: 1, purpose: 'test', ferretId: 'f1' }).success).toBe(false);
  });
});
