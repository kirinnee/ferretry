import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import type { TranscriptProvenance } from '@ferretry/protocol';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  FileHarnessWrapperSource,
  KeyedSerialExecutor,
  NodeCodexRolloutIndex,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  StorageTranscriptClaims,
  StorageTranscriptProvenanceStore,
  SystemClock,
  storedTranscriptProvenance,
} from '../../../../src/adapters/index.ts';
import { parseSessionId, selectCodexRollout } from '../../../../src/lib/index.ts';

const NOW = '2026-08-01T10:00:00.000Z';
const directories = new Set<string>();

afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.add(directory);
  return directory;
}

async function openTemporaryStorage() {
  const home = await temporaryDirectory('ferretry-transcript-storage-');
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  );
  return (await factory.open()).storage;
}

/** One rollout as Codex writes it: a `session_meta` header, then ordinary records. */
async function writeRollout(home: string, day: string, id: string, body: readonly string[] = []): Promise<string> {
  const directory = join(home, 'sessions', day);
  await mkdir(directory, { recursive: true });
  const file = join(directory, `rollout-${day.replaceAll('/', '-')}-${id}.jsonl`);
  const lines = [JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/work/repo' } }), ...body];
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

describe('FileHarnessWrapperSource', () => {
  it('should read a wrapper script off disk', async () => {
    // Arrange
    const directory = await temporaryDirectory('ferretry-wrapper-');
    const wrapper = join(directory, 'claude-auto-loge');
    await writeFile(wrapper, '#!/usr/bin/env bash\nexport CLAUDE_CONFIG_DIR=/home/agent/.claude-loge\n', 'utf8');
    await chmod(wrapper, 0o755);

    // Act
    const source = await new FileHarnessWrapperSource().read(wrapper);

    // Assert
    should(source).containEql('CLAUDE_CONFIG_DIR=/home/agent/.claude-loge');
  });

  it('should answer nothing for a missing path and for a binary published as a wrapper', async () => {
    // Arrange
    const directory = await temporaryDirectory('ferretry-wrapper-');
    const binary = join(directory, 'codex-auto-terra');
    await writeFile(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));

    // Act
    const missing = await new FileHarnessWrapperSource().read(join(directory, 'absent'));
    const compiled = await new FileHarnessWrapperSource().read(binary);

    // Assert
    should(missing).be.undefined();
    should(compiled).be.undefined();
  });

  it('should read only the head of an oversized wrapper', async () => {
    // Arrange: the declaration is at the top; the rest must not be pulled into memory.
    const directory = await temporaryDirectory('ferretry-wrapper-');
    const wrapper = join(directory, 'claude-auto-loge');
    await writeFile(wrapper, `export CLAUDE_CONFIG_DIR=/home/agent/.claude\n${'# padding\n'.repeat(200)}`, 'utf8');

    // Act
    const source = await new FileHarnessWrapperSource(64).read(wrapper);

    // Assert
    should(source).have.length(64);
    should(source).containEql('CLAUDE_CONFIG_DIR=/home/agent/.claude');
  });
});

describe('NodeCodexRolloutIndex', () => {
  it('should list every rollout id a home already holds, across date partitions', async () => {
    // Arrange
    const home = await temporaryDirectory('ferretry-codex-home-');
    await writeRollout(home, '2026/07/31', '11111111-1111-1111-1111-111111111111');
    await writeRollout(home, '2026/08/01', '22222222-2222-2222-2222-222222222222');

    // Act
    const ids = await new NodeCodexRolloutIndex().ids(home);

    // Assert
    should([...ids].sort()).eql(['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222']);
  });

  it('should answer an empty baseline for a home with no sessions directory', async () => {
    // Arrange: a fresh account is the normal case, not an error.
    const home = await temporaryDirectory('ferretry-codex-home-');

    // Act
    const ids = await new NodeCodexRolloutIndex().ids(home);

    // Assert
    should(ids).be.empty();
  });

  it('should mark only the rollout containing the correlation token, and single it out', async () => {
    // Arrange: a teammate's rollout in the same home, same cwd, written later.
    const home = await temporaryDirectory('ferretry-codex-home-');
    const token = '/state/sessions/20260801-abcdef';
    await writeRollout(home, '2026/08/01', 'aaaaaaaa-1111-1111-1111-111111111111', [
      JSON.stringify({ type: 'response_item', payload: { text: 'unrelated work' } }),
    ]);
    const mine = await writeRollout(home, '2026/08/01', 'bbbbbbbb-2222-2222-2222-222222222222', [
      JSON.stringify({ type: 'response_item', payload: { text: `Read the file ${token}/turns/turn-001.md now` } }),
    ]);

    // Act
    const candidates = await new NodeCodexRolloutIndex().candidates(home, token);
    const chosen = selectCodexRollout(candidates, { baseline: [] });

    // Assert
    should(candidates).have.length(2);
    should(chosen?.file).equal(mine);
  });

  it('should find a token that has scrolled out of the header window', async () => {
    // Arrange: a compacted rollout re-states its brief far past the head.
    const home = await temporaryDirectory('ferretry-codex-home-');
    const token = '/state/sessions/20260801-tailonly';
    const padding = Array.from({ length: 400 }, (_value, index) =>
      JSON.stringify({ type: 'response_item', payload: { text: `filler ${index} ${'x'.repeat(200)}` } }),
    );
    await writeRollout(home, '2026/08/01', 'cccccccc-3333-3333-3333-333333333333', [
      ...padding,
      JSON.stringify({ type: 'response_item', payload: { text: `resuming ${token}` } }),
    ]);

    // Act
    const candidates = await new NodeCodexRolloutIndex().candidates(home, token);

    // Assert
    should(candidates.map(candidate => candidate.correlated)).eql([true]);
  });

  it('should still identify a rollout whose header is unreadable, from its filename', async () => {
    // Arrange: a live rollout's first line can be partially flushed.
    const home = await temporaryDirectory('ferretry-codex-home-');
    const directory = join(home, 'sessions', '2026/08/01');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'rollout-2026-08-01-dddddddd-4444-4444-4444-444444444444.jsonl'), '{"type":"ses');

    // Act
    const ids = await new NodeCodexRolloutIndex().ids(home);

    // Assert
    should(ids).eql(['dddddddd-4444-4444-4444-444444444444']);
  });
});

