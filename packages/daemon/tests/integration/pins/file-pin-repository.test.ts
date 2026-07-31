import { describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import should from 'should';
import { createFoundationPaths, resolveStateHome, type FoundationPaths } from '../../../src/lib/index.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { FilePinRepository, FilePinSessionDirectory } from '../../../src/adapters/pins/index.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';

const clock = { now: () => '2026-07-31T00:00:00.000Z' };

async function fixture(): Promise<{
  readonly home: string;
  readonly paths: FoundationPaths;
  readonly repository: FilePinRepository;
  readonly sessions: FilePinSessionDirectory;
}> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-pins-'));
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths, () => 'unique-id');
  return {
    home,
    paths,
    repository: new FilePinRepository(paths, files, new KeyedSerialExecutor(), clock),
    sessions: new FilePinSessionDirectory(paths, files),
  };
}

describe('FilePinRepository', () => {
  it('should persist serialized per-session mutations atomically and retain concurrent changes', async () => {
    // Arrange
    const subject = await fixture();
    try {
      // Act
      const [first, second] = await Promise.all([
        subject.repository.mutate('agent-1', current => [
          {
            id: '00000000-0000-4000-8000-000000000001',
            at: 1,
            kind: 'note' as const,
            text: 'first',
            by: 'human' as const,
            createdBy: null,
            createdByName: null,
          },
          ...current,
        ]),
        subject.repository.mutate('agent-1', current => [
          {
            id: '00000000-0000-4000-8000-000000000002',
            at: 2,
            kind: 'note' as const,
            text: 'second',
            by: 'human' as const,
            createdBy: null,
            createdByName: null,
          },
          ...current,
        ]),
      ]);
      const reread = await subject.repository.snapshot('agent-1');

      // Assert
      should(first.pins).have.length(1);
      should(second.pins).have.length(2);
      should(reread.pins.map(pin => pin.id)).deepEqual([
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000001',
      ]);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should degrade absent, corrupt, foreign, and malformed persisted documents to an empty board', async () => {
    // Arrange
    const subject = await fixture();
    const file = join(subject.paths.sessions, 'agent-1', 'pins.json');
    try {
      // Act + Assert
      should((await subject.repository.snapshot('agent-1')).pins).deepEqual([]);
      await subject.repository.mutate('agent-1', current => current);
      await writeFile(file, '{not-json');
      should((await subject.repository.snapshot('agent-1')).pins).deepEqual([]);
      await writeFile(
        file,
        JSON.stringify({ v: 1, sessionId: 'other', pins: [], updatedAt: '2026-07-31T00:00:00.000Z' }),
      );
      should((await subject.repository.snapshot('agent-1')).pins).deepEqual([]);
      await writeFile(
        file,
        JSON.stringify({ v: 1, sessionId: 'agent-1', pins: [{ id: 'not-a-uuid' }], updatedAt: 'bad' }),
      );
      should((await subject.repository.snapshot('agent-1')).pins).deepEqual([]);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should recognize only a session bearing its version marker', async () => {
    // Arrange
    const subject = await fixture();
    try {
      // Act
      const absent = await subject.sessions.has('agent-1');
      await subject.repository.mutate('agent-1', current => current);
      const stillAbsent = await subject.sessions.has('agent-1');
      await writeFile(join(subject.paths.sessions, 'agent-1', 'session-version'), '1');
      const present = await subject.sessions.has('agent-1');

      // Assert
      should(absent).be.false();
      should(stillAbsent).be.false();
      should(present).be.true();
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });
});
