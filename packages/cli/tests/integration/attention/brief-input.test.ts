import { afterAll, describe, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { AttentionBriefInput } from '../../../src/adapters/attention/brief-input.ts';

/** The real reader behind `fy attention add --json-file`: a file, or standard input for `-`. */

const directory = mkdtempSync(join(tmpdir(), 'fy-attention-brief-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('reading an attention brief body', () => {
  it('should read a path relative to the working directory, and an absolute one', async () => {
    // Arrange
    writeFileSync(join(directory, 'brief.json'), '{"summary":"x"}');
    const input = new AttentionBriefInput(directory, { read: async () => 'unused' });

    // Act / Assert
    should(await input.read('brief.json')).equal('{"summary":"x"}');
    should(await input.read(join(directory, 'brief.json'))).equal('{"summary":"x"}');
  });

  it('should read standard input for -', async () => {
    // Arrange
    const input = new AttentionBriefInput(directory, { read: async () => '{"summary":"from stdin"}' });

    // Act / Assert
    should(await input.read('-')).equal('{"summary":"from stdin"}');
  });

  it('should name a file it cannot read', async () => {
    // Arrange
    const input = new AttentionBriefInput(directory);

    // Act / Assert
    await should(input.read('missing.json')).be.rejectedWith(/cannot read missing\.json/u);
  });
});