describe('transcript provenance storage', () => {
  it('should merge a resolved record into the configuration and read it back', async () => {
    // Arrange
    const storage = await openTemporaryStorage();
    const id = parseSessionId('20260801-resolved');
    await storage.writeConfig(id, { id, agent: 'codex-auto-terra', harness: 'codex' });
    const provenance: TranscriptProvenance = {
      v: 1,
      home: '/home/agent/.codex',
      harnessSessionId: 'rollout-1',
      identity: 'correlated',
      file: '/home/agent/.codex/sessions/rollout-1.jsonl',
      resolvedAt: NOW,
    };

    // Act
    await new StorageTranscriptProvenanceStore(storage).record(id, provenance);
    const stored = storedTranscriptProvenance(await storage.readConfig(id));

    // Assert: the record is added, and nothing already in the document is lost.
    should(stored).eql(provenance);
    should((await storage.readConfig(id)) as { agent: string }).have.property('agent', 'codex-auto-terra');
    await storage.close();
  });

  it('should refuse to write against an id the state home would not accept', async () => {
    // Arrange: a path separator in a session id must never become a directory traversal.
    const storage = await openTemporaryStorage();

    // Act
    await new StorageTranscriptProvenanceStore(storage).record('../escape', {
      v: 1,
      home: '/home/agent/.codex',
      identity: 'undiscovered',
    });

    // Assert
    should(storage.listSessions()).be.empty();
    await storage.close();
  });

  it('should report only the rollouts other sessions have actually been attributed', async () => {
    // Arrange
    const storage = await openTemporaryStorage();
    const mine = parseSessionId('20260801-mine');
    const peer = parseSessionId('20260801-peer');
    const pending = parseSessionId('20260801-pending');
    await storage.writeConfig(mine, {
      id: mine,
      transcript: {
        v: 1,
        home: '/h',
        harnessSessionId: 'rollout-mine',
        identity: 'correlated',
        file: '/f',
        resolvedAt: NOW,
      },
    });
    await storage.writeConfig(peer, {
      id: peer,
      transcript: {
        v: 1,
        home: '/h',
        harnessSessionId: 'rollout-peer',
        identity: 'correlated',
        file: '/g',
        resolvedAt: NOW,
      },
    });
    await storage.writeConfig(pending, { id: pending, transcript: { v: 1, home: '/h', identity: 'undiscovered' } });

    // Act
    const claimed = await new StorageTranscriptClaims(storage).claimed(mine);

    // Assert: this session's own attribution is not a claim against itself.
    should(claimed).eql(['rollout-peer']);
    await storage.close();
  });

  it('should treat an unparseable provenance field as no record at all', async () => {
    // Arrange: a hand-edited document must never be read as a valid attribution.
    const storage = await openTemporaryStorage();
    const id = parseSessionId('20260801-corrupt');
    await storage.writeConfig(id, { id, transcript: { v: 1, identity: 'correlated' } });

    // Act
    const stored = storedTranscriptProvenance(await storage.readConfig(id));
    const claimed = await new StorageTranscriptClaims(storage).claimed('20260801-other');

    // Assert
    should(stored).be.undefined();
    should(claimed).be.empty();
    await storage.close();
  });
});
