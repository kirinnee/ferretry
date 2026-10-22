import { describe, it } from 'bun:test';
import type { FleetCredentialView, GuideCandidate, GuideUseCase, ModelsGuide } from '@ferretry/protocol';
import should from 'should';
import {
  matchUseCase,
  newCommand,
  offers,
  type PackFleetFacts,
  recommend,
  runtimeRefusal,
} from '../../../src/lib/pack/recommend.ts';
import { choice, credential, facts, runtime, tool } from './support.ts';

const useCase = (id: string, title: string, overrides: Partial<GuideUseCase> = {}): GuideUseCase => ({
  id,
  title,
  description: `${title}.`,
  candidates: [],
  ...overrides,
});

const GUIDE: ModelsGuide = {
  source: 'file',
  useCases: [
    useCase('plan-review', 'Hard planning and review', { keywords: ['plan', 'root cause'] }),
    useCase('everyday', 'Everyday coding', { keywords: ['fix'] }),
    useCase('bulk', 'Mechanical bulk edits', { keywords: ['rename'] }),
  ],
};

const readyClaude = runtime('claude-main', {
  catalogId: 'anthropic',
  choices: [choice('opus', 'Opus'), choice('sonnet', 'Sonnet')],
});

describe('matchUseCase', () => {
  it('should honour a use case the caller named', () => {
    // Arrange / Act
    const matched = matchUseCase(GUIDE, 'plan the migration', 'bulk');

    // Assert
    should(matched?.useCase.id).equal('bulk');
    should(matched?.matchedBy).equal('named');
  });

  it('should match by the words of the task, keyword phrases and long title words each counting once', () => {
    // Arrange / Act
    const byKeyword = matchUseCase(GUIDE, 'Find the ROOT CAUSE of the crash');
    const byTitle = matchUseCase(GUIDE, 'a mechanical job');
    const byMost = matchUseCase(GUIDE, 'rename and fix and rename and plan the mechanical bulk');

    // Assert
    should(byKeyword).deepEqual({ useCase: GUIDE.useCases[0], matchedBy: 'words' });
    should(byTitle?.useCase.id).equal('bulk');
    should(byMost?.useCase.id).equal('bulk');
  });

  it('should break a tie by the guide’s order', () => {
    // Arrange / Act
    const matched = matchUseCase(GUIDE, 'plan then fix');

    // Assert
    should(matched?.useCase.id).equal('plan-review');
  });

  it('should fall back to everyday when a named use case is unknown and no word matches', () => {
    // Arrange / Act
    const matched = matchUseCase(GUIDE, 'zzz qqq', 'no-such-case');

    // Assert
    should(matched).deepEqual({ useCase: GUIDE.useCases[1], matchedBy: 'fallback' });
  });

  it('should fall back to the first use case when there is no everyday one', () => {
    // Arrange
    const guide: ModelsGuide = { source: 'file', useCases: [useCase('a', 'Alpha work'), useCase('b', 'Beta work')] };

    // Act
    const matched = matchUseCase(guide, 'nothing relevant');

    // Assert
    should(matched?.useCase.id).equal('a');
    should(matched?.matchedBy).equal('fallback');
  });

  it('should match nothing from a task with no words', () => {
    // Arrange / Act
    const matched = matchUseCase(GUIDE, '!!! ???');

    // Assert
    should(matched?.matchedBy).equal('fallback');
  });

  it('should match nothing at all for a guide with no use case', () => {
    // Arrange / Act
    const matched = matchUseCase({ source: 'file', useCases: [] }, 'anything');

    // Assert
    should(matched).be.undefined();
  });
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
      remedy: 'Pick another candidate.',
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
  it('should print the command that starts a candidate, with its effort when it has one', () => {
    // Arrange
    const base = {
      rank: 1,
      provider: 'anthropic',
      model: 'opus',
      why: 'x',
      ready: true,
      runtime: 'claude-main',
    } as const;

    // Act
    const plain = newCommand('fy', base);
    const effortful = newCommand('fy', { ...base, effort: 'high' });
    const unnamed = newCommand('fy', { rank: 1, provider: 'p', model: 'm', why: 'x', ready: true });

    // Assert
    should(plain).equal('fy new --runtime claude-main --model opus "<complete brief>"');
    should(effortful).equal('fy new --runtime claude-main --model opus --effort high "<complete brief>"');
    should(unnamed).equal('fy new --runtime <runtime> --model m "<complete brief>"');
  });
});

