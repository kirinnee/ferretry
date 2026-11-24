import { describe, expect, test } from 'bun:test';
import { answerBody } from '../../../src/session/session-transport.ts';
import { toBase64Url } from '../../../src/session/wire/index.ts';

/** What the app makes of an answer's body: JSON, text, or the bytes of a file the daemon served. */

describe('an answer body', () => {
  test('is the bytes of a served file when the daemon sent them as base64url, byte for byte', () => {
    const bytes = Uint8Array.from({ length: 1000 }, (_unused, at) => at % 256);

    const body = answerBody(
      { 'content-transfer-encoding': 'base64url', 'content-type': 'video/mp4' },
      toBase64Url(bytes),
    );

    expect(body).toBeInstanceOf(Uint8Array);
    expect([...(body as Uint8Array)]).toEqual([...bytes]);
  });

  test('is an empty file as empty bytes, not as no body', () => {
    const body = answerBody({ 'content-transfer-encoding': 'base64url' }, '');

    expect(body).toBeInstanceOf(Uint8Array);
    expect((body as Uint8Array).byteLength).toBe(0);
  });

  test('is an error, never a made-up body, when the bytes are not valid unpadded base64url', () => {
    expect(() => answerBody({ 'content-transfer-encoding': 'base64url' }, 'not base64url!!')).toThrow(
      'not valid base64url',
    );
    expect(() => answerBody({ 'content-transfer-encoding': 'base64url' }, 'AAA=')).toThrow();
  });

  test('is the parsed JSON, or the text, for any answer without the transfer header', () => {
    expect(answerBody({ 'content-type': 'application/json' }, '{"a":1}')).toEqual({ a: 1 });
    expect(answerBody({}, 'plain words')).toBe('plain words');
    expect(answerBody({}, '')).toBeUndefined();
  });
});
