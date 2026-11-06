import { describe, it } from 'bun:test';
import should from 'should';
import { VOICE_REASSEMBLER_MAX_RUN_BYTES, type VoiceResult } from '../../src/lib/voice-stream.ts';
import { encodeDownlinkUnit, type VoiceDownlinkUnit } from '../../src/lib/voice-stream-downlink.ts';
import {
  EMPTY_VOICE_REASSEMBLY,
  feedDownlink,
  feedUplink,
  finishVoiceReassembly,
  type VoiceReassembly,
} from '../../src/lib/voice-stream-reassembler.ts';
import { encodeUplinkUnit, type VoiceUplinkUnit } from '../../src/lib/voice-stream-uplink.ts';

const mustOk = <T>(result: VoiceResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const code = (result: VoiceResult<unknown>): string => (result.ok ? 'ok' : result.error.code);

const uplink = (seed: number, extra: Partial<VoiceUplinkUnit> = {}): VoiceUplinkUnit => ({
  pcm: Int16Array.from({ length: 640 }, (_, i) => (i * 7 + seed * 1000) % 30000),
  echo: 'AAAAAAAAAAAA',
  ...extra,
});
const downlink = (seed: number): VoiceDownlinkUnit => ({
  nonce: 'AAAAAAAAAAAA',
  state: 'hearing',
  fragment: { turnId: seed, revision: 1, offset: 0, total: 3, text: 'abc' },
});

const join = (parts: readonly Uint8Array[]): Uint8Array => {
  const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    whole.set(part, offset);
    offset += part.byteLength;
  }
  return whole;
};

/** Feeds the runs in order and answers every unit, failing the test on a refusal. */
const run = <Unit>(
  feed: (r: VoiceReassembly, bytes: Uint8Array) => VoiceResult<{ reassembly: VoiceReassembly; units: readonly Unit[] }>,
  runs: readonly Uint8Array[],
): { units: Unit[]; reassembly: VoiceReassembly } => {
  let reassembly = EMPTY_VOICE_REASSEMBLY;
  const units: Unit[] = [];
  for (const bytes of runs) {
    const step = mustOk(feed(reassembly, bytes));
    reassembly = step.reassembly;
    units.push(...step.units);
  }
  return { units, reassembly };
};

