import { describe, it } from 'bun:test';
import { readConfigText } from '@ferretry/fleet/config-text';
import { MAX_ROUTING_PROMPT_CHARS, ModelsGuideFileSchema, PackFileSchema } from '@ferretry/protocol';
import should from 'should';
import type { GuideFileText } from '../../../src/lib/pack/cleanup/file.ts';
import { RoutingMigration, type RoutingMigrationBackup } from '../../../src/lib/pack/migrate.ts';

const NOW = '2026-10-23T09:00:00.000Z';
const DEFAULT = "Pick each sub-task's model by the kind of work:\n- Everyday coding: sonnet.";

const LEGACY_GUIDE = [
  '# yaml-language-server: $schema=.schema/modelsGuide.json',
  '# my guide',
  'useCases:',
  '  - id: plan-review',
  '    title: Hard planning',
  '    description: Plans.',
  '    candidates:',
  '      - provider: anthropic',
  '        model: claude-opus-5-5',
  '        effort: max',
  '        why: Strongest.',
  '      - provider: openai',
  '        model: gpt-6-astra',
  '        harness: codex',
  '        why: Second family.',
  '  - id: bulk',
  '    title: Bulk edits',
  '    description: Chores.',
  '    candidates:',
  '      - provider: anthropic',
  '        model: claude-haiku-5-5',
  '        effort: low',
  '        why: Cheap.',
  'routing:',
  '  prompt: Keep Opus for reviews.',
  '  short: "Routing: plan-review → claude-opus-5-5 max."',
  'models:',
  '  - provider: zai',
  '    model: glm-5.3',
  '    description: Cheap and fast.',
  'suggested:',
  '  by: gpt-oss-120b',
  '  via: claude-work',
  '  at: 2026-10-22T00:00:00.000Z',
  '  acceptedAt: 2026-10-22T01:00:00.000Z',
  '  partial: true',
  '',
].join('\n');

const LEGACY_PACK = [
  '# yaml-language-server: $schema=.schema/pack.json',
  'enabled: true',
  'decision: jev',
  'routingPreferences: GLM for bulk work.',
  '',
].join('\n');

const file = (text: string | undefined, etag: string): GuideFileText =>
  text === undefined ? { exists: false, text: '', etag } : { exists: true, text, etag };

function build(guide: string | undefined, pack: string | undefined) {
  const state = { guide: file(guide, 'g1'), pack: file(pack, 'p1') };
  const events: string[] = [];
  const backups: RoutingMigrationBackup[] = [];
  const subject = new RoutingMigration({
    readGuide: async () => state.guide,
    writeGuide: async (text, etag) => {
      events.push(`guide@${etag}`);
      state.guide = file(text, `${etag}+`);
    },
    readPack: async () => state.pack,
    writePack: async (text, etag) => {
      events.push(`pack@${etag}`);
      state.pack = file(text, `${etag}+`);
    },
    defaultPrompt: async () => DEFAULT,
    backup: async value => {
      events.push('backup');
      backups.push(value);
      return `/state/pack-routing-migration-${String(backups.length)}.json`;
    },
    now: () => NOW,
  });
  return { subject, state, events, backups };
}

const parsed = (text: string): Record<string, unknown> => {
  const read = readConfigText(text);
  if (!read.ok) throw new Error('does not parse');
  return read.read.value as Record<string, unknown>;
};

