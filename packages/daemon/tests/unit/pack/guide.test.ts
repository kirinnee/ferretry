import { describe, it } from 'bun:test';
import should from 'should';
import {
  DERIVED_CANDIDATES,
  deriveGuide,
  effectiveGuide,
  fleetModels,
  PROVIDER_PREFERENCE,
} from '../../../src/lib/pack/guide.ts';
import { catalog, choice, entry, runtime } from './support.ts';

const ANTHROPIC = catalog('anthropic', 'Anthropic', {
  claude: [
    entry('opus', 'Opus', 'best', { efforts: ['low', 'high'], context: 1_000_000 }),
    entry('sonnet', 'Sonnet', 'balanced', { context: 200_000 }),
    entry('haiku', 'Haiku', 'fast', { efforts: ['low', 'medium'], context: 200_000 }),
  ],
});
const OPENAI = catalog('openai', 'OpenAI', {
  codex: [entry('gpt-5', 'GPT-5', 'best', { efforts: ['minimal', 'xhigh'] }), entry('gpt-mini', 'GPT Mini', 'fast')],
});
const GATEWAY = catalog('gateway', 'A Gateway', {
  claude: [
    entry('gw-opus', 'OPUS', 'best', { efforts: ['high'] }),
    entry('gw-own', 'Gateway Own', 'best', { context: 2_000_000 }),
  ],
});

const useCase = (id: string, guide: ReturnType<typeof deriveGuide>) => {
  const found = guide.find(candidate => candidate.id === id);
  if (found === undefined) throw new Error(`no use case ${id}`);
  return found;
};

describe('deriveGuide', () => {
  it('should offer the five use cases in a fixed order', () => {
    // Arrange / Act
    const guide = deriveGuide([ANTHROPIC]);

    // Assert
    should(guide.map(row => row.id)).deepEqual(['plan-review', 'everyday', 'bulk', 'second-opinion', 'long-context']);
  });

  it('should prefer providers in the declared order, then unknown ones in catalog order', () => {
    // Arrange
    const unknownA = catalog('zeta', 'Zeta', { claude: [entry('z1', 'Zed One', 'best')] });
    const unknownB = catalog('alpha', 'Alpha', { claude: [entry('a1', 'Alpha One', 'best')] });

    // Act
    const planning = useCase('plan-review', deriveGuide([unknownA, GATEWAY, unknownB, OPENAI, ANTHROPIC]));

    // Assert
    should(PROVIDER_PREFERENCE[0]).equal('anthropic');
    should(planning.candidates.map(candidate => candidate.provider)).deepEqual([
      'anthropic',
      'openai',
      'zeta',
      'gateway',
      'alpha',
    ]);
  });

  it('should list the same model resold by another catalog once, under its preferred catalog', () => {
    // Arrange / Act
    const planning = useCase('plan-review', deriveGuide([GATEWAY, ANTHROPIC]));

    // Assert
    should(planning.candidates.map(candidate => candidate.model)).deepEqual(['opus', 'gw-own']);
  });

  it('should pick the strongest tier at its highest effort for planning, naming the codex CLI', () => {
    // Arrange / Act
    const planning = useCase('plan-review', deriveGuide([ANTHROPIC, OPENAI]));

    // Assert
    should(planning.candidates).deepEqual([
      {
        provider: 'anthropic',
        model: 'opus',
        effort: 'high',
        why: 'Opus — the strongest tier on Anthropic, at high effort.',
      },
      {
        provider: 'openai',
        model: 'gpt-5',
        harness: 'codex',
        effort: 'xhigh',
        why: 'GPT-5 — the strongest tier on OpenAI, at xhigh effort.',
      },
    ]);
  });

  it('should put the balanced tier before the strongest for everyday coding, with no effort', () => {
    // Arrange / Act
    const everyday = useCase('everyday', deriveGuide([ANTHROPIC, OPENAI]));

    // Assert
    should(everyday.candidates.map(candidate => candidate.model)).deepEqual(['sonnet', 'opus', 'gpt-5']);
    should(everyday.candidates[0]).deepEqual({
      provider: 'anthropic',
      model: 'sonnet',
      why: 'Sonnet — the balanced tier on Anthropic.',
    });
  });

  it('should pick the fast tier at its lowest effort for bulk work, and say nothing of effort when there is none', () => {
    // Arrange / Act
    const bulk = useCase('bulk', deriveGuide([ANTHROPIC, OPENAI]));

    // Assert
    should(bulk.candidates).deepEqual([
      {
        provider: 'anthropic',
        model: 'haiku',
        effort: 'low',
        why: 'Haiku — the fast, cheap tier on Anthropic, at low effort.',
      },
      { provider: 'openai', model: 'gpt-mini', harness: 'codex', why: 'GPT Mini — the fast, cheap tier on OpenAI.' },
    ]);
  });

  it('should ask a different family for a second opinion', () => {
    // Arrange / Act
    const second = useCase('second-opinion', deriveGuide([ANTHROPIC, OPENAI, GATEWAY]));

    // Assert
    should(second.candidates.map(candidate => candidate.model)).deepEqual(['gpt-5', 'gw-own']);
    should(second.candidates[0]?.why).equal('GPT-5 — the strongest tier on OpenAI, a different family.');
    should(second.candidates[0]?.effort).equal('xhigh');
  });

  it('should order long-context reading by window, longest first, leaving out models with none', () => {
    // Arrange / Act
    const long = useCase('long-context', deriveGuide([ANTHROPIC, OPENAI, GATEWAY]));

    // Assert
    should(long.candidates.map(candidate => candidate.model)).deepEqual(['gw-own', 'opus', 'sonnet', 'haiku']);
    should(long.candidates[0]).deepEqual({
      provider: 'gateway',
      model: 'gw-own',
      why: 'Gateway Own — reads 2000k tokens at once, on A Gateway.',
    });
    should(long.candidates[1]?.effort).equal('low');
    should(long.candidates[2]?.effort).be.undefined();
  });

  it('should list no more than the derived limit per use case', () => {
    // Arrange
    const many = catalog('anthropic', 'Anthropic', {
      claude: Array.from({ length: 9 }, (_, index) => entry(`m${String(index)}`, `Model ${String(index)}`, 'best')),
    });

    // Act
    const planning = useCase('plan-review', deriveGuide([many]));

    // Assert
    should(planning.candidates).have.length(DERIVED_CANDIDATES);
  });

  it('should derive empty use cases from no catalogs at all', () => {
    // Arrange / Act
    const guide = deriveGuide([]);

    // Assert
    should(guide.every(row => row.candidates.length === 0)).be.true();
  });
});

