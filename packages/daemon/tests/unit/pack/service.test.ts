import { describe, it } from 'bun:test';
import type {
  ModelCatalogView,
  ModelsGuideFile,
  PackNewOutcome,
  PackNewRequest,
  SessionView,
  StartSessionRequest,
} from '@ferretry/protocol';
import { briefHash } from '@ferretry/protocol';
import should from 'should';
import type { JevGuidance, JevRanking, RankableCandidate } from '../../../src/lib/pack/jev.ts';
import type { PackProbeOutcome, PackProbeRequest } from '../../../src/lib/pack/probe.ts';
import { SCRATCH_REMEDY, scratchMessage } from '../../../src/lib/pack/scratch.ts';
import {
  type PackParent,
  type PackPorts,
  PackService,
  PackStartRefused,
  subFerretFooter,
} from '../../../src/lib/pack/service.ts';
import { sessionView } from '../runtime/mounts/support.ts';
import { catalog, choice, entry, facts, packConfig, runtime } from './support.ts';

const GUIDE_FILE: ModelsGuideFile = {
  useCases: [
    {
      id: 'everyday',
      title: 'Everyday coding',
      description: 'Ordinary work.',
      keywords: ['fix'],
      candidates: [
        { provider: 'anthropic', model: 'opus', effort: 'high', why: 'Strong.' },
        { provider: 'anthropic', model: 'haiku', why: 'Cheap.' },
      ],
    },
  ],
};

const CLAUDE_MAIN = runtime('claude-main', {
  catalogId: 'anthropic',
  choices: [choice('opus', 'Opus'), choice('sonnet', 'Sonnet')],
});
const CLAUDE_FAST = runtime('claude-fast', { catalogId: 'anthropic', choices: [choice('haiku', 'Haiku')] });

const CATALOGS: readonly ModelCatalogView[] = [
  catalog('anthropic', 'Anthropic', {
    claude: [entry('opus', 'Opus', 'best'), entry('haiku', 'Haiku', 'fast'), entry('sonnet', 'Sonnet', 'balanced')],
    codex: [entry('gpt-5', 'GPT-5', 'best')],
  }),
];

const PARENT: PackParent = { id: 'p1', interactive: false, depth: 0, runningChildren: 0, cwd: '/work/parent' };

interface Options {
  config?: ReturnType<typeof packConfig>;
  guideFile?: ModelsGuideFile;
  runtimes?: readonly ReturnType<typeof runtime>[];
  parents?: Readonly<Record<string, PackParent>>;
  /** What a probe answers, by wrapper; absent means OK. */
  probes?: Readonly<Record<string, PackProbeOutcome>>;
  cached?: readonly string[];
  startError?: unknown;
  ranking?: JevRanking;
  spent?: number;
  /** The folders the scratch check calls temporary. */
  scratch?: readonly string[];
}

function build(options: Options = {}) {
  const probes: Array<readonly [PackProbeRequest, number]> = [];
  const starts: StartSessionRequest[] = [];
  const ranks: Array<readonly [string, readonly RankableCandidate[], JevGuidance | undefined]> = [];
  const recorded: number[] = [];
  let spent = options.spent ?? 0;
  const ports: PackPorts = {
    settings: async () => ({
      config: options.config ?? packConfig(),
      guideFile: options.guideFile ?? GUIDE_FILE,
      jevUsdPerMillionInputTokens: 2,
    }),
    catalogs: async () => CATALOGS,
    facts: async () => facts({ runtimes: options.runtimes ?? [CLAUDE_MAIN, CLAUDE_FAST] }),
    parent: async id => options.parents?.[id],
    scratch: async cwd => options.scratch?.includes(cwd) === true,
    probe: async (request, ttlMs) => {
      probes.push([request, ttlMs]);
      return {
        outcome: options.probes?.[request.wrapper] ?? { ok: true, ms: 25 },
        cached: options.cached?.includes(request.wrapper) === true,
      };
    },
    start: async request => {
      starts.push(request);
      if (options.startError !== undefined) throw options.startError;
      return sessionView('child-1') satisfies SessionView;
    },
    jev: {
      rank: async (task, candidates, guidance) => {
        ranks.push([task, candidates, guidance]);
        return options.ranking ?? { kind: 'ranked', order: [1, 0], inputTokens: 500_000 };
      },
    },
    spend: {
      today: async () => spent,
      record: async usd => {
        recorded.push(usd);
        spent += usd;
      },
    },
    bin: 'fy',
  };
  return { subject: new PackService(ports), probes, starts, ranks, recorded };
}

