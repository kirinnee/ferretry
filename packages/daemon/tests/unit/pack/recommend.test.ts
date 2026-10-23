import { describe, it } from 'bun:test';
import type { FleetCredentialView, ModelCatalogView, PackModelOption } from '@ferretry/protocol';
import should from 'should';
import {
  automaticOrder,
  availableModels,
  newCommand,
  offers,
  type PackFleetFacts,
  runtimeRefusal,
} from '../../../src/lib/pack/recommend.ts';
import { fleetModels } from '../../../src/lib/pack/routing.ts';
import { catalog, choice, credential, entry, facts, runtime, tool } from './support.ts';

const readyClaude = runtime('claude-main', {
  catalogId: 'anthropic',
  choices: [choice('opus', 'Opus'), choice('sonnet', 'Sonnet')],
});

describe('runtimeRefusal', () => {
  const claudeTool = tool('claude', true);

  it('should let a runtime that is ready run any model it offers', () => {
    // Arrange
    const known = facts({
      runtimes: [readyClaude],
      credentials: [credential('claude-main-login')],
      tools: [claudeTool],
    });

    // Act
    const refusal = runtimeRefusal(readyClaude, 'opus', known);
    const noModel = runtimeRefusal(readyClaude, undefined, known);

    // Assert
    should(refusal).be.undefined();
    should(noModel).be.undefined();
  });

  it('should refuse a runtime that is not an agent first, whatever else is wrong', () => {
    // Arrange
    const terminal = runtime('terminal', { agent: false, launch: { available: false, reason: 'Sign in' } });

    // Act
    const refusal = runtimeRefusal(terminal, 'opus', facts({ tools: [tool('claude', false)] }));

    // Assert
    should(refusal).deepEqual({
      code: 'not_agent',
      message: 'terminal is for using its CLI yourself and cannot run sub-ferrets.',
      remedy: 'Pick an agent runtime.',
    });
  });

  it('should refuse a CLI that is not installed, and ignore a harness the machine knows nothing about', () => {
    // Arrange
    const missing = facts({ tools: [tool('claude', false)] });
    const unknown = facts({ tools: [tool('codex', false)] });

    // Act
    const refusal = runtimeRefusal(readyClaude, 'opus', missing);
    const passes = runtimeRefusal(readyClaude, 'opus', unknown);

    // Assert
    should(refusal).deepEqual({
      code: 'cli_missing',
      message: 'Claude Code is not installed on this machine, so claude-main cannot start.',
      remedy: 'Install Claude Code, or pick another runtime.',
    });
    should(passes).be.undefined();
  });

  it('should refuse a runtime whose launcher a start would refuse, naming why', () => {
    // Arrange
    const known = facts({
      credentials: [credential('claude-main-login')],
      tools: [claudeTool],
      unlaunchable: {
        'claude-main-wrapper':
          'the fleet publishes claude-main at /fy/fleet/bin/claude-main, but this host cannot run that file',
      },
    });

    // Act
    const refusal = runtimeRefusal(readyClaude, 'opus', known);

    // Assert
    should(refusal).deepEqual({
      code: 'cli_missing',
      message:
        'claude-main cannot be launched: the fleet publishes claude-main at /fy/fleet/bin/claude-main, but this host cannot run that file',
      remedy: 'Pick another runtime.',
    });
  });

  it('should refuse a login that names a secret the store does not hold', () => {
    // Arrange
    const needy = credential('claude-main-login', {
      environment: {
        variables: [],
        quotaSource: 'none',
        missingSecrets: ['GLM_API_KEY', 'OTHER_KEY'],
        test: { available: false, reason: 'no' },
      } as unknown as NonNullable<FleetCredentialView['environment']>,
    });

    // Act
    const refusal = runtimeRefusal(readyClaude, 'opus', facts({ credentials: [needy] }));

    // Assert
    should(refusal?.code).equal('not_logged_in');
    should(refusal?.message).equal("claude-main's login needs GLM_API_KEY, OTHER_KEY, which is not set.");
  });

  it('should refuse a login that needs signing in, from the credential or else the runtime’s own view', () => {
    // Arrange
    const signedOut = credential('claude-main-login', {
      status: {
        word: 'needs_sign_in',
        label: 'Needs sign-in',
        reason: 'not_signed_in',
        explanation: 'x',
        lastCheckInconclusive: false,
      },
    });
    const viaRuntime = runtime('claude-main', {
      catalogId: 'anthropic',
      choices: [choice('opus', 'Opus')],
      credential: { id: 'claude-main-login', store: 'ferretry', status: 'needs_sign_in' },
    });

    // Act
    const fromCredential = runtimeRefusal(readyClaude, 'opus', facts({ credentials: [signedOut] }));
    const fromRuntime = runtimeRefusal(viaRuntime, 'opus', facts());

    // Assert
    should(fromCredential?.message).equal("claude-main's login (claude-main-login) needs signing in.");
    should(fromRuntime?.code).equal('not_logged_in');
  });

  it('should refuse a launch that is unavailable as a login problem', () => {
    // Arrange
    const stuck = runtime('claude-main', { launch: { available: false, reason: 'Sign in to launch' } });

    // Act
    const refusal = runtimeRefusal(stuck, undefined, facts());

    // Assert
    should(refusal).deepEqual({
      code: 'not_logged_in',
      message: 'claude-main cannot launch: Sign in to launch',
      remedy: 'Pick another model.',
    });
  });

  it('should refuse a login whose quota is used up, by provider, five-hour or weekly window', () => {
    // Arrange
    const exhausted = (usage: FleetCredentialView['usage']) =>
      facts({ credentials: [credential('claude-main-login', { usage })] });
    const provider = {
      source: 'zai-coding-plan',
      via: 'endpoint',
      windows: [],
      exhausted: true,
      unverified: false,
      at: '2026-10-19T00:00:00.000Z',
    } as const;

    // Act
    const byProvider = runtimeRefusal(readyClaude, 'opus', exhausted({ fiveHour: {}, weekly: {}, provider }));
    const byFiveHour = runtimeRefusal(readyClaude, 'opus', exhausted({ fiveHour: { usedPercent: 100 }, weekly: {} }));
    const byWeekly = runtimeRefusal(
      readyClaude,
      'opus',
      exhausted({ fiveHour: { usedPercent: 40 }, weekly: { usedPercent: 130 } }),
    );
    const roomy = runtimeRefusal(
      readyClaude,
      'opus',
      exhausted({
        fiveHour: { usedPercent: 99 },
        weekly: { usedPercent: 0 },
        provider: { ...provider, exhausted: false },
      }),
    );

    // Assert
    should([byProvider?.code, byFiveHour?.code, byWeekly?.code]).deepEqual([
      'out_of_quota',
      'out_of_quota',
      'out_of_quota',
    ]);
    should(byFiveHour?.message).equal("claude-main's login (claude-main-login) is out of quota.");
    should(roomy).be.undefined();
  });

  it('should refuse a model the runtime does not offer', () => {
    // Arrange / Act
    const refusal = runtimeRefusal(readyClaude, 'haiku', facts());

    // Assert
    should(refusal).deepEqual({
      code: 'model_unavailable',
      message: 'claude-main does not offer haiku.',
      remedy: '`recommend` lists the runtimes that do.',
    });
  });

  it('should check the refusals in the order a person would fix them', () => {
    // Arrange
    const broken = runtime('broken', {
      launch: { available: false, reason: 'later' },
      credential: { id: 'broken-login', store: 'ferretry', status: 'needs_sign_in' },
    });

    // Act
    const first = runtimeRefusal(broken, 'nope', facts({ tools: [tool('claude', false)] }));
    const second = runtimeRefusal(broken, 'nope', facts());
    const third = runtimeRefusal({ ...broken, credential: { id: 'broken-login', store: 'ferretry' } }, 'nope', facts());
    const fourth = runtimeRefusal(
      { ...broken, credential: { id: 'broken-login', store: 'ferretry' }, launch: { available: true } },
      'nope',
      facts(),
    );

    // Assert
    should([first?.code, second?.code, third?.code, fourth?.code]).deepEqual([
      'cli_missing',
      'not_logged_in',
      'not_logged_in',
      'model_unavailable',
    ]);
  });
});

