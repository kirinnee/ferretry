/**
 * Adding an MCP server for one ferret, at the daemon's front door. The service behind it is a stub:
 * what the mount owns is which capability each route declares, that every body is parsed through the
 * shared schema before the domain sees it, which status each refusal becomes, and that the login add is
 * handed the caller's governance and a way to spend its fresh step-up rather than deciding either.
 */
import { describe, it } from 'bun:test';
import type {
  SessionMcpAdded,
  SessionMcpAddRequest,
  SessionMcpListing,
  SessionMcpPreview,
  SessionMcpPreviewRequest,
} from '@ferretry/protocol';
import should from 'should';
import type { CallerGovernance } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { FleetCatalogRefusal, type FreshStepUpContext } from '../../../../src/lib/fleet/catalog-service.ts';
import {
  createSessionMcpSubsystem,
  type SessionMcpSubsystem,
  sessionMcpRoutes,
} from '../../../../src/lib/runtime/mounts/session-mcp.ts';
import { SessionMcpRefusal } from '../../../../src/lib/session-mcp/service.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, GRANTED, human } from './support.ts';

const SERVER = { transport: 'command', command: 'npx', args: [], env: {} } as const;
const LISTING: SessionMcpListing = { project: null, projectUnavailable: 'not here' };
const PROJECT_PREVIEW: SessionMcpPreview = {
  scope: 'project',
  path: '/r/.mcp.json',
  etag: null,
  replaces: false,
  diff: [],
};
const LOGIN_PREVIEW: SessionMcpPreview = { scope: 'login', runtime: 'r', profile: 'p', replaces: false, ferrets: 1 };
const PROJECT_ADDED: SessionMcpAdded = { scope: 'project', name: 'acme', path: '/r/.mcp.json', etag: 'a'.repeat(64) };
const LOGIN_ADDED: SessionMcpAdded = { scope: 'login', name: 'acme', runtime: 'r', profile: 'p' };

interface Calls {
  readonly seen: unknown[][];
  stepUp?: FreshStepUpContext;
  governance?: CallerGovernance;
}

function stub(failure?: unknown): { subsystem: SessionMcpSubsystem; calls: Calls } {
  const calls: Calls = { seen: [] };
  const answer = async <Value>(value: Value, ...args: unknown[]): Promise<Value> => {
    calls.seen.push(args);
    if (failure !== undefined) throw failure;
    return value;
  };
  return {
    calls,
    subsystem: {
      list: async id => await answer(LISTING, 'list', id),
      previewProject: async (id, body: SessionMcpPreviewRequest) =>
        await answer(PROJECT_PREVIEW, 'previewProject', id, body),
      addProject: async (id, body: SessionMcpAddRequest) => await answer(PROJECT_ADDED, 'addProject', id, body),
      previewLogin: async (id, body) => await answer(LOGIN_PREVIEW, 'previewLogin', id, body),
      addLogin: async (id, body, governance, stepUp) => {
        calls.governance = governance as CallerGovernance;
        calls.stepUp = stepUp;
        return await answer(LOGIN_ADDED, 'addLogin', id, body);
      },
    },
  };
}

const dispatcher = (subsystem: SessionMcpSubsystem): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(sessionMcpRoutes(subsystem)), CREDENTIALS, GRANTED);