describe('recommend', () => {
  const candidate = (provider: string, model: string, extra: Partial<GuideCandidate> = {}): GuideCandidate => ({
    provider,
    model,
    why: `${model} suits it.`,
    ...extra,
  });
  const guideOf = (...candidates: GuideCandidate[]): ModelsGuide => ({
    source: 'derived',
    useCases: [useCase('everyday', 'Everyday coding', { keywords: ['fix'], candidates })],
  });
  const input = { task: 'fix the bug', bin: 'fy' };
  const known = (runtimes: PackFleetFacts['runtimes']): PackFleetFacts =>
    facts({ runtimes, credentials: [credential('claude-main-login')], tools: [tool('claude', true)] });

  it('should answer nothing for a guide with no use case', () => {
    // Arrange / Act
    const answer = recommend(input, { source: 'file', useCases: [] }, facts());

    // Assert
    should(answer).be.undefined();
  });

  it('should resolve a candidate to the runtime that offers it from its own catalog, with the next command', () => {
    // Arrange
    const guide = guideOf(candidate('anthropic', 'opus', { effort: 'high' }));

    // Act
    const answer = recommend(input, guide, known([readyClaude]));

    // Assert
    should(answer).deepEqual({
      task: 'fix the bug',
      useCase: { id: 'everyday', title: 'Everyday coding', matchedBy: 'words' },
      guideSource: 'derived',
      candidates: [
        {
          rank: 1,
          provider: 'anthropic',
          model: 'opus',
          modelLabel: 'Opus',
          harness: 'claude',
          effort: 'high',
          why: 'opus suits it.',
          runtime: 'claude-main',
          ready: true,
          quota: { state: 'unknown', windows: [], summary: 'not measured' },
        },
      ],
      next: 'fy new --runtime claude-main --model opus --effort high "<complete brief>"',
    });
  });

  it('should find the same-label model through another catalog, started on that catalog’s id', () => {
    // Arrange
    const bedrock = runtime('claude-bedrock', {
      catalogId: 'bedrock',
      choices: [choice('anthropic.opus-v1', 'OPUS')],
    });
    const guide = guideOf(candidate('anthropic', 'opus'));
    const labels = new Map([['anthropic\u0000opus', 'Opus']]);

    // Act
    const answer = recommend(input, guide, known([bedrock]), labels);

    // Assert
    should(answer?.candidates[0]).containEql({
      model: 'anthropic.opus-v1',
      modelLabel: 'OPUS',
      runtime: 'claude-bedrock',
      ready: true,
    });
  });

  it('should skip a same-label runtime on another CLI than the candidate names', () => {
    // Arrange
    const codexOnGateway = runtime('codex-gw', {
      harness: 'codex',
      catalogId: 'gateway',
      choices: [choice('g-opus', 'Opus')],
    });
    const guide = guideOf(candidate('anthropic', 'opus', { harness: 'claude' }));
    const labels = new Map([['anthropic\u0000opus', 'Opus']]);

    // Act
    const answer = recommend(input, guide, known([codexOnGateway]), labels);

    // Assert
    should(answer?.candidates[0]?.ready).be.false();
    should(answer?.candidates[0]?.refusal?.code).equal('model_unavailable');
  });

  it('should list a candidate nobody here offers last, with the reason and no runtime', () => {
    // Arrange
    const guide = guideOf(candidate('zai', 'glm-5', { harness: 'claude' }), candidate('anthropic', 'sonnet'));

    // Act
    const answer = recommend(input, guide, known([readyClaude]));

    // Assert
    should(answer?.candidates.map(row => [row.rank, row.model, row.ready])).deepEqual([
      [1, 'sonnet', true],
      [2, 'glm-5', false],
    ]);
    should(answer?.candidates[1]).deepEqual({
      rank: 2,
      provider: 'zai',
      model: 'glm-5',
      harness: 'claude',
      why: 'glm-5 suits it.',
      ready: false,
      refusal: {
        code: 'model_unavailable',
        message: 'No runtime on this machine offers glm-5 (zai).',
        remedy: 'Add a login for that provider, or pick another candidate.',
      },
    });
    should(answer?.next).containEql('--model sonnet');
  });

  it('should name the catalog label for a candidate no runtime offers when the caller knows one', () => {
    // Arrange
    const guide = guideOf(candidate('zai', 'glm-5'));
    const labels = new Map([['zai\u0000glm-5', 'GLM 5']]);

    // Act
    const answer = recommend(input, guide, known([]), labels);

    // Assert
    should(answer?.candidates[0]?.modelLabel).equal('GLM 5');
    should(answer?.candidates[0]?.refusal?.message).equal('No runtime on this machine offers GLM 5 (zai).');
  });

  it('should report a candidate a runtime offers but cannot run, with that runtime’s own refusal', () => {
    // Arrange
    const guide = guideOf(candidate('anthropic', 'opus'));
    const signedOut = credential('claude-main-login', {
      status: {
        word: 'needs_sign_in',
        label: 'Needs sign-in',
        reason: 'not_signed_in',
        explanation: 'x',
        lastCheckInconclusive: false,
      },
    });

    // Act
    const answer = recommend(input, guide, facts({ runtimes: [readyClaude], credentials: [signedOut], tools: [] }));

    // Assert
    should(answer?.candidates[0]?.ready).be.false();
    should(answer?.candidates[0]?.runtime).equal('claude-main');
    should(answer?.candidates[0]?.refusal?.code).equal('not_logged_in');
    should(answer?.next).be.undefined();
  });

  it('should prefer a ready runtime over an earlier one that cannot run', () => {
    // Arrange
    const first = runtime('claude-a', {
      catalogId: 'anthropic',
      choices: [choice('opus', 'Opus')],
      credential: { id: 'a-login', store: 'ferretry', status: 'needs_sign_in' },
    });
    const second = runtime('claude-b', { catalogId: 'anthropic', choices: [choice('opus', 'Opus')] });

    // Act
    const answer = recommend(input, guideOf(candidate('anthropic', 'opus')), known([first, second]));

    // Assert
    should(answer?.candidates[0]).containEql({ runtime: 'claude-b', ready: true });
  });

  it('should keep the guide’s order inside the ready group and inside the unready group', () => {
    // Arrange
    const guide = guideOf(
      candidate('x', 'gone-1'),
      candidate('anthropic', 'sonnet'),
      candidate('x', 'gone-2'),
      candidate('anthropic', 'opus'),
    );

    // Act
    const answer = recommend(input, guide, known([readyClaude]));

    // Assert
    should(answer?.candidates.map(row => row.model)).deepEqual(['sonnet', 'opus', 'gone-1', 'gone-2']);
  });
});