const request = (extra: Partial<PackNewRequest> = {}): PackNewRequest => ({
  task: 'fix the bug',
  parent: 'p1',
  ...extra,
});
const refusalOf = (outcome: PackNewOutcome) => (outcome.outcome === 'refused' ? outcome.refusal : undefined);

describe('subFerretFooter', () => {
  it('should tell a sub-ferret who started it and how its result is handed back', () => {
    // Arrange / Act
    const byFerret = subFerretFooter('fy', 'p1');
    const byPerson = subFerretFooter('ferret', undefined);

    // Assert
    should(byFerret).containEql('started by ferret p1 (Pack mode)');
    should(byFerret).containEql('`fy signal done "<your result');
    should(byPerson).containEql('started with `new` (Pack mode)');
    should(byPerson).containEql('`ferret signal done');
  });
});

describe('PackService.routingShort', () => {
  it("should give the guide's own short routing line, else one rendered from its use cases", async () => {
    // Arrange
    const written = build({
      guideFile: { ...GUIDE_FILE, routing: { prompt: 'Opus, then Haiku.', short: 'Routing: everyday → opus.' } },
    });
    const rendered = build();

    // Act + Assert
    should(await written.subject.routingShort()).equal('Routing: everyday → opus.');
    should(await rendered.subject.routingShort()).equal('Routing: everyday → opus high.');
  });
});

describe('PackService.view', () => {
  it('should read the settings, the guide in effect and every model with the runtimes here', async () => {
    // Arrange
    const { subject } = build({ guideFile: {} });

    // Act
    const view = await subject.view();

    // Assert
    should(view.config).deepEqual(packConfig());
    should(view.guide.source).equal('derived');
    should(view.models.find(model => model.id === 'opus')?.runtimes).deepEqual(['claude-main']);
    should(view.models.find(model => model.id === 'gpt-5')?.runtimes).deepEqual([]);
  });

  it('should show the owner’s guide when the file names use cases', async () => {
    // Arrange
    const { subject } = build();

    // Act
    const view = await subject.view();

    // Assert
    should(view.guide.source).equal('file');
    should(view.guide.useCases.map(useCase => useCase.id)).deepEqual(['everyday']);
  });
});

describe('PackService.recommend', () => {
  it('should resolve the guide’s candidates against the fleet and name models by their catalog label', async () => {
    // Arrange
    const guideFile: ModelsGuideFile = {
      useCases: [
        {
          id: 'everyday',
          title: 'Everyday coding',
          description: 'Ordinary work.',
          keywords: ['fix'],
          candidates: [
            { provider: 'anthropic', model: 'sonnet', why: 'Fine.' },
            { provider: 'anthropic', model: 'haiku', why: 'Cheap.' },
          ],
        },
      ],
    };
    const { subject } = build({ runtimes: [CLAUDE_FAST], guideFile });

    // Act
    const answer = await subject.recommend({ task: 'fix the bug' });

    // Assert
    should(answer?.useCase).deepEqual({ id: 'everyday', title: 'Everyday coding', matchedBy: 'words' });
    should(answer?.candidates.map(row => [row.model, row.modelLabel, row.ready])).deepEqual([
      ['haiku', 'Haiku', true],
      ['sonnet', 'Sonnet', false],
    ]);
    should(answer?.next).equal('fy new --runtime claude-fast --model haiku "<complete brief>"');
  });

  it('should honour a named use case and answer nothing for a guide with none', async () => {
    // Arrange
    const named = build();
    const empty = build({ guideFile: { useCases: [] } });

    // Act
    const byName = await named.subject.recommend({ task: 'zzz', useCase: 'everyday' });
    const none = await empty.subject.recommend({ task: 'fix' });

    // Assert
    should(byName?.useCase.matchedBy).equal('named');
    should(none).be.undefined();
  });
});