describe('RoutingMigration', () => {
  it('should do nothing at all for a machine with none of the old keys', async () => {
    // Arrange
    const { subject, events } = build('prompt: Everything on opus.\n', 'decision: agent\n');
    const empty = build(undefined, undefined);

    // Act / Assert
    should(await subject.run()).deepEqual({ outcome: 'nothing' });
    should(await empty.subject.run()).deepEqual({ outcome: 'nothing' });
    should(events).be.empty();
    should(empty.events).be.empty();
  });

  it('should render the use cases, the routing prompt and the preferences into one prompt, backing both files up first', async () => {
    // Arrange
    const { subject, state, events, backups } = build(LEGACY_GUIDE, LEGACY_PACK);

    // Act
    const outcome = await subject.run();

    // Assert
    const prompt = [
      "Pick each sub-task's model by the kind of work, best first:",
      '- Hard planning: claude-opus-5-5 at max, then gpt-6-astra (codex).',
      '- Bulk edits: claude-haiku-5-5 at low.',
      'Keep Opus for reviews.',
      'Preferences: GLM for bulk work.',
    ].join('\n');
    should(outcome).deepEqual({
      outcome: 'migrated',
      prompt,
      cut: false,
      backup: '/state/pack-routing-migration-1.json',
    });
    should(events).deepEqual(['backup', 'guide@g1', 'pack@p1']);
    should(backups).deepEqual([{ at: NOW, modelsGuide: LEGACY_GUIDE, pack: LEGACY_PACK, prompt, cut: false }]);
    const guide = parsed(state.guide.text);
    should(guide).deepEqual({ prompt });
    should(ModelsGuideFileSchema.safeParse(guide).success).be.true();
    should(state.guide.text).startWith('# yaml-language-server: $schema=.schema/modelsGuide.json');
    const pack = parsed(state.pack.text);
    should(pack).deepEqual({ enabled: true, decision: 'jev' });
    should(PackFileSchema.safeParse(pack).success).be.true();
  });

  it('should run once: a second start finds nothing to do', async () => {
    // Arrange
    const { subject, events } = build(LEGACY_GUIDE, LEGACY_PACK);
    await subject.run();

    // Act
    const again = await subject.run();

    // Assert
    should(again).deepEqual({ outcome: 'nothing' });
    should(events).deepEqual(['backup', 'guide@g1', 'pack@p1']);
  });

  it('should keep a prompt the file already has, and only take the old keys out', async () => {
    // Arrange
    const guide = [
      'prompt: Mine.',
      'suggested:',
      '  by: m',
      '  via: r',
      '  at: 2026-10-22T00:00:00.000Z',
      '  acceptedAt: 2026-10-22T00:00:00.000Z',
      'models:',
      '  - provider: zai',
      '    model: glm-5.3',
      '    description: Cheap.',
      '',
    ].join('\n');
    const { subject, state, backups } = build(guide, undefined);

    // Act
    const outcome = await subject.run();

    // Assert
    should(outcome).deepEqual({ outcome: 'migrated', cut: false, backup: '/state/pack-routing-migration-1.json' });
    should(parsed(state.guide.text)).deepEqual({
      prompt: 'Mine.',
      suggested: { by: 'm', via: 'r', at: '2026-10-22T00:00:00.000Z', acceptedAt: '2026-10-22T00:00:00.000Z' },
    });
    should(backups[0]).deepEqual({ at: NOW, modelsGuide: guide, pack: null, cut: false });
  });

  it('should put preferences after the default prompt when the machine never wrote a guide', async () => {
    // Arrange
    const { subject, state, events } = build(undefined, 'routingPreferences: Opus for reviews.\n');

    // Act
    const outcome = await subject.run();

    // Assert
    should(outcome).containDeep({ outcome: 'migrated', prompt: `${DEFAULT}\nPreferences: Opus for reviews.` });
    should(events).deepEqual(['backup', 'guide@g1', 'pack@p1']);
    should(parsed(state.guide.text)).deepEqual({ prompt: `${DEFAULT}\nPreferences: Opus for reviews.` });
    should(parsed(state.pack.text)).deepEqual({});
  });

  it('should leave a guide that only described models to the default prompt, keeping the descriptions in the backup', async () => {
    // Arrange
    const guide = 'models:\n  - provider: zai\n    model: glm-5.3\n    description: Cheap.\n';
    const { subject, state, backups } = build(guide, undefined);

    // Act
    await subject.run();

    // Assert
    should(parsed(state.guide.text) ?? {}).deepEqual({});
    should(backups[0]?.modelsGuide).equal(guide);
    should(backups[0]).not.have.property('prompt');
  });

  it('should cut what does not fit, keeping the use cases whole, and say so', async () => {
    // Arrange
    const long = 'Prefer the strongest model for anything risky. '.repeat(40);
    const { subject, state } = build(undefined, `routingPreferences: ${long}\n`);

    // Act
    const outcome = await subject.run();

    // Assert
    should(outcome).containDeep({ outcome: 'migrated', cut: true });
    const prompt = String(parsed(state.guide.text).prompt);
    should(prompt.length).be.belowOrEqual(MAX_ROUTING_PROMPT_CHARS);
    should(prompt).startWith(DEFAULT);
  });
});
