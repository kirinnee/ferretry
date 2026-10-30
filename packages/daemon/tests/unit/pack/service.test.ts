import { describe, it } from 'bun:test';
import type {
  ModelCatalogView,
  ModelsGuideFile,
  PackNewOutcome,
  PackNewRequest,
  SessionView,
  StartSessionRequestInput,
} from '@ferretry/protocol';
import { briefHash, PackInventorySchema, PackViewSchema } from '@ferretry/protocol';
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
import type { Delegation } from '../../../src/lib/board/index.ts';
import { sessionView } from '../runtime/mounts/support.ts';
import { catalog, choice, entry, facts, packConfig, runtime } from './support.ts';

const PROMPT = 'Everyday work: opus at high; then haiku for chores.';
const GUIDE_FILE: ModelsGuideFile = { prompt: PROMPT };

const CLAUDE_MAIN = runtime('claude-main', {
  catalogId: 'anthropic',
  choices: [
    choice('opus', 'Opus', { tier: 'best', efforts: ['low', 'high'] }),
    choice('sonnet', 'Sonnet', { tier: 'balanced' }),
  ],
});
const CLAUDE_FAST = runtime('claude-fast', {
  catalogId: 'anthropic',
  choices: [choice('haiku', 'Haiku', { tier: 'fast' })],
});

const CATALOGS: readonly ModelCatalogView[] = [
  catalog('anthropic', 'Anthropic', {
    claude: [
      entry('opus', 'Opus', 'best', { efforts: ['low', 'high'] }),
      entry('haiku', 'Haiku', 'fast'),
      entry('sonnet', 'Sonnet', 'balanced'),
    ],
    codex: [entry('gpt-5', 'GPT-5', 'best')],
  }),
];

const PARENT: PackParent = { id: 'p1', interactive: false, depth: 0, runningChildren: 0, cwd: '/work/parent' };

interface Options {
  config?: ReturnType<typeof packConfig>;
  guideFile?: ModelsGuideFile;
  runtimes?: readonly ReturnType<typeof runtime>[];
  parents?: Readonly<Record<string, PackParent>>;
  /** What a probe answers, by wrapper and model; absent means OK. */
  probes?: Readonly<Record<string, PackProbeOutcome>>;
  cached?: readonly string[];
  startError?: unknown;
  ranking?: JevRanking;
  spent?: number;
  /** The folders the scratch check calls temporary. */
  scratch?: readonly string[];
  /** What the lead's side of the card answers; absent: no card (a board that makes none). */
  delegate?: Awaited<ReturnType<PackPorts['cards']['delegate']>>;
  /** The child the start answers with, focused on a card or not. */
  child?: SessionView;
}

function build(options: Options = {}) {
  const probes: Array<readonly [PackProbeRequest, number]> = [];
  const starts: StartSessionRequestInput[] = [];
  const delegations: Array<Delegation | undefined> = [];
  const delegated: Array<readonly [string, string, boolean]> = [];
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
        outcome: options.probes?.[`${request.wrapper}/${request.model ?? ''}`] ??
          options.probes?.[request.wrapper] ?? { ok: true, ms: 25 },
        cached: options.cached?.includes(request.wrapper) === true,
      };
    },
    start: async (request, delegation) => {
      starts.push(request);
      delegations.push(delegation);
      if (options.startError !== undefined) throw options.startError;
      return options.child ?? (sessionView('child-1') satisfies SessionView);
    },
    cards: {
      delegate: async (lead, brief, inLeadFolder) => {
        delegated.push([lead, brief, inLeadFolder]);
        return options.delegate ?? { notes: [] };
      },
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
    now: () => '2026-10-22T12:00:00.000Z',
  };
  return { subject: new PackService(ports), probes, starts, delegations, delegated, ranks, recorded };
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

describe('PackService.routingLine', () => {
  it("should give the whole routing prompt as one line, the file's or else the default", async () => {
    // Arrange
    const own = build({ guideFile: { prompt: 'Plans: opus at high.\n- Chores: "haiku"' } });
    const none = build({ guideFile: {} });

    // Act / Assert
    should(await own.subject.routingLine()).equal("Routing: Plans: opus at high. Chores: 'haiku'");
    should(await none.subject.routingLine()).startWith("Routing: Pick each sub-task's model by the kind of work: ");
    should(await none.subject.routingLine()).not.containEql('\n');
  });
});

