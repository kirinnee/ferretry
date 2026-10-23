import { describe, it } from 'bun:test';
import {
  type PackCleanUpJobResult,
  type PackCleanUpRequest,
  type PackCleanUpStart,
  type PackCleanUpStatus,
  type PackInventory,
  PackInventorySchema,
  type PackNewOutcome,
  PackNewOutcomeSchema,
  type PackNewRequest,
  type PackRecommendation,
  type PackRoutingAcceptRequest,
  type PackView,
  SessionPackPatchResultSchema,
  type SessionResult,
  SessionResultSchema,
  type SessionView,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { type PackSubsystem, packRoutes } from '../../../../src/lib/runtime/mounts/pack.ts';
import { SessionPackError } from '../../../../src/lib/session/pack/service.ts';
import { jsonBody, request } from '../../api/support.ts';
import { packConfig } from '../../pack/support.ts';
import { agentIn, CREDENTIALS, GRANTED, human, sessionView } from './support.ts';

/** The Pack mode routes, over the real dispatcher: what each status and body is made of. */

const QUOTA = { state: 'plenty', leftPercent: 80, windows: [], summary: '5h 2% · wk 20%' } as const;
const AVAILABLE = {
  provider: 'anthropic',
  model: 'opus',
  modelLabel: 'Opus',
  harness: 'claude',
  tier: 'best',
  efforts: ['low', 'high'],
  runtime: 'claude-main',
  runtimes: 1,
  ready: true,
  quota: QUOTA,
  named: 1,
  command: 'fy new --auto --runtime claude-main --model opus',
} as const;
const ROUTING = { text: 'Opus for planning, haiku for chores.', source: 'file' } as const;
const CLEAN_UP: PackCleanUpStatus = { available: true, runtimes: ['claude-main'] };
const VIEW: Omit<PackView, 'cleanUp' | 'undo'> = {
  config: packConfig(),
  routing: ROUTING,
  models: [],
  available: [AVAILABLE],
};
const RECOMMENDATION: PackRecommendation = {
  task: 'fix the bug',
  routing: ROUTING,
  available: [AVAILABLE],
  next: AVAILABLE.command,
};
const RESULT: SessionResult = { id: 's1', status: 'finished', finished: true, summary: 'done it' };
const INVENTORY: PackInventory = {
  at: '2026-10-22T12:00:00.000Z',
  models: [
    {
      provider: 'anthropic',
      harness: 'claude',
      id: 'opus',
      label: 'Opus',
      tier: 'best',
      efforts: ['low'],
      runtimes: [{ name: 'claude-main', ready: true }],
    },
  ],
  runtimes: [
    {
      name: 'claude-main',
      harness: 'claude',
      provider: 'anthropic',
      login: 'claude-main-login',
      ready: true,
      quota: QUOTA,
      models: ['opus'],
    },
  ],
  routing: ROUTING,
};
const JOB = {
  id: 'run-1',
  session: 's9',
  name: 'Routing Prompt Clean-up',
  runtime: 'claude-main',
  startedAt: '2026-10-22T12:00:00.000Z',
  status: 'running',
} as const;
const SUGGESTED = { by: 'opus', via: 'claude-main', at: '2026-10-22T12:00:00.000Z' };

class FakePack implements PackSubsystem {
  readonly recommended: Array<{ task?: string | undefined }> = [];
  readonly started: PackNewRequest[] = [];
  readonly switched: Array<readonly [string, boolean]> = [];
  readonly cleanUps: PackCleanUpRequest[] = [];
  readonly accepted: PackRoutingAcceptRequest[] = [];
  undone = 0;

  constructor(
    private readonly options: {
      readonly outcome?: PackNewOutcome;
      readonly result?: SessionResult | undefined;
      readonly switchError?: unknown;
      readonly start?: PackCleanUpStart;
      readonly job?: PackCleanUpJobResult | undefined;
      readonly status?: PackCleanUpStatus;
      readonly undo?: { readonly savedAt: string; readonly source: 'file' | 'default' };
    } = {},
  ) {}

  readonly routing = {
    cleanUp: {
      status: async () => this.options.status ?? CLEAN_UP,
      start: async (input: PackCleanUpRequest): Promise<PackCleanUpStart> => {
        this.cleanUps.push(input);
        return this.options.start ?? { outcome: 'started', job: JOB };
      },
      job: async (id: string): Promise<PackCleanUpJobResult | undefined> => {
        if (id === 'boom') throw new Error('unreadable run');
        return 'job' in this.options ? this.options.job : { job: { ...JOB, id } };
      },
    },
    file: {
      undoable: async () => this.options.undo,
      accept: async (input: PackRoutingAcceptRequest) => {
        this.accepted.push(input);
        return { outcome: 'applied' as const, message: 'Accepted.' };
      },
      undo: async () => {
        this.undone += 1;
        return { outcome: 'nothing' as const, message: 'Nothing to undo.' };
      },
    },
  };

  readonly service = {
    view: async () => VIEW,
    inventory: async () => INVENTORY,
    recommend: async (input: { readonly task?: string | undefined }) => {
      this.recommended.push(input);
      return RECOMMENDATION;
    },
    newChild: async (input: PackNewRequest): Promise<PackNewOutcome> => {
      this.started.push(input);
      return (
        this.options.outcome ?? {
          outcome: 'started',
          view: sessionView('child-1'),
          decidedBy: 'agent',
          attempts: [{ runtime: 'claude-main', outcome: 'started' }],
        }
      );
    },
  };

  async result(sessionId: string): Promise<SessionResult | undefined> {
    return 'result' in this.options ? this.options.result : { ...RESULT, id: sessionId };
  }

  async setSwitch(
    sessionId: string,
    enabled: boolean,
  ): Promise<{ view: SessionView; outcome: { restartRequired: boolean; note: string } }> {
    this.switched.push([sessionId, enabled]);
    if (this.options.switchError !== undefined) throw this.options.switchError;
    return { view: sessionView(sessionId), outcome: { restartRequired: true, note: 'Pack mode is off.' } };
  }
}

const dispatcher = (subsystem: PackSubsystem): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(packRoutes(subsystem)), CREDENTIALS, GRANTED);

