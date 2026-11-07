import { describe, it } from 'bun:test';
import {
  type CapabilityGrants,
  STEP_UP_REQUIRED_CODE,
  SessionProcessListSchema,
  type SessionProcessList,
  SessionProcessOutputSchema,
  type SessionProcessOutput,
  SessionProcessStopResultSchema,
  type SessionProcessStopResult,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import {
  sessionProcessRoutes,
  type SessionProcessSubsystem,
} from '../../../../src/lib/runtime/mounts/session-processes.ts';
import { SessionAttachError, type SessionAttachFailure } from '../../../../src/lib/session/attach/index.ts';
import { SessionProcessError, type SessionProcessFailure } from '../../../../src/lib/session/processes/service.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, GRANTED, grantSubsystem, human, sessionDirectory, sessionView } from './support.ts';

/**
 * THE PROCESSES TAB'S THREE ROUTES, with only the processes subsystem replaced.
 *
 * Who may call them is the authorization boundary's question, asked from each route's `terminal.use`
 * declaration. What is asserted is that the declaration is there and holds end to end (a governed caller
 * without the grant is refused before the subsystem is touched), what the route itself owes — bad input
 * is a 400, an unknown session a 404 before the subsystem — and that every refusal is a status a client
 * can act on and every answer is the wire shape.
 */

const ID = '4242.987654';
const LIST: SessionProcessList = {
  sessionId: 's1',
  observedAt: '2026-10-29T10:00:00.000Z',
  available: true,
  processes: [
    {
      id: ID,
      pid: 4242,
      command: 'bun test',
      commandTruncated: false,
      kind: 'command',
      state: 'running',
      startedAt: '2026-10-29T09:59:00.000Z',
      output: { source: 'file' },
      stoppable: true,
    },
  ],
};
const OUTPUT: SessionProcessOutput = {
  processId: ID,
  source: 'file',
  text: 'ok\n',
  start: 0,
  end: 3,
  size: 3,
  skipped: false,
  reset: false,
  complete: false,
};
const STOPPED: SessionProcessStopResult = { processId: ID, signalled: 2 };

class FakeProcesses implements SessionProcessSubsystem {
  readonly calls: string[] = [];
  failure: Error | undefined;

  async list(sessionId: string): Promise<SessionProcessList> {
    this.calls.push(`list ${sessionId}`);
    if (this.failure !== undefined) throw this.failure;
    return LIST;
  }

  async output(sessionId: string, processId: string, after: number | undefined): Promise<SessionProcessOutput> {
    this.calls.push(`output ${sessionId} ${processId} ${after ?? 'none'}`);
    if (this.failure !== undefined) throw this.failure;
    return OUTPUT;
  }

  async stop(sessionId: string, processId: string): Promise<SessionProcessStopResult> {
    this.calls.push(`stop ${sessionId} ${processId}`);
    if (this.failure !== undefined) throw this.failure;
    return STOPPED;
  }
}

const sessions = () => sessionDirectory([sessionView('s1')]);

function fixture(processes: SessionProcessSubsystem = new FakeProcesses()) {
  const dispatcher = new ApiDispatcher(
    new ApiRouter(sessionProcessRoutes(processes, sessions())),
    CREDENTIALS,
    GRANTED,
  );
  return async (overrides: Parameters<typeof request>[0]): Promise<ApiResponse> =>
    await dispatcher.dispatch(request(overrides));
}

const list = (path = '/v1/sessions/s1/processes') => ({ method: 'GET', path, headers: human, loopback: true }) as const;
const output = (path = `/v1/sessions/s1/processes/${ID}/output`, query: readonly [string, string][] = []) =>
  ({ method: 'GET', path, headers: human, loopback: true, query }) as const;
const stop = (path = `/v1/sessions/s1/processes/${ID}/stop`) =>
  ({ method: 'POST', path, headers: human, loopback: true }) as const;

const codeOf = (response: ApiResponse): unknown => jsonBody(response).code;

describe('the session processes routes’ declarations', () => {
  it('should declare all three as operator routes needing terminal use, and never cached', () => {
    // Arrange
    const routes = sessionProcessRoutes(new FakeProcesses(), sessions());

    // Act
    const declared = routes.map(route => ({
      method: route.method,
      path: route.path,
      minimum: route.minimum,
      capability: route.capability,
      noStore: route.noStore,
    }));

    // Assert
    const terminalUse = { capability: 'terminal', axis: 'use' };
    should(declared).deepEqual([
      {
        method: 'GET',
        path: '/v1/sessions/:sessionId/processes',
        minimum: 'operator',
        capability: terminalUse,
        noStore: true,
      },
      {
        method: 'GET',
        path: '/v1/sessions/:sessionId/processes/:processId/output',
        minimum: 'operator',
        capability: terminalUse,
        noStore: true,
      },
      {
        method: 'POST',
        path: '/v1/sessions/:sessionId/processes/:processId/stop',
        minimum: 'operator',
        capability: terminalUse,
        noStore: true,
      },
    ]);
  });
});

describe('the session processes routes', () => {
  it('should list a session’s processes as the wire list, uncached', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const dispatch = fixture(processes);

    // Act
    const response = await dispatch(list());

    // Assert
    should(response.status).equal(200);
    should(SessionProcessListSchema.parse(jsonBody(response))).deepEqual(LIST);
    should(response.headers.get('cache-control')).eql('no-store');
    should(processes.calls).deepEqual(['list s1']);
  });

  it('should read output from the offset after, and from the tail with none', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const dispatch = fixture(processes);

    // Act
    const followed = await dispatch(output(undefined, [['after', '120']]));
    const tail = await dispatch(output());

    // Assert
    should(followed.status).equal(200);
    should(SessionProcessOutputSchema.parse(jsonBody(followed))).deepEqual(OUTPUT);
    should(tail.status).equal(200);
    should(processes.calls).deepEqual([`output s1 ${ID} 120`, `output s1 ${ID} none`]);
  });

  it('should treat an empty after as no offset', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const dispatch = fixture(processes);

    // Act
    const response = await dispatch(output(undefined, [['after', '']]));

    // Assert
    should(response.status).equal(200);
    should(processes.calls).deepEqual([`output s1 ${ID} none`]);
  });

  it('should stop a process and answer how many were signalled', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const dispatch = fixture(processes);

    // Act
    const response = await dispatch(stop());

    // Assert
    should(response.status).equal(200);
    should(SessionProcessStopResultSchema.parse(jsonBody(response))).deepEqual(STOPPED);
    should(response.headers.get('cache-control')).eql('no-store');
    should(processes.calls).deepEqual([`stop s1 ${ID}`]);
  });

  it('should refuse a process id that is not pid.start with 400, before the subsystem is touched', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const dispatch = fixture(processes);
    const bad = [
      'abc',
      '0.1',
      '12',
      '12.',
      '.5',
      '12.5.6',
      '-3.4',
      '12345678901.5',
      '12.123456789012345678901',
      '1e3.4',
    ];

    // Act
    const responses = [] as ApiResponse[];
    for (const id of bad) {
      responses.push(await dispatch(output(`/v1/sessions/s1/processes/${id}/output`)));
      responses.push(await dispatch(stop(`/v1/sessions/s1/processes/${id}/stop`)));
    }

    // Assert
    should(responses.map(response => [response.status, codeOf(response)])).deepEqual(
      responses.map(() => [400, 'invalid_process_id']),
    );
    should(processes.calls).deepEqual([]);
  });

  it('should refuse an encoded path-traversal process id with 400', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const dispatch = fixture(processes);

    // Act
    const response = await dispatch(output('/v1/sessions/s1/processes/..%2Fetc%2Fpasswd/output'));

    // Assert
    should([response.status, codeOf(response)]).deepEqual([400, 'invalid_process_id']);
    should(processes.calls).deepEqual([]);
  });

  it('should refuse a bad after with 400 invalid_query', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const dispatch = fixture(processes);
    const bad = ['-1', '1.5', 'abc', '0x10x', '9007199254740993', 'NaN', 'Infinity'];

    // Act
    const responses = [] as ApiResponse[];
    for (const after of bad) responses.push(await dispatch(output(undefined, [['after', after]])));

    // Assert
    should(responses.map(response => [response.status, codeOf(response)])).deepEqual(
      bad.map(() => [400, 'invalid_query']),
    );
    should(processes.calls).deepEqual([]);
  });

  it('should answer an unknown session 404 not-found on all three routes, without asking the subsystem', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const dispatch = fixture(processes);

    // Act
    const responses = [
      await dispatch(list('/v1/sessions/ghost/processes')),
      await dispatch(output(`/v1/sessions/ghost/processes/${ID}/output`)),
      await dispatch(stop(`/v1/sessions/ghost/processes/${ID}/stop`)),
    ];

    // Assert
    should(responses.map(response => [response.status, codeOf(response)])).deepEqual([
      [404, 'not-found'],
      [404, 'not-found'],
      [404, 'not-found'],
    ]);
    should(processes.calls).deepEqual([]);
  });

  const refusals: readonly [SessionProcessFailure, number, string][] = [
    ['not_found', 404, 'process_not_found'],
    ['changed', 409, 'process_changed'],
    ['not_stoppable', 409, 'process_not_stoppable'],
  ];
  for (const [failure, status, code] of refusals) {
    it(`should map a ${failure} refusal to ${status} ${code} on output and stop`, async () => {
      // Arrange
      const processes = new FakeProcesses();
      processes.failure = new SessionProcessError(failure, `that is ${failure}`);
      const dispatch = fixture(processes);

      // Act
      const read = await dispatch(output());
      const stopped = await dispatch(stop());

      // Assert
      should([read.status, codeOf(read)]).deepEqual([status, code]);
      should([stopped.status, codeOf(stopped)]).deepEqual([status, code]);
      should(String(jsonBody(stopped).error)).equal(`that is ${failure}`);
    });
  }

  it('should map a pane-proof refusal through the attach taxonomy on the list too', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const failure: SessionAttachFailure = 'pane_unavailable';
    processes.failure = new SessionAttachError(failure, 'the pane is not there');
    const dispatch = fixture(processes);

    // Act
    const response = await dispatch(list());

    // Assert
    should([response.status, codeOf(response)]).deepEqual([409, 'attach_pane_unavailable']);
  });

  it('should not turn a defect into a refusal', async () => {
    // Arrange
    const processes = new FakeProcesses();
    processes.failure = new Error('the vault could not be opened');
    const dispatch = fixture(processes);

    // Act
    const response = await dispatch(list());

    // Assert
    should(response.status).equal(500);
    should(JSON.stringify(jsonBody(response))).not.containEql('the vault could not be opened');
  });
});

