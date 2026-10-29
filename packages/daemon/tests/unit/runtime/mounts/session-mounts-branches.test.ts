import { describe, it } from 'bun:test';
import { FY_REQUEST_ID_HEADER } from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import type { ApiRoute, RouteContext } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { SessionAttachmentError } from '../../../../src/lib/attachments/index.ts';
import {
  SessionAnswerError,
  type SessionAnswerSubsystem,
  sessionAnswerRoutes,
} from '../../../../src/lib/runtime/mounts/session-answer.ts';
import {
  type SessionAttachmentSubsystem,
  sessionAttachmentRoutes,
} from '../../../../src/lib/runtime/mounts/session-attachments.ts';
import { sessionControlRoutes } from '../../../../src/lib/runtime/mounts/session-control.ts';
import {
  type SessionProcessSubsystem,
  sessionProcessRoutes,
} from '../../../../src/lib/runtime/mounts/session-processes.ts';
import { sessionReadRoutes } from '../../../../src/lib/runtime/mounts/session-reads.ts';
import { type SessionSendSubsystem, sessionSendRoutes } from '../../../../src/lib/runtime/mounts/session-send.ts';
import { sessionRoutes } from '../../../../src/lib/runtime/mounts/sessions.ts';
import type { OperatorReadService } from '../../../../src/lib/session/reads/service.ts';
import { request } from '../../api/support.ts';
import { CREDENTIALS, FakeSessionControl, GRANTED, human, sessionDirectory, sessionView } from './support.ts';

/** Refusal branches of the session mounts that only a hostile or broken caller reaches. */

const dispatch = async (
  routes: readonly ApiRoute[],
  overrides: Parameters<typeof request>[0],
  guard = NO_GOVERNED_ROUTES_GUARD,
) => await new ApiDispatcher(new ApiRouter(routes), CREDENTIALS, guard).dispatch(request(overrides));

const errorBody = (body: string): { error: string; code: string } =>
  JSON.parse(body) as { error: string; code: string };

describe('a session id that regains a path separator', () => {
  it('should never reach the answer, attachment or process subsystem', async () => {
    // Arrange
    const refusing = new Proxy({}, { get: () => () => Promise.reject(new Error('the subsystem must not be reached')) });

    // Act
    const answer = await dispatch(sessionAnswerRoutes(refusing as SessionAnswerSubsystem), {
      method: 'POST',
      path: '/v1/sessions/%2Fetc/answer',
      headers: { ...human, [FY_REQUEST_ID_HEADER]: 'answer-1' },
      body: JSON.stringify({ toolUseId: 'tool-1', labels: ['one'] }),
    });
    const attachments = await dispatch(sessionAttachmentRoutes(refusing as SessionAttachmentSubsystem), {
      path: '/v1/sessions/%2Fetc/attachments/att_1',
      headers: human,
    });
    const processes = await dispatch(
      sessionProcessRoutes(refusing as SessionProcessSubsystem, sessionDirectory()),
      { path: '/v1/sessions/%2Fetc/processes', headers: human, loopback: true },
      GRANTED,
    );

    // Assert
    for (const response of [answer, attachments, processes]) {
      should(response.status).equal(400);
      should(errorBody(response.body).code).equal('invalid_session_id');
    }
  });
});

describe('the answer mount refusals', () => {
  it.each([
    ['invalid', 400, 'invalid_request'],
    ['not_found', 404, 'not-found'],
  ] as const)('should restate a %s answer failure as %i', async (failure, status, code) => {
    // Arrange
    const subsystem = {
      answer: async () => {
        throw new SessionAnswerError(failure, 'stated by the domain');
      },
    } as unknown as SessionAnswerSubsystem;

    // Act
    const response = await dispatch(sessionAnswerRoutes(subsystem), {
      method: 'POST',
      path: '/v1/sessions/s1/answer',
      headers: { ...human, [FY_REQUEST_ID_HEADER]: 'answer-1' },
      body: JSON.stringify({ toolUseId: 'tool-1', labels: ['one'] }),
    });

    // Assert
    should(response.status).equal(status);
    should(errorBody(response.body)).match({ code, error: 'stated by the domain' });
  });
});

