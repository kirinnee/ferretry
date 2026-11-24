import { describe, expect, test } from 'bun:test';
import {
  DOWNLINK_UNIT_BYTES,
  REPLY_AUDIO_SAMPLES,
  REPLY_DOWNLINK_UNIT_BYTES,
  SPEAK_FRAME_BYTES,
  StreamProtocolError,
  StreamStartSchema,
  decodeReplyDownlinkUnit,
  decodeSpeakFrame,
  encodeReplyDownlinkUnit,
  encodeSpeakFrame,
  fitSpeakText,
  type StreamSnapshot,
} from '../../../contract/index.ts';

const base: StreamSnapshot = { v: 1, state: 'listening', nonce: '0123456789abcdef', turn: 0 };
const bytesOf = (text: string): number => new TextEncoder().encode(text).byteLength;

describe('the reply voice downlink unit', () => {
  test('is always the snapshot slot plus 200 ms of audio, whatever it carries', () => {
    expect(REPLY_AUDIO_SAMPLES).toBe(3_200);
    expect(REPLY_DOWNLINK_UNIT_BYTES).toBe(DOWNLINK_UNIT_BYTES + 6_400);
    const quiet = encodeReplyDownlinkUnit({ ...base, reply: 'loading' }, new Int16Array(0));
    const pcm = Int16Array.from({ length: 1_000 }, (_, index) => (index % 2 === 0 ? 32767 : -32768));
    const speaking = encodeReplyDownlinkUnit(
      { ...base, reply: 'ready', audio: { id: 4, samples: 1_000, last: true } },
      pcm,
    );
    expect(quiet.byteLength).toBe(REPLY_DOWNLINK_UNIT_BYTES);
    expect(speaking.byteLength).toBe(REPLY_DOWNLINK_UNIT_BYTES);
    const decoded = decodeReplyDownlinkUnit(speaking);
    expect(decoded.snapshot).toMatchObject({ reply: 'ready', audio: { id: 4, samples: 1_000, last: true } });
    expect(decoded.pcm).toEqual(pcm);
    expect(decodeReplyDownlinkUnit(quiet).pcm).toHaveLength(0);
  });

  test('a full slot, a failed line and an empty line end all round-trip', () => {
    const full = Int16Array.from({ length: REPLY_AUDIO_SAMPLES }, (_, index) => index - 1_600);
    const unit = encodeReplyDownlinkUnit(
      { ...base, audio: { id: 0, samples: REPLY_AUDIO_SAMPLES, last: false } },
      full,
    );
    expect(decodeReplyDownlinkUnit(unit).pcm).toEqual(full);
    const failed = encodeReplyDownlinkUnit(
      { ...base, audio: { id: 2, samples: 0, last: true, failed: 'reply_voice_failed' } },
      new Int16Array(0),
    );
    expect(decodeReplyDownlinkUnit(failed).snapshot.audio).toEqual({
      id: 2,
      samples: 0,
      last: true,
      failed: 'reply_voice_failed',
    });
  });

  test('a snapshot and its audio that disagree, a wrong size, or a dirty slot are refused', () => {
    expect(() =>
      encodeReplyDownlinkUnit({ ...base, audio: { id: 0, samples: 10, last: false } }, new Int16Array(9)),
    ).toThrow(StreamProtocolError);
    expect(() => encodeReplyDownlinkUnit(base, new Int16Array(1))).toThrow(StreamProtocolError);
    const good = encodeReplyDownlinkUnit({ ...base, audio: { id: 0, samples: 10, last: false } }, new Int16Array(10));
    expect(() => decodeReplyDownlinkUnit(good.slice(1))).toThrow(StreamProtocolError);
    const dirty = good.slice();
    dirty[REPLY_DOWNLINK_UNIT_BYTES - 1] = 1;
    expect(() => decodeReplyDownlinkUnit(dirty)).toThrow(StreamProtocolError);
    // More samples than a slot holds is not a snapshot at all.
    expect(() =>
      encodeReplyDownlinkUnit(
        { ...base, audio: { id: 0, samples: REPLY_AUDIO_SAMPLES + 1, last: false } },
        new Int16Array(REPLY_AUDIO_SAMPLES + 1),
      ),
    ).toThrow();
  });
});

