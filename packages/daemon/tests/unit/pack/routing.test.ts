import { describe, it } from 'bun:test';
import { MAX_ROUTING_PROMPT_CHARS, ModelsGuideFileSchema, RoutingPromptSchema } from '@ferretry/protocol';
import should from 'should';
import {
  cut,
  defaultPrompt,
  effectiveRouting,
  fleetModels,
  legacyPrompt,
  PROVIDER_PREFERENCE,
  ROUTING_LINE_PREFIX,
  routingLine,
} from '../../../src/lib/pack/routing.ts';
import { catalog, choice, entry, runtime } from './support.ts';

const ANTHROPIC = catalog('anthropic', 'Anthropic', {
  claude: [
    entry('opus', 'Opus', 'best', { efforts: ['low', 'high', 'max'], context: 1_000_000 }),
    entry('sonnet', 'Sonnet', 'balanced', { context: 200_000 }),
    entry('haiku', 'Haiku', 'fast', { efforts: ['low', 'medium'] }),
  ],
});
const OPENAI = catalog('openai', 'OpenAI', {
  codex: [
    entry('gpt-5', 'GPT-5', 'best', { efforts: ['minimal', 'xhigh'] }),
    entry('gpt-mid', 'GPT Mid', 'balanced'),
    entry('gpt-mini', 'GPT Mini', 'fast'),
  ],
});
const GATEWAY = catalog('gateway', 'A Gateway', {
  claude: [entry('gw-opus', 'Opus', 'best', { efforts: ['high'] }), entry('gw-own', 'Gateway Own', 'best')],
});
const ALL = [GATEWAY, OPENAI, ANTHROPIC];

describe('fleetModels', () => {
  it('should list every catalog entry in provider preference order, with the runtimes here that run each', () => {
    // Arrange
    const here = [
      runtime('claude-main', { catalogId: 'anthropic', choices: [choice('opus', 'Opus'), choice('sonnet', 'Sonnet')] }),
      runtime('codex-main', { harness: 'codex', catalogId: 'openai', choices: [choice('gpt-5', 'GPT-5')] }),
      runtime('cli-only', { catalogId: 'anthropic', choices: [choice('opus', 'Opus')], agent: false }),
    ];

    // Act
    const models = fleetModels(ALL, here);

    // Assert
    should(models.map(model => `${model.provider}/${model.id}`)).deepEqual([
      'anthropic/opus',
      'anthropic/sonnet',
      'anthropic/haiku',
      'openai/gpt-5',
      'openai/gpt-mid',
      'openai/gpt-mini',
      'gateway/gw-opus',
      'gateway/gw-own',
    ]);
    should(models.find(model => model.id === 'opus')?.runtimes).deepEqual(['claude-main']);
    should(models.find(model => model.id === 'gpt-5')?.runtimes).deepEqual(['codex-main']);
    should(models.find(model => model.id === 'haiku')?.runtimes).deepEqual([]);
    should(models.find(model => model.id === 'opus')).not.have.property('description');
    should(PROVIDER_PREFERENCE[0]).equal('anthropic');
  });
});

describe('defaultPrompt', () => {
  it('should name the strongest tier at its highest effort for planning, another family second, balanced for everyday and fast for chores', () => {
    // Act
    const prompt = defaultPrompt(fleetModels(ALL, []), 'fy');

    // Assert
    should(prompt).equal(
      [
        "Pick each sub-task's model by the kind of work:",
        '- Planning, review and the hardest or most critical code: opus at max; for a second opinion from another family, gpt-5 at xhigh.',
        '- Everyday coding: sonnet, then gpt-mid.',
        '- Mechanical chores and bulk edits: haiku at low.',
        'Prefer a login with quota left. When a model is refused, take the next one named here.',
      ].join('\n'),
    );
    should(RoutingPromptSchema.safeParse(prompt).success).be.true();
  });

  it('should prefer a model a runtime here runs over a better-placed one nothing here runs', () => {
    // Arrange
    const here = [
      runtime('codex-main', { harness: 'codex', catalogId: 'openai', choices: [choice('gpt-5', 'GPT-5')] }),
    ];

    // Act
    const prompt = defaultPrompt(fleetModels(ALL, here), 'fy');

    // Assert
    should(prompt).containEql('critical code: gpt-5 at xhigh; for a second opinion from another family, opus at max.');
  });

  it('should leave out a tier no catalog lists, and say so when there is nothing at all', () => {
    // Arrange
    const bestOnly = catalog('anthropic', 'Anthropic', { claude: [entry('opus', 'Opus', 'best')] });

    // Act
    const some = defaultPrompt(fleetModels([bestOnly], []), 'fy');
    const none = defaultPrompt([], 'zz');

    // Assert
    should(some).containEql('critical code: opus.');
    should(some).not.containEql('Everyday');
    should(some).not.containEql('chores');
    should(none).containEql('`zz recommend` shows what can run.');
  });
});