describe('an unexpected subsystem failure', () => {
  it('should not be restated as a domain refusal by the attachment mount', async () => {
    // Arrange
    const subsystem = {
      lock: async () => {
        throw new TypeError('disk exploded');
      },
    } as unknown as SessionAttachmentSubsystem;

    // Act
    const response = await dispatch(sessionAttachmentRoutes(subsystem), {
      method: 'DELETE',
      path: '/v1/sessions/s1/attachments/att_1/unlock',
      headers: human,
    });
    const attachmentFailure = await dispatch(
      sessionAttachmentRoutes({
        lock: async () => {
          throw new SessionAttachmentError('not_found', 'no such attachment');
        },
      } as unknown as SessionAttachmentSubsystem),
      { method: 'DELETE', path: '/v1/sessions/s1/attachments/att_1/unlock', headers: human },
    );

    // Assert — an unexpected failure is never labelled `attachment_*`; a domain one always is.
    should(response.status).equal(500);
    should(errorBody(response.body).code).equal('internal_error');
    should(errorBody(attachmentFailure.body).code).startWith('attachment_');
  });

  it('should not be restated as a send refusal by the send mount', async () => {
    // Arrange
    const subsystem = {
      sends: async () => {
        throw new TypeError('ledger unreadable');
      },
    } as unknown as SessionSendSubsystem;

    // Act
    const response = await dispatch(sessionSendRoutes(subsystem), {
      path: '/v1/sessions/s1/sends',
      headers: human,
    });

    // Assert
    should(response.status).equal(500);
    should(errorBody(response.body).code).equal('internal_error');
  });

  it('should not be restated as a reader refusal by the session directory mount', async () => {
    // Arrange
    const directory = {
      list: async () => [],
      get: async () => {
        throw new TypeError('index unreadable');
      },
    };

    // Act
    const response = await dispatch(sessionRoutes(directory), { path: '/v1/sessions/s1', headers: human });

    // Assert
    should(response.status).equal(500);
    should(errorBody(response.body).code).equal('internal_error');
  });
});

describe('the session directory mount', () => {
  it('should answer an unusable session id as a bad request', async () => {
    // Arrange
    const directory = sessionDirectory([sessionView('s1')], { invalid: ['bad id'] });

    // Act
    const response = await dispatch(sessionRoutes(directory), { path: '/v1/sessions/bad%20id', headers: human });

    // Assert
    should(response.status).equal(400);
    should(errorBody(response.body).code).equal('invalid_session_id');
  });
});

describe('the session snapshot read', () => {
  it('should refuse a live flag that is neither true nor false before any evidence is read', async () => {
    // Arrange
    const reads = new Proxy({}, { get: () => () => Promise.reject(new Error('no read may happen')) });

    // Act
    const response = await dispatch(sessionReadRoutes(reads as OperatorReadService, sessionDirectory()), {
      path: '/v1/sessions/s1/snapshot',
      query: [['live', 'maybe']],
      headers: human,
    });

    // Assert
    should(response.status).equal(400);
    should(errorBody(response.body)).match({ code: 'invalid_query', error: /live/u });
  });
});

describe('the session stop and start writes', () => {
  const stopRequest = (body: string) =>
    ({
      method: 'POST',
      path: '/v1/sessions/s1/stop',
      headers: { ...human, [FY_REQUEST_ID_HEADER]: 'stop-1' },
      body,
    }) satisfies Parameters<typeof request>[0];

  it('should refuse a stop body that is not the stop request, without stopping anything', async () => {
    // Arrange
    const control = new FakeSessionControl();

    // Act
    const response = await dispatch(
      sessionControlRoutes(control, { guard: NO_GOVERNED_ROUTES_GUARD, knownRoots: async () => [] }),
      stopRequest(JSON.stringify({ reason: 7, extra: true })),
    );

    // Assert
    should(response.status).equal(400);
    should(errorBody(response.body)).match({ code: 'invalid_request', error: /request body is invalid/u });
    should(control.stops).eql([]);
  });

  it('should refuse a start whose body cannot be read, without starting anything', async () => {
    // Arrange
    const control = new FakeSessionControl();

    // Act
    const response = await dispatch(
      sessionControlRoutes(control, { guard: NO_GOVERNED_ROUTES_GUARD, knownRoots: async () => [] }),
      {
        method: 'POST',
        path: '/v1/sessions',
        headers: { ...human, [FY_REQUEST_ID_HEADER]: 'req-1' },
        unreadableBody: true,
      },
    );

    // Assert
    should(response.status).equal(400);
    should(errorBody(response.body).code).equal('unreadable_body');
    should(control.starts).eql([]);
  });

  it('should refuse a governed caller a terminal-class start with the grant refusal when the gate has nothing to explain', async () => {
    // Arrange
    const control = new FakeSessionControl();
    const route = sessionControlRoutes(control, { guard: NO_GOVERNED_ROUTES_GUARD, knownRoots: async () => [] }).find(
      candidate => candidate.method === 'POST' && candidate.path === '/v1/sessions',
    );
    if (route === undefined) throw new Error('no start route');
    const context: RouteContext = {
      request: request({
        method: 'POST',
        path: '/v1/sessions',
        headers: { ...human, [FY_REQUEST_ID_HEADER]: 'req-1' },
        body: JSON.stringify({
          agent: 'claude-auto-loge',
          mode: 'auto',
          prompt: 'wire the subsystems',
          harnessFlags: ['--dangerously-skip-permissions'],
        }),
      }),
      params: new Map<string, string>(),
      presentation: { loopback: false, adminToken: false, actor: 'device:d1', stepUp: false, freshStepUp: false },
    };

    // Act
    const response = await route.handle(context);

    // Assert — not a step-up demand: the caller is told the grant, never let through.
    should(response.status).equal(403);
    should(errorBody(response.body)).match({
      code: 'grant_undetermined',
      error: /terminal access/u,
    });
    should(control.starts).eql([]);
  });
});