describe('offers', () => {
  it('should read the login’s catalog, and accept any id a catalog with custom ids takes', () => {
    // Arrange
    const closed = runtime('closed', { catalogId: 'anthropic', choices: [choice('opus', 'Opus')] });
    const open = runtime('open', { catalogId: 'ollama', customIds: true, choices: [choice('llama', 'Llama')] });

    // Act
    const answers = [offers(closed, 'opus'), offers(closed, 'other'), offers(open, 'anything')];

    // Assert
    should(answers).deepEqual([true, false, true]);
  });

  it('should read the profile’s model set when the login has no catalog, counting only available models', () => {
    // Arrange
    const withSet = runtime('set', {
      modelSet: {
        source: 'model-set',
        name: 'mine',
        declaredDefault: 'a',
        models: [
          { id: 'a', available: true },
          { id: 'b', available: false },
        ],
      },
    });
    const bare = runtime('bare');

    // Act
    const answers = [offers(withSet, 'a'), offers(withSet, 'b'), offers(withSet, 'c'), offers(bare, 'a')];

    // Assert
    should(answers).deepEqual([true, false, false, false]);
  });
});

describe('newCommand', () => {
  it('should print the command that starts a model, with its effort when it has one and always a name', () => {
    should(newCommand('fy', { runtime: 'claude-main', model: 'opus', effort: 'max' })).equal(
      'fy new --runtime claude-main --model opus --effort max --name "<short task title>" "<complete brief>"',
    );
    should(newCommand('zz', { runtime: 'r', model: 'm' })).equal(
      'zz new --runtime r --model m --name "<short task title>" "<complete brief>"',
    );
  });
});