const call = (method: string, path: string, body?: unknown, loopback = false) =>
  request({ method, path, headers: human, loopback, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('GET /v1/pack', () => {
  it('should answer the settings page’s view with the clean-up status merged in, uncached', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('GET', '/v1/pack'));

    // Assert
    should(answer.status).equal(200);
    should(jsonBody(answer)).deepEqual({
      ...(JSON.parse(JSON.stringify(VIEW)) as Record<string, unknown>),
      cleanUp: CLEAN_UP,
    });
    should(answer.headers.get('cache-control')).equal('no-store');
  });

  it('should add what an undo would put back, when there is one, and the newest clean-up run', async () => {
    // Arrange
    const subsystem = new FakePack({
      undo: { savedAt: '2026-10-22T12:00:00.000Z', source: 'default' },
      status: { available: false, runtimes: [], reason: 'No runtime can start a ferret now.', job: JOB },
    });

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('GET', '/v1/pack'));

    // Assert
    should(jsonBody(answer).undo).deepEqual({ savedAt: '2026-10-22T12:00:00.000Z', source: 'default' });
    should(jsonBody(answer).cleanUp).deepEqual({
      available: false,
      runtimes: [],
      reason: 'No runtime can start a ferret now.',
      job: JOB,
    });
  });
});

describe('the routing prompt clean-up routes', () => {
  it('should answer the inventory the clean-up ferret is shown, valid against its schema', async () => {
    // Act
    const answer = await dispatcher(new FakePack()).dispatch(call('GET', '/v1/pack/inventory'));

    // Assert
    should(answer.status).equal(200);
    should(PackInventorySchema.parse(jsonBody(answer))).deepEqual(INVENTORY);
  });

  it('should start a clean-up for a person with 201, and answer a refusal with 200', async () => {
    // Arrange
    const subsystem = new FakePack();
    const refusing = new FakePack({ start: { outcome: 'refused', message: 'No runtime is ready.' } });

    // Act
    const started = await dispatcher(subsystem).dispatch(
      call('POST', '/v1/pack/routing/clean-up', { runtime: 'claude-main', prompt: 'opus for reviews, i guess' }),
    );
    const refused = await dispatcher(refusing).dispatch(call('POST', '/v1/pack/routing/clean-up', {}));

    // Assert
    should(started.status).equal(201);
    should(jsonBody(started).job).containEql({ id: 'run-1', status: 'running' });
    should(subsystem.cleanUps).deepEqual([{ runtime: 'claude-main', prompt: 'opus for reviews, i guess' }]);
    should(refused.status).equal(200);
    should(jsonBody(refused)).deepEqual({ outcome: 'refused', message: 'No runtime is ready.' });
  });

  it('should refuse 400 a clean-up request that carries a key it does not know, and start nothing', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(
      call('POST', '/v1/pack/routing/clean-up', { preferences: 'old key' }),
    );

    // Assert
    should(answer.status).equal(400);
    should(subsystem.cleanUps).be.empty();
  });

  it("should refuse a ferret's own credential every act that spends a model run or rewrites the prompt", async () => {
    // Arrange
    const subsystem = new FakePack();
    const agent = (path: string, body: unknown) =>
      dispatcher(subsystem).dispatch(
        request({ method: 'POST', path, headers: agentIn('s1'), body: JSON.stringify(body) }),
      );

    // Act
    const answers = await Promise.all([
      agent('/v1/pack/routing/clean-up', {}),
      agent('/v1/pack/routing/accept', { prompt: 'Opus.', suggested: SUGGESTED }),
      agent('/v1/pack/routing/undo', {}),
    ]);

    // Assert
    should(answers.map(answer => answer.status)).deepEqual([403, 403, 403]);
    should(jsonBody(answers[0] as (typeof answers)[number]).code).equal('forbidden');
    should(subsystem.cleanUps).be.empty();
    should(subsystem.accepted).be.empty();
    should(subsystem.undone).equal(0);
  });

  it('should answer a run, and 404 for one that does not exist or cannot be read', async () => {
    // Arrange
    const missing = new FakePack({ job: undefined });

    // Act
    const found = await dispatcher(new FakePack()).dispatch(call('GET', '/v1/pack/routing/jobs/run-7'));
    const gone = await dispatcher(missing).dispatch(call('GET', '/v1/pack/routing/jobs/run-8'));
    const broken = await dispatcher(new FakePack()).dispatch(call('GET', '/v1/pack/routing/jobs/boom'));

    // Assert
    should(found.status).equal(200);
    should((jsonBody(found).job as { id: string }).id).equal('run-7');
    should(gone.status).equal(404);
    should(jsonBody(gone).code).equal('not-found');
    should(broken.status).equal(404);
  });

  it('should accept and undo for a person, and refuse an accept that is not a prompt with where it came from', async () => {
    // Arrange
    const subsystem = new FakePack();
    const accept = { prompt: 'Planning and review: opus. Chores: haiku.', suggested: SUGGESTED };

    // Act
    const accepted = await dispatcher(subsystem).dispatch(call('POST', '/v1/pack/routing/accept', accept));
    const undone = await dispatcher(subsystem).dispatch(call('POST', '/v1/pack/routing/undo', {}));
    const bare = await dispatcher(subsystem).dispatch(call('POST', '/v1/pack/routing/accept', { prompt: 'x' }));
    const legacy = await dispatcher(subsystem).dispatch(
      call('POST', '/v1/pack/routing/accept', { ...accept, useCases: [] }),
    );

    // Assert
    should([accepted.status, undone.status, bare.status, legacy.status]).deepEqual([200, 200, 400, 400]);
    should(jsonBody(accepted)).deepEqual({ outcome: 'applied', message: 'Accepted.' });
    should(jsonBody(undone)).deepEqual({ outcome: 'nothing', message: 'Nothing to undo.' });
    should(subsystem.accepted).deepEqual([accept]);
    should(subsystem.undone).equal(1);
  });

  it('should no longer answer the guide-builder paths', async () => {
    // Act
    const answers = await Promise.all(
      ['/v1/pack/guide/suggest', '/v1/pack/guide/accept', '/v1/pack/guide/undo', '/v1/pack/guide/describe'].map(path =>
        dispatcher(new FakePack()).dispatch(call('POST', path, {})),
      ),
    );

    // Assert
    should(answers.map(answer => answer.status)).deepEqual([404, 404, 404, 404]);
  });
});