describe('PackService.newChild refusals before anything is probed', () => {
  it('should refuse everything when the machine’s switch is off', async () => {
    // Arrange
    const { subject, probes, starts } = build({ config: packConfig({ enabled: false }), parents: { p1: PARENT } });

    // Act
    const outcome = await subject.newChild(request({ runtime: 'claude-main' }));

    // Assert
    should(outcome).deepEqual({
      outcome: 'refused',
      refusal: { code: 'pack_off', message: 'Pack mode is off on this machine.', remedy: 'Do the work yourself.' },
      attempts: [],
    });
    should([probes, starts]).deepEqual([[], []]);
  });

  it('should refuse a parent that does not exist', async () => {
    // Arrange
    const { subject } = build();

    // Act
    const outcome = await subject.newChild(request({ runtime: 'claude-main', parent: 'ghost' }));

    // Assert
    should(refusalOf(outcome)).deepEqual({
      code: 'unknown_runtime',
      message: 'There is no ferret ghost to start a sub-ferret for.',
    });
  });

  it('should refuse a parent whose own switch is off', async () => {
    // Arrange
    const { subject } = build({ parents: { p1: { ...PARENT, pack: false } } });

    // Act
    const outcome = await subject.newChild(request({ runtime: 'claude-main' }));

    // Assert
    should(refusalOf(outcome)).deepEqual({
      code: 'pack_off',
      message: 'Pack mode is off for p1.',
      remedy: 'Do the work yourself.',
    });
  });

  it('should hold a parent to the admission limits', async () => {
    // Arrange
    const { subject } = build({ parents: { p1: { ...PARENT, runningChildren: 4 } } });

    // Act
    const outcome = await subject.newChild(request({ runtime: 'claude-main' }));

    // Assert
    should(refusalOf(outcome)?.code).equal('limit_reached');
  });

  it('should refuse a start with no parent and no folder', async () => {
    // Arrange
    const { subject } = build();

    // Act
    const outcome = await subject.newChild({ task: 'fix', runtime: 'claude-main' });

    // Assert
    should(refusalOf(outcome)).deepEqual({
      code: 'unknown_runtime',
      message: 'A sub-ferret with no parent must name its working folder (--cwd).',
    });
  });

  it('should refuse a runtime the machine does not have, naming the command that lists them', async () => {
    // Arrange
    const { subject, probes } = build({ parents: { p1: PARENT } });

    // Act
    const outcome = await subject.newChild(request({ runtime: 'nope' }));

    // Assert
    should(refusalOf(outcome)).deepEqual({
      code: 'unknown_runtime',
      message: 'There is no runtime nope on this machine.',
      remedy: '`fy recommend "<task>"` lists the runtimes that can run it.',
    });
    should(probes).be.empty();
  });

  it('should refuse a runtime that cannot run the model asked for', async () => {
    // Arrange
    const { subject, probes } = build({ parents: { p1: PARENT } });

    // Act
    const outcome = await subject.newChild(request({ runtime: 'claude-main', model: 'haiku' }));

    // Assert
    should(refusalOf(outcome)?.code).equal('model_unavailable');
    should(probes).be.empty();
  });
});

