import { describe, it } from 'bun:test';
import { readConfigText } from '@ferretry/fleet/config-text';
import { ModelsGuideFileSchema } from '@ferretry/protocol';
import should from 'should';
import {
  GUIDE_MODELINE,
  GuideFileService,
  type ReplacedGuide,
  rawOf,
  without,
} from '../../../../src/lib/pack/cleanup/file.ts';

const NOW = '2026-10-22T12:00:00.000Z';
const SUGGESTED = { by: 'opus', via: 'claude-main', at: '2026-10-22T11:00:00.000Z' };
const PROMPT = 'Planning and review: opus at max. Chores: haiku.';

/** models-guide.yaml in memory, written through the same edits the real writer is given. */
function world(initial: string | undefined, kept?: ReplacedGuide) {
  const state = { text: initial, writes: 0, etags: [] as string[] };
  let replaced: ReplacedGuide | undefined = kept;
  const service = new GuideFileService({
    read: async () => ({
      exists: state.text !== undefined,
      text: state.text ?? '',
      etag: `etag-${String(state.writes)}`,
    }),
    write: async (text, etag) => {
      state.etags.push(etag);
      state.text = text;
      state.writes += 1;
    },
    replaced: {
      read: async () => replaced,
      write: async value => {
        replaced = value;
      },
    },
    now: () => NOW,
  });
  const file = () => {
    const read = readConfigText(state.text ?? '');
    if (!read.ok) throw new Error('the file does not parse');
    return ModelsGuideFileSchema.parse(read.read.value ?? {});
  };
  return { service, state, file, replaced: () => replaced };
}

