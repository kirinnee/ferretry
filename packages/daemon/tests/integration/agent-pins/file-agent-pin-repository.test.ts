import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { agentPinsFile, FileAgentPinRepository } from '../../../src/adapters/agent-pins/index.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-agent-pins-'));
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  await mkdir(paths.state, { recursive: true });
  let id = 0;
  const files = new StateFileSystem(paths, () => `unique-${++id}`);
  return { home, file: agentPinsFile(paths), repository: new FileAgentPinRepository(paths, files) };
}

describe('FileAgentPinRepository', () => {
  it('should find no pins before anything was pinned', async () => {
    const subject = await fixture();
    try {
      should(await subject.repository.load()).deepEqual([]);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should keep pins across a new repository over the same state home, owner-only on disk', async () => {
    const subject = await fixture();
    try {
      const pins = [{ sessionId: 'agent-1', pinnedAt: '2026-11-01T10:00:00.000Z' }];
      await subject.repository.save(pins);

      should(await subject.repository.load()).deepEqual(pins);
      should(JSON.parse(await readFile(subject.file, 'utf8'))).deepEqual({ version: 1, pins });
      should((await stat(subject.file)).mode & 0o777).equal(0o600);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should treat a damaged file as an empty list rather than failing the roster', async () => {
    const subject = await fixture();
    try {
      await writeFile(subject.file, '{not json');
      should(await subject.repository.load()).deepEqual([]);
      await writeFile(subject.file, JSON.stringify({ version: 2, pins: [] }));
      should(await subject.repository.load()).deepEqual([]);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });
});