describe('uplink reassembly', () => {
  const units = [
    uplink(1),
    uplink(2, { control: { kind: 'shown', turnId: 1, revision: 2 } }),
    uplink(3, { control: { kind: 'end' } }),
  ];
  const stream = join(units.map(u => mustOk(encodeUplinkUnit(u))));
  const expected = units.map(u => ({ ...u, pcm: [...u.pcm] }));
  const seen = (found: readonly VoiceUplinkUnit[]) => found.map(u => ({ ...u, pcm: [...u.pcm] }));

  it('yields whole units from whole records', () => {
    const records = units.map(u => mustOk(encodeUplinkUnit(u)));
    const { units: found, reassembly } = run(feedUplink, records);
    should(seen(found)).eql(expected);
    should(mustOk(finishVoiceReassembly(reassembly))).equal(true);
  });

  it('survives a single split at every offset, across two whole units', () => {
    const two = stream.subarray(0, 1344 * 2);
    for (let cut = 0; cut <= two.byteLength; cut += 1) {
      const { units: found, reassembly } = run(feedUplink, [two.subarray(0, cut), two.subarray(cut)]);
      should(seen(found)).eql(expected.slice(0, 2));
      should(reassembly.pending.byteLength).equal(0);
    }
  }, 30_000);

  it('survives two cuts anywhere in the first unit and its neighbour (coalesced and split)', () => {
    const head = stream.subarray(0, 1344 + 40);
    const tail = stream.subarray(1344 + 40);
    for (let a = 0; a <= head.byteLength; a += 37)
      for (let b = a; b <= head.byteLength; b += 53) {
        const { units: found } = run(feedUplink, [head.subarray(0, a), head.subarray(a, b), head.subarray(b), tail]);
        should(seen(found)).eql(expected);
      }
  });

  it('survives one byte at a time and holds less than a unit between bytes', () => {
    let reassembly = EMPTY_VOICE_REASSEMBLY;
    const found: VoiceUplinkUnit[] = [];
    for (const byte of stream.subarray(0, 1344 * 2 + 17)) {
      const step = mustOk(feedUplink(reassembly, Uint8Array.of(byte)));
      reassembly = step.reassembly;
      found.push(...step.units);
      should(reassembly.pending.byteLength).be.below(1344);
    }
    should(found.length).equal(2);
    should(reassembly.pending.byteLength).equal(17);
  });

  it('survives every unit glued into one run and an empty run', () => {
    const { units: found } = run(feedUplink, [new Uint8Array(0), stream, new Uint8Array(0)]);
    should(seen(found)).eql(expected);
  });

  it("does not keep the caller's buffer: mutating it after a feed changes nothing", () => {
    const first = Uint8Array.from(stream.subarray(0, 100));
    const step = mustOk(feedUplink(EMPTY_VOICE_REASSEMBLY, first));
    first.fill(0xaa);
    const rest = mustOk(feedUplink(step.reassembly, stream.subarray(100, 1344)));
    should(seen(rest.units)).eql(expected.slice(0, 1));
  });

  it("copies pending bytes out of a Node Buffer: overwriting the caller's Buffer changes nothing", () => {
    const first = Buffer.from(stream.subarray(0, 100));
    const step = mustOk(feedUplink(EMPTY_VOICE_REASSEMBLY, first));
    first.fill(0xaa);
    const rest = mustOk(feedUplink(step.reassembly, stream.subarray(100, 1344)));
    should(seen(rest.units)).eql(expected.slice(0, 1));
  });

  it("does not retain the caller's backing buffer through a small view", () => {
    const large = Buffer.alloc(1024 * 1024, 7);
    const step = mustOk(feedUplink(EMPTY_VOICE_REASSEMBLY, large.subarray(0, 1)));
    should(step.reassembly.pending.byteLength).equal(1);
    should(step.reassembly.pending.buffer.byteLength).equal(1);
    should(step.reassembly.pending.buffer).not.equal(large.buffer);
  });

  it('is a value: feeding an old state again gives the same answer', () => {
    const step = mustOk(feedUplink(EMPTY_VOICE_REASSEMBLY, stream.subarray(0, 700)));
    const a = mustOk(feedUplink(step.reassembly, stream.subarray(700, 1344)));
    const b = mustOk(feedUplink(step.reassembly, stream.subarray(700, 1344)));
    should(seen(a.units)).eql(seen(b.units));
  });

  it('fails the stream on a malformed slot, whichever run it arrives in', () => {
    const bad = Uint8Array.from(stream.subarray(0, 1344));
    bad[1280] = 200;
    should(code(feedUplink(EMPTY_VOICE_REASSEMBLY, bad))).equal('slot_length');
    const first = mustOk(feedUplink(EMPTY_VOICE_REASSEMBLY, bad.subarray(0, 1300)));
    should(code(feedUplink(first.reassembly, bad.subarray(1300)))).equal('slot_length');
    // A good unit before a bad one: the whole feed fails, there is no partial answer.
    should(code(feedUplink(EMPTY_VOICE_REASSEMBLY, join([stream.subarray(0, 1344), bad])))).equal('slot_length');
  });

  it('fails on an over-length slot field and on padding that is not zero', () => {
    const padded = Uint8Array.from(stream.subarray(0, 1344));
    padded[1343] = 1;
    should(code(feedUplink(EMPTY_VOICE_REASSEMBLY, padded))).equal('slot_padding');
  });

  it('treats a stream that ends mid-unit as an error, and one that ends on a boundary as clean', () => {
    for (const cut of [1, 1343, 1344 + 1, 1344 * 2 + 1343]) {
      const { reassembly } = run(feedUplink, [stream.subarray(0, cut)]);
      should(code(finishVoiceReassembly(reassembly))).equal('stream_ended_mid_unit');
    }
    should(code(finishVoiceReassembly(EMPTY_VOICE_REASSEMBLY))).equal('ok');
    should(code(finishVoiceReassembly(run(feedUplink, [stream.subarray(0, 1344)]).reassembly))).equal('ok');
  });

  it('refuses a run over the limit and accepts one at it', () => {
    should(code(feedUplink(EMPTY_VOICE_REASSEMBLY, new Uint8Array(VOICE_REASSEMBLER_MAX_RUN_BYTES + 1)))).equal(
      'run_too_large',
    );
    const silent = mustOk(encodeUplinkUnit({ pcm: new Int16Array(640) }));
    const many = join(Array.from({ length: Math.floor(VOICE_REASSEMBLER_MAX_RUN_BYTES / 1344) }, () => silent));
    const step = mustOk(feedUplink(EMPTY_VOICE_REASSEMBLY, many));
    should(step.units.length).equal(48);
    should(step.reassembly.pending.byteLength).equal(0);
    const maximum = join([many, new Uint8Array(VOICE_REASSEMBLER_MAX_RUN_BYTES - many.byteLength)]);
    should(code(feedUplink(EMPTY_VOICE_REASSEMBLY, maximum))).equal('ok');
  });
});

