import { describe, it } from 'bun:test';
import {
  type PackGuideAcceptRequest,
  type PackGuideDescribeRequest,
  type PackGuideJobResult,
  type PackGuideSuggestRequest,
  type PackGuideSuggestStart,
  type PackInventory,
  type PackNewOutcome,
  PackNewOutcomeSchema,
  type PackNewRequest,
  type PackRecommendation,
  type PackView,
  SessionPackPatchResultSchema,
  type SessionResult,
  SessionResultSchema,
  type SessionView,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { GuideModelUnknownError } from '../../../../src/lib/pack/builder/index.ts';
import { type PackSubsystem, packRoutes } from '../../../../src/lib/runtime/mounts/pack.ts';
import { SessionPackError } from '../../../../src/lib/session/pack/service.ts';
import { jsonBody, request } from '../../api/support.ts';
import { packConfig } from '../../pack/support.ts';
import { agentIn, CREDENTIALS, GRANTED, human, sessionView } from './support.ts';

/** The five Pack mode routes, over the real dispatcher: what each status and body is made of. */

const VIEW: PackView = { config: packConfig(), guide: { source: 'derived', useCases: [] }, models: [] };
const RECOMMENDATION: PackRecommendation = {
  task: 'fix the bug',
  useCase: { id: 'everyday', title: 'Everyday coding', matchedBy: 'words' },
  guideSource: 'derived',
  candidates: [
    {
      rank: 1,
      provider: 'anthropic',
      model: 'opus',
      why: 'Strong.',
      ready: false,
      refusal: { code: 'no_candidate', message: 'none' },
    },
  ],
};
const RESULT: SessionResult = { id: 's1', status: 'finished', finished: true, summary: 'done it' };
const INVENTORY: PackInventory = {
  at: '2026-10-22T12:00:00.000Z',
  models: [],
  runtimes: [],
  guide: { source: 'derived', useCases: [] },
};
const JOB = {
  id: 'run-1',
  session: 's9',
  name: 'Models Guide Builder',
  runtime: 'claude-main',
  startedAt: '2026-10-22T12:00:00.000Z',
  status: 'running',
} as const;
const BUILDER = { available: true, runtimes: ['claude-main'] };
const SUGGESTED = { by: 'opus', via: 'claude-main', at: '2026-10-22T12:00:00.000Z' };

class FakePack implements PackSubsystem {
  readonly recommended: Array<{ task: string; useCase?: string }> = [];
  readonly started: PackNewRequest[] = [];
  readonly switched: Array<readonly [string, boolean]> = [];
  readonly suggested: PackGuideSuggestRequest[] = [];
  readonly accepted: PackGuideAcceptRequest[] = [];
  readonly described: PackGuideDescribeRequest[] = [];
  undone = 0;

  constructor(
    private readonly options: {
      readonly recommendation?: PackRecommendation | undefined;
      readonly outcome?: PackNewOutcome;
      readonly result?: SessionResult | undefined;
      readonly switchError?: unknown;
      readonly start?: PackGuideSuggestStart;
      readonly job?: PackGuideJobResult | undefined;
      readonly describeError?: unknown;
      readonly undo?: { readonly savedAt: string; readonly source: 'file' | 'derived' };
    } = {},
  ) {}

  readonly guide = {
    builder: {
      status: async () => BUILDER,
      start: async (request: PackGuideSuggestRequest): Promise<PackGuideSuggestStart> => {
        this.suggested.push(request);
        return this.options.start ?? { outcome: 'started', job: JOB };
      },
      job: async (id: string): Promise<PackGuideJobResult | undefined> => {
        if (id === 'boom') throw new Error('unreadable run');
        return 'job' in this.options ? this.options.job : { job: { ...JOB, id } };
      },
    },
    file: {
      undoable: async () => this.options.undo,
      accept: async (request: PackGuideAcceptRequest) => {
        this.accepted.push(request);
        return { outcome: 'applied' as const, message: 'Accepted.' };
      },
      undo: async () => {
        this.undone += 1;
        return { outcome: 'nothing' as const, message: 'Nothing to undo.' };
      },
      describe: async (request: PackGuideDescribeRequest) => {
        this.described.push(request);
        if (this.options.describeError !== undefined) throw this.options.describeError;
        return { outcome: 'applied' as const, message: 'Saved.' };
      },
    },
  };

  readonly service = {
    view: async () => VIEW,
    inventory: async () => INVENTORY,
    recommend: async (input: { readonly task: string; readonly useCase?: string }) => {
      this.recommended.push(input);
      return 'recommendation' in this.options ? this.options.recommendation : RECOMMENDATION;
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
  it('should answer the settings page’s view, uncached', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('GET', '/v1/pack'));

    // Assert
    should(answer.status).equal(200);
    should(jsonBody(answer)).deepEqual({
      ...(JSON.parse(JSON.stringify(VIEW)) as Record<string, unknown>),
      builder: BUILDER,
    });
    should(answer.headers.get('cache-control')).equal('no-store');
  });

  it('should add what an undo would put back, when there is one', async () => {
    // Act
    const answer = await dispatcher(
      new FakePack({ undo: { savedAt: '2026-10-22T12:00:00.000Z', source: 'derived' } }),
    ).dispatch(call('GET', '/v1/pack'));

    // Assert
    should(jsonBody(answer).undo).deepEqual({ savedAt: '2026-10-22T12:00:00.000Z', source: 'derived' });
  });
});

