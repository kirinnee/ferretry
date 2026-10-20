import { afterEach, describe, it } from 'bun:test';
import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import should from 'should';
import { FileConversationFiles } from '../../../src/adapters/migrate/file-conversation-files.ts';
import { NodeCodexRolloutIndex } from '../../../src/adapters/session/transcript/node-codex-rollout-index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * The transcripts a migration carries between logins, on a real filesystem inside a throwaway tree.
 */

const SESSION = '/state/sessions/mvd5yjxz-c22a4a22';

async function put(file: string, body: string, modifiedSeconds: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
  await utimes(file, modifiedSeconds, modifiedSeconds);
}

describe('FileConversationFiles', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('should copy a conversation into another home, replacing a stale copy and leaving no temporary', async () => {
    // Arrange
    const home = await tempDirectory('conversation-copy');
    const from = join(home, 'origin', 'projects', '-work', 'a.jsonl');
    const to = join(home, 'target', 'projects', '-work', 'a.jsonl');
    await put(from, 'first\nsecond\n', 1_800_000_000);
    await put(to, 'first\n', 1_700_000_000);
    const subject = new FileConversationFiles(new NodeCodexRolloutIndex(), () => 'fixed');

    // Act
    await subject.copy(from, to);

    // Assert
    should(await readFile(to, 'utf8')).equal('first\nsecond\n');
    should((await stat(to)).mode & 0o777).equal(0o600);
    should(await readdir(dirname(to))).deepEqual(['a.jsonl']);
    should(await subject.written(to)).be.true();
    should(await subject.written(dirname(to))).be.false();
    should(await subject.written(join(home, 'absent.jsonl'))).be.false();
  });

  it('should leave nothing behind when the copy fails', async () => {
    // Arrange
    const home = await tempDirectory('conversation-copy-fails');
    const subject = new FileConversationFiles(new NodeCodexRolloutIndex(), () => 'fixed');
    const to = join(home, 'target', 'b.jsonl');

    // Act
    const failure = await subject.copy(join(home, 'missing.jsonl'), to).catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(Error);
    should(await readdir(dirname(to))).deepEqual([]);
  });

  it("should list a Claude folder's conversations newest first with whether each names the session", async () => {
    // Arrange
    const home = await tempDirectory('conversation-prior-claude');
    const folder = join(home, 'projects', '-work-repo');
    await put(join(folder, 'real.jsonl'), `{"content":"read ${SESSION}/turns/turn-001.md"}\n`, 1_800_000_000);
    await put(join(folder, 'stranger.jsonl'), '{"content":"hello"}\n', 1_800_000_600);
    await mkdir(join(folder, 'real'), { recursive: true });
    await put(join(folder, 'notes.txt'), SESSION, 1_800_001_000);
    const subject = new FileConversationFiles(new NodeCodexRolloutIndex());

    // Act
    const found = await subject.prior('claude', home, '/work/repo', SESSION);
    const none = await subject.prior('claude', home, '/elsewhere', SESSION);

    // Assert
    should(found.map(entry => [entry.id, entry.mentionsSession])).deepEqual([
      ['stranger', false],
      ['real', true],
    ]);
    should(found[1]).have.property('file', join(folder, 'real.jsonl'));
    should(found[1]?.modifiedMs).equal(1_800_000_000_000);
    should(none).deepEqual([]);
  });

  it('should list Codex rollouts with whether each was correlated to the session', async () => {
    // Arrange
    const home = await tempDirectory('conversation-prior-codex');
    const rollout = join(home, 'sessions', '2026', '10', '20', 'rollout-2026-10-20T06-00-00-thread-a.jsonl');
    await put(
      rollout,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-a' } })}\n{"workspace_roots":["${SESSION}"]}\n`,
      1_800_000_000,
    );
    const subject = new FileConversationFiles(new NodeCodexRolloutIndex());

    // Act
    const found = await subject.prior('codex', home, '/work/repo', SESSION);

    // Assert
    should(found).deepEqual([{ id: 'thread-a', file: rollout, modifiedMs: 1_800_000_000_000, mentionsSession: true }]);
  });

  it('should read a whole file, and nothing at all when it is missing, a folder or over the limit', async () => {
    // Arrange
    const home = await tempDirectory('conversation-read');
    const file = join(home, 'a.jsonl');
    await put(file, 'twelve bytes', 1_800_000_000);
    const subject = new FileConversationFiles(new NodeCodexRolloutIndex());

    // Act
    const whole = await subject.read(file, 12);
    const over = await subject.read(file, 11);
    const missing = await subject.read(join(home, 'gone.jsonl'), 100);
    const folder = await subject.read(home, 1_000_000);

    // Assert
    should(whole).equal('twelve bytes');
    should(over).be.undefined();
    should(missing).be.undefined();
    should(folder).be.undefined();
  });

  it('should write a converted file privately and whole, and leave no temporary when it cannot', async () => {
    // Arrange
    const home = await tempDirectory('conversation-write');
    const file = join(home, 'codex', 'sessions', '2026', '10', '20', 'rollout.jsonl');
    const blocked = join(home, 'blocked');
    await mkdir(join(blocked, 'occupied'), { recursive: true });
    const subject = new FileConversationFiles(new NodeCodexRolloutIndex(), () => 'fixed');

    // Act
    await subject.write(file, 'converted\n');
    await subject.write(join(home, 'image.png'), new Uint8Array([1, 2, 3]));
    const refused = subject.write(blocked, 'cannot replace a folder');

    // Assert
    should(await readFile(file, 'utf8')).equal('converted\n');
    should((await stat(file)).mode & 0o777).equal(0o600);
    should([...(await readFile(join(home, 'image.png')))]).deepEqual([1, 2, 3]);
    await should(refused).be.rejected();
    should(await readdir(home)).not.containEql('.blocked.fixed.tmp');
  });
});
