import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { TranscriptFileExposure } from '../../../src/adapters/index.ts';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const transcript = async (lines: readonly string[]): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'fy-exposure-'));
  roots.push(root);
  const file = join(root, 'session.jsonl');
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
};

describe('TranscriptFileExposure over a real transcript file', () => {
  it('should find a value the agent already saw, escaped as JSON lines write it, and miss one it did not', async () => {
    const file = await transcript([
      JSON.stringify({ type: 'tool_result', content: 'token: ghp_SEEN-1234\nnext "line"' }),
      JSON.stringify({ type: 'assistant', text: 'done' }),
    ]);
    const exposure = new TranscriptFileExposure({ file: async () => file });

    should(await exposure.transcriptHolds('s1', 'ghp_SEEN-1234')).equal('found');
    should(await exposure.transcriptHolds('s1', 'ghp_SEEN-1234\nnext "line"')).equal('found');
    should(await exposure.transcriptHolds('s1', 'ghp_NEVER-SHOWN')).equal('clean');
  });

  it('should find a value written on the last line', async () => {
    const file = await transcript([JSON.stringify({ early: 'ghp_EARLY' }), JSON.stringify({ late: 'ghp_LATE' })]);
    const exposure = new TranscriptFileExposure({ file: async () => file });

    should(await exposure.transcriptHolds('s1', 'ghp_LATE')).equal('found');
  });

  it('should answer unknown for a transcript file that is not there', async () => {
    const exposure = new TranscriptFileExposure({ file: async () => join(tmpdir(), 'fy-exposure-missing', 'x.jsonl') });

    should(await exposure.transcriptHolds('s1', 'anything')).equal('unknown');
  });
});
