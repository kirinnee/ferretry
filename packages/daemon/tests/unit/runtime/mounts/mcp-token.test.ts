import { describe, it } from 'bun:test';
import should from 'should';
import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { FerretMcpTokens } from '../../../../src/lib/mcp-inventory/ferret-token.ts';
import type { FerretMcpToken } from '../../../../src/lib/mcp-inventory/project-sign-in.ts';
import { mcpTokenRoutes } from '../../../../src/lib/runtime/mounts/mcp-token.ts';
import { jsonBody, request } from '../../api/support.ts';

/**
 * `POST /v1/sessions/:sessionId/mcp/token`: ONLY the ferret itself may ask, and what it is told is the token its own
 * launch holds, renewed. Every case drives the real route with the context the dispatcher would build for that caller.
 */

const VARIABLE = 'FY_MCP_SLACK_0123456789ABCDEF_TOKEN';
const PATH = '/v1/sessions/s1/mcp/token';
const SESSION = { config: { agent: '/fy/fleet/bin/claude-work', cwd: '/work/app' } };

interface Caller {
  readonly credential: AuthenticatedCredential;
  readonly actor: string;
}

const SELF: Caller = {
  credential: { kind: 'authenticated', tokenClass: 'session', sessionId: 's1' },
  actor: 'peer:s1',
};
/** A ferret with no credential of its own (an older `fy`): the honest-client admin token naming its session. */
const SELF_BY_HEADER: Caller = { credential: { kind: 'authenticated', tokenClass: 'admin' }, actor: 'peer:s1' };
const OTHER_FERRET: Caller = {
  credential: { kind: 'authenticated', tokenClass: 'session', sessionId: 's2' },
  actor: 'peer:s2',
};
const OTHER_BY_HEADER: Caller = { credential: { kind: 'authenticated', tokenClass: 'admin' }, actor: 'peer:s2' };
const OWNER: Caller = { credential: { kind: 'authenticated', tokenClass: 'admin' }, actor: 'admin-cli' };
const DEVICE: Caller = {
  credential: { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' },
  actor: 'device:d1',
};
const WARDEN: Caller = { credential: { kind: 'authenticated', tokenClass: 'warden' }, actor: 'warden:w1' };

interface Asked {
  wrapper: string;
  cwd: string;
  variable: string;
}

function subsystem(answer: FerretMcpToken, known = true) {
  const asked: Asked[] = [];
  const tokens = new FerretMcpTokens({
    sessions: { get: async () => (known ? SESSION : undefined) },
    tokens: {
      mcpTokenFor: async (wrapper, cwd, variable) => {
        asked.push({ wrapper, cwd, variable });
        return answer;
      },
    },
  });
  return { asked, subsystem: { tokens } };
}

async function drive(
  made: ReturnType<typeof subsystem>,
  caller: Caller,
  body: unknown = { variable: VARIABLE },
  path = PATH,
) {
  const found = new ApiRouter(mcpTokenRoutes(made.subsystem)).lookup('POST', path);
  if (found.kind !== 'matched') throw new Error(`no route POST ${path}`);
  const context: RouteContext = {
    request: request({
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: found.params,
    actor: caller.actor,
    credential: caller.credential,
  };
  try {
    const response = await found.route.handle(context);
    return { status: response.status, body: jsonBody(response) as Record<string, unknown> };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, code: error.code, message: error.message };
  }
}

describe('POST /v1/sessions/:sessionId/mcp/token', () => {
  it('should declare itself as secrets.use, uncached, for an operator and any caller', () => {
    // Act
    const [route] = mcpTokenRoutes(subsystem({ kind: 'unknown' }).subsystem);

    // Assert
    should(route).containEql({
      method: 'POST',
      path: '/v1/sessions/:sessionId/mcp/token',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      capability: { capability: 'secrets', axis: 'use' },
    });
  });

  for (const [who, caller] of [
    ['a ferret on its own credential', SELF],
    ['a ferret named by the honest-client header', SELF_BY_HEADER],
  ] as const) {
    it(`should give ${who} the headers for its session’s agent and folder`, async () => {
      // Arrange
      const made = subsystem({ kind: 'token', token: 'fresh-token' });

      // Act
      const answer = await drive(made, caller);

      // Assert — the token goes out only in the body; the variable is echoed for the security log.
      should(answer.status).equal(200);
      should(answer.body).deepEqual({ variable: VARIABLE, headers: { Authorization: 'Bearer fresh-token' } });
      should(made.asked).deepEqual([{ wrapper: SESSION.config.agent, cwd: SESSION.config.cwd, variable: VARIABLE }]);
    });
  }

  for (const [who, caller] of [
    ['another ferret', OTHER_FERRET],
    ['another ferret by header', OTHER_BY_HEADER],
    ['a person at the machine', OWNER],
    ['a paired device', DEVICE],
    ['a warden', WARDEN],
  ] as const) {
    it(`should refuse ${who} with a 403 and never ask for a token`, async () => {
      // Arrange
      const made = subsystem({ kind: 'token', token: 'fresh-token' });

      // Act
      const answer = await drive(made, caller);

      // Assert
      should(answer.status).equal(403);
      should(answer.code).equal('not_this_ferret');
      should(JSON.stringify(answer)).not.containEql('fresh-token');
      should(made.asked).deepEqual([]);
    });
  }

  it('should answer 404 not_this_ferrets_server for a variable the launch does not hold', async () => {
    // Arrange
    const made = subsystem({ kind: 'unknown' });

    // Act
    const answer = await drive(made, SELF);

    // Assert
    should(answer.status).equal(404);
    should(answer.code).equal('not_this_ferrets_server');
    should(answer.message).containEql(VARIABLE);
  });

  it('should answer 409 naming the server when its sign-in must be redone, and carry no token', async () => {
    // Arrange
    const made = subsystem({ kind: 'needs-sign-in', server: 'slack' });

    // Act
    const answer = await drive(made, SELF);

    // Assert
    should(answer.status).equal(409);
    should(answer.code).equal('mcp_needs_sign_in');
    should(answer.message).containEql('“slack”');
    should(answer.message).containEql('fy mcp ls');
  });

  it('should answer 404 for a session the daemon does not know', async () => {
    // Arrange
    const made = subsystem({ kind: 'token', token: 'fresh-token' }, false);

    // Act
    const answer = await drive(made, SELF);

    // Assert
    should(answer.status).equal(404);
    should(made.asked).deepEqual([]);
  });

  it.each([
    ['a name that is not a sign-in variable', { variable: 'PATH' }],
    ['a secret name', { variable: 'MCP_SLACK_0123456789ABCDEF_ACCESS' }],
    ['no variable at all', {}],
    ['an extra field', { variable: VARIABLE, secret: 'X' }],
  ] as const)('should refuse %s at the schema, before any token is read', async (_what, body) => {
    // Arrange
    const made = subsystem({ kind: 'token', token: 'fresh-token' });

    // Act
    const answer = await drive(made, SELF, body);

    // Assert
    should(answer.status).equal(400);
    should(made.asked).deepEqual([]);
  });
});