describe('PackService.view', () => {
  it('should read the settings, the routing prompt in effect, the vocabulary and the models usable now', async () => {
    // Arrange
    const { subject } = build();

    // Act
    const view = await subject.view();

    // Assert
    should(view.config).deepEqual(packConfig());
    should(view.routing).deepEqual({ text: PROMPT, source: 'file' });
    should(view.models.map(model => model.id)).deepEqual(['opus', 'haiku', 'sonnet', 'gpt-5']);
    should(view.available.map(option => [option.model, option.named ?? null])).deepEqual([
      ['opus', 1],
      ['haiku', 2],
      ['sonnet', null],
    ]);
    should(PackViewSchema.safeParse({ ...view, cleanUp: { available: false, runtimes: [] } }).success).be.true();
  });

  it('should show the default, and say so, when the file has no prompt', async () => {
    // Act
    const view = await build({ guideFile: {} }).subject.view();

    // Assert
    should(view.routing.source).equal('default');
    should(view.routing.text).containEql('critical code: opus at high');
  });

  it('should render the default from the catalogs whatever the file says', async () => {
    should(await build().subject.defaultPrompt()).containEql('- Everyday coding: sonnet.');
  });
});

describe('PackService.inventory', () => {
  it('should show the clean-up ferret every runtime, every model and the prompt in effect, names and states only', async () => {
    // Act
    const inventory = await build().subject.inventory();

    // Assert
    should(PackInventorySchema.safeParse(inventory).success).be.true();
    should(inventory.at).equal('2026-10-22T12:00:00.000Z');
    should(inventory.runtimes.map(row => [row.name, row.login, row.ready, row.models])).deepEqual([
      ['claude-main', 'claude-main-login', true, ['opus', 'sonnet']],
      ['claude-fast', 'claude-fast-login', true, ['haiku']],
    ]);
    should(inventory.models.find(model => model.id === 'opus')?.runtimes).deepEqual([
      { name: 'claude-main', ready: true },
    ]);
    should(inventory.routing.text).equal(PROMPT);
  });
});

