import { describe, expect, test } from 'bun:test';
import { bytesResponse } from '../../../contract/http.ts';
import { toResponse } from '../../../host/listener.ts';
import { answerRecords } from '../../../host/session/wire/answer.ts';
import { fromBase64Url } from '../../../host/session/wire/binary.ts';
import { MAX_PLAINTEXT_BYTES } from '../../../host/session/wire/constants.ts';
import { publishResponse } from '../../../host/responses.ts';

/** A served file (`ApiResponse.bytes`) on the two carriers: raw on HTTP, base64url on the session wire. */

/** `size` bytes covering every byte value, so a text round trip would corrupt them. */
const every = (size: number): Uint8Array => Uint8Array.from({ length: size }, (_unused, at) => at % 256);

const bodiesOf = (records: ReturnType<typeof answerRecords>): { head: Record<string, unknown>; body: string } => {
  const decoded = records.map(
    record => JSON.parse(new TextDecoder().decode(record.plaintext)) as Record<string, unknown>,
  );
  return { body: decoded.map(part => String(part.body)).join(''), head: decoded[0] ?? {} };
};

describe('a binary answer on the session wire', () => {
  test('travels as unpadded base64url under content-transfer-encoding alone, and reads back byte for byte', () => {
    const bytes = every(1_000);
    const { head, body } = bodiesOf(
      answerRecords(1, bytesResponse(bytes, 'video/mp4', 206, { 'content-range': 'bytes 0-999/5000' })),
    );

    expect(head.status).toBe(206);
    const headers = head.headers as Record<string, string>;
    expect(headers['content-transfer-encoding']).toBe('base64url');
    expect(headers['content-encoding']).toBeUndefined();
    expect(headers['content-type']).toBe('video/mp4');
    expect(headers['content-range']).toBe('bytes 0-999/5000');
    expect([...(fromBase64Url(body) ?? [])]).toEqual([...bytes]);
  });

  test('is cut into ordered parts when it does not fit one record, and the parts join back to the bytes', () => {
    const bytes = every(MAX_PLAINTEXT_BYTES * 2);
    const records = answerRecords(1, bytesResponse(bytes, 'audio/mpeg'));

    expect(records.length).toBeGreaterThan(1);
    expect([...(fromBase64Url(bodiesOf(records).body) ?? [])]).toEqual([...bytes]);
  });

  test('is refused with a 502 naming the size when it is more than one session carries, never cut short', () => {
    const records = answerRecords(1, bytesResponse(new Uint8Array(25 * 1024 * 1024), 'video/mp4'));
    const { head, body } = bodiesOf(records);

    expect(head.status).toBe(502);
    expect(body).toContain('answer_too_large');
  });

  test('is a plain answer with no bytes unchanged: JSON stays text with no transfer header', () => {
    const { head, body } = bodiesOf(
      answerRecords(1, { body: '{"a":1}', headers: new Map([['content-type', 'application/json']]), status: 200 }),
    );

    expect((head.headers as Record<string, string>)['content-transfer-encoding']).toBeUndefined();
    expect(body).toBe('{"a":1}');
  });

  test('keeps its permit: bytes changed between the seal and the pull refuse the sealed record', () => {
    const shared = bytesResponse(every(64), 'audio/wav');
    let current = shared;
    const records = answerRecords(1, { ...shared, late: () => current });
    expect(records[0]?.permit?.()).toBe(true);

    current = { ...shared, bytes: every(64).map(value => value ^ 1) };
    expect(records[0]?.permit?.()).toBe(false);
  });

  test('survives publication as a copy no caller can edit', () => {
    const source = every(32);
    const published = publishResponse(bytesResponse(source, 'audio/ogg'));
    source[0] = 99;
    const first = published.bytes as Uint8Array;
    first[1] = 77;

    expect(published.bytes?.[0]).toBe(0);
    expect(published.bytes?.[1]).toBe(1);
  });
});

describe('a binary answer on HTTP', () => {
  test('is the raw bytes with the status and headers the route chose', async () => {
    const bytes = every(300);
    const response = toResponse(
      bytesResponse(bytes, 'audio/wav', 206, {
        'content-range': 'bytes 0-299/900',
        'x-content-type-options': 'nosniff',
      }),
      true,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(response.headers.get('content-range')).toBe('bytes 0-299/900');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...bytes]);
  });
});
