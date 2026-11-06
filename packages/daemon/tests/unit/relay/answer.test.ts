import { describe, it, spyOn } from 'bun:test';
import { MAX_PLAINTEXT_BYTES, utf8Text } from '@ferretry/relay';
import should from 'should';
import type { ApiResponse, PlainApiResponse } from '../../../src/lib/api/http.ts';
import { publishResponse } from '../../../src/lib/api/response-generation.ts';
import { tunnelAnswerRecords } from '../../../src/lib/relay/answer.ts';
import { encodeTunnelMessage, tunnelResponseMessages } from '../../../src/lib/relay/tunnel.ts';

const answer = (body = 'hello'): PlainApiResponse => ({ status: 200, headers: new Map(), body });

describe('a tunnel answer generation', () => {
  it('should encode the ordinary wire contract once, with no permit for a static answer', () => {
    // Arrange
    const input = answer('x'.repeat(MAX_PLAINTEXT_BYTES * 3));
    const expected = tunnelResponseMessages(7, input).map(encodeTunnelMessage);

    // Act
    const actual = tunnelAnswerRecords(7, input);

    // Assert
    should(actual.map(record => record.plaintext)).eql(expected);
    should(actual[0]?.part).be.undefined();
    should(actual.slice(1).every(record => record.part === true)).be.true();
    should(actual.every(record => record.permit === undefined)).be.true();
  });

  for (const count of [4, 12]) {
    it(`should do only linear encoding work for an unchanged ${String(count)}-part late answer`, () => {
      // Arrange — fresh response and header objects on every check, as the real dispatcher returns.
      const body = 'x'.repeat(MAX_PLAINTEXT_BYTES * count);
      let checks = 0;
      const input: ApiResponse = {
        ...answer(),
        late: () => {
          checks += 1;
          return answer(body);
        },
      };
      const encoder = spyOn(TextEncoder.prototype, 'encode');
      try {
        // Act — every part still checks its late source, just before leaving.
        const records = tunnelAnswerRecords(7, input);
        const permitted = records.map(record => record.permit?.());
        const calls = [...encoder.mock.calls];

        // Assert — one whole-body encode, one size calculation, and one encode per part, not N whole bodies.
        should(records.length).be.above(count);
        should(permitted.every(value => value === true)).be.true();
        should(checks).equal(records.length + 1);
        should(calls.length).equal(records.length + 3);
        should(calls.reduce((total, [text]) => total + (text?.length ?? 0), 0)).be.below(body.length * 4);
      } finally {
        encoder.mockRestore();
      }
    });
  }

  it('should encode a gzip body only once while rechecking all of its parts', () => {
    // Arrange
    const gzip = new Uint8Array(MAX_PLAINTEXT_BYTES * 3).fill(71);
    const current = publishResponse({ ...answer(), gzip });
    const input: ApiResponse = { ...answer(), late: () => current };
    const encoder = spyOn(TextEncoder.prototype, 'encode');
    try {
      // Act
      const records = tunnelAnswerRecords(3, input);
      const permitted = records.map(record => record.permit?.());

      // Assert
      should(permitted.every(value => value === true)).be.true();
      should(encoder.mock.calls.length).equal(records.length + 3);
    } finally {
      encoder.mockRestore();
    }
  });

  for (const size of [262_144, 786_432]) {
    it(`should read gzip bytes only during publication and rendering for ${String(size)} bytes`, () => {
      // Arrange — count copies, iteration AND numeric reads, including on every derived slice.
      // Counting encoder calls alone missed the old whole-gzip comparison in every permit.
      let work = 0;
      const counted = (bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> =>
        new Proxy(bytes, {
          get(target, key) {
            if (key === Symbol.iterator)
              return function* () {
                for (const byte of target) {
                  work += 1;
                  yield byte;
                }
              };
            if (typeof key === 'string' && /^\d+$/u.test(key)) work += 1;
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      const originalSlice = Uint8Array.prototype.slice;
      const copies = spyOn(Uint8Array.prototype, 'slice').mockImplementation(function (
        this: Uint8Array,
        start?: number,
        end?: number,
      ) {
        const result = originalSlice.call(this, start, end);
        work += result.byteLength;
        return counted(result);
      });
      try {
        const current = publishResponse({ ...answer(), gzip: counted(new Uint8Array(size).fill(71)) });
        let checks = 0;
        const records = tunnelAnswerRecords(3, {
          ...answer(),
          late: () => {
            checks += 1;
            return current;
          },
        });
        const renderedWork = work;

        // Act
        const permitted = records.map(record => record.permit?.());

        // Assert — O(size) total byte work and zero further byte reads across all N permits.
        should(records.length).be.above(5);
        should(permitted.every(value => value === true)).be.true();
        should(checks).equal(records.length + 1);
        should(renderedWork).be.aboveOrEqual(size);
        should(work).be.belowOrEqual(size * 6);
        should(work).equal(renderedWork);
      } finally {
        copies.mockRestore();
      }
    });
  }

  it('should still permit an unchanged prefix but stop the later part that changed between seals', () => {
    // Arrange
    const prefix = 'x'.repeat(MAX_PLAINTEXT_BYTES * 2);
    let current: PlainApiResponse = answer(`${prefix}before`);
    const records = tunnelAnswerRecords(1, { ...current, late: () => current });

    // Act
    should(records[0]?.permit?.()).be.true();
    current = answer(`${prefix}after!`);

    // Assert — the first two records are byte-identical; the final one must not leave.
    should(records[1]?.permit?.()).be.true();
    should(records.at(-1)?.permit?.()).be.false();
  });

  it('should refuse parts missing from a shorter new answer, including one behind a credit wait', () => {
    // Arrange
    let current: PlainApiResponse = answer('x'.repeat(MAX_PLAINTEXT_BYTES * 2));
    const records = tunnelAnswerRecords(1, { ...current, late: () => current });

    // Act
    current = answer('held');

    // Assert
    should(records[0]?.permit?.()).be.false();
    should(records[1]?.permit?.()).be.false();
  });

  it('should observe status changes and header edits, including in-place edits and order', () => {
    // Arrange
    for (const change of ['status', 'header-count', 'header-value', 'header-order'] as const) {
      const headers = new Map([
        ['one', '1'],
        ['two', '2'],
      ]);
      let current: PlainApiResponse = { ...answer(), headers };
      const records = tunnelAnswerRecords(1, { ...current, late: () => current });

      // Act
      if (change === 'status') current = { ...current, status: 403 };
      else if (change === 'header-count') headers.set('three', '3');
      else if (change === 'header-value') headers.set('one', 'different');
      else {
        headers.delete('one');
        headers.set('one', '1');
      }

      // Assert
      should(records[0]?.permit?.()).be.false();
    }
  });

  it('should observe gzip changes, including a mutable array, and switching compression on or off', () => {
    // Arrange
    for (const change of ['bytes', 'length', 'plain', 'gzip'] as const) {
      const gzip = Uint8Array.of(1, 2, 3);
      let source: ApiResponse = change === 'gzip' ? answer() : { ...answer(), gzip };
      let current = publishResponse(source);
      const records = tunnelAnswerRecords(1, { ...current, late: () => current });

      // Act
      if (change === 'bytes') gzip[1] = 8;
      else if (change === 'length') source = { ...source, gzip: Uint8Array.of(1) };
      else if (change === 'plain') source = answer();
      else source = { ...source, gzip };
      current = publishResponse(source);

      // Assert
      should(records[0]?.permit?.()).be.false();
    }
  });

  it('should compare the compressed wire bytes even when the plain body changed', () => {
    // Arrange
    let current = publishResponse({ ...answer(), gzip: Uint8Array.of(1, 2, 3) });
    const records = tunnelAnswerRecords(1, { ...current, late: () => current });

    // Act
    current = publishResponse({ ...answer('different'), gzip: Uint8Array.of(1, 2, 3) });

    // Assert
    should(records[0]?.permit?.()).be.true();
    should(utf8Text(records[0]?.plaintext ?? new Uint8Array())).containEql('base64url');
  });

  it('should fail closed when the late source throws after the initial rendering', () => {
    // Arrange
    let fails = false;
    const records = tunnelAnswerRecords(1, {
      ...answer(),
      late: () => {
        if (fails) throw new Error('the source is gone');
        return answer();
      },
    });

    // Act
    fails = true;

    // Assert
    should(records[0]?.permit?.()).be.false();
  });
});
