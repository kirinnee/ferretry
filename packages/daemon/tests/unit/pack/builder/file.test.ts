import { describe, it } from 'bun:test';
import { readConfigText } from '@ferretry/fleet/config-text';
import { ModelsGuideFileSchema } from '@ferretry/protocol';
import should from 'should';
import { GuideFileService, GuideModelUnknownError, type ReplacedGuide } from '../../../../src/lib/pack/builder/file.ts';
import { catalog, entry } from '../support.ts';

const NOW = '2026-10-22T12:00:00.000Z';
const SUGGESTED = { by: 'opus', via: 'claude-main', at: '2026-10-22T11:00:00.000Z' };
const ROUTING = { prompt: 'Plan on Opus.', short: 'Routing: plan → opus.' };
const USE_CASES = [
  {
    id: 'plan-review',
    title: 'Planning',
    description: 'Plans.',
    candidates: [{ provider: 'anthropic', model: 'opus', why: 'Strongest.' }],
  },
];
const CATALOGS = [
  catalog('anthropic', 'Anthropic', { claude: [entry('opus', 'Opus', 'best'), entry('shared', 'Shared', 'fast')] }),
  catalog('bedrock', 'Bedrock', {
    claude: [entry('shared', 'Shared', 'fast'), entry('b-opus', 'Bedrock Opus', 'best')],
  }),
];

/** models-guide.yaml in memory, written through the same edits the real writer is given. */
function world(initial: string | undefined) {
  const state = { text: initial, writes: 0, etags: [] as string[] };
  let replaced: ReplacedGuide | undefined;
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
    catalogs: async () => CATALOGS,
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
  it('should write the reviewed guide with where it came from, keep comments and descriptions, and undo exactly', async () => {
    // Arrange
    const before = [
      '# yaml-language-server: $schema=.schema/modelsGuide.json',
      '# my notes stay',
      'models:',
      '  - provider: anthropic',
      '    model: opus',
      '    description: Strongest; slow.',
      '',
    ].join('\n');
    const subject = world(before);

    // Act
    const accepted = await subject.service.accept({
      useCases: USE_CASES,
      routing: ROUTING,
      suggested: SUGGESTED,
      partial: true,
    });

    // Assert
    should(accepted).deepEqual({
      outcome: 'applied',
      message:
        'The guide now has 1 use case and its routing guidance, suggested by opus. Undo puts the previous one back.',
    });
    should(subject.file()).deepEqual({
      models: [{ provider: 'anthropic', model: 'opus', description: 'Strongest; slow.' }],
      useCases: USE_CASES,
      routing: ROUTING,
      suggested: { ...SUGGESTED, acceptedAt: NOW, partial: true },
    });
    should(subject.state.text).containEql('# my notes stay');
    should(subject.state.etags).deepEqual(['etag-0']);
    should(await subject.service.undoable()).deepEqual({ savedAt: NOW, source: 'derived' });

    // Act — undo
    const undone = await subject.service.undo();

    // Assert
    should(undone).deepEqual({
      outcome: 'applied',
      message: 'Undone: the guide built from the model catalogs is in effect again.',
    });
    should(subject.state.text).equal(before);
    should(await subject.service.undoable()).be.undefined();
    should(await subject.service.undo()).deepEqual({
      outcome: 'nothing',
      message: 'There is no accepted suggestion to undo.',
    });
  });

  it("should undo to the owner's own guide, and leave the routing alone when none was accepted", async () => {
    // Arrange
    const subject = world('useCases: []\nrouting:\n  prompt: Mine.\n  short: "Routing: mine."\n');

    // Act
    const accepted = await subject.service.accept({
      useCases: [...USE_CASES, { ...USE_CASES[0], id: 'other' } as never],
      suggested: SUGGESTED,
    });

    // Assert
    should(accepted.message).equal(
      'The guide now has 2 use cases, suggested by opus. Undo puts the previous one back.',
    );
    should(subject.file().routing).deepEqual({ prompt: 'Mine.', short: 'Routing: mine.' });
    should(subject.file().suggested).deepEqual({ ...SUGGESTED, acceptedAt: NOW });
    should((await subject.service.undo()).message).equal('Undone: the guide you had before is back.');
    should(subject.file()).deepEqual({ useCases: [], routing: { prompt: 'Mine.', short: 'Routing: mine.' } });
  });

  it('should undo an accept made with no file by taking out what it wrote and keeping later descriptions', async () => {
    // Arrange
    const subject = world(undefined);
    await subject.service.accept({ useCases: USE_CASES, routing: ROUTING, suggested: SUGGESTED });
    await subject.service.describe({ model: 'opus', description: 'Added after.' });

    // Act
    await subject.service.undo();

    // Assert
    should(subject.replaced()).be.undefined();
    should(subject.file()).deepEqual({
      models: [{ provider: 'anthropic', model: 'opus', description: 'Added after.' }],
    });
    should(subject.state.text).startWith('# yaml-language-server: $schema=.schema/modelsGuide.json');
  });

  it('should refuse to edit a file that does not parse', async () => {
    // Arrange
    const subject = world('useCases: [unclosed');

    // Act + Assert
    await should(subject.service.accept({ useCases: USE_CASES, suggested: SUGGESTED })).be.rejectedWith(
      /does not parse/u,
    );
    should(subject.replaced()).be.undefined();
  });
});

describe('GuideFileService.describe', () => {
  it("should set, replace and clear the owner's description, finding the catalog from the id or the label", async () => {
    // Arrange
    const subject = world(undefined);

    // Act
    const set = await subject.service.describe({ model: 'opus', description: 'Strongest.' });
    await subject.service.describe({ model: 'Bedrock Opus', description: 'Through Bedrock.' });
    await subject.service.describe({
      provider: 'anthropic',
      model: 'opus',
      description: 'Strongest; use for reviews.',
    });
    const afterSet = subject.file().models;
    const cleared = await subject.service.describe({ model: 'opus', description: null });
    await subject.service.describe({ provider: 'bedrock', model: 'b-opus', description: null });

    // Assert
    should(set).deepEqual({ outcome: 'applied', message: 'Saved your description of anthropic opus.' });
    should(afterSet).deepEqual([
      { provider: 'bedrock', model: 'b-opus', description: 'Through Bedrock.' },
      { provider: 'anthropic', model: 'opus', description: 'Strongest; use for reviews.' },
    ]);
    should(cleared.message).equal('anthropic opus is described by its catalog again.');
    should(subject.file()).deepEqual({});
  });

  it('should refuse a model no catalog lists, and one two catalogs list, naming them', async () => {
    // Arrange
    const subject = world(undefined);

    // Act + Assert
    const ghost = await subject.service.describe({ model: 'ghost', description: 'x' }).catch((error: unknown) => error);
    const shared = await subject.service
      .describe({ model: 'shared', description: 'x' })
      .catch((error: unknown) => error);
    should(ghost).be.instanceOf(GuideModelUnknownError).and.have.property('message', 'No catalog lists ghost.');
    should(shared)
      .be.instanceOf(GuideModelUnknownError)
      .and.have.property('message', 'shared is listed by anthropic, bedrock; name the provider too.');
    should(subject.state.writes).equal(0);
  });
});