describe('POST /v1/pack/recommend', () => {
  it('should answer the routing prompt and the models usable now, and pass on the task', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('POST', '/v1/pack/recommend', { task: 'fix the bug' }));

    // Assert
    should(answer.status).equal(200);
    should(jsonBody(answer)).deepEqual(JSON.parse(JSON.stringify(RECOMMENDATION)) as Record<string, unknown>);
    should(subsystem.recommended).deepEqual([{ task: 'fix the bug' }]);
  });

  it('should answer without a task, and refuse 400 a body that has a blank task or a use case', async () => {
    // Arrange
    const valid = new FakePack();

    // Act
    const bare = await dispatcher(valid).dispatch(call('POST', '/v1/pack/recommend', {}));
    const blank = await dispatcher(valid).dispatch(call('POST', '/v1/pack/recommend', { task: '' }));
    const old = await dispatcher(valid).dispatch(
      call('POST', '/v1/pack/recommend', { task: 'x', useCase: 'everyday' }),
    );

    // Assert
    should(bare.status).equal(200);
    should(blank.status).equal(400);
    should(old.status).equal(400);
    should(valid.recommended).have.length(1);
  });
});

describe('POST /v1/pack/new', () => {
  const body = { task: 'fix the bug', runtime: 'claude-main', parent: 'p1' };

  it('should answer 201 with the started outcome', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('POST', '/v1/pack/new', body));

    // Assert
    should(answer.status).equal(201);
    should(PackNewOutcomeSchema.parse(jsonBody(answer)).outcome).equal('started');
    should(subsystem.started).deepEqual([body]);
  });

  it('should answer 200 for a refusal, because a refusal is an answer', async () => {
    // Arrange
    const refused: PackNewOutcome = {
      outcome: 'refused',
      refusal: { code: 'limit_reached', message: 'too many' },
      attempts: [],
    };
    const subsystem = new FakePack({ outcome: refused });

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('POST', '/v1/pack/new', body));

    // Assert
    should(answer.status).equal(200);
    should(jsonBody(answer)).deepEqual({ ...refused });
  });

  it('should let a caller at the machine name the sub-ferret’s folder', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('POST', '/v1/pack/new', { ...body, cwd: '/work' }, true));

    // Assert
    should(answer.status).equal(201);
    should(subsystem.started[0]?.cwd).equal('/work');
  });

  it('should refuse 403 a folder chosen by a caller who is not at the machine', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('POST', '/v1/pack/new', { ...body, cwd: '/etc' }));

    // Assert
    should(answer.status).equal(403);
    should(jsonBody(answer).code).equal('not-granted');
    should(subsystem.started).be.empty();
  });

  it('should refuse 400 a start that names no runtime and does not ask for --auto', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('POST', '/v1/pack/new', { task: 'x' }));

    // Assert
    should(answer.status).equal(400);
    should(subsystem.started).be.empty();
  });
});