const post = (path: string, body: unknown) =>
  request({
    method: 'POST',
    path,
    headers: { ...human, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('the session MCP mount', () => {
  it('should declare one capability per scope, operator scope, never cached', () => {
    // Act
    const routes = sessionMcpRoutes(stub().subsystem);

    // Assert — deeper paths first, so no pattern can shadow another.
    should(
      routes.map(route => [route.method, route.path, route.capability?.capability, route.capability?.axis]),
    ).deepEqual([
      ['POST', '/v1/sessions/:sessionId/mcp/project/preview', 'filesystem', 'use'],
      ['POST', '/v1/sessions/:sessionId/mcp/login/preview', 'fleet', 'use'],
      ['POST', '/v1/sessions/:sessionId/mcp/project', 'filesystem', 'configure'],
      ['POST', '/v1/sessions/:sessionId/mcp/login', 'fleet', 'configure'],
      ['GET', '/v1/sessions/:sessionId/mcp', 'filesystem', 'use'],
    ]);
    should(routes.every(route => route.minimum === 'operator' && route.noStore === true)).be.true();
  });

  it('should hand each act its session and parsed body, and answer through the shared schema', async () => {
    // Arrange
    const { subsystem, calls } = stub();
    const subject = dispatcher(subsystem);
    const preview = { name: 'acme', server: SERVER };

    // Act
    const answers = await Promise.all([
      subject.dispatch(request({ path: '/v1/sessions/s1/mcp', headers: human })),
      subject.dispatch(post('/v1/sessions/s1/mcp/project/preview', preview)),
      subject.dispatch(post('/v1/sessions/s1/mcp/project', { ...preview, etag: null })),
      subject.dispatch(post('/v1/sessions/s1/mcp/login/preview', preview)),
      subject.dispatch(post('/v1/sessions/s1/mcp/login', preview)),
    ]);

    // Assert
    should(answers.map(answer => answer.status)).deepEqual([200, 200, 200, 200, 200]);
    should(answers.map(answer => answer.headers.get('cache-control'))).deepEqual(Array(5).fill('no-store'));
    should(answers.map(answer => jsonBody(answer))).deepEqual([
      LISTING,
      PROJECT_PREVIEW,
      PROJECT_ADDED,
      LOGIN_PREVIEW,
      LOGIN_ADDED,
    ]);
    should(calls.seen).deepEqual([
      ['list', 's1'],
      ['previewProject', 's1', preview],
      ['addProject', 's1', { ...preview, etag: null }],
      ['previewLogin', 's1', preview],
      ['addLogin', 's1', preview],
    ]);
  });

  it('should hand the login add the caller governance and a step-up spend it can call', async () => {
    // Arrange
    const { subsystem, calls } = stub();

    // Act
    await dispatcher(subsystem).dispatch(post('/v1/sessions/s1/mcp/login', { name: 'acme', server: SERVER }));
    calls.stepUp?.spend();

    // Assert
    should(calls.governance).containDeep({ governed: false });
    should(calls.stepUp).have.property('presentation');
  });

  it('should refuse a body outside the contract and a session id that regains a separator', async () => {
    // Arrange
    const { subsystem, calls } = stub();
    const subject = dispatcher(subsystem);

    // Act
    const answers = await Promise.all([
      subject.dispatch(post('/v1/sessions/s1/mcp/login', { name: 'acme', server: SERVER, etag: null })),
      subject.dispatch(post('/v1/sessions/s1/mcp/project/preview', { name: '../x', server: SERVER })),
      subject.dispatch(request({ path: '/v1/sessions/%2e%2e%2fetc/mcp', headers: human })),
    ]);

    // Assert
    should(answers.map(answer => answer.status)).deepEqual([400, 400, 400]);
    should(jsonBody(answers[2] as never)).have.property('code', 'invalid_session_id');
    should(calls.seen).be.empty();
  });

  it('should answer the domain refusals and the fleet refusals with their own status, and hide a defect', async () => {
    // Arrange
    const answers = await Promise.all(
      [
        new SessionMcpRefusal(409, 'mcp_file_changed', '.mcp.json changed since the preview.'),
        new FleetCatalogRefusal('fleet_change_refused', 'that layer does not exist'),
        new FleetCatalogRefusal('fleet_change_unknown', 'no such change'),
        new Error('the storage index was closed'),
      ].map(
        async failure =>
          await dispatcher(stub(failure).subsystem).dispatch(
            post('/v1/sessions/s1/mcp/login', { name: 'a', server: SERVER }),
          ),
      ),
    );

    // Assert
    should(answers.map(answer => answer.status)).deepEqual([409, 409, 404, 500]);
    should(answers.slice(0, 3).map(answer => jsonBody(answer))).containDeep([
      { code: 'mcp_file_changed', error: '.mcp.json changed since the preview.' },
      { code: 'fleet_change_refused', error: 'that layer does not exist' },
      { code: 'fleet_change_unknown' },
    ]);
    should(answers[3]?.body).not.match(/storage index/u);
  });

  it('should build the subsystem the composition root mounts', async () => {
    // Arrange
    const subsystem = createSessionMcpSubsystem({
      sessions: { get: async () => undefined, list: async () => [] },
      projectRoots: async () => [],
      files: {
        read: async () => ({ text: null, etag: null }),
        replace: async () => 'a'.repeat(64),
      },
      fleet: {} as never,
    });

    // Act
    const answer = await dispatcher(subsystem).dispatch(request({ path: '/v1/sessions/ghost/mcp', headers: human }));

    // Assert
    should(answer.status).equal(404);
    should(jsonBody(answer)).containDeep({ code: 'not-found', error: 'no session ghost' });
  });
});