describe('availableModels', () => {
  const NOW = '2026-10-22T12:00:00.000Z';
  const RESET = '2026-10-22T18:00:00.000Z';
  const ANTHROPIC: ModelCatalogView = catalog('anthropic', 'Anthropic', {
    claude: [
      entry('opus', 'Opus', 'best', { efforts: ['low', 'high', 'max'] }),
      entry('sonnet', 'Sonnet', 'balanced'),
      entry('haiku', 'Haiku', 'fast', { efforts: ['low'] }),
    ],
  });
  const BEDROCK: ModelCatalogView = catalog('bedrock', 'Bedrock', {
    claude: [entry('us.opus-v1', 'Opus', 'best', { efforts: ['high'] })],
  });
  const opusChoice = choice('opus', 'Opus', { tier: 'best', efforts: ['low', 'high', 'max'] });
  const sonnetChoice = choice('sonnet', 'Sonnet', { tier: 'balanced' });
  const haikuChoice = choice('haiku', 'Haiku', { tier: 'fast', efforts: ['low'] });
  const usedWeek = (name: string, percent: number): FleetCredentialView =>
    credential(`${name}-login`, {
      usage: { fiveHour: { usedPercent: 10 }, weekly: { usedPercent: percent, resetsAt: RESET } },
    });
  const list = (known: PackFleetFacts, prompt: string, catalogs = [ANTHROPIC]): readonly PackModelOption[] =>
    availableModels(known, fleetModels(catalogs, known.runtimes), prompt, 'fy');

  it('should list every model a runtime here offers once, ready with its command, sorted by headroom', () => {
    // Arrange
    const known = facts({
      now: NOW,
      runtimes: [
        runtime('claude-busy', { catalogId: 'anthropic', choices: [opusChoice, sonnetChoice] }),
        runtime('claude-fresh', { catalogId: 'anthropic', choices: [haikuChoice] }),
      ],
      credentials: [usedWeek('claude-busy', 90), usedWeek('claude-fresh', 5)],
    });

    // Act
    const rows = list(known, 'Nothing named here.');

    // Assert
    should(rows.map(row => [row.model, row.runtime, row.ready])).deepEqual([
      ['haiku', 'claude-fresh', true],
      ['opus', 'claude-busy', true],
      ['sonnet', 'claude-busy', true],
    ]);
    should(rows[0]?.command).equal(
      'fy new --runtime claude-fresh --model haiku --name "<short task title>" "<complete brief>"',
    );
    should(rows[1]).containDeep({ provider: 'anthropic', modelLabel: 'Opus', tier: 'best', runtimes: 1 });
    should(rows[1]?.quota.state).equal('low');
  });

  it('should mark where the routing prompt names each model and the effort it names after it', () => {
    // Arrange
    const known = facts({
      runtimes: [runtime('claude-main', { catalogId: 'anthropic', choices: [opusChoice, haikuChoice] })],
    });

    // Act
    const rows = list(known, 'Chores: haiku at low. Planning: Opus @max, then haiku again.');

    // Assert
    should(rows.map(row => [row.model, row.named, row.effort])).deepEqual([
      ['haiku', 1, 'low'],
      ['opus', 2, 'max'],
    ]);
    should(rows[1]?.command).equal(
      'fy new --runtime claude-main --model opus --effort max --name "<short task title>" "<complete brief>"',
    );
  });

  it('should serve the same model resold under another catalog from the runtime with the most headroom', () => {
    // Arrange
    const known = facts({
      now: NOW,
      runtimes: [
        runtime('claude-main', { catalogId: 'anthropic', choices: [opusChoice] }),
        runtime('claude-bedrock', {
          catalogId: 'bedrock',
          choices: [choice('us.opus-v1', 'Opus', { efforts: ['high'] })],
        }),
      ],
      credentials: [usedWeek('claude-main', 95), usedWeek('claude-bedrock', 10)],
    });

    // Act
    const rows = list(known, 'Plans on opus at max.', [ANTHROPIC, BEDROCK]);

    // Assert
    should(rows).have.length(1);
    should(rows[0]).containDeep({ model: 'us.opus-v1', runtime: 'claude-bedrock', runtimes: 2, named: 1, ready: true });
    // `max` is not one of Bedrock's efforts, so it is not carried over.
    should(rows[0]?.effort).be.undefined();
  });

  it('should list a model no runtime can start now last, with the refusal and no command', () => {
    // Arrange
    const known = facts({
      runtimes: [
        runtime('claude-off', {
          catalogId: 'anthropic',
          choices: [opusChoice],
          launch: { available: false, reason: 'Sign in' },
        }),
        runtime('claude-main', { catalogId: 'anthropic', choices: [haikuChoice] }),
        runtime('cli-only', { catalogId: 'anthropic', choices: [sonnetChoice], agent: false }),
      ],
    });

    // Act
    const rows = list(known, 'opus first.');

    // Assert
    should(rows.map(row => [row.model, row.ready])).deepEqual([
      ['haiku', true],
      ['opus', false],
    ]);
    should(rows[1]?.refusal?.code).equal('not_logged_in');
    should(rows[1]).not.have.property('command');
  });

  it("should list a profile model set's available models by id, and skip a runtime with only the harness default", () => {
    // Arrange
    const known = facts({
      runtimes: [
        runtime('claude-set', {
          modelSet: {
            source: 'model-set',
            name: 'set',
            models: [
              { id: 'local-7b', available: true },
              { id: 'local-70b', available: false },
            ],
            declaredDefault: 'local-7b',
            default: 'local-7b',
          },
        }),
        runtime('claude-plain'),
      ],
    });

    // Act
    const rows = list(known, 'local-7b for everything.');

    // Assert
    should(rows.map(row => [row.model, row.modelLabel, row.runtime])).deepEqual([
      ['local-7b', 'local-7b', 'claude-set'],
    ]);
    should(rows[0]).not.have.property('provider');
  });

  it('should break a headroom tie by the prompt order, then tier, then label', () => {
    // Arrange
    const known = facts({
      runtimes: [runtime('claude-main', { catalogId: 'anthropic', choices: [haikuChoice, sonnetChoice, opusChoice] })],
    });

    // Act
    const named = list(known, 'sonnet first.');
    const unnamed = list(known, 'Nothing.');

    // Assert
    should(named.map(row => row.model)).deepEqual(['sonnet', 'opus', 'haiku']);
    should(unnamed.map(row => row.model)).deepEqual(['opus', 'sonnet', 'haiku']);
  });
});

describe('automaticOrder', () => {
  const option = (model: string, extra: Partial<PackModelOption> = {}): PackModelOption => ({
    model,
    modelLabel: model,
    harness: 'claude',
    efforts: [],
    runtime: `${model}-runtime`,
    runtimes: 1,
    ready: true,
    quota: { state: 'unknown', windows: [], summary: 'not measured' },
    ...extra,
  });

  it('should try the ready models the prompt names in its order, then the ready one with the most headroom', () => {
    // Arrange: already in the list's order — ready first, then by headroom.
    const available = [
      option('fresh'),
      option('second', { named: 2 }),
      option('first', { named: 1 }),
      option('later'),
      option('gone', { named: 3, ready: false }),
    ];

    // Act / Assert
    should(automaticOrder(available).map(row => row.model)).deepEqual(['first', 'second', 'fresh']);
  });

  it('should fall back to the one with the most headroom when the prompt names nothing ready', () => {
    should(automaticOrder([option('a'), option('b')]).map(row => row.model)).deepEqual(['a']);
    should(automaticOrder([option('x', { ready: false })])).deepEqual([]);
  });
});