describe('recommend by live quota', () => {
  const NOW = '2026-10-22T12:00:00.000Z';
  const RESET = '2026-10-22T18:00:00.000Z';
  const opusOn = (name: string) => runtime(name, { catalogId: 'anthropic', choices: [choice('opus', 'Opus')] });
  const sonnetOn = (name: string) => runtime(name, { catalogId: 'anthropic', choices: [choice('sonnet', 'Sonnet')] });
  const usedWeek = (name: string, percent: number): FleetCredentialView =>
    credential(`${name}-login`, {
      usage: { fiveHour: { usedPercent: 10 }, weekly: { usedPercent: percent, resetsAt: RESET } },
    });
  const guide = (...models: string[]): ModelsGuide => ({
    source: 'file',
    useCases: [
      useCase('everyday', 'Everyday coding', {
        keywords: ['fix'],
        candidates: models.map(model => ({ provider: 'anthropic', model, why: `${model} suits it.` })),
      }),
    ],
    routing: { prompt: 'Opus first; Sonnet when Opus is low.', short: 'Routing: everyday → opus.', source: 'file' },
    suggested: { by: 'gpt-oss-120b', via: 'claude-work', at: NOW, acceptedAt: NOW },
  });
  const input = { task: 'fix the bug', bin: 'fy' };

  it('should move a candidate whose login is near its limit below one with headroom, and say why', () => {
    // Arrange
    const known = facts({
      runtimes: [opusOn('claude-kirin'), sonnetOn('claude-atomi')],
      credentials: [usedWeek('claude-kirin', 91), usedWeek('claude-atomi', 20)],
      now: NOW,
    });

    // Act
    const answer = recommend(input, guide('opus', 'sonnet'), known);

    // Assert
    should(answer?.candidates.map(row => [row.rank, row.model, row.runtime, row.movedDown])).deepEqual([
      [1, 'sonnet', 'claude-atomi', undefined],
      [2, 'opus', 'claude-kirin', 'claude-kirin, 91% of the week used, resets 18:00Z'],
    ]);
    should(answer?.candidates[1]?.quota?.state).equal('low');
    should(answer?.next).equal('fy new --runtime claude-atomi --model sonnet "<complete brief>"');
  });

  it("should keep the guide's order when headroom is alike, and restore a demoted candidate once its window resets", () => {
    // Arrange
    const runtimes = [opusOn('claude-kirin'), sonnetOn('claude-atomi')];
    const credentials = [usedWeek('claude-kirin', 95), usedWeek('claude-atomi', 30)];

    // Act
    const before = recommend(input, guide('opus', 'sonnet'), facts({ runtimes, credentials, now: NOW }));
    const after = recommend(
      input,
      guide('opus', 'sonnet'),
      facts({ runtimes, credentials, now: '2026-10-22T18:30:00.000Z' }),
    );
    const alike = recommend(
      input,
      guide('opus', 'sonnet'),
      facts({ runtimes, credentials: [usedWeek('claude-kirin', 10), usedWeek('claude-atomi', 5)], now: NOW }),
    );

    // Assert
    should(before?.candidates.map(row => row.model)).deepEqual(['sonnet', 'opus']);
    should(after?.candidates.map(row => [row.model, row.movedDown])).deepEqual([
      ['opus', undefined],
      ['sonnet', undefined],
    ]);
    should(alike?.candidates.map(row => row.model)).deepEqual(['opus', 'sonnet']);
  });

  it('should not hold an unmeasured login against a candidate', () => {
    // Arrange
    const known = facts({
      runtimes: [opusOn('claude-kirin'), sonnetOn('claude-atomi')],
      credentials: [credential('claude-kirin-login'), usedWeek('claude-atomi', 5)],
      now: NOW,
    });

    // Act + Assert
    should(recommend(input, guide('opus', 'sonnet'), known)?.candidates.map(row => row.model)).deepEqual([
      'opus',
      'sonnet',
    ]);
  });

  it('should start a model on the runtime with the most headroom among those that run it', () => {
    // Arrange
    const known = facts({
      runtimes: [opusOn('claude-kirin'), opusOn('claude-atomi')],
      credentials: [usedWeek('claude-kirin', 85), usedWeek('claude-atomi', 40)],
      now: NOW,
    });

    // Act
    const answer = recommend(input, guide('opus'), known);

    // Assert
    should(answer?.candidates.map(row => [row.runtime, row.quota?.summary])).deepEqual([
      ['claude-atomi', '5h 10% · wk 40%'],
    ]);
  });

  it('should refuse a login out of quota until its window resets, and offer it again after', () => {
    // Arrange
    const runtimes = [opusOn('claude-kirin')];
    const credentials = [usedWeek('claude-kirin', 100)];

    // Act
    const out = recommend(input, guide('opus'), facts({ runtimes, credentials, now: NOW }));
    const back = recommend(input, guide('opus'), facts({ runtimes, credentials, now: '2026-10-22T18:00:00.000Z' }));

    // Assert
    should(out?.candidates[0]?.refusal).deepEqual({
      code: 'out_of_quota',
      message: "claude-kirin's login (claude-kirin-login) is out of quota until 18:00Z.",
      remedy: 'Pick another candidate.',
    });
    should(back?.candidates[0]?.ready).be.true();
  });

  it('should carry the guide routing prompt and where an accepted guide came from', () => {
    // Act
    const answer = recommend(input, guide('opus'), facts({ runtimes: [opusOn('claude-kirin')], now: NOW }));

    // Assert
    should(answer?.routing).equal('Opus first; Sonnet when Opus is low.');
    should(answer?.guideSuggested).deepEqual({ by: 'gpt-oss-120b', via: 'claude-work', at: NOW, acceptedAt: NOW });
  });
});
