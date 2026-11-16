import { describe, it } from 'bun:test';
import type { Instant } from '@ferretry/std';
import should from 'should';
import type { PacksFile, ReplacedRouting, RoutingFile } from '../../../../contract/index.ts';
import { GuideFileService, type GuideWrite } from '../../../../daemon/lib/cleanup/file.ts';

const NOW = '2026-10-22T12:00:00.000Z';
const SUGGESTED = { by: 'opus', via: 'claude-main', at: '2026-10-22T11:00:00.000Z' as Instant };
const PROMPT = 'Planning and review: opus at max. Chores: haiku.';

/**
 * packs.yaml in memory (the parsed file), written through the same edit the real writer is given: the `routing`
 * section alone (`undefined` takes it out), every other key left as it is. `answer` is what the writer says.
 */
function world(initial: PacksFile | undefined, kept?: ReplacedRouting, answer?: () => GuideWrite | Error) {
  const state = { file: initial, writes: 0, etags: [] as string[] };
  let replaced: ReplacedRouting | undefined = kept;
  const service = new GuideFileService({
    read: async () => ({ file: state.file ?? {}, etag: `etag-${String(state.writes)}` }),
    write: async (routing: RoutingFile | undefined, etag) => {
      state.etags.push(etag);
      const said = answer?.() ?? { kind: 'written' as const };
      if (said instanceof Error) throw said;
      if (said.kind === 'held') return said;
      const { routing: _was, ...rest } = state.file ?? {};
      state.file = routing === undefined ? rest : { ...rest, routing };
      state.writes += 1;
      return said;
    },
    replaced: {
      read: async () => replaced,
      write: async value => {
        replaced = value;
      },
    },
    now: () => NOW,
  });
  return { service, state, replaced: () => replaced };
}

describe('GuideFileService.accept and undo', () => {
  it("should write the reviewed prompt with where it came from, keep the rest of the file, and undo to the owner's prompt", async () => {
    // Arrange
    const subject = world({
      enabled: false,
      routing: { prompt: 'Opus for everything I do.' },
    });

    // Act
    const accepted = await subject.service.accept({ prompt: PROMPT, suggested: SUGGESTED });

    // Assert
    should(accepted).deepEqual({
      outcome: 'applied',
      message: 'The routing prompt is the one opus cleaned up. Undo puts the previous one back.',
    });
    should(subject.state.file).deepEqual({
      enabled: false,
      routing: { prompt: PROMPT, suggested: { ...SUGGESTED, acceptedAt: NOW } },
    });
    should(subject.state.etags).deepEqual(['etag-0']);
    should(subject.replaced()).deepEqual({
      format: 1,
      text: 'Opus for everything I do.',
      savedAt: NOW,
      source: 'file',
    });
    should(await subject.service.undoable()).deepEqual({ savedAt: NOW, source: 'file' });

    // Act — undo
    const undone = await subject.service.undo();

    // Assert
    should(undone).deepEqual({ outcome: 'applied', message: 'Undone: the routing prompt you had before is back.' });
    should(subject.state.file).deepEqual({ enabled: false, routing: { prompt: 'Opus for everything I do.' } });
    should(subject.state.etags).deepEqual(['etag-0', 'etag-1']);
    should(await subject.service.undoable()).be.undefined();
  });

  it('should say the prompt was written and record it as written', async () => {
    // Arrange
    const subject = world(undefined);

    // Act
    const accepted = await subject.service.accept({ prompt: PROMPT, suggested: { ...SUGGESTED, mode: 'generate' } });

    // Assert
    should(accepted).deepEqual({
      outcome: 'applied',
      message: 'The routing prompt is the one opus wrote. Undo puts the previous one back.',
    });
    should(subject.state.file).deepEqual({
      routing: { prompt: PROMPT, suggested: { ...SUGGESTED, mode: 'generate', acceptedAt: NOW } },
    });
  });

  it('should answer nothing to a second undo, and to one with no accept before it', async () => {
    // Arrange
    const subject = world({ routing: { prompt: 'Mine.' } });
    await subject.service.accept({ prompt: PROMPT, suggested: SUGGESTED });
    await subject.service.undo();
    const writes = subject.state.writes;
    const fresh = world(undefined);

    // Act
    const second = await subject.service.undo();
    const none = await fresh.service.undo();

    // Assert
    should(second).deepEqual({ outcome: 'nothing', message: 'There is no accepted clean-up to undo.' });
    should(none).deepEqual(second);
    should(subject.state.writes).equal(writes);
    should(fresh.state.writes).equal(0);
    should(subject.state.file).deepEqual({ routing: { prompt: 'Mine.' } });
  });

  it('should undo an accept made over a file with no prompt of the owner’s back to the default', async () => {
    // Arrange
    const subject = world({
      routing: { suggested: { ...SUGGESTED, acceptedAt: '2026-10-01T10:05:00.000Z' as Instant } },
    });

    // Act
    await subject.service.accept({ prompt: PROMPT, suggested: SUGGESTED });
    const kept = subject.replaced();
    const undone = await subject.service.undo();

    // Assert
    should(kept).deepEqual({ format: 1, text: null, savedAt: NOW, source: 'default' });
    should(undone).deepEqual({
      outcome: 'applied',
      message: 'Undone: the default routing prompt, built from the model catalogs, is in effect again.',
    });
    should(subject.state.file).deepEqual({});
  });

  it('should undo an accept made with no file at all by taking out what it wrote, and keep what came after', async () => {
    // Arrange
    const subject = world(undefined);
    await subject.service.accept({ prompt: PROMPT, suggested: SUGGESTED });
    should(subject.replaced()).deepEqual({ format: 1, text: null, savedAt: NOW, source: 'default' });
    subject.state.file = { ...subject.state.file, enabled: false };

    // Act
    const undone = await subject.service.undo();

    // Assert
    should(undone.outcome).equal('applied');
    should(subject.replaced()).be.undefined();
    should(subject.state.file).deepEqual({ enabled: false });
  });

  it('should undo a prompt-less accept to an empty file when nothing else was written', async () => {
    // Arrange
    const subject = world(undefined);
    await subject.service.accept({ prompt: PROMPT, suggested: SUGGESTED });

    // Act
    await subject.service.undo();

    // Assert
    should(subject.state.file).deepEqual({});
    should(await subject.service.undoable()).be.undefined();
  });

  it('should write only the routing section, so every other setting survives an accept', async () => {
    // Arrange
    const subject = world({ decision: 'jev', limits: { maxDepth: 3 } });

    // Act
    await subject.service.accept({ prompt: PROMPT, suggested: SUGGESTED });

    // Assert
    should(subject.state.file).deepEqual({
      decision: 'jev',
      limits: { maxDepth: 3 },
      routing: { prompt: PROMPT, suggested: { ...SUGGESTED, acceptedAt: NOW } },
    });
  });

  it('should say what an undo would put back from a kept file, without reading the settings', async () => {
    // Arrange
    const subject = world(
      { routing: { prompt: 'Mine.' } },
      { format: 1, text: 'Old.', savedAt: NOW as Instant, source: 'file' },
    );

    // Act
    const actual = await subject.service.undoable();

    // Assert
    should(actual).deepEqual({ savedAt: NOW, source: 'file' });
    should(subject.state.writes).equal(0);
  });
});

