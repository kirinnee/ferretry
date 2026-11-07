import { describe, it } from 'bun:test';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import type { ApiRoute } from '../../../../src/lib/api/route.ts';
import type { SocketRoute } from '../../../../src/lib/api/socket.ts';
import type { AgentControlKind } from '../../../../src/lib/fleet/agent-control.ts';
import { agentControlledRoutes, agentControlledSockets } from '../../../../src/lib/runtime/mounts/agent-control.ts';
import { jsonBody, request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, GRANTED, human } from './support.ts';

/** The machine's switches, settable per case, and every kind each request asked about. */
function switches() {
  const off = new Set<AgentControlKind>();
  const asked: AgentControlKind[] = [];
  return {
    off,
    asked,
    policy: {
      allows: async (kind: AgentControlKind) => {
        asked.push(kind);
        return !off.has(kind);
      },
    },
  };
}

const route = (path: string, capability?: 'terminal' | 'browser' | 'filesystem' | 'fleet'): ApiRoute => ({
  method: 'GET',
  path,
  minimum: 'operator',
  caller: 'any',
  ...(capability === undefined ? {} : { capability: { capability, axis: 'use' } }),
  handle: async () =>
    new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }) as never,
});

describe('"What agents may control" on the ordinary surface routes', () => {
  it('should refuse an agent a switched-off kind, on every route of that kind, in the setting’s own words', async () => {
    // Arrange
    const { off, asked, policy } = switches();
    off.add('terminal');
    off.add('files');
    const dispatch = new ApiDispatcher(
      new ApiRouter(
        agentControlledRoutes(policy, [
          route('/t', 'terminal'),
          route('/b', 'browser'),
          route('/f', 'filesystem'),
          route('/x', 'fleet'),
          route('/n'),
        ]),
      ),
      CREDENTIALS,
      GRANTED,
    );
    const as = (path: string, headers: Readonly<Record<string, string>>) =>
      dispatch.dispatch(request({ method: 'GET', path, headers }));

    // Act
    const agentTerminal = await as('/t', agentIn('s1'));
    const agentBrowser = await as('/b', agentIn('s1'));
    const agentFiles = await as('/f', agentIn('s1'));
    const agentOther = await as('/x', agentIn('s1'));
    const agentNone = await as('/n', agentIn('s1'));
    const personTerminal = await as('/t', human);
    const warden = await as('/t', { authorization: `Bearer ${CREDENTIALS.warden}` });

    // Assert — the person is never asked; an agent is refused only the kinds switched off.
    should(agentTerminal.status).equal(403);
    should(jsonBody(agentTerminal)).match({
      code: 'agent_control_off',
      error: /"What agents may control › Terminals" is off/u,
    });
    should(agentBrowser.status).equal(200);
    should(jsonBody(agentFiles)).match({ error: /"What agents may control › Files" is off/u });
    should([agentOther.status, agentNone.status, personTerminal.status]).deepEqual([200, 200, 200]);
    should(warden.status).equal(403);
    should(asked).deepEqual(['terminal', 'browser', 'files']);
  });

  it('should ask before an agent attaches to a terminal or the browser over a socket', async () => {
    // Arrange
    const { off, policy } = switches();
    off.add('browser');
    const accepted: string[] = [];
    const sockets: SocketRoute[] = [
      {
        method: 'GET',
        path: '/stream',
        minimum: 'operator',
        caller: 'any',
        capability: { capability: 'browser', axis: 'use' },
        accept: async () => {
          accepted.push('browser');
          return async () => ({ open: async () => undefined, fromClient: () => undefined, close: () => undefined });
        },
      },
      {
        method: 'GET',
        path: '/events',
        minimum: 'operator',
        caller: 'any',
        accept: async () => {
          accepted.push('events');
          return async () => ({ open: async () => undefined, fromClient: () => undefined, close: () => undefined });
        },
      },
    ];
    const [stream, events] = agentControlledSockets(policy, sockets) as [SocketRoute, SocketRoute];
    const context = (headers: Readonly<Record<string, string>>) => ({
      request: request({ method: 'GET', path: '/stream', headers }),
      params: new Map<string, string>(),
      actor: headers['x-ferretry-session-id'] === undefined ? 'admin-cli' : `peer:${headers['x-ferretry-session-id']}`,
      credential: { kind: 'authenticated' as const, tokenClass: 'admin' as const },
    });

    // Act
    const refused = await stream.accept(context(agentIn('s1'))).catch((error: unknown) => error);
    await stream.accept(context(human));
    await events.accept(context(agentIn('s1')));

    // Assert
    should(refused).have.property('status', 403);
    should(accepted).deepEqual(['browser', 'events']);
  });
});