describe('GET /v1/sessions/:sessionId/result', () => {
  it('should answer what a ferret reported', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('GET', '/v1/sessions/s1/result'));

    // Assert
    should(answer.status).equal(200);
    should(SessionResultSchema.parse(jsonBody(answer))).deepEqual(RESULT);
  });

  it('should answer 404 for a session that does not exist and 400 for an id that cannot be read', async () => {
    // Arrange
    const subsystem = new FakePack({ result: undefined });

    // Act
    const gone = await dispatcher(subsystem).dispatch(call('GET', '/v1/sessions/ghost/result'));
    const blank = await dispatcher(subsystem).dispatch(call('GET', '/v1/sessions/%E0%A4%A/result'));

    // Assert
    should(gone.status).equal(404);
    should(jsonBody(gone).code).equal('not-found');
    should(blank.status).equal(400);
    should(jsonBody(blank).code).equal('invalid_session_id');
  });
});

describe('PATCH /v1/sessions/:sessionId/pack', () => {
  it('should switch one ferret and answer with its view, whether it needs a restart, and why', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('PATCH', '/v1/sessions/s1/pack', { enabled: false }));

    // Assert
    should(answer.status).equal(200);
    const result = SessionPackPatchResultSchema.parse(jsonBody(answer));
    should(result.restartRequired).be.true();
    should(result.note).equal('Pack mode is off.');
    should(result.view.config.id).equal('s1');
    should(subsystem.switched).deepEqual([['s1', false]]);
  });

  it('should answer 404 for a session that does not exist, 400 for a bad body, and 500 for a fault it does not own', async () => {
    // Arrange
    const missing = new FakePack({ switchError: new SessionPackError('not-found', 'no session ghost') });
    const broken = new FakePack({ switchError: new Error('disk full') });
    const valid = new FakePack();

    // Act
    const gone = await dispatcher(missing).dispatch(call('PATCH', '/v1/sessions/ghost/pack', { enabled: true }));
    const fault = await dispatcher(broken).dispatch(call('PATCH', '/v1/sessions/s1/pack', { enabled: true }));
    const bad = await dispatcher(valid).dispatch(call('PATCH', '/v1/sessions/s1/pack', { on: true }));

    // Assert
    should(gone.status).equal(404);
    should(jsonBody(gone).code).equal('not-found');
    should(fault.status).equal(500);
    should(bad.status).equal(400);
    should(valid.switched).be.empty();
  });
});

