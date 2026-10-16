import { describe, it } from 'bun:test';
import { Readable } from 'node:stream';
import should from 'should';
import { StdinConfigText } from '../../../src/adapters/config/stdin.ts';

/** The real stream behind `fy config write`: standard input, read whole. */

describe('reading the new text of a file from standard input', () => {
  it('should return every chunk, joined, with no newline stripped', async () => {
    const stream = Readable.from([Buffer.from('a: 1\n'), Buffer.from('b:\n  - x\n\n')]);
    should(await new StdinConfigText(stream).read()).equal('a: 1\nb:\n  - x\n\n');
  });

  it('should keep a multi-byte character that a chunk boundary splits', async () => {
    const bytes = Buffer.from('name: héllo ✓\n');
    const stream = Readable.from([bytes.subarray(0, 8), bytes.subarray(8)]);
    should(await new StdinConfigText(stream).read()).equal('name: héllo ✓\n');
  });

  it('should accept string chunks too', async () => {
    const stream = Readable.from(['a: 1\n', 'b: 2']);
    should(await new StdinConfigText(stream).read()).equal('a: 1\nb: 2');
  });

  it('should answer an empty string for empty input', async () => {
    should(await new StdinConfigText(Readable.from([])).read()).equal('');
  });
});
