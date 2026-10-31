import { describe, expect, it } from 'bun:test';
import { CANONICAL_JSON_MAX_DEPTH, canonicalJson } from '../../src/lib/canonical-json.ts';

const text = (value: unknown): string => {
  const result = canonicalJson(value);
  if (!result.ok) throw new Error(result.reason);
  return result.text;
};

/** An IEEE 754 double from its 64-bit pattern, as RFC 8785 Appendix B lists them. */
const double = (hex: string): number => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
};

describe('canonicalJson (RFC 8785)', () => {
  it('writes the example of §3.2.2 exactly', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    );
    expect(text(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts keys by UTF-16 code units, as §3.2.3 does', () => {
    const input = JSON.parse(
      '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}',
    );
    const written = [...text(input).matchAll(/"((?:[^"\\]|\\.)*)":/gu)].map(
      match => JSON.parse(`"${match[1]}"`) as string,
    );
    expect(written).toEqual(['\r', '1', '\u0080', 'ö', '€', '\u{1F600}', 'דּ']);
  });

  it('writes every number of Appendix B as the scheme says', () => {
    const vectors: readonly (readonly [string, string])[] = [
      ['0000000000000000', '0'],
      ['8000000000000000', '0'],
      ['0000000000000001', '5e-324'],
      ['8000000000000001', '-5e-324'],
      ['7fefffffffffffff', '1.7976931348623157e+308'],
      ['ffefffffffffffff', '-1.7976931348623157e+308'],
      ['4340000000000000', '9007199254740992'],
      ['c340000000000000', '-9007199254740992'],
      ['4430000000000000', '295147905179352830000'],
      ['44b52d02c7e14af5', '9.999999999999997e+22'],
      ['44b52d02c7e14af6', '1e+23'],
      ['44b52d02c7e14af7', '1.0000000000000001e+23'],
      ['444b1ae4d6e2ef4e', '999999999999999700000'],
      ['444b1ae4d6e2ef4f', '999999999999999900000'],
      ['444b1ae4d6e2ef50', '1e+21'],
      ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
      ['3eb0c6f7a0b5ed8d', '0.000001'],
      ['41b3de4355555553', '333333333.3333332'],
      ['41b3de4355555554', '333333333.33333325'],
      ['41b3de4355555555', '333333333.3333333'],
      ['41b3de4355555556', '333333333.3333334'],
      ['41b3de4355555557', '333333333.33333343'],
      ['becbf647612f3696', '-0.0000033333333333333333'],
      ['43143ff3c1cb0959', '1424953923781206.2'],
    ];
    for (const [bits, expected] of vectors) expect(`${bits} ${text(double(bits))}`).toBe(`${bits} ${expected}`);
  });

  it('refuses NaN and infinity, which have no JSON spelling (Appendix B)', () => {
    for (const bits of ['7fffffffffffffff', '7ff0000000000000', 'fff0000000000000']) {
      expect(canonicalJson({ n: double(bits) }).ok).toBe(false);
    }
  });

  it('refuses a lone surrogate in a value or a key, and keeps a pair', () => {
    expect(canonicalJson({ a: '\ud800' }).ok).toBe(false);
    expect(canonicalJson({ '\udc00': 1 }).ok).toBe(false);
    expect(text({ a: '😀' })).toBe('{"a":"😀"}');
  });

  it('writes no whitespace, and leaves non-ASCII and U+2028 unescaped', () => {
    expect(text({ b: [1, { d: 'é ' }], a: true })).toBe('{"a":true,"b":[1,{"d":"é "}]}');
  });

  it('leaves out a property whose value is undefined, as an absent optional field', () => {
    expect(text({ a: 1, b: undefined })).toBe(text({ a: 1 }));
  });

  it('refuses what is not JSON at all', () => {
    for (const value of [undefined, [undefined], 1n, () => 1, new Date(0), new Map(), Symbol('x')]) {
      expect(canonicalJson(value).ok).toBe(false);
    }
  });

  it('is total on a document too deep to walk', () => {
    let deep: unknown = 1;
    for (let depth = 0; depth <= CANONICAL_JSON_MAX_DEPTH + 1; depth += 1) deep = [deep];
    const result = canonicalJson(deep);
    expect(result.ok).toBe(false);
    let fine: unknown = 1;
    for (let depth = 0; depth < CANONICAL_JSON_MAX_DEPTH; depth += 1) fine = [fine];
    expect(canonicalJson(fine).ok).toBe(true);
  });

  it('gives one spelling to one meaning', () => {
    expect(text(JSON.parse('{"b":1.0,"a":"\\u00e9"}'))).toBe(text({ a: 'é', b: 1 }));
  });
});

describe('canonicalJson and failures that are not about JSON', () => {
  it('lets an error it did not raise through, rather than calling it a JSON problem', () => {
    const hostile = {
      get boom(): never {
        throw new Error('a getter threw');
      },
    };
    expect(() => canonicalJson(hostile)).toThrow('a getter threw');
  });
});
