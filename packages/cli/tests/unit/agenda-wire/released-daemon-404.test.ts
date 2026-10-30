import { describe, it } from 'bun:test';
import { FyApiClient } from '@ferretry/protocol/client';
import should from 'should';
import { ProtocolAgendaGateway } from '../../../src/lib/agenda/gateway';
import { snapshot } from '../agenda/fixtures';

/**
 * WHAT A RELEASED DAEMON SAYS FOR A ROUTE IT DOES NOT HAVE, byte for byte — pinned here rather than built
 * from today's `unknownRouteResponse`, so a change on the daemon side cannot quietly move both ends.
 *
 * The shape arrived with the daemon's HTTP API itself (e10db2a1d, #26, first released in v0.14.0) and
 * `git log -L` on `unknownRouteResponse` shows no other commit through v4.109.0. No release mounts a
 * catch-all under `/v1/sessions/:sessionId/…` or `/v1/warden/…` that could answer an agenda path
 * differently, the tunnel listener hands every request to the same dispatcher, and authentication
 * runs before the route lookup (a bad credential is 401 on both spellings, so it needs no fallback).
 * Older than v0.14.0 there was no HTTP API, so no route to fall back to.
 */
const releasedUnknownRoute = (method: string, path: string): Response =>
  new Response(JSON.stringify({ error: `no route ${method} ${path}`, code: 'unknown_route', method, path }), {
    status: 404,
    headers: { 'content-type': 'application/json', 'x-fy-version': '4.109.0' },
  });

const SESSION = 's-1';
const AGENDA = `/v1/sessions/${SESSION}/agenda`;
const LEGACY_ATTENTION = `/v1/sessions/${SESSION}/attention`;

/** A v4.109.0 daemon on the wire: the agenda route answers, the agenda route is the released 404. */
async function releasedDaemon(
  agendaAnswer: (method: string, path: string) => Response = releasedUnknownRoute,
): Promise<{ gateway: ProtocolAgendaGateway; dialed: string[] }> {
  const dialed: string[] = [];
  const client = await FyApiClient.connect({
    baseUrl: 'http://127.0.0.1:7777',
    token: 'admin-token',
    version: '4.110.0',
    transport: {
      send: (url: string, init: RequestInit): Promise<Response> => {
        const path = new URL(url).pathname;
        const method = init.method ?? 'GET';
        dialed.push(`${method} ${path}`);
        if (path === LEGACY_ATTENTION) {
          return Promise.resolve(
            new Response(JSON.stringify(snapshot([])), {
              status: 200,
              headers: { 'content-type': 'application/json', 'x-fy-version': '4.109.0' },
            }),
          );
        }
        return Promise.resolve(agendaAnswer(method, path));
      },
    },
  });
  return { gateway: new ProtocolAgendaGateway(client, SESSION), dialed };
}

describe('the agenda routes against a released daemon (contract)', () => {
  it('should fall back to the agenda route on the exact 404 v0.14.0 through v4.109.0 send', async () => {
    // Arrange
    const { gateway, dialed } = await releasedDaemon();

    // Act
    const first = await gateway.snapshot(SESSION);
    const second = await gateway.snapshot(SESSION);

    // Assert
    should(first.items).deepEqual([]);
    should(second.items).deepEqual([]);
    should(dialed).deepEqual([`GET ${AGENDA}`, `GET ${LEGACY_ATTENTION}`, `GET ${LEGACY_ATTENTION}`]);
  });

  it('should NOT fall back on a 404 that is not an unknown route, and surface it', async () => {
    // Arrange — a 404 with another meaning (no such session) must not be retried on another route.
    const { gateway, dialed } = await releasedDaemon(
      () =>
        new Response(JSON.stringify({ error: 'no such session s-1', code: 'session_not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );

    // Act
    const actual = await gateway.snapshot(SESSION).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(actual).be.instanceOf(Error);
    should((actual as Error).message).containEql('no such session');
    should(dialed).deepEqual([`GET ${AGENDA}`]);
  });
});
