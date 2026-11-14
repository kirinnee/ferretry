import { readFile } from 'node:fs/promises';
import { describe, it } from 'bun:test';
import should from 'should';

/** The Browsers tests type a verb the way `fy` hands it over, with a copy of the shell's parser; this holds the copy to it. */
const SHELL = new URL('../../src/lib/argv.ts', import.meta.url);
const COPY = new URL('../../../plugins/browsers/tests/support/shell-argv.ts', import.meta.url);

/** The code of `isWord` and `parseArgs`, without comments or blank lines, so only a change of behaviour differs. */
function parserCode(source: string): string {
  const from = source.indexOf('const isWord');
  const body = source.slice(from, source.indexOf('\n}\n', source.indexOf('export function parseArgs')) + 3);
  return body
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .map(line => line.replace(/\s\/\/.*$/u, '').trimEnd())
    .filter(line => line.trim() !== '' && !line.trim().startsWith('//'))
    .join('\n');
}

describe('the Browsers tests’ copy of the shell’s argument parser', () => {
  it('should be the shell’s parser, code for code', async () => {
    // Arrange
    const shell = parserCode(await readFile(SHELL, 'utf8'));
    const copy = parserCode(await readFile(COPY, 'utf8'));

    // Assert
    should(shell).containEql('export function parseArgs');
    should(copy).equal(shell);
  });
});