describe('downlink reassembly', () => {
  const units = [downlink(1), downlink(2), downlink(3)];
  const stream = join(units.map(u => mustOk(encodeDownlinkUnit(u))));

  it('survives a single split at every offset', () => {
    for (let cut = 0; cut <= stream.byteLength; cut += 1) {
      const { units: found, reassembly } = run(feedDownlink, [stream.subarray(0, cut), stream.subarray(cut)]);
      should(found).eql(units);
      should(reassembly.pending.byteLength).equal(0);
    }
  });

  it('survives coalesced runs and a stream cut mid-unit', () => {
    should(run(feedDownlink, [stream]).units).eql(units);
    const { reassembly } = run(feedDownlink, [stream.subarray(0, 1024 + 500)]);
    should(code(finishVoiceReassembly(reassembly))).equal('stream_ended_mid_unit');
  });

  it("copies pending bytes out of a Node Buffer: overwriting the caller's Buffer changes nothing", () => {
    const first = Buffer.from(stream.subarray(0, 100));
    const step = mustOk(feedDownlink(EMPTY_VOICE_REASSEMBLY, first));
    first.fill(0xaa);
    const rest = mustOk(feedDownlink(step.reassembly, stream.subarray(100, 1024)));
    should(rest.units).eql(units.slice(0, 1));
  });

  it("does not retain the caller's backing buffer through a small view", () => {
    const large = Buffer.alloc(1024 * 1024, 7);
    const step = mustOk(feedDownlink(EMPTY_VOICE_REASSEMBLY, large.subarray(0, 1)));
    should(step.reassembly.pending.byteLength).equal(1);
    should(step.reassembly.pending.buffer.byteLength).equal(1);
    should(step.reassembly.pending.buffer).not.equal(large.buffer);
  });

  it('fails on a malformed unit', () => {
    const bad = Uint8Array.from(stream.subarray(0, 1024));
    bad[1] = 0;
    bad[0] = 0;
    should(code(feedDownlink(EMPTY_VOICE_REASSEMBLY, bad))).equal('unit_length');
    const padded = Uint8Array.from(stream.subarray(0, 1024));
    padded[1023] = 9;
    should(code(feedDownlink(EMPTY_VOICE_REASSEMBLY, padded))).equal('unit_padding');
  });

  it('refuses a run over the limit', () => {
    should(code(feedDownlink(EMPTY_VOICE_REASSEMBLY, new Uint8Array(VOICE_REASSEMBLER_MAX_RUN_BYTES + 1)))).equal(
      'run_too_large',
    );
  });
});