describe('effectiveRouting', () => {
  it("should be the file's prompt, with where an accepted clean-up came from", () => {
    // Arrange
    const suggested = {
      by: 'opus',
      via: 'claude-main',
      at: '2026-10-22T00:00:00Z',
      acceptedAt: '2026-10-22T01:00:00Z',
    };

    // Act
    const actual = effectiveRouting({ prompt: 'Everything on opus.', suggested }, ALL, []);

    // Assert
    should(actual).deepEqual({ text: 'Everything on opus.', source: 'file', suggested });
  });

  it('should be the default rendered from the catalogs when the file has no prompt', () => {
    should(effectiveRouting({}, ALL, [])).deepEqual({
      text: defaultPrompt(fleetModels(ALL, []), 'fy'),
      source: 'default',
    });
  });

  it('should render an old use-case guide the migration has not reached yet, so nothing it said is lost meanwhile', () => {
    // Arrange
    const file = ModelsGuideFileSchema.parse({
      useCases: [{ id: 'bulk', title: 'Bulk', candidates: [{ provider: 'anthropic', model: 'haiku', why: 'cheap' }] }],
    });

    // Act
    const actual = effectiveRouting(file, ALL, []);

    // Assert
    should(actual.source).equal('file');
    should(actual.text).containEql('- Bulk: haiku.');
  });

  it('should fall back to the default for an old file that only described models', () => {
    should(effectiveRouting({ models: [{ provider: 'zai', model: 'glm', description: 'x' }] }, ALL, []).source).equal(
      'default',
    );
  });
});

describe('routingLine', () => {
  it('should make the prompt one line: bullets dropped, a sentence end kept, other lines joined with "; "', () => {
    // Act
    const line = routingLine('Pick by work:\n- Planning: opus at max\n- Chores: haiku.\n\nPrefer quota left');

    // Assert
    should(line).equal(`${ROUTING_LINE_PREFIX}Pick by work: Planning: opus at max; Chores: haiku. Prefer quota left`);
  });

  it('should leave nothing that could break either harness quoting', () => {
    // Act
    const line = routingLine('Use "opus" \\ for\tplans\u0007 now');

    // Assert
    should(line).equal("Routing: Use 'opus' for plans now");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it must not hold
    should(line).not.match(/["\\\u0000-\u001f\u007f]/u);
  });

  it('should stay within the prompt limit and its prefix for the longest prompt', () => {
    should(routingLine('x'.repeat(MAX_ROUTING_PROMPT_CHARS)).length).equal(
      ROUTING_LINE_PREFIX.length + MAX_ROUTING_PROMPT_CHARS,
    );
  });
});

describe('cut', () => {
  it('should keep text that fits whole, and cut longer text at a sentence end with an ellipsis', () => {
    should(cut('short', 10)).deepEqual({ text: 'short', cut: false });
    const actual = cut('First sentence here. Second one is long and goes on.', 30);
    should(actual).deepEqual({ text: 'First sentence here.…', cut: true });
    should(cut('x'.repeat(50), 20).text.length).equal(20);
  });
});

describe('legacyPrompt', () => {
  const BASE = 'The default prompt.';
  const useCases = [
    {
      id: 'plan-review',
      title: 'Hard planning',
      candidates: [
        { provider: 'anthropic', model: 'opus', effort: 'max', why: 'x' },
        { provider: 'openai', model: 'gpt-5', harness: 'codex', effort: 'xhigh', why: 'y' },
        { provider: 'zai', model: 'glm', why: 'z' },
        { provider: 'kimi', model: 'k2', why: 'dropped: past three' },
      ],
    },
    { id: 'bulk', title: 'Bulk edits', candidates: [] },
  ];

  it('should render each use case with its first three candidates, then the routing prompt, then the preferences', () => {
    // Act
    const actual = legacyPrompt(
      { useCases, routing: { prompt: 'Keep Opus for reviews.', short: 'Routing: x.' } },
      'GLM for bulk work.',
      BASE,
    );

    // Assert
    should(actual).deepEqual({
      text: [
        "Pick each sub-task's model by the kind of work, best first:",
        '- Hard planning: opus at max, then gpt-5 (codex) at xhigh, then glm.',
        '- Bulk edits: no model named.',
        'Keep Opus for reviews.',
        'Preferences: GLM for bulk work.',
      ].join('\n'),
      cut: false,
    });
  });

  it('should stand the default prompt in for a guide that named no use cases', () => {
    should(legacyPrompt({ routing: { prompt: 'Opus first.', short: 'x' } }, undefined, BASE)).deepEqual({
      text: `${BASE}\nOpus first.`,
      cut: false,
    });
    should(legacyPrompt({}, 'Only preferences.', BASE)?.text).equal(`${BASE}\nPreferences: Only preferences.`);
  });

  it('should be nothing for a file that said nothing a prompt could carry', () => {
    should(
      legacyPrompt({ models: [{ provider: 'zai', model: 'glm', description: 'Cheap.' }] }, '  ', BASE),
    ).be.undefined();
  });

  it('should keep the use cases whole and cut the prose to fit, saying it was cut', () => {
    // Act
    const actual = legacyPrompt(
      { useCases, routing: { prompt: `${'A long sentence about routing. '.repeat(60)}`, short: 'x' } },
      undefined,
      BASE,
    );

    // Assert
    should(actual?.cut).be.true();
    should(actual?.text.length).be.belowOrEqual(MAX_ROUTING_PROMPT_CHARS);
    should(actual?.text).containEql('- Hard planning: opus at max');
    should(actual?.text.endsWith('…')).be.true();
  });

  it('should skip a candidate that names no model, keeping the ones that do', () => {
    should(
      legacyPrompt(
        {
          useCases: [
            { id: 'chores', title: 'Chores', candidates: [{ effort: 'low' }, { model: 'haiku', effort: 'low' }] },
          ],
        },
        undefined,
        BASE,
      )?.text,
    ).containEql('- Chores: haiku at low.');
  });

  it('should read leniently: a use case without a title or candidates that are not objects', () => {
    should(
      legacyPrompt({ useCases: [{ id: 'only-id', candidates: ['nope', { model: 'opus' }] }, 'junk'] }, undefined, BASE)
        ?.text,
    ).containEql('- only-id: opus.');
  });
});
