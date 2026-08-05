import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import { type FyApiClient, FyTransportError } from '../../src/adapters/fy-api-client.ts';
import { FY_REQUEST_ID_HEADER } from '../../src/lib/client.ts';
import {
  analyticsResponse,
  cgroupConfigView,
  fyEvent,
  healthView,
  pwaConfigView,
  scratchPlanView,
  scratchSweepView,
  sendResult,
  sessionAttachTarget,
  sessionView,
  usageFeedView,
  wardenConfigView,
  wardenRunView,
  wardenStatusView,
} from '../fixtures.ts';
import { BASE_URL, connectClient, headersOf, jsonBodyOf } from './client-harness.ts';
import { captureError, emptyResponse, jsonResponse, QueuedHttpTransport, textResponse } from './fakes.ts';

/**
 * Every typed method is a thin delegation to `request()`. What can break in a delegation is the
 * verb, the path (including parameter encoding), the request schema applied to the body, and the
 * response schema applied to the payload — so the table pins all four for each one.
 */
interface MethodCase {
  /** Test name suffix; also the delegation being pinned. */
  readonly name: string;
  readonly invoke: (client: FyApiClient) => Promise<unknown>;
  readonly verb: string;
  readonly path: string;
  /** Expected JSON request body, or undefined when the method must not send one. */
  readonly body?: unknown;
  /** Caller-supplied idempotency key, when a mutation must preserve it. */
  readonly requestId?: string;
  /** Fresh response per use — a Response body may only be consumed once. */
  readonly response: () => Response;
  readonly expected: unknown;
}

const SESSION_ID = 'session-1';
const SNAPSHOT_TEXT = 'pane line one\npane line two';
const LOG_TEXT = 'turn 1 log output';
const WARDEN_REPORT = '# Warden report\n\nVerdict: LEAVE\n';
const NAME_SUGGESTIONS = ['Fix Transcript Scrolling', 'Port Protocol Client', 'Cover Typed Methods'];

const sessionResponse = (): Response => jsonResponse(sessionView);

