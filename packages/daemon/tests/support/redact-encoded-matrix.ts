import { createHash } from 'node:crypto';

// The Opus r4 recheck's seed and shapes. All bytes are synthetic.
function bytes(tag: string, sample: number, length: number): Buffer {
  const value = Buffer.alloc(length);
  for (let offset = 0; offset < length; offset += 32)
    createHash('sha256').update(`rv4-opus:${tag}:${sample}:${offset}`).digest().copy(value, offset);
  return value;
}
const base62 = (tag: string, sample: number, length: number): string =>
  [...bytes(tag, sample, length)]
    .map(byte => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[byte % 62])
    .join('');

export const MATRIX_SHAPES: readonly [string, (sample: number) => string][] = [
  ['vault', sample => bytes('k', sample, 32).toString('base64')],
  ['AWS40', sample => bytes('aws', sample, 30).toString('base64')],
  ['48B', sample => bytes('48', sample, 48).toString('base64')],
  ['64Bpad', sample => bytes('64', sample, 64).toString('base64')],
  ['ct148', sample => bytes('c148', sample, 148).toString('base64')],
  ['ct616', sample => bytes('c616', sample, 616).toString('base64')],
  ['ct2016', sample => bytes('c2016', sample, 2016).toString('base64')],
  ['iv:ct', sample => `${bytes('iv', sample, 12).toString('base64')}:${bytes('ivc', sample, 148).toString('base64')}`],
  ['base62-32', sample => base62('62a', sample, 32)],
  ['base62-40', sample => base62('62b', sample, 40)],
  ['base62-64', sample => base62('62c', sample, 64)],
  ['base64url', sample => bytes('url', sample, 32).toString('base64url')],
];

export const MATRIX_WRAPPERS: readonly [string, (value: string) => string][] = [
  ['bare', value => value],
  ['X=', value => `X=${value}`],
  ['export DATA=', value => `export DATA=${value}`],
  ['dot', value => `${value}.`],
  ['colon', value => `${value}:${value}`],
  ['_', value => `_${value}`],
  ['-', value => `-${value}`],
  ['JSON', value => JSON.stringify([value])],
  ['JSON object', value => JSON.stringify({ blob: value })],
  ['aK.md', value => `a${value}.md`],
  ['x+K.md', value => `x+${value}.md`],
  ['$X/9K', value => `$X/9${value}`],
  ['$RELAY/9K', value => `see $RELAY/9${value}`],
  ['notes-9K.txt', value => `notes-9${value}.txt`],
  ['$VAR/K', value => `$VAR/${value}`],
  ['$RELAY/K', value => `see $RELAY/${value}`],
  ['$HOME/x/K', value => `$HOME/x/${value}`],
  ['$X/models/K', value => `$X/models/${value}`],
  ['$X/K unpad', value => `$X/${value.replace(/=$/u, '')}`],
  ['./K unpad', value => `./${value.replace(/=$/u, '')}`],
  ['~/K unpad', value => `~/${value.replace(/=$/u, '')}`],
  ['/abs/K', value => `/abs/${value}`],
  ['K/suffix', value => `${value}/suffix`],
  ['K/suffix unpad', value => `${value.replace(/=$/u, '')}/suffix`],
  ['K.v2 unpad', value => `${value.replace(/=$/u, '')}.v2`],
  ['K-7b.gguf unpad', value => `${value.replace(/=$/u, '')}-7b.gguf`],
  ['./K.v2 unpad', value => `./${value.replace(/=$/u, '')}.v2`],
  ['dir/K.txt', value => `dir/${value}.txt`],
  ['K.json', value => `${value}.json`],
  ...['/9j/', 'iVBORw0KGgo', 'R0lGOD', 'UklGR'].flatMap(prefix => {
    const image = (value: string): string => prefix + value.slice(prefix.length);
    return [
      [`${prefix} dot`, (value: string) => `${image(value)}.`],
      [`${prefix} colon`, (value: string) => `${image(value)}:${image(value)}`],
      [`${prefix} dir`, (value: string) => `${image(value)}/suffix`],
      [`${prefix} unpad dir`, (value: string) => `${image(value).replace(/=$/u, '')}/suffix`],
      [`${prefix} filename`, (value: string) => `${image(value).replace(/=$/u, '')}-7b.gguf`],
      [`${prefix} data URI`, (value: string) => `data:image/png;base64,${image(value)}`],
    ] as [string, (value: string) => string][];
  }),
];

/** Same whole/32-character-fragment comparison as the Opus harness, including iv:ct parts. */
export function matrixExposure(output: string, input: string): number {
  const targets = input.match(/[A-Za-z0-9+/_-]{32,}={0,2}/gu) ?? [];
  let total = 0;
  for (const match of output.matchAll(/[A-Za-z0-9+/=_-]+/gu)) {
    const run = match[0].replace(/^[=/_-]+|[=/_-]+$/gu, '');
    if (run.length < 32) continue;
    for (const target of targets) {
      const core = target.replace(/=+$/u, '');
      if (run.includes(core)) total += core.length;
      else if (core.includes(run)) total += run.length;
    }
  }
  return total;
}