describe('PackService.newChild with a named runtime', () => {
  it('should probe, then start the sub-ferret in its parent’s folder with the footer on its brief', async () => {
    // Arrange
    const { subject, probes, starts } = build({ parents: { p1: PARENT } });

    // Act
    const outcome = await subject.newChild(
      request({ runtime: 'claude-main', model: 'opus', effort: 'high', name: 'Fix It', mode: 'interactive' }),
    );

    // Assert
    should(probes).deepEqual([
      [
        {
          wrapper: 'claude-main-wrapper',
          harness: 'claude',
          model: 'opus',
          effort: 'high',
          cwd: '/work/parent',
          timeoutMs: 45_000,
        },
        180_000,
      ],
    ]);
    should(starts).deepEqual([
      {
        mode: 'interactive',
        agent: 'claude-main-wrapper',
        prompt: `fix the bug${subFerretFooter('fy', 'p1')}`,
        boardAccess: 'none',
        cwd: '/work/parent',
        parent: 'p1',
        model: 'opus',
        effort: 'high',
        name: 'Fix It',
      },
    ]);
    should(outcome.outcome).equal('started');
    if (outcome.outcome !== 'started') return;
    should(outcome.decidedBy).equal('agent');
    should(outcome.view.config.id).equal('child-1');
    should(outcome.attempts).deepEqual([
      { runtime: 'claude-main', model: 'opus', outcome: 'started', probe: 'ran', probeMs: 25 },
    ]);
    should('note' in outcome).be.false();
  });

  it('should find the runtime by its wrapper and prefer the request’s folder to the parent’s', async () => {
    // Arrange
    const { subject, starts } = build({ parents: { p1: PARENT } });

    // Act
    const outcome = await subject.newChild(
      request({ runtime: 'claude-main-wrapper', cwd: '/elsewhere', model: 'opus' }),
    );

    // Assert
    should(outcome.outcome).equal('started');
    should(starts[0]?.cwd).equal('/elsewhere');
    should(starts[0]?.mode).equal('auto');
  });

  it('should title an unnamed sub-ferret from its brief, else from its use case and a short hash', async () => {
    // Arrange
    const { subject, starts } = build({ parents: { p1: PARENT } });
    const boilerplate = 'You are an implementer. Read /tmp/briefs/x.md and follow it exactly.';

    // Act
    await subject.newChild(request({ runtime: 'claude-main', model: 'opus', task: 'Fix the login redirect bug now' }));
    await subject.newChild(request({ runtime: 'claude-main', model: 'opus', task: boilerplate }));
    await subject.newChild(
      request({ runtime: 'claude-main', model: 'opus', task: boilerplate, useCase: 'code-review' }),
    );

    // Assert
    should(starts[0]?.name).equal('Fix the Login Redirect Bug');
    should(starts[1]?.name).equal(`Sub Ferret ${briefHash(boilerplate)}`);
    should(starts[2]?.name).equal(`Code Review ${briefHash(boilerplate)}`);
  });

  it("should run a sub-ferret in its parent's folder even when that folder is temporary", async () => {
    // Arrange
    const { subject, starts } = build({ parents: { p1: { ...PARENT, cwd: '/tmp/work' } }, scratch: ['/tmp/work'] });

    // Act
    const outcome = await subject.newChild(request({ runtime: 'claude-main-wrapper', model: 'opus' }));

    // Assert
    should(outcome.outcome).equal('started');
    should(starts[0]?.cwd).equal('/tmp/work');
  });

  it('should refuse a NAMED temporary folder, unless the caller allows it, before probing anything', async () => {
    // Arrange
    const refusing = build({ parents: { p1: PARENT }, scratch: ['/tmp/claude-1/scratchpad'] });
    const allowing = build({ parents: { p1: PARENT }, scratch: ['/tmp/claude-1/scratchpad'] });

    // Act
    const refused = await refusing.subject.newChild(
      request({ runtime: 'claude-main-wrapper', cwd: '/tmp/claude-1/scratchpad' }),
    );
    const allowed = await allowing.subject.newChild(
      request({ runtime: 'claude-main-wrapper', cwd: '/tmp/claude-1/scratchpad', allowScratch: true }),
    );

    // Assert
    should(refused).deepEqual({
      outcome: 'refused',
      refusal: {
        code: 'scratch_cwd',
        message: scratchMessage('/tmp/claude-1/scratchpad'),
        remedy: SCRATCH_REMEDY,
      },
      attempts: [],
    });
    should(refusing.probes).deepEqual([]);
    should(allowed.outcome).equal('started');
    should(allowing.starts[0]?.cwd).equal('/tmp/claude-1/scratchpad');
  });

  it('should start a top-level sub-ferret with no parent, on the runtime’s own default model', async () => {
    // Arrange
    const withCatalog = runtime('claude-default', { catalogId: 'anthropic', choices: [choice('opus', 'Opus')] });
    const defaulted =
      withCatalog.models === undefined
        ? withCatalog
        : { ...withCatalog, models: { ...withCatalog.models, default: 'opus' } };
    const bare = runtime('bare');
    const { subject, probes, starts } = build({ runtimes: [defaulted, bare] });

    // Act
    const first = await subject.newChild({ task: 'fix', runtime: 'claude-default', cwd: '/w' });
    const second = await subject.newChild({ task: 'fix', runtime: 'bare', cwd: '/w' });

    // Assert
    should(probes.map(([probe]) => probe.model)).deepEqual(['opus', undefined]);
    should(starts[0]).not.have.property('parent');
    should(starts[0]).not.have.property('model');
    should(starts[0]?.prompt).containEql('started with `new`');
    should(first.outcome === 'started' && first.attempts[0]).deepEqual({
      runtime: 'claude-default',
      model: 'opus',
      outcome: 'started',
      probe: 'ran',
      probeMs: 25,
    });
    should(second.outcome === 'started' && second.attempts[0]).deepEqual({
      runtime: 'bare',
      outcome: 'started',
      probe: 'ran',
      probeMs: 25,
    });
  });

  it('should refuse probe_failed and start nothing when the runtime does not answer', async () => {
    // Arrange
    const { subject, starts } = build({
      parents: { p1: PARENT },
      probes: { 'claude-main-wrapper': { ok: false, ms: 45_000, reason: 'timed out' } },
    });

    // Act
    const outcome = await subject.newChild(request({ runtime: 'claude-main', model: 'opus' }));

    // Assert
    const refusal = {
      code: 'probe_failed',
      message: 'claude-main did not answer a "reply OK" check on opus: timed out.',
      remedy: 'Try the next candidate.',
    };
    should(outcome).deepEqual({
      outcome: 'refused',
      refusal,
      attempts: [{ runtime: 'claude-main', model: 'opus', outcome: 'refused', refusal, probe: 'ran', probeMs: 45_000 }],
    });
    should(starts).be.empty();
  });

  it('should refuse with what the probe found — out of quota — and fall back to the next candidate in order', async () => {
    // Arrange
    const { subject, starts } = build({
      parents: { p1: PARENT },
      probes: {
        'claude-main-wrapper': {
          ok: false,
          ms: 900,
          reason: 'it exited 1: its login is out of quota or rate-limited',
          code: 'out_of_quota',
        },
      },
    });

    // Act
    const outcome = await subject.newChild(request({ auto: true }));

    // Assert
    should(outcome.outcome).equal('started');
    should(outcome.attempts.map(attempt => [attempt.runtime, attempt.outcome, attempt.refusal?.code])).deepEqual([
      ['claude-main', 'refused', 'out_of_quota'],
      ['claude-fast', 'started', undefined],
    ]);
    should(starts.map(start => start.agent)).deepEqual(['claude-fast-wrapper']);
  });

  it('should word a failed probe without a model when none is known', async () => {
    // Arrange
    const bare = runtime('bare');
    const { subject } = build({
      runtimes: [bare],
      probes: { 'bare-wrapper': { ok: false, ms: 1, reason: 'no output' } },
    });

    // Act
    const outcome = await subject.newChild({ task: 'fix', runtime: 'bare', cwd: '/w' });

    // Assert
    should(refusalOf(outcome)?.message).equal('bare did not answer a "reply OK" check: no output.');
  });

  it('should report a cached probe as cached', async () => {
    // Arrange
    const { subject } = build({ parents: { p1: PARENT }, cached: ['claude-main-wrapper'] });

    // Act
    const outcome = await subject.newChild(request({ runtime: 'claude-main', model: 'opus' }));

    // Assert
    should(outcome.outcome === 'started' && outcome.attempts[0]?.probe).equal('cached');
  });

  it('should answer a start the daemon’s own admission refuses as a refusal that keeps its attempt', async () => {
    // Arrange
    const refusal = { code: 'limit_reached', message: 'too many' } as const;
    const { subject } = build({ parents: { p1: PARENT }, startError: new PackStartRefused(refusal) });

    // Act
    const outcome = await subject.newChild(request({ runtime: 'claude-main', model: 'opus' }));

    // Assert
    should(outcome).deepEqual({
      outcome: 'refused',
      refusal,
      attempts: [{ runtime: 'claude-main', model: 'opus', outcome: 'refused', refusal, probe: 'ran' }],
    });
  });

  it('should let any other start failure propagate', async () => {
    // Arrange
    const { subject } = build({ parents: { p1: PARENT }, startError: new Error('disk full') });

    // Act
    const failure = subject.newChild(request({ runtime: 'claude-main', model: 'opus' }));

    // Assert
    await should(failure).rejectedWith('disk full');
  });

  it('should name PackStartRefused for what it is', () => {
    // Arrange / Act
    const error = new PackStartRefused({ code: 'pack_off', message: 'off' });

    // Assert
    should(error.name).equal('PackStartRefused');
    should(error.message).equal('off');
  });
});

