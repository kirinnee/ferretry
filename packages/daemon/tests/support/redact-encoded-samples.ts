import { createHash } from 'node:crypto';

/** Deterministic fake bytes, never credentials from the host. */
export function encodedSample(sample: number, length: number): string {
  const bytes = Buffer.alloc(length);
  for (let offset = 0; offset < length; offset += 32) {
    createHash('sha256').update(`v4-redaction-r4:${sample}:${offset}`).digest().copy(bytes, offset);
  }
  return bytes.toString('base64');
}

export const ENCODED_SHAPES = [
  ['vault key', 32],
  ['AWS-style 40-char', 30],
  ['48B', 48],
  ['64B padded', 64],
  ['148B ciphertext', 148],
  ['616B ciphertext', 616],
  ['2016B ciphertext', 2016],
] as const;

export const ENCODED_WRAPPERS = [
  ['bare', (value: string) => value],
  ['X=', (value: string) => `X=${value}`],
  ['export DATA=', (value: string) => `export DATA=${value}`],
  ['trailing dot', (value: string) => `${value}.`],
  ['colon pair', (value: string) => `${value}:${value}`],
  ['underscore', (value: string) => `_${value}`],
  ['dash', (value: string) => `-${value}`],
  ['unnamed JSON', (value: string) => JSON.stringify([value])],
] as const;

/** Count surviving encoded fragments too: a slash-splitting regression can hide only part of a value. */
export function exposedEncoded(text: string, value: string): number {
  return [...text.matchAll(/[A-Za-z0-9+/]{32,}={0,2}/gu)].reduce(
    (total, [run]) => total + (run.includes(value) ? value.length : value.includes(run) ? run.length : 0),
    0,
  );
}