describe('the session processes routes behind the grants', () => {
  const deviceId = `fy_device_id_${'d'.repeat(22)}`;
  const phone = { deviceId, appSession: 'app-one' } as const;
  const credentials = {
    admin: 'admin-secret',
    warden: 'warden-secret',
    devices: { has: (id: string) => id === deviceId, grants: () => DEFAULT_CAPABILITY_GRANTS },
  };

  async function governed(granted: CapabilityGrants) {
    const processes = new FakeProcesses();
    const grants = grantSubsystem({ grants: granted });
    await grants.refresh();
    const dispatcher = new ApiDispatcher(
      new ApiRouter(sessionProcessRoutes(processes, sessions())),
      credentials,
      grants,
    );
    const ask = (method: string, path: string) =>
      dispatcher.dispatch(request({ method, path, device: phone, loopback: false }));
    return { processes, ask };
  }

  const surface = [
    ['list', 'GET', '/v1/sessions/s1/processes'],
    ['output', 'GET', `/v1/sessions/s1/processes/${ID}/output`],
    ['stop', 'POST', `/v1/sessions/s1/processes/${ID}/stop`],
  ] as const;

  it('should refuse a governed caller 403 on list, output and stop when terminal use is not granted', async () => {
    // Arrange
    const { processes, ask } = await governed({
      ...DEFAULT_CAPABILITY_GRANTS,
      terminal: { use: false, configure: false },
    });

    // Act
    const responses = [] as ApiResponse[];
    for (const [, method, path] of surface) responses.push(await ask(method, path));

    // Assert
    should(responses.map(response => response.status)).deepEqual([403, 403, 403]);
    for (const response of responses)
      should(String(jsonBody(response).error)).match(/has not granted the UI the use of session terminals/u);
    should(processes.calls).deepEqual([]);
  });

  it('should refuse a governed caller when the machine cannot say what it granted', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const dispatcher = new ApiDispatcher(
      new ApiRouter(sessionProcessRoutes(processes, sessions())),
      credentials,
      grantSubsystem({ broken: true }),
    );

    // Act
    const responses = [] as ApiResponse[];
    for (const [, method, path] of surface)
      responses.push(await dispatcher.dispatch(request({ method, path, device: phone, loopback: false })));

    // Assert
    should(responses.map(response => [response.status, codeOf(response)])).deepEqual(
      surface.map(() => [403, 'grant_undetermined']),
    );
    should(processes.calls).deepEqual([]);
  });

  it('should still refuse a governed caller holding the grant but no step-up, 403 grant_step_up_required', async () => {
    // Arrange — terminal use is a gated act: an unlock buys it, a grant alone does not.
    const { processes, ask } = await governed(DEFAULT_CAPABILITY_GRANTS);

    // Act
    const responses = [] as ApiResponse[];
    for (const [, method, path] of surface) responses.push(await ask(method, path));

    // Assert
    should(responses.map(response => [response.status, codeOf(response)])).deepEqual(
      surface.map(() => [403, STEP_UP_REQUIRED_CODE]),
    );
    should(processes.calls).deepEqual([]);
  });

  it('should leave a caller at this machine ungoverned, whatever the grants', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const grants = grantSubsystem({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: false, configure: false } },
    });
    await grants.refresh();
    const dispatcher = new ApiDispatcher(
      new ApiRouter(sessionProcessRoutes(processes, sessions())),
      credentials,
      grants,
    );

    // Act
    const responses = [] as ApiResponse[];
    for (const [, method, path] of surface)
      responses.push(await dispatcher.dispatch(request({ method, path, headers: human, loopback: true })));

    // Assert
    should(responses.map(response => response.status)).deepEqual([200, 200, 200]);
  });

  it('should refuse a caller with no credentials, not merely one without the grant', async () => {
    // Arrange
    const { processes } = await governed(DEFAULT_CAPABILITY_GRANTS);
    const dispatcher = new ApiDispatcher(
      new ApiRouter(sessionProcessRoutes(processes, sessions())),
      credentials,
      GRANTED,
    );

    // Act
    const response = await dispatcher.dispatch(
      request({ method: 'GET', path: '/v1/sessions/s1/processes', loopback: false }),
    );

    // Assert
    should(response.status).equal(401);
    should(processes.calls).deepEqual([]);
  });
});