describe('the models-guide generator routes', () => {
  it('should answer the inventory the builder is shown', async () => {
    // Act
    const answer = await dispatcher(new FakePack()).dispatch(call('GET', '/v1/pack/inventory'));

    // Assert
    should(answer.status).equal(200);
    should(jsonBody(answer)).deepEqual(JSON.parse(JSON.stringify(INVENTORY)) as Record<string, unknown>);
  });

  it('should start a builder for a person with 201, and answer a refusal with 200', async () => {
    // Arrange
    const subsystem = new FakePack();
    const refusing = new FakePack({ start: { outcome: 'refused', message: 'No runtime is ready.' } });

    // Act
    const started = await dispatcher(subsystem).dispatch(
      call('POST', '/v1/pack/guide/suggest', { runtime: 'claude-main', preferences: 'Opus for reviews.' }),
    );
    const refused = await dispatcher(refusing).dispatch(call('POST', '/v1/pack/guide/suggest', {}));

    // Assert
    should(started.status).equal(201);
    should(jsonBody(started).job).containEql({ id: 'run-1', status: 'running' });
    should(subsystem.suggested).deepEqual([{ runtime: 'claude-main', preferences: 'Opus for reviews.' }]);
    should(refused.status).equal(200);
    should(jsonBody(refused)).deepEqual({ outcome: 'refused', message: 'No runtime is ready.' });
  });

  it("should refuse a ferret's own credential every act that spends or rewrites the guide", async () => {
    // Arrange
    const subsystem = new FakePack();
    const agent = (path: string, body: unknown) =>
      dispatcher(subsystem).dispatch(
        request({ method: 'POST', path, headers: agentIn('s1'), body: JSON.stringify(body) }),
      );

    // Act
    const answers = await Promise.all([
      agent('/v1/pack/guide/suggest', {}),
      agent('/v1/pack/guide/accept', { useCases: [], suggested: SUGGESTED }),
      agent('/v1/pack/guide/undo', {}),
      agent('/v1/pack/guide/describe', { model: 'opus', description: 'x' }),
    ]);

    // Assert
    should(answers.map(answer => answer.status)).deepEqual([403, 403, 403, 403]);
    should(subsystem.suggested).be.empty();
    should(subsystem.accepted).be.empty();
    should(subsystem.undone).equal(0);
    should(subsystem.described).be.empty();
  });

  it('should answer a run, and 404 for one that does not exist or cannot be read', async () => {
    // Arrange
    const missing = new FakePack({ job: undefined });

    // Act
    const found = await dispatcher(new FakePack()).dispatch(call('GET', '/v1/pack/guide/jobs/run-7'));
    const gone = await dispatcher(missing).dispatch(call('GET', '/v1/pack/guide/jobs/run-8'));
    const broken = await dispatcher(new FakePack()).dispatch(call('GET', '/v1/pack/guide/jobs/boom'));

    // Assert
    should(found.status).equal(200);
    should((jsonBody(found).job as { id: string }).id).equal('run-7');
    should(gone.status).equal(404);
    should(broken.status).equal(404);
  });

  it('should accept, undo and describe for a person, and answer 404 for a model no catalog lists', async () => {
    // Arrange
    const subsystem = new FakePack();
    const unknown = new FakePack({ describeError: new GuideModelUnknownError('No catalog lists nope.') });
    const accept = {
      useCases: [],
      routing: { prompt: 'Opus.', short: 'Routing: x.' },
      suggested: SUGGESTED,
      partial: true,
    };

    // Act
    const accepted = await dispatcher(subsystem).dispatch(call('POST', '/v1/pack/guide/accept', accept));
    const undone = await dispatcher(subsystem).dispatch(call('POST', '/v1/pack/guide/undo', {}));
    const described = await dispatcher(subsystem).dispatch(
      call('POST', '/v1/pack/guide/describe', { model: 'opus', description: null }),
    );
    const missing = await dispatcher(unknown).dispatch(
      call('POST', '/v1/pack/guide/describe', { model: 'nope', description: 'x' }),
    );
    const faulty = await dispatcher(new FakePack({ describeError: new Error('disk full') })).dispatch(
      call('POST', '/v1/pack/guide/describe', { model: 'opus', description: 'x' }),
    );

    // Assert
    should([accepted.status, undone.status, described.status, missing.status, faulty.status]).deepEqual([
      200, 200, 200, 404, 500,
    ]);
    should(subsystem.accepted).deepEqual([accept]);
    should(subsystem.undone).equal(1);
    should(subsystem.described).deepEqual([{ model: 'opus', description: null }]);
    should(jsonBody(missing).error).equal('No catalog lists nope.');
  });
});

