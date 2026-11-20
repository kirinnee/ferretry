import { describe, it } from 'bun:test';
import should from 'should';
import {
  VOICE_UPLINK_PCM_BYTES,
  VOICE_UPLINK_PCM_SAMPLES,
  VOICE_UPLINK_UNIT_BYTES,
  type VoiceResult,
} from '../../src/lib/voice-stream.ts';
import {
  decodeUplinkUnit,
  encodeUplinkUnit,
  float32ToInt16,
  packUplinkUnit,
  int16ToFloat32,
  type VoiceUplinkControl,
  type VoiceUplinkUnit,
} from '../../src/lib/voice-stream-uplink.ts';

const NONCE = 'AAAAAAAAAAAA';
const NONCE2 = 'abcdefghijkl';

const pcmOf = (seed = 1): Int16Array =>
  Int16Array.from({ length: VOICE_UPLINK_PCM_SAMPLES }, (_, i) => ((i * 97 + seed * 31) % 65536) - 32768);

const mustOk = <T>(result: VoiceResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const code = (result: VoiceResult<unknown>): string => (result.ok ? 'ok' : result.error.code);

const encode = (unit: VoiceUplinkUnit): Uint8Array => mustOk(encodeUplinkUnit(unit));

/** A unit whose slot is raw bytes: PCM zeros, then `length` and `slot` as given. */
const withSlot = (length: number, slot: Uint8Array): Uint8Array => {
  const bytes = new Uint8Array(VOICE_UPLINK_UNIT_BYTES);
  bytes[VOICE_UPLINK_PCM_BYTES] = length;
  bytes.set(slot, VOICE_UPLINK_PCM_BYTES + 1);
  return bytes;
};
const slotJson = (value: unknown): Uint8Array => {
  const json = new TextEncoder().encode(JSON.stringify(value));
  return withSlot(json.byteLength, json);
};

describe('uplink unit: golden layout', () => {
  it('lays the PCM out little-endian, then the length byte, the JSON and zeros', () => {
    const pcm = new Int16Array(VOICE_UPLINK_PCM_SAMPLES);
    pcm[0] = 0x0102;
    pcm[1] = -2;
    pcm[639] = -32768;
    const bytes = encode({ pcm, echo: NONCE, control: { kind: 'hold', turnId: 7 } });
    should(bytes.byteLength).equal(1344);
    should([...bytes.subarray(0, 4)]).eql([0x02, 0x01, 0xfe, 0xff]);
    should([...bytes.subarray(1278, 1280)]).eql([0x00, 0x80]);
    const json = '{"n":"AAAAAAAAAAAA","k":"hold","t":7}';
    should(bytes[1280]).equal(json.length);
    should(new TextDecoder().decode(bytes.subarray(1281, 1281 + json.length))).equal(json);
    should(bytes.subarray(1281 + json.length).every(b => b === 0)).equal(true);
  });

  it('writes the empty slot as a single zero length and all zeros', () => {
    const bytes = encode({ pcm: pcmOf() });
    should(bytes.subarray(1280).every(b => b === 0)).equal(true);
  });

  it('writes an echo alone, each control with and without an echo, and fixes the member order', () => {
    const json = (unit: Omit<VoiceUplinkUnit, 'pcm'>): string => {
      const bytes = encode({ pcm: pcmOf(), ...unit });
      return new TextDecoder().decode(bytes.subarray(1281, 1281 + (bytes[1280] ?? 0)));
    };
    should(json({ echo: NONCE })).equal('{"n":"AAAAAAAAAAAA"}');
    should(json({ control: { kind: 'muted' } })).equal('{"k":"muted"}');
    should(json({ echo: NONCE, control: { kind: 'unmuted' } })).equal('{"n":"AAAAAAAAAAAA","k":"unmuted"}');
    should(json({ echo: NONCE, control: { kind: 'end' } })).equal('{"n":"AAAAAAAAAAAA","k":"end"}');
    should(json({ echo: NONCE, control: { kind: 'send-now', turnId: 3 } })).equal(
      '{"n":"AAAAAAAAAAAA","k":"send-now","t":3}',
    );
    should(json({ echo: NONCE, control: { kind: 'shown', turnId: 3, revision: 9 } })).equal(
      '{"n":"AAAAAAAAAAAA","k":"shown","t":3,"r":9}',
    );
    should(json({ control: { kind: 'shown', turnId: 0, revision: 0 } })).equal('{"k":"shown","t":0,"r":0}');
  });
});

describe('uplink unit: every unit is exactly its size, and the slot always fits', () => {
  const controls: (VoiceUplinkControl | undefined)[] = [
    undefined,
    { kind: 'shown', turnId: 4294967295, revision: 4294967295 },
    { kind: 'hold', turnId: 4294967295 },
    { kind: 'send-now', turnId: 4294967295 },
    { kind: 'muted' },
    { kind: 'unmuted' },
    { kind: 'end' },
  ];

  it('encodes every echo/control combination to 1,344 bytes and decodes it back', () => {
    for (const echo of [undefined, NONCE, '____________'])
      for (const control of controls) {
        if (echo === undefined && control === undefined) continue;
        const pcm = pcmOf(3);
        const bytes = encode({
          pcm,
          ...(echo === undefined ? {} : { echo }),
          ...(control === undefined ? {} : { control }),
        });
        should(bytes.byteLength).equal(VOICE_UPLINK_UNIT_BYTES);
        const unit = mustOk(decodeUplinkUnit(bytes));
        should([...unit.pcm]).eql([...pcm]);
        should(unit.echo).equal(echo);
        should(unit.control).eql(control);
      }
  });

  it('keeps the worst slot (shown, both integers at their maximum) at 62 of 63 bytes', () => {
    const bytes = encode({
      pcm: pcmOf(),
      echo: NONCE,
      control: { kind: 'shown', turnId: 4294967295, revision: 4294967295 },
    });
    should(bytes[1280]).equal(62);
  });

  it('keys the base64url length of a unit to its byte count alone', () => {
    const lengths = new Set<number>();
    for (const unit of [
      { pcm: new Int16Array(640) },
      { pcm: pcmOf(5), echo: NONCE, control: { kind: 'shown', turnId: 1, revision: 1 } as const },
      { pcm: pcmOf(9), echo: NONCE2, control: { kind: 'end' } as const },
    ])
      lengths.add(Buffer.from(encode(unit)).toString('base64url').length);
    should([...lengths]).eql([1792]);
  });

  it('refuses a PCM block that is not 640 samples, and a slot that is not valid, without throwing', () => {
    should(code(encodeUplinkUnit({ pcm: new Int16Array(639) }))).equal('unit_size');
    should(code(encodeUplinkUnit({ pcm: new Int16Array(641) }))).equal('unit_size');
    should(code(encodeUplinkUnit({ pcm: pcmOf(), echo: 'short' }))).equal('slot_shape');
    should(code(encodeUplinkUnit({ pcm: pcmOf(), echo: 'AAAAAAAAAAA!' }))).equal('slot_shape');
    should(code(encodeUplinkUnit({ pcm: pcmOf(), control: { kind: 'hold', turnId: -1 } }))).equal('slot_shape');
    should(code(encodeUplinkUnit({ pcm: pcmOf(), control: { kind: 'hold', turnId: 4294967296 } }))).equal('slot_shape');
    should(code(encodeUplinkUnit({ pcm: pcmOf(), control: { kind: 'shown', turnId: 1.5, revision: 1 } }))).equal(
      'slot_shape',
    );
  });
});

describe('packing a slot', () => {
  it('never truncates: JSON over 63 bytes is slot_length, and exactly 63 is accepted', () => {
    should(code(packUplinkUnit(pcmOf(), '"'.padEnd(63, 'x')))).equal('ok');
    should(code(packUplinkUnit(pcmOf(), '"'.padEnd(64, 'x')))).equal('slot_length');
    // Bytes, not characters.
    should(code(packUplinkUnit(pcmOf(), 'é'.repeat(32)))).equal('slot_length');
    should(mustOk(packUplinkUnit(pcmOf(), '"'.padEnd(63, 'x')))[1280]).equal(63);
  });

  it('writes the empty slot for no JSON and refuses a short PCM block', () => {
    should(mustOk(packUplinkUnit(pcmOf(), undefined))[1280]).equal(0);
    should(code(packUplinkUnit(new Int16Array(10), undefined))).equal('unit_size');
  });
});

describe('uplink unit: refusals', () => {
  it('refuses any size but 1,344', () => {
    for (const size of [0, 1, 1343, 1345, 2688])
      should(code(decodeUplinkUnit(new Uint8Array(size)))).equal('unit_size');
  });

  it('refuses a slot length past the slot', () => {
    should(code(decodeUplinkUnit(withSlot(64, new Uint8Array(0))))).equal('slot_length');
    should(code(decodeUplinkUnit(withSlot(255, new Uint8Array(0))))).equal('slot_length');
  });

  it('accepts the longest declared length when the JSON really fills it', () => {
    const json = '{"n":"AAAAAAAAAAAA","k":"send-now","t":4294967295}'.padEnd(63, ' ');
    should(json.length).equal(63);
    const bytes = withSlot(63, new TextEncoder().encode(json));
    should(code(decodeUplinkUnit(bytes))).equal('ok');
  });

  it('refuses a non-zero byte anywhere in the padding', () => {
    for (const at of [1281 + 20, 1320, 1343]) {
      const bytes = slotJson({ n: NONCE });
      should(code(decodeUplinkUnit(bytes))).equal('ok');
      bytes[at] = 1;
      should(code(decodeUplinkUnit(bytes))).equal('slot_padding');
    }
  });

  it('refuses a slot that is not UTF-8 or not JSON', () => {
    should(code(decodeUplinkUnit(withSlot(2, Uint8Array.from([0xff, 0xfe]))))).equal('slot_encoding');
    should(code(decodeUplinkUnit(withSlot(2, Uint8Array.from([0xc3, 0x28]))))).equal('slot_encoding');
    should(code(decodeUplinkUnit(withSlot(5, new TextEncoder().encode('{"n":'))))).equal('slot_encoding');
    should(code(decodeUplinkUnit(withSlot(3, new TextEncoder().encode('abc'))))).equal('slot_encoding');
  });

  it('refuses a slot of the wrong shape', () => {
    const shapes: unknown[] = [
      {},
      [],
      null,
      7,
      'x',
      { n: 'short' },
      { n: NONCE, extra: 1 },
      { k: 'shown', t: 1 },
      { k: 'shown', t: 1, r: 1, extra: 1 },
      { k: 'hold' },
      { k: 'hold', t: 1, r: 1 },
      { k: 'muted', t: 1 },
      { k: 'nope' },
      { k: 'hold', t: -1 },
      { k: 'hold', t: 4294967296 },
      { k: 'hold', t: 1.5 },
      { k: 'hold', t: '1' },
      { n: 5, k: 'end' },
    ];
    for (const shape of shapes) should(code(decodeUplinkUnit(slotJson(shape)))).equal('slot_shape');
    // A slot of just spaces is JSON-invalid, not an empty slot.
    should(code(decodeUplinkUnit(withSlot(1, Uint8Array.from([0x20]))))).equal('slot_encoding');
  });

  it('does not read the PCM block as part of the slot', () => {
    const bytes = encode({ pcm: pcmOf(8) });
    bytes[0] = 0x7b;
    should(code(decodeUplinkUnit(bytes))).equal('ok');
  });

  it('decodes a unit that is a view into a larger buffer', () => {
    const whole = new Uint8Array(VOICE_UPLINK_UNIT_BYTES + 10);
    const unit = encode({ pcm: pcmOf(2), echo: NONCE });
    whole.set(unit, 10);
    const decoded = mustOk(decodeUplinkUnit(whole.subarray(10)));
    should([...decoded.pcm]).eql([...pcmOf(2)]);
    should(decoded.echo).equal(NONCE);
  });
});

describe('float and 16-bit samples', () => {
  it('maps the ends and zero exactly and clamps', () => {
    should([...float32ToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5, -0.5]))]).eql([
      0, 32767, -32768, 32767, -32768, 16384, -16384,
    ]);
  });

  it('treats NaN as silence and infinities as the ends', () => {
    should([...float32ToInt16(Float32Array.from([Number.NaN, Infinity, -Infinity]))]).eql([0, 32767, -32768]);
  });

  it('round-trips every 16-bit value', () => {
    const all = Int16Array.from({ length: 65536 }, (_, i) => i - 32768);
    should([...float32ToInt16(int16ToFloat32(all))]).eql([...all]);
  });

  it('answers values in [-1, 1]', () => {
    const floats = int16ToFloat32(Int16Array.from([-32768, 32767, 0]));
    should([...floats]).eql([-1, 1, 0]);
  });

  it('handles an empty block', () => {
    should(float32ToInt16(new Float32Array(0)).length).equal(0);
    should(int16ToFloat32(new Int16Array(0)).length).equal(0);
  });
});
