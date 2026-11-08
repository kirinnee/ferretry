import { describe, it } from 'bun:test';
import should from 'should';
import type { RootHandle, RootName } from '@ferretry/kernel/contract';
import { HistoryConversationFiles } from '../../../../daemon/adapters/moves/history-conversation-files.ts';
import type { MoveCodexRollouts } from '../../../../daemon/lib/moves/ports.ts';
import { MemoryHistoryRoots } from '../../../support/daemon/memory-history-roots.ts';
import { testToolkit } from '../../../support/daemon/move-toolkit.ts';

/**
 * The transcripts a move carries between logins, through the `harness-history` root of the login that holds each one.
 * The root is the kernel's: it replaces a file whole, refuses a link that leaves the home and keeps modes, so what is
 * measured here is which home a path belongs to, what is read and listed, and what happens when the root refuses.
 */

const SESSION = '/state/sessions/mvd5yjxz-c22a4a22';
const HOMES = ['/homes/origin', '/homes/target', '/homes/codex'];

const NO_ROLLOUTS: MoveCodexRollouts = { candidates: async () => [] };

const over = (roots: MemoryHistoryRoots, rollouts: MoveCodexRollouts = NO_ROLLOUTS) =>
  new HistoryConversationFiles(roots, async () => HOMES, rollouts, testToolkit());

describe('HistoryConversationFiles', () => {
  it('should copy a conversation into another home, replacing a stale copy', async () => {
    // Arrange
    const roots = new MemoryHistoryRoots();
    const from = '/homes/origin/projects/-work/a.jsonl';
    const to = '/homes/target/projects/-work/a.jsonl';
    roots.plant(from, 'first\nsecond\n', 1_800_000_000);
    roots.plant(to, 'first\n', 1_700_000_000);
    const subject = over(roots);

    // Act
    await subject.copy(from, to);

    // Assert
    should(roots.text(to)).equal('first\nsecond\n');
    should(roots.text(from)).equal('first\nsecond\n');
    should(await subject.written(to)).be.true();
    should(await subject.written('/homes/target/projects/-work')).be.false();
    should(await subject.written('/homes/target/absent.jsonl')).be.false();
    should(roots.scopes).containEql('/homes/target');
  });

  it('should leave nothing behind when the copy fails', async () => {
    // Arrange
    const roots = new MemoryHistoryRoots();
    const to = '/homes/target/b.jsonl';

    // Act
    const failure = await over(roots)
      .copy('/homes/origin/missing.jsonl', to)
      .catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(Error);
    should(roots.text(to)).be.undefined();
  });

  it('should refuse a copy whose destination root refuses writes, and leave the destination as it was', async () => {
    // The real `harness-history` root is read-only: a move that must put a transcript into the target login's
    // home fails here, before the record that would point at it is written (the module restates it as `failed`).
    // Arrange
    const roots = new MemoryHistoryRoots({ readOnly: true });
    roots.plant('/homes/origin/a.jsonl', 'first\n');
    roots.plant('/homes/target/a.jsonl', 'older\n');

    // Act
    const failure = await over(roots)
      .copy('/homes/origin/a.jsonl', '/homes/target/a.jsonl')
      .catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(Error);
    should(roots.text('/homes/target/a.jsonl')).equal('older\n');
  });

  it("should list a Claude folder's conversations newest first with whether each names the session", async () => {
    // Arrange
    const roots = new MemoryHistoryRoots();
    const folder = '/homes/origin/projects/-work-repo';
    roots.plant(`${folder}/real.jsonl`, `{"content":"read ${SESSION}/turns/turn-001.md"}\n`, 1_800_000_000);
    roots.plant(`${folder}/stranger.jsonl`, '{"content":"hello"}\n', 1_800_000_600);
    roots.plant(`${folder}/real/nested.txt`, 'a folder, not a conversation', 1_800_000_700);
    roots.plant(`${folder}/notes.txt`, SESSION, 1_800_001_000);
    const subject = over(roots);

    // Act
    const found = await subject.prior('claude', '/homes/origin', '/work/repo', SESSION);
    const none = await subject.prior('claude', '/homes/origin', '/elsewhere', SESSION);

    // Assert
    should(found.map(entry => [entry.id, entry.mentionsSession])).deepEqual([
      ['stranger', false],
      ['real', true],
    ]);
    should(found[1]).have.property('file', `${folder}/real.jsonl`);
    should(found[1]?.modifiedMs).equal(1_800_000_000_000);
    should(none).deepEqual([]);
  });

  it('should find a mention in a transcript larger than one search chunk, split across two chunks or not', async () => {
    // Arrange: the session's name straddles the first 1 MiB boundary in one file, and is absent from
    // another of the same size, so both are searched a chunk at a time rather than read whole.
    const roots = new MemoryHistoryRoots();
    const folder = '/homes/origin/projects/-work-repo';
    const cut = 1024 * 1024 - Math.floor(SESSION.length / 2);
    roots.plant(`${folder}/split.jsonl`, `${'a'.repeat(cut)}${SESSION}${'b'.repeat(2 * 1024 * 1024)}`, 1_800_000_000);
    roots.plant(`${folder}/absent.jsonl`, 'c'.repeat(3 * 1024 * 1024), 1_800_000_100);
    roots.plant(`${folder}/sealed.jsonl`, SESSION, 1_800_000_200);
    roots.unreadable.add(`${folder}/sealed.jsonl`);

    // Act
    const found = await over(roots).prior('claude', '/homes/origin', '/work/repo', SESSION);

    // Assert: a file it cannot open names nothing.
    should(found.map(entry => [entry.id, entry.mentionsSession])).deepEqual([
      ['sealed', false],
      ['absent', false],
      ['split', true],
    ]);
  });

  it('should list Codex rollouts with whether each was correlated to the session', async () => {
    // Arrange
    const roots = new MemoryHistoryRoots();
    const rollout = '/homes/codex/sessions/2026/10/20/rollout-2026-10-20T06-00-00-thread-a.jsonl';
    roots.plant(rollout, '{}', 1_800_000_000);
    const asked: Array<[string, string]> = [];
    const rollouts: MoveCodexRollouts = {
      candidates: async (home, token) => {
        asked.push([home, token]);
        return [{ id: 'thread-a', file: rollout, correlated: true }];
      },
    };

    // Act
    const found = await over(roots, rollouts).prior('codex', '/homes/codex', '/work/repo', SESSION);

    // Assert
    should(found).deepEqual([{ id: 'thread-a', file: rollout, modifiedMs: 1_800_000_000_000, mentionsSession: true }]);
    should(asked).deepEqual([['/homes/codex', SESSION]]);
  });

  it('should read a whole file, and nothing at all when it is missing, a folder or over the limit', async () => {
    // Arrange
    const roots = new MemoryHistoryRoots();
    roots.plant('/homes/origin/a.jsonl', 'twelve bytes', 1_800_000_000);
    const subject = over(roots);

    // Act
    const whole = await subject.read('/homes/origin/a.jsonl', 12);
    const over11 = await subject.read('/homes/origin/a.jsonl', 11);
    const missing = await subject.read('/homes/origin/gone.jsonl', 100);
    const folder = await subject.read('/homes/origin', 1_000_000);

    // Assert
    should(whole).equal('twelve bytes');
    should(over11).be.undefined();
    should(missing).be.undefined();
    should(folder).be.undefined();
  });

  it('should write a converted file whole, text or bytes, when the root allows it', async () => {
    // Arrange
    const roots = new MemoryHistoryRoots();
    const subject = over(roots);

    // Act
    await subject.write('/homes/codex/sessions/2026/10/20/rollout.jsonl', 'converted\n');
    await subject.write('/homes/codex/image.png', new Uint8Array([1, 2, 3]));

    // Assert
    should(roots.text('/homes/codex/sessions/2026/10/20/rollout.jsonl')).equal('converted\n');
    should([...(roots.files.get('/homes/codex/image.png')?.bytes ?? [])]).deepEqual([1, 2, 3]);
  });

  it('should touch nothing outside the homes the account inventory publishes', async () => {
    // A transcript record is the agent's, so a path it names that is inside no login's home is neither read,
    // searched nor written.
    // Arrange
    const roots = new MemoryHistoryRoots();
    roots.plant('/etc/secret', 'not a conversation');
    const subject = over(roots);

    // Act
    const read = await subject.read('/etc/secret', 1_000);
    const written = await subject.written('/etc/secret');
    const copy = await subject.copy('/etc/secret', '/homes/target/x.jsonl').catch((error: unknown) => error);
    const write = await subject.write('/elsewhere/x.jsonl', 'x').catch((error: unknown) => error);

    // Assert
    should(read).be.undefined();
    should(written).be.false();
    should(copy).be.instanceOf(Error);
    should(write).be.instanceOf(Error);
    should(roots.text('/elsewhere/x.jsonl')).be.undefined();
    should(roots.scopes).deepEqual([]);
  });
});