describe('the speak frame', () => {
  test('is exactly 1,024 bytes of JSON whatever it says, and reads back as the plain record it is', () => {
    const short = encodeSpeakFrame({ t: 'speak', id: 0, text: 'Hi.' });
    const long = encodeSpeakFrame({ t: 'speak', id: 7, text: 'Ünïcode ✓ and 日本語 and "quotes"' });
    expect(bytesOf(short)).toBe(SPEAK_FRAME_BYTES);
    expect(bytesOf(long)).toBe(SPEAK_FRAME_BYTES);
    expect(JSON.parse(short)).toEqual({ t: 'speak', id: 0, text: 'Hi.' });
    expect(decodeSpeakFrame(long)).toEqual({ t: 'speak', id: 7, text: 'Ünïcode ✓ and 日本語 and "quotes"' });
  });

  test('a line that does not fit, a wrong size, bad JSON and another shape are protocol errors', () => {
    expect(() => encodeSpeakFrame({ t: 'speak', id: 0, text: 'x'.repeat(2_000) })).toThrow(StreamProtocolError);
    expect(() => decodeSpeakFrame('{"t":"speak","id":0,"text":"hi"}')).toThrow(StreamProtocolError);
    expect(() => decodeSpeakFrame('x'.repeat(SPEAK_FRAME_BYTES))).toThrow(StreamProtocolError);
    const other = JSON.stringify({ t: 'shout', id: 0, text: 'hi' });
    expect(() => decodeSpeakFrame(other.padEnd(SPEAK_FRAME_BYTES))).toThrow(StreamProtocolError);
  });

  test('fitSpeakText leaves a short line whole and cuts a long one into pieces that each fit, at spaces', () => {
    expect(fitSpeakText('  Let me   check\nthe test. ')).toEqual(['Let me check the test.']);
    const sentence = 'word '.repeat(600).trim();
    const pieces = fitSpeakText(sentence);
    expect(pieces.length).toBeGreaterThan(2);
    for (const piece of pieces)
      expect(() => encodeSpeakFrame({ t: 'speak', id: 2_147_483_647, text: piece })).not.toThrow();
    expect(pieces.join(' ')).toBe(sentence);
    // Three-byte characters fit by bytes, not by characters.
    const wide = fitSpeakText('日本語'.repeat(400));
    expect(wide.length).toBeGreaterThan(1);
    expect(wide.join('')).toBe('日本語'.repeat(400));
    // A surrogate pair is never cut in half.
    const emoji = fitSpeakText('😀'.repeat(300));
    expect(emoji.join('')).toBe('😀'.repeat(300));
    for (const piece of emoji) expect([...piece].every(char => char === '😀')).toBe(true);
    expect(fitSpeakText('   ')).toEqual([]);
  });
});

describe('the start record', () => {
  test('may ask for the machine to speak the reply, and for nothing else', () => {
    expect(StreamStartSchema.parse({ t: 'start', v: 1, purpose: 'test', reply: 'machine' })).toMatchObject({
      reply: 'machine',
    });
    expect(
      StreamStartSchema.parse({ t: 'start', v: 1, purpose: 'chat', ferretId: 'f1', reply: 'machine' }),
    ).toMatchObject({
      reply: 'machine',
    });
    expect(StreamStartSchema.safeParse({ t: 'start', v: 1, purpose: 'test', reply: 'phone' }).success).toBe(false);
    expect(StreamStartSchema.parse({ t: 'start', v: 1, purpose: 'test' })).not.toHaveProperty('reply');
  });
});
