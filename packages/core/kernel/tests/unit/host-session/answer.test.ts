import { describe, expect, test } from 'bun:test';
import { type ApiResponse, jsonResponse } from '../../../contract/http.ts';
import { publishResponse } from '../../../host/responses.ts';
import { answerRecords } from '../../../host/session/wire/answer.ts';
import { MAX_PLAINTEXT_BYTES } from '../../../host/session/wire/constants.ts';

// These are the reference answer.ts fixtures: plain sources own mutable maps; only a nominal publication is immutable.
describe('the after-seal answer check', () => {
  test('R515 an unchanged nominal publication keeps a final permit on every part', () => {
    const current = publishResponse(jsonResponse({ text: 'x'.repeat(MAX_PLAINTEXT_BYTES * 2) }));
    const answer: ApiResponse = { ...current, late: () => current };
    const records = answerRecords(1, answer);
    expect(records.length).toBeGreaterThan(1);
    for (const record of records) {
      expect(record.permit?.()).toBe(true);
      expect(record.permit?.()).toBe(true);
    }
  });

  test('R516 a shared plain header map changed between seal and pull refuses the original ciphertext', async () => {
    const headers = new Map([['x-fixture', 'before']]);
    const shared = { status: 200, headers, body: 'fixture-content' };
    const records = answerRecords(1, { ...shared, late: () => shared });
    await Promise.resolve();
    headers.set('x-fixture', 'after');
    expect(records[0]?.permit?.()).toBe(false);
    headers.set('x-fixture', 'before');
    expect(records[0]?.permit?.()).toBe(true);
  });

  test('R517 plain late answers compare status, ordered headers and body rather than identity', () => {
    const shared = {
      status: 200,
      headers: new Map([
        ['a', '1'],
        ['b', '2'],
      ]),
      body: 'before',
    };
    const records = answerRecords(1, { ...shared, late: () => shared });
    shared.status = 409;
    expect(records[0]?.permit?.()).toBe(false);
    shared.status = 200;
    shared.body = 'after';
    expect(records[0]?.permit?.()).toBe(false);
    shared.body = 'before';
    shared.headers.delete('a');
    shared.headers.set('a', '1');
    expect(records[0]?.permit?.()).toBe(false);
  });

  test('R516 R517 an unchanged plain answer and a fresh equal answer still pass, and a throwing source fails closed', () => {
    let fail = false;
    const shared = jsonResponse({ value: 1 });
    const records = answerRecords(1, {
      ...shared,
      late: () => {
        if (fail) throw new Error('unavailable');
        return { ...shared, headers: new Map(shared.headers) };
      },
    });
    expect(records[0]?.permit?.()).toBe(true);
    fail = true;
    expect(records[0]?.permit?.()).toBe(false);
  });
});
