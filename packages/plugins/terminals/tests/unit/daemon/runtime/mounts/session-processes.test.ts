import { describe, it } from 'bun:test';
import type { Instant } from '@ferretry/std';
import should from 'should';
import {
  type SessionProcessList,
  SessionProcessListSchema,
  type SessionProcessOutput,
  SessionProcessOutputSchema,
  type SessionProcessStopResult,
  SessionProcessStopResultSchema,
} from '../../../../../daemon/lib/protocol/session-processes.ts';
import {
  processHandlers,
  type SessionProcessSubsystem,
} from '../../../../../daemon/lib/runtime/mounts/session-processes.ts';
import { SessionAttachError, type SessionAttachFailure } from '../../../../../daemon/lib/session/attach/index.ts';
import {
  SessionProcessError,
  type SessionProcessFailure,
} from '../../../../../daemon/lib/session/processes/service.ts';
import { type Answer, answer, type CallInit, ferretDirectory } from './processes-support.ts';

/**
 * THE PROCESSES TAB'S THREE ROUTES, with only the processes subsystem replaced.
 *
 * Who may call them is the manifest descriptor's (`terminal.use`, operator) and the kernel's question. What is
 * asserted is what the handler itself owes: bad input is a 400, an unknown ferret a 404 before the subsystem, and
 * every refusal is a status a client can act on and every answer is the wire shape.
 */

const ID = '4242.987654';
const LIST: SessionProcessList = {
  sessionId: 's1',
  observedAt: '2026-10-29T10:00:00.000Z' as Instant,
  available: true,
  processes: [
    {
      id: ID,
      pid: 4242,
      command: 'bun test',
      commandTruncated: false,
      kind: 'command',
      state: 'running',
      startedAt: '2026-10-29T09:59:00.000Z' as Instant,
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

function fixture(processes: SessionProcessSubsystem = new FakeProcesses()) {
  const handlers = processHandlers(processes, ferretDirectory());
  return {
    list: async (ferretId = 's1'): Promise<Answer> => await answer(handlers.list, { params: { ferretId } }),
    output: async (init: { processId?: string; ferretId?: string; query?: CallInit['query'] } = {}): Promise<Answer> =>
      await answer(handlers.output, {
        params: { ferretId: init.ferretId ?? 's1', processId: init.processId ?? ID },
        ...(init.query === undefined ? {} : { query: init.query }),
      }),
    stop: async (init: { processId?: string; ferretId?: string } = {}): Promise<Answer> =>
      await answer(handlers.stop, { params: { ferretId: init.ferretId ?? 's1', processId: init.processId ?? ID } }),
  };
}

describe('the ferret processes routes', () => {
  it('should list a ferret’s processes as the wire list', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const routes = fixture(processes);

    // Act
    const response = await routes.list();

    // Assert
    should(response.status).equal(200);
    should(SessionProcessListSchema.parse(response.body)).deepEqual(LIST);
    should(processes.calls).deepEqual(['list s1']);
  });

  it('should read output from the offset after, and from the tail with none', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const routes = fixture(processes);

    // Act
    const followed = await routes.output({ query: [['after', '120']] });
    const tail = await routes.output();

    // Assert
    should(followed.status).equal(200);
    should(SessionProcessOutputSchema.parse(followed.body)).deepEqual(OUTPUT);
    should(tail.status).equal(200);
    should(processes.calls).deepEqual([`output s1 ${ID} 120`, `output s1 ${ID} none`]);
  });

  it('should treat an empty after as no offset', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const routes = fixture(processes);

    // Act
    const response = await routes.output({ query: [['after', '']] });

    // Assert
    should(response.status).equal(200);
    should(processes.calls).deepEqual([`output s1 ${ID} none`]);
  });

  it('should stop a process and answer how many were signalled', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const routes = fixture(processes);

    // Act
    const response = await routes.stop();

    // Assert
    should(response.status).equal(200);
    should(SessionProcessStopResultSchema.parse(response.body)).deepEqual(STOPPED);
    should(processes.calls).deepEqual([`stop s1 ${ID}`]);
  });

  it('should refuse a process id that is not pid.start with 400, before the subsystem is touched', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const routes = fixture(processes);
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
    const responses: Answer[] = [];
    for (const processId of bad) {
      responses.push(await routes.output({ processId }));
      responses.push(await routes.stop({ processId }));
    }

    // Assert
    should(responses.map(response => [response.status, response.code])).deepEqual(
      responses.map(() => [400, 'invalid_process_id']),
    );
    should(processes.calls).deepEqual([]);
  });

  it('should refuse an encoded path-traversal process id with 400', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const routes = fixture(processes);

    // Act
    const response = await routes.output({ processId: '..%2Fetc%2Fpasswd' });

    // Assert
    should([response.status, response.code]).deepEqual([400, 'invalid_process_id']);
    should(processes.calls).deepEqual([]);
  });

  it('should refuse an unusable ferret id with 400 before anything else', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const routes = fixture(processes);

    // Act
    const responses = [
      await routes.list('%2f'),
      await routes.output({ ferretId: '..', processId: 'abc' }),
      await routes.stop({ ferretId: '' }),
    ];

    // Assert — the ferret id is checked first, so a bad process id behind it is not what is reported.
    should(responses.map(response => [response.status, response.code])).deepEqual([
      [400, 'invalid_session_id'],
      [400, 'invalid_session_id'],
      [400, 'invalid_session_id'],
    ]);
    should(processes.calls).deepEqual([]);
  });

  it('should refuse a bad after with 400 invalid_query', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const routes = fixture(processes);
    const bad = ['-1', '1.5', 'abc', '0x10x', '9007199254740993', 'NaN', 'Infinity'];

    // Act
    const responses: Answer[] = [];
    for (const after of bad) responses.push(await routes.output({ query: [['after', after]] }));

    // Assert
    should(responses.map(response => [response.status, response.code])).deepEqual(
      bad.map(() => [400, 'invalid_query']),
    );
    should(processes.calls).deepEqual([]);
  });

  it('should answer an unknown ferret 404 not-found on all three routes, without asking the subsystem', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const routes = fixture(processes);

    // Act
    const responses = [
      await routes.list('ghost'),
      await routes.output({ ferretId: 'ghost' }),
      await routes.stop({ ferretId: 'ghost' }),
    ];

    // Assert
    should(responses.map(response => [response.status, response.code])).deepEqual([
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
      const routes = fixture(processes);

      // Act
      const read = await routes.output();
      const stopped = await routes.stop();

      // Assert
      should([read.status, read.code]).deepEqual([status, code]);
      should([stopped.status, stopped.code]).deepEqual([status, code]);
      should(stopped.error).equal(`that is ${failure}`);
    });
  }

  it('should map a pane-proof refusal through the attach taxonomy on the list too', async () => {
    // Arrange
    const processes = new FakeProcesses();
    const failure: SessionAttachFailure = 'pane_unavailable';
    processes.failure = new SessionAttachError(failure, 'the pane is not there');
    const routes = fixture(processes);

    // Act
    const response = await routes.list();

    // Assert
    should([response.status, response.code]).deepEqual([409, 'attach_pane_unavailable']);
  });

  it('should not turn a defect into a refusal', async () => {
    // Arrange
    const processes = new FakeProcesses();
    processes.failure = new Error('the vault could not be opened');
    const routes = fixture(processes);

    // Act / Assert — the kernel answers a non-ApiError as its own 500, without the message.
    await should(routes.list()).be.rejectedWith('the vault could not be opened');
  });
});
