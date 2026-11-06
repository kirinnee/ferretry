import { describe, it } from 'bun:test';
import should from 'should';
import {
  VOICE_DOWNLINK_JSON_MAX_BYTES,
  VOICE_DOWNLINK_UNIT_BYTES,
  VOICE_FRAGMENT_TEXT_MAX_BYTES,
  VOICE_TURN_WORDS_MAX_BYTES,
  type VoiceResult,
} from '../../src/lib/voice-stream.ts';
import {
  applyVoiceFragment,
  checkVoiceFragment,
  decodeDownlinkUnit,
  encodeDownlinkUnit,
  fragmentTurnWords,
  packDownlinkJson,
  type TurnWords,
  type VoiceDownlinkUnit,
  type VoiceFragment,
  voiceEscapedBytes,
} from '../../src/lib/voice-stream-downlink.ts';

const NONCE = 'AAAAAAAAAAAA';
const defined = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('expected a value');
  return value;
};
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const mustOk = <T>(result: VoiceResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const code = (result: VoiceResult<unknown>): string => (result.ok ? 'ok' : result.error.code);

/** A raw downlink unit: length prefix, then the bytes, then zeros. */
const raw = (body: Uint8Array, length = body.byteLength): Uint8Array => {
  const bytes = new Uint8Array(VOICE_DOWNLINK_UNIT_BYTES);
  new DataView(bytes.buffer).setUint16(0, length, false);
  bytes.set(body, 2);
  return bytes;
};
const rawJson = (value: unknown): Uint8Array => raw(utf8(JSON.stringify(value)));

const max = 4294967295;
const unit = (extra: Partial<VoiceDownlinkUnit> = {}): VoiceDownlinkUnit => ({
  nonce: NONCE,
  state: 'listening',
  ...extra,
});

describe('downlink unit: golden layout', () => {
  it('puts a big-endian length first, then compact JSON, then zeros', () => {
    const bytes = mustOk(encodeDownlinkUnit(unit()));
    const json = '{"n":"AAAAAAAAAAAA","s":"listening"}';
    should(bytes.byteLength).equal(1024);
    should([...bytes.subarray(0, 2)]).eql([0, json.length]);
    should(new TextDecoder().decode(bytes.subarray(2, 2 + json.length))).equal(json);
    should(bytes.subarray(2 + json.length).every(b => b === 0)).equal(true);
  });

  it('writes every member in the order the document fixes', () => {
    const bytes = mustOk(
      encodeDownlinkUnit(
        unit({
          state: 'counting',
          countdown: { turnId: 3, revision: 2, sendAt: 1_800_000_001_500, now: 1_800_000_000_000 },
          sent: { sendId: 's:3' },
          error: { code: 'engine_behind' },
          fragment: { turnId: 3, revision: 2, offset: 0, total: 2, text: 'hi' },
        }),
      ),
    );
    const length = new DataView(bytes.buffer).getUint16(0, false);
    should(new TextDecoder().decode(bytes.subarray(2, 2 + length))).equal(
      '{"n":"AAAAAAAAAAAA","s":"counting","c":{"t":3,"r":2,"at":1800000001500,"now":1800000000000},"d":"s:3","e":"engine_behind","f":{"t":3,"r":2,"o":0,"l":2,"x":"hi"}}',
    );
  });

  it('round-trips each optional member alone and together', () => {
    const variants: VoiceDownlinkUnit[] = [
      unit(),
      unit({ state: 'hearing' }),
      unit({ state: 'finishing' }),
      unit({ state: 'held' }),
      unit({ state: 'muted' }),
      unit({ countdown: { turnId: 0, revision: 0, sendAt: 0, now: 0 } }),
      unit({ sent: { sendId: 'a_B:c.d-9' } }),
      unit({ error: { code: 'engine_timeout' } }),
      unit({ fragment: { turnId: 1, revision: 1, offset: 0, total: 0, text: '' } }),
      unit({ fragment: { turnId: 1, revision: 1, offset: 0, total: 9, text: '日本語' } }),
    ];
    for (const variant of variants) {
      const bytes = mustOk(encodeDownlinkUnit(variant));
      should(bytes.byteLength).equal(VOICE_DOWNLINK_UNIT_BYTES);
      should(mustOk(decodeDownlinkUnit(bytes))).eql(variant);
    }
  });
});

describe('downlink unit: the worst case fits', () => {
  const worst = (text: string): VoiceDownlinkUnit => ({
    nonce: NONCE,
    state: 'listening',
    countdown: { turnId: max, revision: max, sendAt: Number.MAX_SAFE_INTEGER, now: Number.MAX_SAFE_INTEGER },
    sent: { sendId: 'x'.repeat(64) },
    error: { code: 'e'.repeat(32) },
    fragment: {
      turnId: max,
      revision: max,
      offset: VOICE_TURN_WORDS_MAX_BYTES,
      total: VOICE_TURN_WORDS_MAX_BYTES,
      text,
    },
  });

  it('holds every other member at its maximum plus a full fragment inside 1,022 bytes', () => {
    // Offset at the ceiling needs a zero-length remainder, so use the largest offset a full fragment can have.
    const text = 'a'.repeat(VOICE_FRAGMENT_TEXT_MAX_BYTES);
    const full = worst(text);
    const fragment = { ...defined(full.fragment), offset: VOICE_TURN_WORDS_MAX_BYTES - text.length };
    const bytes = mustOk(encodeDownlinkUnit({ ...full, fragment }));
    const length = new DataView(bytes.buffer).getUint16(0, false);
    should(length).be.belowOrEqual(VOICE_DOWNLINK_JSON_MAX_BYTES);
    // And the margin is real: the unit is not within a hair of the limit.
    should(VOICE_DOWNLINK_JSON_MAX_BYTES - length).be.aboveOrEqual(20);
  });

  it('holds the worst escaped text: a cap of control characters', () => {
    const escapedHeavy = '\u0001'.repeat(Math.floor(VOICE_FRAGMENT_TEXT_MAX_BYTES / 6));
    should(voiceEscapedBytes(escapedHeavy)).be.belowOrEqual(VOICE_FRAGMENT_TEXT_MAX_BYTES);
    const full = worst(escapedHeavy);
    const fragment = { ...defined(full.fragment), offset: 0 };
    should(code(encodeDownlinkUnit({ ...full, fragment }))).equal('ok');
  });

  it('never truncates: JSON over 1,022 bytes is unit_too_large, and exactly 1,022 is accepted', () => {
    const body = (size: number): string => '{"x":"'.padEnd(size - 2, 'y') + '"}';
    should(body(1022).length).equal(1022);
    should(code(packDownlinkJson(body(1022)))).equal('ok');
    should(code(packDownlinkJson(body(1023)))).equal('unit_too_large');
    // Bytes, not characters: 512 two-byte characters are 1,024 bytes.
    should(code(packDownlinkJson('é'.repeat(512)))).equal('unit_too_large');
    const packed = mustOk(packDownlinkJson(body(1022)));
    should(new DataView(packed.buffer).getUint16(0, false)).equal(1022);
    should(packed.byteLength).equal(1024);
  });
});

describe('downlink unit: encoder refusals', () => {
  it('refuses a unit that is not valid, without throwing', () => {
    const bad: VoiceDownlinkUnit[] = [
      unit({ nonce: 'short' }),
      { ...unit(), state: 'dancing' as never },
      unit({ countdown: { turnId: -1, revision: 0, sendAt: 0, now: 0 } }),
      unit({ countdown: { turnId: 0, revision: max + 1, sendAt: 0, now: 0 } }),
      unit({ countdown: { turnId: 0, revision: 0, sendAt: 1.5, now: 0 } }),
      unit({ sent: { sendId: '' } }),
      unit({ sent: { sendId: 'x'.repeat(65) } }),
      unit({ sent: { sendId: 'a b' } }),
      unit({ error: { code: 'Engine' } }),
      unit({ error: { code: 'e'.repeat(33) } }),
      unit({ error: { code: '' } }),
    ];
    for (const value of bad) should(code(encodeDownlinkUnit(value))).equal('unit_shape');
  });

  it('refuses an inconsistent or over-sized fragment with the fragment code', () => {
    const base = { turnId: 1, revision: 1, offset: 0, total: 10, text: 'abc' };
    should(code(encodeDownlinkUnit(unit({ fragment: { ...base, total: 16385 } })))).equal('fragment_total');
    should(code(encodeDownlinkUnit(unit({ fragment: { ...base, text: '\ud800' } })))).equal('fragment_text');
    should(code(encodeDownlinkUnit(unit({ fragment: { ...base, offset: 8 } })))).equal('fragment_inconsistent');
    should(code(encodeDownlinkUnit(unit({ fragment: { ...base, text: '' } })))).equal('fragment_inconsistent');
    should(
      code(
        encodeDownlinkUnit(
          unit({ fragment: { ...base, total: 5000, text: 'a'.repeat(VOICE_FRAGMENT_TEXT_MAX_BYTES + 1) } }),
        ),
      ),
    ).equal('fragment_inconsistent');
  });
});

describe('downlink unit: decoder refusals', () => {
  it('refuses any size but 1,024', () => {
    for (const size of [0, 1, 1023, 1025, 2048])
      should(code(decodeDownlinkUnit(new Uint8Array(size)))).equal('unit_size');
  });

  it('refuses a zero length or one past the unit', () => {
    should(code(decodeDownlinkUnit(new Uint8Array(1024)))).equal('unit_length');
    should(code(decodeDownlinkUnit(raw(new Uint8Array(0), 1023)))).equal('unit_length');
    should(code(decodeDownlinkUnit(raw(new Uint8Array(0), 1022)))).equal('unit_encoding');
    should(code(decodeDownlinkUnit(raw(new Uint8Array(0), 65535)))).equal('unit_length');
  });

  it('refuses non-zero padding', () => {
    const bytes = mustOk(encodeDownlinkUnit(unit()));
    for (const at of [60, 500, 1023]) {
      const copy = Uint8Array.from(bytes);
      copy[at] = 1;
      should(code(decodeDownlinkUnit(copy))).equal('unit_padding');
    }
  });

  it('refuses a body that is not UTF-8 or not JSON', () => {
    should(code(decodeDownlinkUnit(raw(Uint8Array.from([0xff, 0xfe]))))).equal('unit_encoding');
    should(code(decodeDownlinkUnit(raw(utf8('{"n":'))))).equal('unit_encoding');
  });

  it('refuses a body of the wrong shape', () => {
    const shapes: unknown[] = [
      {},
      [],
      null,
      { n: NONCE },
      { s: 'listening' },
      { n: NONCE, s: 'listening', extra: 1 },
      { n: 'short', s: 'listening' },
      { n: NONCE, s: 'asleep' },
      { n: NONCE, s: 'listening', c: { t: 1, r: 1, at: 1 } },
      { n: NONCE, s: 'listening', c: { t: 1, r: 1, at: 1, now: 1, extra: 1 } },
      { n: NONCE, s: 'listening', f: { t: 1, r: 1, o: 0, l: 1 } },
      { n: NONCE, s: 'listening', f: { t: 1, r: 1, o: -1, l: 1, x: 'a' } },
      { n: NONCE, s: 'listening', d: 5 },
    ];
    for (const shape of shapes) should(code(decodeDownlinkUnit(rawJson(shape)))).equal('unit_shape');
  });

  it('refuses an inconsistent fragment at decode, so a bad unit is fatal on arrival', () => {
    const f = (patch: object) =>
      rawJson({ n: NONCE, s: 'listening', f: { t: 1, r: 1, o: 0, l: 3, x: 'abc', ...patch } });
    should(code(decodeDownlinkUnit(f({})))).equal('ok');
    should(code(decodeDownlinkUnit(f({ l: 16385 })))).equal('fragment_total');
    should(code(decodeDownlinkUnit(f({ o: 1 })))).equal('fragment_inconsistent');
    should(code(decodeDownlinkUnit(f({ x: '' })))).equal('fragment_inconsistent');
    should(code(decodeDownlinkUnit(f({ x: '\ud800', l: 3 })))).equal('fragment_text');
  });

  it('decodes a unit that is a view into a larger buffer', () => {
    const whole = new Uint8Array(VOICE_DOWNLINK_UNIT_BYTES + 7);
    whole.set(mustOk(encodeDownlinkUnit(unit({ state: 'hearing' }))), 7);
    should(mustOk(decodeDownlinkUnit(whole.subarray(7))).state).equal('hearing');
  });
});

describe('every downlink unit is the same size whatever it holds', () => {
  it('seals to the same base64url length however the JSON varies', () => {
    const lengths = new Set<number>();
    for (const value of [
      unit(),
      unit({ fragment: { turnId: 1, revision: 1, offset: 0, total: 5, text: 'a"b\\c' } }),
      unit({ fragment: { turnId: 1, revision: 1, offset: 0, total: 3, text: '\u0001\u0002' } }),
    ])
      lengths.add(Buffer.from(mustOk(encodeDownlinkUnit(value))).toString('base64url').length);
    should([...lengths]).eql([1366]);
  });
});

describe('fragmenting a turn', () => {
  const frag = (text: string, turnId = 1, revision = 1): readonly VoiceFragment[] =>
    mustOk(fragmentTurnWords({ turnId, revision, text }));
  const join = (fragments: readonly VoiceFragment[]): string => fragments.map(f => f.text).join('');

  it('makes one empty fragment of empty text', () => {
    should(frag('')).eql([{ turnId: 1, revision: 1, offset: 0, total: 0, text: '' }]);
  });

  it('keeps short text whole', () => {
    should(frag('hello')).eql([{ turnId: 1, revision: 1, offset: 0, total: 5, text: 'hello' }]);
  });

  it('cuts at the cap exactly, with contiguous offsets and one total', () => {
    const text = 'x'.repeat(VOICE_FRAGMENT_TEXT_MAX_BYTES * 2 + 10);
    const fragments = frag(text);
    should(fragments.map(f => f.text.length)).eql([700, 700, 10]);
    should(fragments.map(f => f.offset)).eql([0, 700, 1400]);
    should(new Set(fragments.map(f => f.total))).eql(new Set([1410]));
    should(join(fragments)).equal(text);
    should(frag('y'.repeat(700)).length).equal(1);
    should(frag('y'.repeat(701)).length).equal(2);
  });

  it('counts a quote or a control character as its escaped bytes', () => {
    const quotes = '"'.repeat(400);
    const fragments = frag(quotes);
    should(fragments.map(f => f.text.length)).eql([350, 50]);
    for (const f of fragments) should(voiceEscapedBytes(f.text)).be.belowOrEqual(700);
    const controls = '\u0001'.repeat(200);
    const pieces = frag(controls);
    should(pieces.map(f => f.text.length)).eql([116, 84]);
    should(join(pieces)).equal(controls);
  });

  it('never splits a code point: emoji, CJK, and a boundary that lands inside one', () => {
    const emoji = '😀'.repeat(300); // 4 bytes each, 4 escaped bytes each: 175 per fragment.
    const pieces = frag(emoji);
    should(join(pieces)).equal(emoji);
    for (const piece of pieces) {
      should(Array.from(piece.text).length).equal(piece.text.length / 2);
      should(piece.text.isWellFormed()).equal(true);
    }
    should(pieces.map(f => f.offset)).eql([0, 700, 1400].slice(0, pieces.length));
    // CJK: 3 bytes each, 3 escaped each; 700 / 3 = 233 per fragment, leaving a one-byte gap each time.
    const cjk = '日本語'.repeat(200);
    const cjkPieces = frag(cjk);
    should(cjkPieces[0]?.text.length).equal(233);
    should(cjkPieces.map(f => new TextEncoder().encode(f.text).byteLength).slice(0, -1)).eql(
      cjkPieces.slice(0, -1).map(() => 699),
    );
    should(join(cjkPieces)).equal(cjk);
    for (const piece of cjkPieces)
      should(piece.offset).equal(
        new TextEncoder().encode(join(cjkPieces.slice(0, cjkPieces.indexOf(piece)))).byteLength,
      );
    // A mixed text with a 4-byte code point exactly on the cap edge.
    const edge = 'a'.repeat(698) + '😀' + 'b';
    const edgePieces = frag(edge);
    should(edgePieces.map(f => f.text)).eql(['a'.repeat(698), '😀b']);
    should(edgePieces[1]?.offset).equal(698);
  });

  it('accepts the ceiling and refuses a byte more', () => {
    should(join(frag('z'.repeat(VOICE_TURN_WORDS_MAX_BYTES)))).equal('z'.repeat(VOICE_TURN_WORDS_MAX_BYTES));
    should(frag('z'.repeat(VOICE_TURN_WORDS_MAX_BYTES)).length).equal(Math.ceil(VOICE_TURN_WORDS_MAX_BYTES / 700));
    should(code(fragmentTurnWords({ turnId: 1, revision: 1, text: 'z'.repeat(VOICE_TURN_WORDS_MAX_BYTES + 1) }))).equal(
      'fragment_total',
    );
    // Bytes, not characters: 5,462 three-byte characters are 16,386 bytes.
    should(code(fragmentTurnWords({ turnId: 1, revision: 1, text: '日'.repeat(5462) }))).equal('fragment_total');
    should(code(fragmentTurnWords({ turnId: 1, revision: 1, text: '日'.repeat(5461) }))).equal('ok');
  });

  it('refuses text that is not well-formed and counters that do not fit', () => {
    should(code(fragmentTurnWords({ turnId: 1, revision: 1, text: 'a\ud800' }))).equal('fragment_text');
    should(code(fragmentTurnWords({ turnId: -1, revision: 1, text: 'a' }))).equal('fragment_inconsistent');
    should(code(fragmentTurnWords({ turnId: 1, revision: 2 ** 32, text: 'a' }))).equal('fragment_inconsistent');
    should(code(fragmentTurnWords({ turnId: 1.5, revision: 1, text: 'a' }))).equal('fragment_inconsistent');
  });

  it('makes fragments every one of which encodes into a unit and reassembles to the text', () => {
    const text = 'Let me check the README — 日本語の説明 😀 "quoted" \\ back\n'.repeat(60);
    let words: TurnWords | undefined;
    for (const fragment of frag(text, 9, 4)) {
      const decoded = mustOk(decodeDownlinkUnit(mustOk(encodeDownlinkUnit(unit({ fragment })))));
      words = mustOk(applyVoiceFragment(words, defined(decoded.fragment)));
    }
    should(words?.complete).equal(true);
    should(words?.text).equal(text);
  });
});

describe('reassembling a turn', () => {
  const fragment = (patch: Partial<VoiceFragment> = {}): VoiceFragment => ({
    turnId: 1,
    revision: 1,
    offset: 0,
    total: 6,
    text: 'abc',
    ...patch,
  });
  const second = fragment({ offset: 3, text: 'def' });

  it('is whole only when every byte has arrived', () => {
    const half = mustOk(applyVoiceFragment(undefined, fragment()));
    should(half).eql({ turnId: 1, revision: 1, total: 6, received: 3, text: 'abc', complete: false });
    const whole = mustOk(applyVoiceFragment(half, second));
    should(whole).eql({ turnId: 1, revision: 1, total: 6, received: 6, text: 'abcdef', complete: true });
  });

  it('counts UTF-8 bytes, not characters', () => {
    const first = mustOk(applyVoiceFragment(undefined, fragment({ total: 9, text: '日本' })));
    should(first.received).equal(6);
    should(first.complete).equal(false);
    should(mustOk(applyVoiceFragment(first, fragment({ total: 9, offset: 6, text: '語' }))).complete).equal(true);
  });

  it('treats an empty revision as whole at once', () => {
    const words = mustOk(applyVoiceFragment(undefined, fragment({ total: 0, text: '' })));
    should(words.complete).equal(true);
    should(words.text).equal('');
  });

  it('drops the older revision when a newer one starts at offset zero', () => {
    const old = mustOk(applyVoiceFragment(undefined, fragment()));
    const newer = mustOk(applyVoiceFragment(old, fragment({ revision: 2, total: 3 })));
    should(newer).eql({ turnId: 1, revision: 2, total: 3, received: 3, text: 'abc', complete: true });
    // The old revision's remainder is now stale.
    should(code(applyVoiceFragment(newer, second))).equal('fragment_inconsistent');
  });

  it('drops the older turn when a newer turn starts', () => {
    const old = mustOk(applyVoiceFragment(undefined, fragment({ turnId: 2, revision: 5 })));
    const next = mustOk(applyVoiceFragment(old, fragment({ turnId: 3, revision: 1 })));
    should(next.turnId).equal(3);
    should(next.revision).equal(1);
  });

  it('refuses a newer revision that does not start at offset zero', () => {
    const old = mustOk(applyVoiceFragment(undefined, fragment()));
    should(code(applyVoiceFragment(old, fragment({ revision: 2, offset: 3, text: 'def' })))).equal(
      'fragment_inconsistent',
    );
    should(code(applyVoiceFragment(undefined, second))).equal('fragment_inconsistent');
  });

  it('refuses a stale turn or revision', () => {
    const current = mustOk(applyVoiceFragment(undefined, fragment({ turnId: 5, revision: 3 })));
    should(code(applyVoiceFragment(current, fragment({ turnId: 4, revision: 9 })))).equal('fragment_inconsistent');
    should(code(applyVoiceFragment(current, fragment({ turnId: 5, revision: 2 })))).equal('fragment_inconsistent');
  });

  it('refuses a gap, a repeat, an overlap and a changed total', () => {
    const half = mustOk(applyVoiceFragment(undefined, fragment()));
    should(code(applyVoiceFragment(half, fragment({ offset: 4, text: 'ef' })))).equal('fragment_inconsistent');
    should(code(applyVoiceFragment(half, fragment()))).equal('fragment_inconsistent');
    should(code(applyVoiceFragment(half, fragment({ offset: 2, text: 'cde' })))).equal('fragment_inconsistent');
    should(code(applyVoiceFragment(half, fragment({ offset: 3, total: 7, text: 'def' })))).equal(
      'fragment_inconsistent',
    );
  });

  it('refuses a fragment of a revision that is already whole', () => {
    const whole = mustOk(applyVoiceFragment(mustOk(applyVoiceFragment(undefined, fragment())), second));
    should(code(applyVoiceFragment(whole, second))).equal('fragment_inconsistent');
    should(code(applyVoiceFragment(whole, fragment()))).equal('fragment_inconsistent');
  });

  it('refuses a total over 16 KB, a run past the total, and an empty piece of a non-empty total', () => {
    should(code(applyVoiceFragment(undefined, fragment({ total: 16385 })))).equal('fragment_total');
    should(code(applyVoiceFragment(undefined, fragment({ total: 2 })))).equal('fragment_inconsistent');
    should(code(applyVoiceFragment(undefined, fragment({ text: '' })))).equal('fragment_inconsistent');
    should(code(applyVoiceFragment(undefined, fragment({ text: 'a\ud800', total: 4 })))).equal('fragment_text');
  });

  it('checks a fragment alone', () => {
    should(code(checkVoiceFragment(fragment()))).equal('ok');
    should(code(checkVoiceFragment(fragment({ total: 3 })))).equal('ok');
    should(code(checkVoiceFragment(fragment({ total: 2 })))).equal('fragment_inconsistent');
  });
});