describe('GuideFileService.accept and undo', () => {
  it("should write the reviewed prompt with where it came from, keep comments, and undo to the owner's file exactly", async () => {
    // Arrange
    const before = [
      GUIDE_MODELINE,
      '# my notes stay',
      'prompt: Opus for everything I do.',
      'suggested:',
      '  by: haiku',
      '  via: claude-fast',
      '  at: "2026-10-01T10:00:00.000Z"',
      '  acceptedAt: "2026-10-01T10:05:00.000Z"',
      '',
    ].join('\n');
    const subject = world(before);

    // Act
    const accepted = await subject.service.accept({ prompt: PROMPT, suggested: SUGGESTED });

    // Assert
    should(accepted).deepEqual({
      outcome: 'applied',
      message: 'The routing prompt is the one opus cleaned up. Undo puts the previous one back.',
    });
    should(subject.file()).deepEqual({ prompt: PROMPT, suggested: { ...SUGGESTED, acceptedAt: NOW } });
    should(subject.state.text).containEql('# my notes stay');
    should(subject.state.etags).deepEqual(['etag-0']);
    should(subject.replaced()).deepEqual({ text: before, savedAt: NOW, source: 'file' });
    should(await subject.service.undoable()).deepEqual({ savedAt: NOW, source: 'file' });

    // Act — undo
    const undone = await subject.service.undo();

    // Assert
    should(undone).deepEqual({ outcome: 'applied', message: 'Undone: the routing prompt you had before is back.' });
    should(subject.state.text).equal(before);
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
    should(subject.file()).deepEqual({
      prompt: PROMPT,
      suggested: { ...SUGGESTED, mode: 'generate', acceptedAt: NOW },
    });
  });

  it('should answer nothing to a second undo, and to one with no accept before it', async () => {
    // Arrange
    const subject = world('# mine\nprompt: Mine.\n');
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
    should(subject.state.text).equal('# mine\nprompt: Mine.\n');
  });

  it('should undo an accept made over a file with no prompt of the owner’s back to the default, text and all', async () => {
    // Arrange
    const before = [GUIDE_MODELINE, 'suggested:', '  by: x', '  via: y', '  at: "2026-10-01T10:00:00.000Z"', ''].join(
      '\n',
    );
    const subject = world(before);

    // Act
    await subject.service.accept({ prompt: PROMPT, suggested: SUGGESTED });
    const kept = subject.replaced();
    const undone = await subject.service.undo();

    // Assert
    should(kept).deepEqual({ text: before, savedAt: NOW, source: 'default' });
    should(undone).deepEqual({
      outcome: 'applied',
      message: 'Undone: the default routing prompt, built from the model catalogs, is in effect again.',
    });
    should(subject.state.text).equal(before);
  });

  it('should undo an accept made with no file at all by taking out what it wrote, and keep what came after', async () => {
    // Arrange
    const subject = world(undefined);
    await subject.service.accept({ prompt: PROMPT, suggested: SUGGESTED });
    should(subject.file()).deepEqual({ prompt: PROMPT, suggested: { ...SUGGESTED, acceptedAt: NOW } });
    should(subject.replaced()).deepEqual({ text: null, savedAt: NOW, source: 'default' });
    subject.state.text = `${subject.state.text ?? ''}useCases: []\n`;

    // Act
    const undone = await subject.service.undo();

    // Assert
    should(undone.outcome).equal('applied');
    should(subject.replaced()).be.undefined();
    should(subject.file()).deepEqual({ useCases: [] });
    should(subject.state.text).containEql(GUIDE_MODELINE);
    should(subject.state.text).not.containEql('prompt:');
    should(subject.state.text).not.containEql('suggested:');
  });

  it('should undo a prompt-less accept to an empty file when nothing else was written', async () => {
    // Arrange
    const subject = world(undefined);
    await subject.service.accept({ prompt: PROMPT, suggested: SUGGESTED });

    // Act
    await subject.service.undo();

    // Assert
    should(subject.file()).deepEqual({});
    should(await subject.service.undoable()).be.undefined();
  });

  it('should write only the keys that change, so another key and its comment survive an accept', async () => {
    // Arrange
    const subject = world(`${GUIDE_MODELINE}\n# legacy, migrated elsewhere\nuseCases: []\n`);

    // Act
    await subject.service.accept({ prompt: PROMPT, suggested: SUGGESTED });

    // Assert
    should(subject.state.text).containEql('# legacy, migrated elsewhere');
    should(subject.file()).deepEqual({ useCases: [], prompt: PROMPT, suggested: { ...SUGGESTED, acceptedAt: NOW } });
  });

  it('should say what an undo would put back from a kept file, without reading the guide', async () => {
    // Arrange
    const subject = world('prompt: Mine.\n', { text: 'prompt: Old.\n', savedAt: NOW, source: 'file' });

    // Act
    const actual = await subject.service.undoable();

    // Assert
    should(actual).deepEqual({ savedAt: NOW, source: 'file' });
    should(subject.state.writes).equal(0);
  });

  it('should refuse to edit a file that does not parse, and keep nothing', async () => {
    // Arrange
    const subject = world('prompt: [unclosed');

    // Act + Assert
    await should(subject.service.accept({ prompt: PROMPT, suggested: SUGGESTED })).be.rejectedWith(/does not parse/u);
    should(subject.replaced()).be.undefined();
    should(subject.state.writes).equal(0);
  });
});

describe('rawOf and without', () => {
  it('should read no file, an empty file and a mapping as a record, and refuse what is not one', () => {
    // Act + Assert
    should(rawOf({ exists: false, text: '', etag: 'e' })).deepEqual({});
    should(rawOf({ exists: true, text: '', etag: 'e' })).deepEqual({});
    should(rawOf({ exists: true, text: '# only a comment\n', etag: 'e' })).deepEqual({});
    should(rawOf({ exists: true, text: 'prompt: Mine.\n', etag: 'e' })).deepEqual({ prompt: 'Mine.' });
    should(() => rawOf({ exists: true, text: '- a\n- b\n', etag: 'e' })).throw(/does not parse/u);
    should(() => rawOf({ exists: true, text: 'prompt: [unclosed', etag: 'e' })).throw(/does not parse/u);
  });

  it('should drop the named keys and leave the rest, without changing the record it was given', () => {
    // Arrange
    const input = { prompt: 'p', suggested: { by: 'x' }, other: 1 };

    // Act
    const actual = without(input, 'prompt', 'suggested');

    // Assert
    should(actual).deepEqual({ other: 1 });
    should(Object.keys(input)).deepEqual(['prompt', 'suggested', 'other']);
  });
});