describe('POST /v1/pack/recommend', () => {
  it('should answer the recommendation for a task and pass on the use case named', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(
      call('POST', '/v1/pack/recommend', { task: 'fix the bug', useCase: 'everyday' }),
    );

    // Assert
    should(answer.status).equal(200);
    should((jsonBody(answer).candidates as unknown[]).length).equal(1);
    should(subsystem.recommended).deepEqual([{ task: 'fix the bug', useCase: 'everyday' }]);
  });

  it('should answer 409 when the guide names no use case, and 400 for a body that is not a task', async () => {
    // Arrange
    const empty = new FakePack({ recommendation: undefined });
    const valid = new FakePack();

    // Act
    const conflict = await dispatcher(empty).dispatch(call('POST', '/v1/pack/recommend', { task: 'x' }));
    const bad = await dispatcher(valid).dispatch(call('POST', '/v1/pack/recommend', { task: '' }));

    // Assert
    should(conflict.status).equal(409);
    should(jsonBody(conflict).code).equal('no_candidate');
    should(bad.status).equal(400);
    should(valid.recommended).be.empty();
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
  it('should be operator routes, never cached, with fleet capabilities on the fleet reads and the guide writes', () => {
    // Arrange / Act
    const routes = packRoutes(new FakePack());

    // Assert
    should(
      routes.map(route => [route.method, route.path, route.minimum, route.noStore, route.capability?.capability]),
    ).deepEqual([
      ['GET', '/v1/pack', 'operator', true, 'fleet'],
      ['GET', '/v1/pack/inventory', 'operator', true, 'fleet'],
      ['POST', '/v1/pack/guide/suggest', 'operator', true, 'fleet'],
      ['GET', '/v1/pack/guide/jobs/:jobId', 'operator', true, 'fleet'],
      ['POST', '/v1/pack/guide/accept', 'operator', true, 'fleet'],
      ['POST', '/v1/pack/guide/undo', 'operator', true, 'fleet'],
      ['POST', '/v1/pack/guide/describe', 'operator', true, 'fleet'],
      ['POST', '/v1/pack/recommend', 'operator', true, 'fleet'],
      ['POST', '/v1/pack/new', 'operator', true, undefined],
      ['GET', '/v1/sessions/:sessionId/result', 'operator', true, undefined],
      ['PATCH', '/v1/sessions/:sessionId/pack', 'operator', true, undefined],
    ]);
  });
});