const CASES: readonly MethodCase[] = [
  {
    name: 'health',
    invoke: client => client.health(),
    verb: 'GET',
    path: '/v1/health',
    response: () => jsonResponse(healthView),
    expected: healthView,
  },
  {
    name: 'wardenStatus',
    invoke: client => client.wardenStatus(),
    verb: 'GET',
    path: '/v1/warden/status',
    response: () => jsonResponse(wardenStatusView),
    expected: wardenStatusView,
  },
  {
    name: 'wardenVerdicts',
    invoke: client => client.wardenVerdicts(),
    verb: 'GET',
    path: '/v1/warden/verdicts',
    response: () => jsonResponse([]),
    expected: [],
  },
  {
    name: 'wardenReport',
    invoke: client => client.wardenReport('/state/warden/reports/report 1.md'),
    verb: 'GET',
    path: '/v1/warden/report?path=%2Fstate%2Fwarden%2Freports%2Freport%201.md',
    response: () => textResponse(WARDEN_REPORT),
    expected: WARDEN_REPORT,
  },
  {
    name: 'wardenRun without a spawn',
    invoke: client => client.wardenRun(),
    verb: 'POST',
    path: '/v1/warden/run',
    body: { spawn: false },
    response: () => jsonResponse(wardenRunView),
    expected: wardenRunView,
  },
  {
    name: 'wardenRun with a spawn',
    invoke: client => client.wardenRun(true),
    verb: 'POST',
    path: '/v1/warden/run',
    body: { spawn: true },
    response: () => jsonResponse(wardenRunView),
    expected: wardenRunView,
  },
  {
    name: 'wardenConfig',
    invoke: client => client.wardenConfig(),
    verb: 'GET',
    path: '/v1/warden/config',
    response: () => jsonResponse(wardenConfigView),
    expected: wardenConfigView,
  },
  {
    name: 'updateWardenConfig',
    invoke: client => client.updateWardenConfig({ enabled: false, intervalMinutes: 7 }),
    verb: 'PATCH',
    path: '/v1/warden/config',
    body: { enabled: false, intervalMinutes: 7 },
    response: () => jsonResponse(wardenConfigView),
    expected: wardenConfigView,
  },
  {
    name: 'cgroupConfig',
    invoke: client => client.cgroupConfig(),
    verb: 'GET',
    path: '/v1/cgroups/config',
    response: () => jsonResponse(cgroupConfigView),
    expected: cgroupConfigView,
  },
  {
    name: 'updateCgroupConfig',
    invoke: client => client.updateCgroupConfig({ enabled: true, fleet: { cpuPercent: 50 } }),
    verb: 'PATCH',
    path: '/v1/cgroups/config',
    body: { enabled: true, fleet: { cpuPercent: 50 } },
    response: () => jsonResponse(cgroupConfigView),
    expected: cgroupConfigView,
  },
  {
    name: 'pwaConfig',
    invoke: client => client.pwaConfig(),
    verb: 'GET',
    path: '/v1/pwa/config',
    response: () => jsonResponse(pwaConfigView),
    expected: pwaConfigView,
  },
  {
    name: 'updatePwaConfig through the normalizing patch schema',
    invoke: client => client.updatePwaConfig({ name: '  Fleet   Controls ', icon: ' fy ' }),
    verb: 'PATCH',
    path: '/v1/pwa/config',
    body: { name: 'Fleet Controls', icon: 'FY' },
    response: () => jsonResponse(pwaConfigView),
    expected: pwaConfigView,
  },
  {
    name: 'usage',
    invoke: client => client.usage(),
    verb: 'GET',
    path: '/v1/usage',
    response: () => jsonResponse(usageFeedView),
    expected: usageFeedView,
  },
  {
    name: 'projects',
    invoke: client => client.projects(),
    verb: 'GET',
    path: '/v1/projects',
    response: () => jsonResponse([]),
    expected: [],
  },
  {
    name: 'sessionSkills with a percent-encoded session id',
    invoke: client => client.sessionSkills('session 1/a'),
    verb: 'GET',
    path: '/v1/sessions/session%201%2Fa/skills',
    response: () => jsonResponse({ harness: 'codex', skills: [] }),
    expected: { harness: 'codex', skills: [] },
  },
  {
    name: 'analytics without a query',
    invoke: client => client.analytics(),
    verb: 'GET',
    path: '/v1/analytics',
    response: () => jsonResponse(analyticsResponse),
    expected: analyticsResponse,
  },
  {
    name: 'analytics with a blank query',
    invoke: client => client.analytics('   '),
    verb: 'GET',
    path: '/v1/analytics',
    response: () => jsonResponse(analyticsResponse),
    expected: analyticsResponse,
  },
  {
    name: 'analytics with an encoded query',
    invoke: client => client.analytics('  status:running &live  '),
    verb: 'GET',
    path: '/v1/analytics?q=status%3Arunning+%26live',
    response: () => jsonResponse(analyticsResponse),
    expected: analyticsResponse,
  },
  {
    name: 'scratchPlan with the default limit',
    invoke: client => client.scratchPlan(),
    verb: 'GET',
    path: '/v1/gc?limit=20',
    response: () => jsonResponse([scratchPlanView]),
    expected: [scratchPlanView],
  },
  {
    name: 'scratchPlan with an explicit limit',
    invoke: client => client.scratchPlan(5),
    verb: 'GET',
    path: '/v1/gc?limit=5',
    response: () => jsonResponse([scratchPlanView]),
    expected: [scratchPlanView],
  },
  {
    name: 'scratchSweep without force',
    invoke: client => client.scratchSweep(),
    verb: 'POST',
    path: '/v1/gc',
    body: { force: false },
    response: () => jsonResponse(scratchSweepView),
    expected: scratchSweepView,
  },
  {
    name: 'scratchSweep with force',
    invoke: client => client.scratchSweep(true),
    verb: 'POST',
    path: '/v1/gc',
    body: { force: true },
    response: () => jsonResponse(scratchSweepView),
    expected: scratchSweepView,
  },
  {
    name: 'list',
    invoke: client => client.list(),
    verb: 'GET',
    path: '/v1/sessions',
    response: () => jsonResponse([sessionView]),
    expected: [sessionView],
  },
  {
    name: 'suggestNames with the default count',
    invoke: client => client.suggestNames(),
    verb: 'GET',
    path: '/v1/names?count=1',
    response: () => jsonResponse(NAME_SUGGESTIONS.slice(0, 1)),
    expected: NAME_SUGGESTIONS.slice(0, 1),
  },
  {
    name: 'suggestNames with an explicit count',
    invoke: client => client.suggestNames(3),
    verb: 'GET',
    path: '/v1/names?count=3',
    response: () => jsonResponse(NAME_SUGGESTIONS),
    expected: NAME_SUGGESTIONS,
  },
  {
    name: 'get with a percent-encoded session id',
    invoke: client => client.get('session 1/a'),
    verb: 'GET',
    path: '/v1/sessions/session%201%2Fa',
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'send',
    invoke: client => client.send(SESSION_ID, { message: 'hello', now: true }),
    verb: 'POST',
    path: '/v1/sessions/session-1/send',
    body: { message: 'hello', now: true },
    response: () => jsonResponse(sendResult),
    expected: sendResult,
  },
  {
    name: 'answer with labels only',
    invoke: client => client.answer(SESSION_ID, 'tool-1', ['yes']),
    verb: 'POST',
    path: '/v1/sessions/session-1/answer',
    body: { toolUseId: 'tool-1', labels: ['yes'] },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'answer with free text, legacy responses, and lossless ordered answers',
    invoke: client =>
      client.answer(
        SESSION_ID,
        'tool-1',
        ['other'],
        'ship it',
        ['first', 'second'],
        [
          { kind: 'selection', labels: ['first', 'also first'] },
          { kind: 'other', text: 'second' },
        ],
        'question-request-1',
      ),
    verb: 'POST',
    path: '/v1/sessions/session-1/answer',
    body: {
      toolUseId: 'tool-1',
      labels: ['other'],
      other: 'ship it',
      responses: ['first', 'second'],
      answers: [
        { kind: 'selection', labels: ['first', 'also first'] },
        { kind: 'other', text: 'second' },
      ],
    },
    requestId: 'question-request-1',
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'interrupt',
    invoke: client => client.interrupt(SESSION_ID),
    verb: 'POST',
    path: '/v1/sessions/session-1/interrupt',
    body: {},
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'stop without a reason',
    invoke: client => client.stop(SESSION_ID),
    verb: 'POST',
    path: '/v1/sessions/session-1/stop',
    body: {},
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'stop with a reason',
    invoke: client => client.stop(SESSION_ID, 'operator asked'),
    verb: 'POST',
    path: '/v1/sessions/session-1/stop',
    body: { reason: 'operator asked' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'resume without a message',
    invoke: client => client.resume(SESSION_ID),
    verb: 'POST',
    path: '/v1/sessions/session-1/resume',
    body: {},
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'resume with a message',
    invoke: client => client.resume(SESSION_ID, 'carry on'),
    verb: 'POST',
    path: '/v1/sessions/session-1/resume',
    body: { message: 'carry on' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'runtime model and effort',
    invoke: client =>
      client.runtime(SESSION_ID, { action: 'model', model: 'gpt-5.6-sol', effort: 'high' }, 'runtime-1'),
    verb: 'POST',
    path: '/v1/sessions/session-1/runtime',
    body: { action: 'model', model: 'gpt-5.6-sol', effort: 'high' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'runtime opens Codex native picker without claiming a selected model',
    invoke: client => client.runtime(SESSION_ID, { action: 'model' }),
    verb: 'POST',
    path: '/v1/sessions/session-1/runtime',
    body: { action: 'model' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'migrate with the agent alone',
    invoke: client => client.migrate(SESSION_ID, 'claude-auto-loge'),
    verb: 'POST',
    path: '/v1/sessions/session-1/migrate',
    body: { agent: 'claude-auto-loge', allowContextDowngrade: false },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'migrate with a model and an accepted context downgrade',
    invoke: client => client.migrate(SESSION_ID, 'claude-auto-loge', 'claude-opus-5', true),
    verb: 'POST',
    path: '/v1/sessions/session-1/migrate',
    body: { agent: 'claude-auto-loge', model: 'claude-opus-5', allowContextDowngrade: true },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'rename with a name',
    invoke: client => client.rename(SESSION_ID, 'Cover Typed Methods'),
    verb: 'POST',
    path: '/v1/sessions/session-1/rename',
    body: { name: 'Cover Typed Methods' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'rename with a teammate and a cleared parent',
    invoke: client => client.rename(SESSION_ID, undefined, 'reviewer', true),
    verb: 'POST',
    path: '/v1/sessions/session-1/rename',
    body: { teammate: 'reviewer', clearParent: true },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'signal done',
    invoke: client => client.signal(SESSION_ID, 'done'),
    verb: 'POST',
    path: '/v1/sessions/session-1/signal',
    body: { kind: 'done' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'signal help with the required message',
    invoke: client => client.signal(SESSION_ID, 'help', 'blocked on credentials'),
    verb: 'POST',
    path: '/v1/sessions/session-1/signal',
    body: { kind: 'help', message: 'blocked on credentials' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'signal waiting with every wait option',
    invoke: client =>
      client.signal(SESSION_ID, 'waiting', 'parked', { until: '45m', condition: 'ci run', peer: 'session-2' }),
    verb: 'POST',
    path: '/v1/sessions/session-1/signal',
    body: { kind: 'waiting', message: 'parked', until: '45m', condition: 'ci run', peer: 'session-2' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'signal working',
    invoke: client => client.signal(SESSION_ID, 'working'),
    verb: 'POST',
    path: '/v1/sessions/session-1/signal',
    body: { kind: 'working' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'remove with default flags',
    invoke: client => client.remove(SESSION_ID),
    verb: 'DELETE',
    path: '/v1/sessions/session-1?purge=false&force=false',
    response: () => emptyResponse(),
    expected: undefined,
  },
  {
    name: 'remove with purge and force',
    invoke: client => client.remove(SESSION_ID, true, true),
    verb: 'DELETE',
    path: '/v1/sessions/session-1?purge=true&force=true',
    response: () => emptyResponse(),
    expected: undefined,
  },
  {
    name: 'attachTarget',
    invoke: client => client.attachTarget(SESSION_ID),
    verb: 'GET',
    path: '/v1/sessions/session-1/attach',
    response: () => jsonResponse(sessionAttachTarget),
    expected: sessionAttachTarget,
  },
  {
    name: 'snapshot',
    invoke: client => client.snapshot(SESSION_ID),
    verb: 'GET',
    path: '/v1/sessions/session-1/snapshot?live=true',
    response: () => textResponse(SNAPSHOT_TEXT),
    expected: SNAPSHOT_TEXT,
  },
  {
    name: 'logs without a turn',
    invoke: client => client.logs(SESSION_ID),
    verb: 'GET',
    path: '/v1/sessions/session-1/logs',
    response: () => textResponse(LOG_TEXT),
    expected: LOG_TEXT,
  },
  {
    name: 'logs for turn zero',
    invoke: client => client.logs(SESSION_ID, 0),
    verb: 'GET',
    path: '/v1/sessions/session-1/logs?turn=0',
    response: () => textResponse(LOG_TEXT),
    expected: LOG_TEXT,
  },
  {
    name: 'events with default paging',
    invoke: client => client.events(SESSION_ID),
    verb: 'GET',
    path: '/v1/sessions/session-1/events?after=0&limit=1000',
    response: () => jsonResponse([fyEvent]),
    expected: [fyEvent],
  },
  {
    name: 'events with an explicit cursor and limit',
    invoke: client => client.events(SESSION_ID, 5, 10),
    verb: 'GET',
    path: '/v1/sessions/session-1/events?after=5&limit=10',
    response: () => jsonResponse([fyEvent]),
    expected: [fyEvent],
  },
];

describe('FyApiClient typed method delegation', () => {
  for (const testCase of CASES) {
    it(`should route ${testCase.name} to ${testCase.verb} ${testCase.path}`, async () => {
      // Arrange
      const transport = new QueuedHttpTransport(testCase.response());
      const client = await connectClient(transport);

      // Act
      const actual = await testCase.invoke(client);

      // Assert
      should(actual).deepEqual(testCase.expected);
      should(transport.calls).have.length(1);
      should(transport.calls[0]?.url).equal(`${BASE_URL}${testCase.path}`);
      should(transport.calls[0]?.init.method ?? 'GET').equal(testCase.verb);
      if (testCase.body === undefined) {
        should(transport.calls[0]?.init.body).be.undefined();
      } else {
        should(jsonBodyOf(transport)).deepEqual(testCase.body);
        should(headersOf(transport).get('content-type')).equal('application/json');
      }
      if (testCase.requestId !== undefined)
        should(headersOf(transport).get(FY_REQUEST_ID_HEADER)).equal(testCase.requestId);
    });
  }

  for (const testCase of CASES) {
    it(`should reject a ${testCase.name} payload the response schema does not accept`, async () => {
      // Arrange
      const transport = new QueuedHttpTransport(jsonResponse({ unexpected: 'payload' }));
      const client = await connectClient(transport);

      // Act
      const actual = await captureError(() => testCase.invoke(client));

      // Assert
      should(actual instanceof z.ZodError).be.true();
      should(transport.calls).have.length(1);
    });
  }

  it('should pass a caller cancellation through an event read', async () => {
    // Arrange
    const cancelled = new Error('operator left');
    const transport = new QueuedHttpTransport(
      call =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal;
          if (signal === undefined || signal === null) throw new Error('event request had no signal');
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const client = await connectClient(transport);
    const controller = new AbortController();

    // Act
    const reading = client.events(SESSION_ID, 0, 1_000, controller.signal);
    controller.abort(cancelled);
    const failure = await captureError(() => reading);

    // Assert — request() classifies a caller abort and does not retry it.
    should(failure).be.instanceof(FyTransportError);
    should((failure as FyTransportError).message).match(/was cancelled/);
    should(transport.calls).have.length(1);
    should(transport.calls[0]?.init.signal?.aborted).be.true();
  });

  it('should make a wait-style session read cancellable too', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(sessionResponse());
    const client = await connectClient(transport);
    const controller = new AbortController();

    // Act
    const actual = await client.get(SESSION_ID, controller.signal);

    // Assert
    should(actual).deepEqual(sessionView);
    should(transport.calls[0]?.init.signal).not.be.undefined();
  });
});

describe('FyApiClient typed method input validation', () => {
  it('should reject invalid session identifiers before any transport I/O', async () => {
    // Arrange
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport);
    const invocations: Array<() => Promise<unknown>> = [
      () => client.get('   '),
      () => client.send('', { message: 'hello' }),
      () => client.remove('   '),
      () => client.attachTarget('   '),
      () => client.snapshot('   '),
      () => client.logs('   '),
      () => client.events('   '),
      () => client.upload('   ', new Blob(['a'])),
    ];

    // Act
    const actual = await Promise.all(invocations.map(invocation => captureError(invocation)));

    // Assert
    for (const error of actual) should(error instanceof z.ZodError).be.true();
    should(transport.calls).have.length(0);
  });

  it('should reject out-of-range paging and counting arguments before any transport I/O', async () => {
    // Arrange
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport);
    const invocations: Array<() => Promise<unknown>> = [
      () => client.scratchPlan(0),
      () => client.suggestNames(0),
      () => client.logs('session-1', -1),
      () => client.events('session-1', -1),
      () => client.events('session-1', 0, 1_001),
      () => client.history('session-1', 0, 0),
    ];

    // Act
    const actual = await Promise.all(invocations.map(invocation => captureError(invocation)));

    // Assert
    for (const error of actual) should(error instanceof z.ZodError).be.true();
    should(transport.calls).have.length(0);
  });

  it('should reject request bodies their schemas refuse before any transport I/O', async () => {
    // Arrange
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport);
    const invocations: Array<() => Promise<unknown>> = [
      () => client.send('session-1', { message: '' }),
      () => client.answer('session-1', '', ['yes']),
      () => client.rename('session-1'),
      () => client.updatePwaConfig({}),
      () => client.updatePwaConfig({ icon: 'too-long' }),
      () => client.signal('session-1', 'help'),
      () => client.signal('session-1', 'done', 'finished', { until: '45m' }),
    ];

    // Act
    const actual = await Promise.all(invocations.map(invocation => captureError(invocation)));

    // Assert
    for (const error of actual) should(error instanceof z.ZodError).be.true();
    should(transport.calls).have.length(0);
  });
});