describe('GuideFileService when the writer does not put the edit into effect', () => {
  const HELD: GuideWrite = { kind: 'held', sentences: ['the prompt names a secret'] };

  it('should report an accept the owner must confirm as held, and keep no undo for what is not in effect', async () => {
    // Arrange
    const subject = world({ routing: { prompt: 'Mine.' } }, undefined, () => HELD);

    // Act
    const accepted = await subject.service.accept({ prompt: PROMPT, suggested: SUGGESTED });

    // Assert
    should(accepted.outcome).equal('held');
    should(accepted.message).containEql('waits for you to confirm it');
    should(accepted.message).containEql('the prompt names a secret');
    should(subject.state.file).deepEqual({ routing: { prompt: 'Mine.' } });
    should(subject.replaced()).be.undefined();
  });

  it('should leave the undo it had when a later accept is held', async () => {
    // Arrange
    const before: ReplacedRouting = { format: 1, text: 'Old.', savedAt: NOW as Instant, source: 'file' };
    const subject = world({ routing: { prompt: 'Mine.' } }, before, () => HELD);

    // Act
    await subject.service.accept({ prompt: PROMPT, suggested: SUGGESTED });

    // Assert
    should(subject.replaced()).deepEqual(before);
  });

  it('should keep the undo and report held when an undo is held, so it can be tried again', async () => {
    // Arrange
    const kept: ReplacedRouting = { format: 1, text: 'Old.', savedAt: NOW as Instant, source: 'file' };
    const subject = world({ routing: { prompt: 'Mine.' } }, kept, () => HELD);

    // Act
    const undone = await subject.service.undo();

    // Assert
    should(undone.outcome).equal('held');
    should(subject.replaced()).deepEqual(kept);
  });

  it('should refuse, and keep the undo it had, when the file moved since it was read', async () => {
    // Arrange
    const moved = new Error('packs.yaml changed since it was last read; nothing was saved. Try again.');
    const kept: ReplacedRouting = { format: 1, text: 'Old.', savedAt: NOW as Instant, source: 'file' };
    const subject = world({ routing: { prompt: 'Mine.' } }, kept, () => moved);

    // Act
    const failed = await subject.service.accept({ prompt: PROMPT, suggested: SUGGESTED }).catch((e: unknown) => e);
    const failedUndo = await subject.service.undo().catch((e: unknown) => e);

    // Assert
    should(failed).equal(moved);
    should(failedUndo).equal(moved);
    should(subject.replaced()).deepEqual(kept);
    should(subject.state.file).deepEqual({ routing: { prompt: 'Mine.' } });
  });
});
