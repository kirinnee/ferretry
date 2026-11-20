import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import should from 'should';
import * as voice from '../../src/lib/voice-stream.ts';
import {
  encodeVoiceNonce,
  parseVoiceStreamStart,
  VOICE_START_RECORD_MAX_BYTES,
  voiceIsWellFormed,
} from '../../src/lib/voice-stream.ts';

const doc = readFileSync(new URL('../../../../docs/voice-stream.md', import.meta.url), 'utf8');

describe('voice stream constants and the document that owns the wire', () => {
  const table: (readonly [string, number])[] = [...doc.matchAll(/^\| `(VOICE_[A-Z_]+)`\s*\| (\d+)\s*\|/gm)].map(
    match => [String(match[1]), Number(match[2])] as const,
  );
  const exports: Record<string, unknown> = { ...voice };

  it('lists every numeric constant the module exports, with the same value', () => {
    const exported = Object.entries(exports).filter(
      (entry): entry is [string, number] => entry[0].startsWith('VOICE_') && typeof entry[1] === 'number',
    );
    should(table.map(([name]) => name).sort()).eql(exported.map(([name]) => name).sort());
    for (const [name, value] of table) should(exports[name]).equal(value);
  });

  it('keeps the arithmetic the sizes depend on', () => {
    should(voice.VOICE_UPLINK_PCM_BYTES).equal(voice.VOICE_UPLINK_PCM_SAMPLES * 2);
    should(voice.VOICE_UPLINK_UNIT_BYTES).equal(voice.VOICE_UPLINK_PCM_BYTES + voice.VOICE_UPLINK_SLOT_BYTES);
    should(voice.VOICE_UPLINK_SLOT_JSON_MAX_BYTES).equal(voice.VOICE_UPLINK_SLOT_BYTES - 1);
    should(voice.VOICE_DOWNLINK_JSON_MAX_BYTES).equal(
      voice.VOICE_DOWNLINK_UNIT_BYTES - voice.VOICE_DOWNLINK_LENGTH_BYTES,
    );
    should(voice.VOICE_UPLINK_UNITS_PER_SECOND * voice.VOICE_UPLINK_UNIT_INTERVAL_MS).equal(1000);
    should(voice.VOICE_RATE_MAX_UNITS).equal(
      Math.floor(voice.VOICE_UPLINK_UNITS_PER_SECOND * 1.25 * (voice.VOICE_RATE_WINDOW_MS / 1000)),
    );
    should(voice.VOICE_NONCE_CHARS).equal((voice.VOICE_NONCE_RANDOM_BYTES * 4) / 3);
  });
});

describe('the start record', () => {
  const start = { purpose: 'voice-chat', sessionId: 'fy_abc', style: 'after-stop' };

  it('accepts exactly the three members', () => {
    const parsed = parseVoiceStreamStart(JSON.stringify(start));
    should(parsed).eql({ ok: true, value: start });
    for (const purpose of ['dictation', 'voice-chat'])
      for (const style of ['after-stop', 'real-time'])
        should(parseVoiceStreamStart(JSON.stringify({ ...start, purpose, style })).ok).equal(true);
  });

  it('refuses everything else as start_invalid', () => {
    const bad = [
      '',
      'not json',
      'null',
      '[]',
      JSON.stringify({ ...start, extra: 1 }),
      JSON.stringify({ purpose: 'dictation', sessionId: 'x' }),
      JSON.stringify({ ...start, purpose: 'chat' }),
      JSON.stringify({ ...start, style: 'live' }),
      JSON.stringify({ ...start, sessionId: '' }),
      JSON.stringify({ ...start, sessionId: 'x'.repeat(129) }),
      JSON.stringify({ ...start, sessionId: 7 }),
    ];
    for (const text of bad) {
      const parsed = parseVoiceStreamStart(text);
      should(parsed.ok).equal(false);
      if (!parsed.ok) should(parsed.error.code).equal('start_invalid');
    }
    should(parseVoiceStreamStart(JSON.stringify({ ...start, sessionId: 'x'.repeat(128) })).ok).equal(true);
  });

  it('refuses a record over its byte limit before parsing it', () => {
    const padded = ' '.repeat(VOICE_START_RECORD_MAX_BYTES) + JSON.stringify(start);
    should(parseVoiceStreamStart(padded).ok).equal(false);
    // Bytes, not characters: a 4-byte emoji costs four.
    const emoji = JSON.stringify({ ...start, sessionId: '😀'.repeat(50) });
    should(parseVoiceStreamStart(emoji).ok).equal(true);
    const wide = ' '.repeat(VOICE_START_RECORD_MAX_BYTES - JSON.stringify(start).length) + JSON.stringify(start);
    should(parseVoiceStreamStart(wide).ok).equal(true);
    should(parseVoiceStreamStart(' ' + wide).ok).equal(false);
  });
});

describe('nonces', () => {
  it('makes 12 base64url characters from 9 bytes, deterministically', () => {
    should(encodeVoiceNonce(new Uint8Array(9))).equal('AAAAAAAAAAAA');
    should(encodeVoiceNonce(new Uint8Array(9).fill(0xff))).equal('____________');
    should(encodeVoiceNonce(Uint8Array.from([0xfb, 0xef, 0xbe, 0, 0, 0, 0xff, 0xff, 0xff]))).equal('----AAAA____');
    should(encodeVoiceNonce(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))).equal('AQIDBAUGBwgJ');
  });

  it('refuses other lengths', () => {
    should(encodeVoiceNonce(new Uint8Array(8))).equal(undefined);
    should(encodeVoiceNonce(new Uint8Array(10))).equal(undefined);
  });
});

describe('small helpers', () => {
  it('knows a lone surrogate from a pair', () => {
    should(voiceIsWellFormed('plain 😀 日本語')).equal(true);
    should(voiceIsWellFormed('\ud800')).equal(false);
    should(voiceIsWellFormed('\udc00x')).equal(false);
    should(voiceIsWellFormed('a\ud83d')).equal(false);
    should(voiceIsWellFormed('\ud83dx')).equal(false);
  });
});