describe('the Pack route table', () => {
  it('should be operator routes, never cached, with fleet capabilities on the fleet reads and the routing prompt writes', () => {
    // Arrange / Act
    const routes = packRoutes(new FakePack());

    // Assert
    should(
      routes.map(route => [
        route.method,
        route.path,
        route.minimum,
        route.noStore,
        route.capability?.capability,
        route.capability?.axis,
      ]),
    ).deepEqual([
      ['GET', '/v1/pack', 'operator', true, 'fleet', 'use'],
      ['GET', '/v1/pack/inventory', 'operator', true, 'fleet', 'use'],
      ['POST', '/v1/pack/routing/clean-up', 'operator', true, 'fleet', 'use'],
      ['GET', '/v1/pack/routing/jobs/:jobId', 'operator', true, 'fleet', 'use'],
      ['POST', '/v1/pack/routing/accept', 'operator', true, 'fleet', 'configure'],
      ['POST', '/v1/pack/routing/undo', 'operator', true, 'fleet', 'configure'],
      ['POST', '/v1/pack/recommend', 'operator', true, 'fleet', 'use'],
      ['POST', '/v1/pack/new', 'operator', true, undefined, undefined],
      ['GET', '/v1/sessions/:sessionId/result', 'operator', true, undefined, undefined],
      ['PATCH', '/v1/sessions/:sessionId/pack', 'operator', true, undefined, undefined],
    ]);
  });
});
