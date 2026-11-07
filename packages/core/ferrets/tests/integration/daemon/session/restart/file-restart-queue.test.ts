import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileRestartQueue } from '../../../../src/adapters/session/restart/file-restart-queue.ts';

const entry = { id: 'ses-1', since: '2026-10-30T01:00:00.000Z', reason: 'mid-turn' as const, onlyIfOutdated: true };

describe('FileRestartQueue', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'fy-restart-queue-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('should read as empty before anything is saved', async () => {
    should(await new FileRestartQueue(home).load()).eql([]);
  });

  it('should hand back what a previous daemon saved', async () => {
    await new FileRestartQueue(home).save([entry]);
    should(await new FileRestartQueue(home).load()).eql([entry]);
  });

  it('should read as empty when the file is not JSON or not the right shape', async () => {
    await mkdir(join(home, 'restarts'), { recursive: true });
    await writeFile(join(home, 'restarts', 'queue.json'), '{ nope');
    should(await new FileRestartQueue(home).load()).eql([]);
    await writeFile(join(home, 'restarts', 'queue.json'), '{"queued": 3}');
    should(await new FileRestartQueue(home).load()).eql([]);
  });

  it('should drop only the entries that do not parse', async () => {
    await mkdir(join(home, 'restarts'), { recursive: true });
    await writeFile(join(home, 'restarts', 'queue.json'), JSON.stringify({ queued: [entry, { id: 7 }] }));
    should(await new FileRestartQueue(home).load()).eql([entry]);
  });
});