describe('effectiveGuide', () => {
  it('should use the derived guide when the file names no use cases', () => {
    // Arrange / Act
    const guide = effectiveGuide({}, [ANTHROPIC]);

    // Assert
    should(guide.source).equal('derived');
    should(guide.useCases).deepEqual(deriveGuide([ANTHROPIC]));
  });

  it('should use the owner’s use cases when the file names any, even none', () => {
    // Arrange
    const mine = { id: 'mine', title: 'Mine', description: 'My own.', candidates: [] };

    // Act
    const named = effectiveGuide({ useCases: [mine] }, [ANTHROPIC]);
    const empty = effectiveGuide({ useCases: [] }, [ANTHROPIC]);

    // Assert
    should(named).deepEqual({ source: 'file', useCases: [mine] });
    should(empty).deepEqual({ source: 'file', useCases: [] });
  });
});

describe('fleetModels', () => {
  it('should list every model of every catalog and CLI with the runtimes here that run it', () => {
    // Arrange
    const claudeRuntime = runtime('claude-main', {
      catalogId: 'anthropic',
      choices: [choice('opus', 'Opus'), choice('haiku', 'Haiku')],
    });
    const codexRuntime = runtime('codex-main', {
      harness: 'codex',
      catalogId: 'openai',
      choices: [choice('gpt-5', 'GPT-5')],
    });

    // Act
    const models = fleetModels([OPENAI, ANTHROPIC], [claudeRuntime, codexRuntime]);

    // Assert
    should(models.map(model => [model.provider, model.harness, model.id, model.runtimes])).deepEqual([
      ['anthropic', 'claude', 'opus', ['claude-main']],
      ['anthropic', 'claude', 'sonnet', []],
      ['anthropic', 'claude', 'haiku', ['claude-main']],
      ['openai', 'codex', 'gpt-5', ['codex-main']],
      ['openai', 'codex', 'gpt-mini', []],
    ]);
    should(models[0]).deepEqual({
      provider: 'anthropic',
      providerLabel: 'Anthropic',
      harness: 'claude',
      id: 'opus',
      label: 'Opus',
      tier: 'best',
      context: 1_000_000,
      efforts: ['low', 'high'],
      runtimes: ['claude-main'],
    });
    should(models[3]?.context).be.undefined();
    should('context' in (models[3] ?? {})).be.false();
  });

  it('should leave out runtimes that are not agents or run another CLI', () => {
    // Arrange
    const notAgent = runtime('terminal-only', {
      agent: false,
      catalogId: 'anthropic',
      choices: [choice('opus', 'Opus')],
    });
    const otherCli = runtime('codex-on-anthropic', {
      harness: 'codex',
      catalogId: 'anthropic',
      choices: [choice('opus', 'Opus')],
    });
    const noCatalog = runtime('no-catalog');

    // Act
    const models = fleetModels([ANTHROPIC], [notAgent, otherCli, noCatalog]);

    // Assert
    should(models.every(model => model.runtimes.length === 0)).be.true();
  });
});