/** A root whose `stat` fails, as a home that vanished or a mount that went away mid-move would. */
class StatFailingRoots extends MemoryHistoryRoots {
  override root(name: RootName, scope?: { readonly subfolder?: string }): RootHandle {
    return {
      ...super.root(name, scope),
      stat: async () => {
        throw new Error('stat failed');
      },
    } as RootHandle;
  }
}

describe('HistoryConversationFiles when a root cannot answer', () => {
  it('should say a file is not written when its root cannot stat it', async () => {
    // Arrange
    const roots = new StatFailingRoots();
    roots.plant('/homes/target/a.jsonl', 'present');

    // Act
    const written = await over(roots).written('/homes/target/a.jsonl');

    // Assert
    should(written).be.false();
  });

  it('should read nothing from a file its root can stat but cannot read', async () => {
    // Arrange
    const roots = new MemoryHistoryRoots();
    roots.plant('/homes/origin/sealed.jsonl', 'content');
    roots.unreadable.add('/homes/origin/sealed.jsonl');

    // Act
    const read = await over(roots).read('/homes/origin/sealed.jsonl', 1_000);

    // Assert
    should(read).be.undefined();
  });

  it('should sort a Codex rollout last when its modification time cannot be read or the file has vanished', async () => {
    // Arrange
    const gone = '/homes/codex/sessions/2026/10/20/rollout-gone.jsonl';
    const rollouts: MoveCodexRollouts = {
      candidates: async () => [
        { id: 'thread-gone', file: gone, correlated: false },
        { id: 'thread-here', file: '/homes/codex/sessions/rollout-here.jsonl', correlated: true },
      ],
    };
    const vanished = new MemoryHistoryRoots();
    vanished.plant('/homes/codex/sessions/rollout-here.jsonl', '{}', 1_800_000_000);
    const failing = new StatFailingRoots();

    // Act
    const missing = await over(vanished, rollouts).prior('codex', '/homes/codex', '/work/repo', SESSION);
    const unreadable = await over(failing, rollouts).prior('codex', '/homes/codex', '/work/repo', SESSION);

    // Assert
    should(missing.map(entry => [entry.id, entry.modifiedMs])).deepEqual([
      ['thread-gone', 0],
      ['thread-here', 1_800_000_000_000],
    ]);
    should(unreadable.map(entry => entry.modifiedMs)).deepEqual([0, 0]);
  });
});