describe('PackService.recommend', () => {
  it('should answer the routing prompt, the models usable now and what --auto would try first', async () => {
    // Act
    const answer = await build().subject.recommend({ task: 'fix the bug' });

    // Assert
    should(answer.task).equal('fix the bug');
    should(answer.routing.text).equal(PROMPT);
    should(answer.available).have.length(3);
    should(answer.next).equal(
      'fy new --runtime claude-main --model opus --effort high --name "<short task title>" "<complete brief>"',
    );
  });

  it('should answer without a task, and with no next when nothing can run', async () => {
    // Act
    const answer = await build({ runtimes: [] }).subject.recommend({});

    // Assert
    should(answer).not.have.property('task');
    should(answer).not.have.property('next');
    should(answer.available).be.empty();
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

  it('should title an unnamed sub-ferret from its brief, else Sub Ferret and a short hash', async () => {
    // Arrange
    const { subject, starts } = build({ parents: { p1: PARENT } });
    const boilerplate = 'You are an implementer. Read /tmp/briefs/x.md and follow it exactly.';

    // Act
    await subject.newChild(request({ runtime: 'claude-main', model: 'opus', task: 'Fix the login redirect bug now' }));
    await subject.newChild(request({ runtime: 'claude-main', model: 'opus', task: boilerplate }));

    // Assert
    should(starts[0]?.name).equal('Fix the Login Redirect Bug');
    should(starts[1]?.name).equal(`Sub Ferret ${briefHash(boilerplate)}`);
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
  it('should start the first ready model the routing prompt names, at the effort it names unless the request names one', async () => {
    // Arrange
    const plain = build({ parents: { p1: PARENT } });
    const forced = build({ parents: { p1: PARENT } });

    // Act
    const first = await plain.subject.newChild(request({ auto: true }));
    await forced.subject.newChild(request({ auto: true, effort: 'low' }));

    // Assert
    should(first.outcome === 'started' && first.decidedBy).equal('routing');
    should(plain.starts[0]).containEql({ agent: 'claude-main-wrapper', model: 'opus', effort: 'high' });
    should(plain.ranks).be.empty();
    should(forced.starts[0]?.effort).equal('low');
  });

  it("should fall back down the prompt's order, then to the ready model with the most headroom it does not name", async () => {
    // Arrange
    const { subject, starts, probes } = build({
      parents: { p1: PARENT },
      probes: {
        'claude-main-wrapper/opus': { ok: false, ms: 9, reason: 'no OK', code: 'out_of_quota' },
        'claude-fast-wrapper/haiku': { ok: false, ms: 8, reason: 'no OK' },
      },
    });

    // Act
    const outcome = await subject.newChild(request({ auto: true }));

    // Assert
    should(probes.map(([probe]) => probe.model)).deepEqual(['opus', 'haiku', 'sonnet']);
    should(outcome.outcome).equal('started');
    if (outcome.outcome !== 'started') return;
    should(
      outcome.attempts.map(attempt => [attempt.runtime, attempt.model, attempt.outcome, attempt.refusal?.code]),
    ).deepEqual([
      ['claude-main', 'opus', 'refused', 'out_of_quota'],
      ['claude-fast', 'haiku', 'refused', 'probe_failed'],
      ['claude-main', 'sonnet', 'started', undefined],
    ]);
    should(starts.map(start => start.model)).deepEqual(['sonnet']);
  });

  it('should try the ready model with the most headroom when the prompt names nothing that can run', async () => {
    // Arrange
    const { subject, starts } = build({ parents: { p1: PARENT }, guideFile: { prompt: 'Use glm-9 for everything.' } });

    // Act
    const outcome = await subject.newChild(request({ auto: true }));

    // Assert
    should(outcome.outcome === 'started' && outcome.attempts).have.length(1);
    should(starts[0]?.model).equal('opus');
  });

  it('should refuse no_candidate, saying why the first model cannot run, when nothing is ready', async () => {
    // Arrange
    const off = runtime('claude-off', {
      catalogId: 'anthropic',
      choices: [choice('opus', 'Opus')],
      launch: { available: false, reason: 'Sign in to launch' },
    });
    const { subject, starts } = build({ parents: { p1: PARENT }, runtimes: [off] });
    const empty = build({ parents: { p1: PARENT }, runtimes: [] });

    // Act
    const outcome = await subject.newChild(request({ auto: true }));
    const nothing = await empty.subject.newChild(request({ auto: true }));

    // Assert
    should(refusalOf(outcome)).deepEqual({
      code: 'no_candidate',
      message: 'No model a runtime here offers can run now: claude-off cannot launch: Sign in to launch',
      remedy: 'Do the work yourself, or ask the owner to sign a login in.',
    });
    should(refusalOf(nothing)?.message).equal('No model a runtime here offers can run now');
    should(starts).be.empty();
  });

  it('should refuse with the last probe failure, keeping every attempt, when all fail', async () => {
    // Arrange
    const { subject, starts } = build({
      parents: { p1: PARENT },
      runtimes: [CLAUDE_FAST],
      probes: { 'claude-fast-wrapper/haiku': { ok: false, ms: 8, reason: 'second' } },
    });

    // Act
    const outcome = await subject.newChild(request({ auto: true }));

    // Assert
    should(outcome.outcome).equal('refused');
    if (outcome.outcome !== 'refused') return;
    should(outcome.refusal.message).containEql('claude-fast did not answer');
    should(outcome.refusal.message).containEql('second');
    should(outcome.attempts).have.length(1);
    should(starts).be.empty();
  });
});

describe('PackService.newChild --auto with Jev deciding', () => {
  const jev = packConfig({ decision: 'jev', jev: { usdPerDay: 0.25 } });

  it('should give Jev the same routing prompt and every ready model, and try them in its order', async () => {
    // Arrange
    const { subject, ranks, recorded, starts } = build({ config: jev, parents: { p1: PARENT } });

    // Act
    const outcome = await subject.newChild(request({ auto: true }));

    // Assert
    should(ranks).have.length(1);
    should(ranks[0]?.[0]).equal('fix the bug');
    should(ranks[0]?.[1]).deepEqual([
      { model: 'opus', runtime: 'claude-main', why: 'Opus, best tier, named 1 in the routing prompt, at high effort' },
      { model: 'haiku', runtime: 'claude-fast', why: 'Haiku, fast tier, named 2 in the routing prompt' },
      { model: 'sonnet', runtime: 'claude-main', why: 'Sonnet, balanced tier' },
    ]);
    // Jev decides with exactly the text the asking ferret reads.
    should(ranks[0]?.[2]).deepEqual({ routing: PROMPT });
    should(recorded).deepEqual([1]);
    should(starts[0]?.agent).equal('claude-fast-wrapper');
    should(outcome.outcome === 'started' && outcome.decidedBy).equal('jev');
    should(outcome.outcome === 'started' && 'note' in outcome).be.false();
  });

  it("should use the routing prompt's order, and say so, once Jev's daily cap is reached", async () => {
    // Arrange
    const { subject, ranks, recorded, starts } = build({ config: jev, parents: { p1: PARENT }, spent: 0.25 });

    // Act
    const outcome = await subject.newChild(request({ auto: true }));

    // Assert
    should(ranks).be.empty();
    should(recorded).be.empty();
    should(starts[0]?.agent).equal('claude-main-wrapper');
    should(outcome.outcome === 'started' && outcome.decidedBy).equal('routing');
    should(outcome.outcome === 'started' && outcome.note).equal(
      "Jev's daily cap for Pack mode is reached, so the routing prompt's order was used.",
    );
  });

  it("should use the routing prompt's order, and say why, when Jev could not decide", async () => {
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
    should(outcome.outcome === 'started' && outcome.decidedBy).equal('routing');
    should(outcome.outcome === 'started' && outcome.note).equal(
      "Jev could not decide (no Jev key is set), so the routing prompt's order was used.",
    );
  });

  it('should not ask Jev to choose between one model', async () => {
    // Arrange
    const { subject, ranks } = build({ config: jev, parents: { p1: PARENT }, runtimes: [CLAUDE_FAST] });

    // Act
    const outcome = await subject.newChild(request({ auto: true }));

    // Assert
    should(ranks).be.empty();
    should(outcome.outcome === 'started' && outcome.decidedBy).equal('routing');
  });
});

describe("a sub-ferret's card", () => {
  const delegation = (extra: Partial<Delegation> = {}): Delegation => ({
    lead: 'p1',
    brief: 'fix the bug',
    id: 'F413',
    parent: { id: 'F412' },
    project: 'Ferretry',
    notes: [],
    ...extra,
  });

  it('should reserve the card under the lead, name it in the brief and start no board access', async () => {
    // Arrange
    const reserved = delegation();
    const { subject, starts, delegations, delegated } = build({
      parents: { p1: PARENT },
      delegate: { delegation: reserved, notes: [] },
      child: sessionView('child-1', { focusTask: { id: 'F413' } }),
    });

    // Act
    const outcome = await subject.newChild(request({ runtime: 'claude-main' }));

    // Assert
    should(delegated).deepEqual([['p1', 'fix the bug', true]]);
    should(delegations).deepEqual([reserved]);
    should(starts[0]?.prompt).containEql(
      'Your card is &F413 on the Ferretry board; move it as you work (`fy task …`).',
    );
    should(starts[0]).not.have.property('boardAccess');
    should(outcome.outcome === 'started' && outcome.card).deepEqual({ id: 'F413', project: 'Ferretry' });
  });

  it("should say the lead's card was made for it, and not name a board a named folder may not be on", async () => {
    // Arrange
    const notes = ['You had no card, so &F412 was made for you.'];
    const { subject, starts, delegated } = build({
      parents: { p1: PARENT },
      delegate: { delegation: delegation({ leadCard: 'F412', project: undefined, notes }), notes },
      child: sessionView('child-1', { focusTask: { id: 'F413' } }),
    });

    // Act
    const outcome = await subject.newChild(request({ runtime: 'claude-main', cwd: '/work/other' }));

    // Assert
    should(delegated[0]?.[2]).be.false();
    should(starts[0]?.prompt).containEql("Your card is &F413 on the project's board");
    should(outcome.outcome === 'started' && outcome.card).deepEqual({ id: 'F413', leadCard: 'F412', note: notes[0] });
  });

  it('should say so when the start made no card, and the footer then names none', async () => {
    // Arrange
    const missed = build({
      parents: { p1: PARENT },
      delegate: { delegation: delegation(), notes: [] },
    });
    const refused = build({ parents: { p1: PARENT }, delegate: { notes: ['No card was made: the board is down'] } });

    // Act
    const unmade = await missed.subject.newChild(request({ runtime: 'claude-main' }));
    const none = await refused.subject.newChild(request({ runtime: 'claude-main' }));

    // Assert
    should(unmade.outcome === 'started' && unmade.card).deepEqual({
      note: '&F413 could not be made, so the sub-ferret started without a card.',
    });
    should(refused.starts[0]?.prompt).not.containEql('Your card is');
    should(none.outcome === 'started' && none.card).deepEqual({ note: 'No card was made: the board is down' });
  });

  it('should leave a top-level start to make its own card, and report the one it focuses', async () => {
    // Arrange
    const { subject, delegated, delegations } = build({
      child: sessionView('child-1', { focusTask: { id: 'F9' } }),
    });
    const plain = build();

    // Act
    const outcome = await subject.newChild({ task: 'fix', runtime: 'claude-main', cwd: '/w' });
    const bare = await plain.subject.newChild({ task: 'fix', runtime: 'claude-main', cwd: '/w' });

    // Assert
    should(delegated).be.empty();
    should(delegations).deepEqual([undefined]);
    should(outcome.outcome === 'started' && outcome.card).deepEqual({ id: 'F9' });
    should(bare.outcome === 'started' && 'card' in bare).be.false();
  });

  it('should reserve nothing when no candidate gets as far as a start', async () => {
    // Arrange
    const { subject, delegated } = build({
      parents: { p1: PARENT },
      probes: { 'claude-main-wrapper': { ok: false, ms: 5, reason: 'no answer' } },
    });

    // Act
    const outcome = await subject.newChild(request({ runtime: 'claude-main' }));

    // Assert
    should(outcome.outcome).equal('refused');
    should(delegated).be.empty();
  });
});