describe('PackService.newChild --auto', () => {
  it('should start the guide’s first ready candidate, at the candidate’s effort unless the request names one', async () => {
    // Arrange
    const plain = build({ parents: { p1: PARENT } });
    const forced = build({ parents: { p1: PARENT } });

    // Act
    const first = await plain.subject.newChild(request({ auto: true, useCase: 'everyday' }));
    await forced.subject.newChild(request({ auto: true, effort: 'low' }));

    // Assert
    should(first.outcome === 'started' && first.decidedBy).equal('guide');
    should(plain.starts[0]).containEql({ agent: 'claude-main-wrapper', model: 'opus', effort: 'high' });
    should(plain.ranks).be.empty();
    should(forced.starts[0]?.effort).equal('low');
  });

  it('should refuse no_candidate, saying why the first candidate cannot run, when nothing is ready', async () => {
    // Arrange
    const { subject, starts } = build({ parents: { p1: PARENT }, runtimes: [] });

    // Act
    const outcome = await subject.newChild(request({ auto: true }));

    // Assert
    should(refusalOf(outcome)).deepEqual({
      code: 'no_candidate',
      message: 'Nothing in the models guide can run here now: No runtime on this machine offers Opus (anthropic).',
      remedy: 'Do the work yourself, or ask the owner to sign a login in.',
    });
    should(starts).be.empty();
  });

  it('should refuse no_candidate without a reason when the guide names no use case', async () => {
    // Arrange
    const { subject } = build({ parents: { p1: PARENT }, guideFile: { useCases: [] } });

    // Act
    const outcome = await subject.newChild(request({ auto: true }));

    // Assert
    should(refusalOf(outcome)?.message).equal('Nothing in the models guide can run here now');
  });

  it('should try the next ready candidate when the first fails its probe', async () => {
    // Arrange
    const { subject, starts } = build({
      parents: { p1: PARENT },
      probes: { 'claude-main-wrapper': { ok: false, ms: 9, reason: 'no OK' } },
    });

    // Act
    const outcome = await subject.newChild(request({ auto: true }));

    // Assert
    should(outcome.outcome).equal('started');
    if (outcome.outcome !== 'started') return;
    should(outcome.attempts.map(attempt => [attempt.runtime, attempt.outcome, attempt.refusal?.code])).deepEqual([
      ['claude-main', 'refused', 'probe_failed'],
      ['claude-fast', 'started', undefined],
    ]);
    should(starts).have.length(1);
    should(starts[0]?.agent).equal('claude-fast-wrapper');
  });

  it('should refuse with the last probe failure, keeping every attempt, when all fail', async () => {
    // Arrange
    const { subject, starts } = build({
      parents: { p1: PARENT },
      probes: {
        'claude-main-wrapper': { ok: false, ms: 9, reason: 'first' },
        'claude-fast-wrapper': { ok: false, ms: 8, reason: 'second' },
      },
    });

    // Act
    const outcome = await subject.newChild(request({ auto: true }));

    // Assert
    should(outcome.outcome).equal('refused');
    if (outcome.outcome !== 'refused') return;
    should(outcome.refusal.message).containEql('claude-fast did not answer');
    should(outcome.refusal.message).containEql('second');
    should(outcome.attempts).have.length(2);
    should(starts).be.empty();
  });
});

describe('PackService.newChild --auto with Jev deciding', () => {
  const jev = packConfig({ decision: 'jev', jev: { usdPerDay: 0.25 } });

  it('should try the candidates in Jev’s order and record what the answer cost', async () => {
    // Arrange
    const { subject, ranks, recorded, starts } = build({ config: jev, parents: { p1: PARENT } });

    // Act
    const outcome = await subject.newChild(request({ auto: true }));

    // Assert
    should(ranks).have.length(1);
    should(ranks[0]?.slice(0, 2)).deepEqual([
      'fix the bug',
      [
        { model: 'opus', runtime: 'claude-main', why: 'Strong.' },
        { model: 'haiku', runtime: 'claude-fast', why: 'Cheap.' },
      ],
    ]);
    // Jev decides WITH the guide: its routing prompt (rendered here, the file has none) and the use case.
    should(ranks[0]?.[2]?.useCase).deepEqual({ title: 'Everyday coding', description: 'Ordinary work.' });
    should(ranks[0]?.[2]?.routing).containEql('Everyday coding (everyday): Opus at high effort, then Haiku.');
    should(recorded).deepEqual([1]);
    should(starts[0]?.agent).equal('claude-fast-wrapper');
    should(outcome.outcome === 'started' && outcome.decidedBy).equal('jev');
    should(outcome.outcome === 'started' && 'note' in outcome).be.false();
  });

  it('should use the guide’s order, and say so, once Jev’s daily cap is reached', async () => {
    // Arrange
    const { subject, ranks, recorded, starts } = build({ config: jev, parents: { p1: PARENT }, spent: 0.25 });

    // Act
    const outcome = await subject.newChild(request({ auto: true }));

    // Assert
    should(ranks).be.empty();
    should(recorded).be.empty();
    should(starts[0]?.agent).equal('claude-main-wrapper');
    should(outcome.outcome === 'started' && outcome.decidedBy).equal('guide');
    should(outcome.outcome === 'started' && outcome.note).equal(
      "Jev's daily cap for Pack mode is reached, so the guide's order was used.",
    );
  });

  it('should use the guide’s order, and say why, when Jev could not decide', async () => {
    // Arrange
    const { subject, recorded, starts } = build({
      config: jev,
      parents: { p1: PARENT },
      ranking: { kind: 'failed', reason: 'no Jev key is set' },
    });

    // Act
    const outcome = await subject.newChild(request({ auto: true }));

    // Assert
    should(recorded).be.empty();
    should(starts[0]?.agent).equal('claude-main-wrapper');
    should(outcome.outcome === 'started' && outcome.decidedBy).equal('guide');
    should(outcome.outcome === 'started' && outcome.note).equal(
      "Jev could not decide (no Jev key is set), so the guide's order was used.",
    );
  });

  it('should not ask Jev to choose between one candidate', async () => {
    // Arrange
    const { subject, ranks } = build({ config: jev, parents: { p1: PARENT }, runtimes: [CLAUDE_MAIN] });

    // Act
    const outcome = await subject.newChild(request({ auto: true }));

    // Assert
    should(ranks).be.empty();
    should(outcome.outcome === 'started' && outcome.decidedBy).equal('guide');
  });
});
