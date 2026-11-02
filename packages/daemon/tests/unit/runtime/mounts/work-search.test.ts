import { describe, it } from 'bun:test';
import type { WorkRelatedRequest, WorkSearchQuery } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiRouter } from '../../../../src/lib/api/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { type WorkSearchSubsystem, workSearchRoutes } from '../../../../src/lib/runtime/mounts/work-search.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, grantSubsystem, human } from './support.ts';

const phone = { deviceId: 'fy_device_id_phone', appSession: 'app-one' } as const;
const MEMBER = { memberId: 'mbr_x', keyId: 'mk_x', appSession: 'app-one', sessionId: 'relay-1' } as const;

const HIT = {
  kind: 'task',
  id: 'F12',
  projectId: 'unfiled',
  sessionId: 'lead',
  title: 'Search cards',
  state: 'open',
  standing: 'In progress',
  updatedAt: '2026-10-30T10:00:00.000Z',
  match: { field: 'summary', line: 'one search over cards' },
  score: 12,
} as const;

/** A search that records what each route handed it. */
const recording = () => {
  const calls: { readonly route: string; readonly value: unknown }[] = [];
  const search: WorkSearchSubsystem = {
    search: async (query: WorkSearchQuery) => {
      calls.push({ route: 'search', value: query });
      return { hits: [HIT], total: 1, indexed: { tasks: 1, agenda: 0 } };
    },
    related: async (value: WorkRelatedRequest) => {
      calls.push({ route: 'related', value });
      return { matches: [{ strength: 'strong', hit: HIT }] };
    },
  };
  return { calls, search };
};

async function dispatcher(
  search: WorkSearchSubsystem,
  fleet = DEFAULT_CAPABILITY_GRANTS.fleet,
): Promise<ApiDispatcher> {
  const grants = grantSubsystem({ grants: { ...DEFAULT_CAPABILITY_GRANTS, fleet } });
  await grants.refresh();
  return new ApiDispatcher(new ApiRouter(workSearchRoutes(search)), CREDENTIALS, grants, undefined, {
    held: device => device.deviceId === phone.deviceId,
  });
}

describe('GET /v1/search', () => {
  it('should hand the service the parsed query, with the defaults filled', async () => {
    // Arrange
    const { calls, search } = recording();

    // Act
    const response = await (
      await dispatcher(search)
    ).dispatch(
      request({
        path: '/v1/search',
        headers: human,
        query: [
          ['q', 'search cards'],
          ['kind', 'task'],
          ['open', 'true'],
          ['limit', '5'],
        ],
      }),
    );

    // Assert
    should(response.status).equal(200);
    should(calls).eql([{ route: 'search', value: { q: 'search cards', kind: 'task', open: true, limit: 5 } }]);
    should(jsonBody(response)).eql({ hits: [HIT], total: 1, indexed: { tasks: 1, agenda: 0 } });
  });

  it('should read `all` into the query, and leave it out when it was not sent', async () => {
    // Arrange
    const { calls, search } = recording();
    const run = async (query: readonly (readonly [string, string])[]) =>
      (await dispatcher(search)).dispatch(request({ path: '/v1/search', headers: human, query }));

    // Act
    const asked = await run([
      ['q', 'old'],
      ['all', 'true'],
    ]);
    const notAsked = await run([['q', 'old']]);

    // Assert
    should(asked.status).equal(200);
    should(notAsked.status).equal(200);
    should(calls.map(call => (call.value as { all?: boolean }).all)).eql([true, undefined]);
  });

  it.each([
    ['no words', []],
    [
      'an all that is not a boolean',
      [
        ['q', 'x'],
        ['all', 'yes'],
      ],
    ],
    [
      'an unknown kind',
      [
        ['q', 'x'],
        ['kind', 'card'],
      ],
    ],
    [
      'a limit past the cap',
      [
        ['q', 'x'],
        ['limit', '51'],
      ],
    ],
    [
      'an open that is not a boolean',
      [
        ['q', 'x'],
        ['open', 'yes'],
      ],
    ],
  ] as const)('should refuse %s with a 400', async (_, query) => {
    // Arrange
    const { calls, search } = recording();

    // Act
    const response = await (await dispatcher(search)).dispatch(request({ path: '/v1/search', headers: human, query }));

    // Assert
    should(response.status).equal(400);
    should(calls).eql([]);
  });

  it('should answer a paired device the fleet grant lets in', async () => {
    // Arrange
    const { calls, search } = recording();

    // Act
    const response = await (
      await dispatcher(search)
    ).dispatch(request({ path: '/v1/search', device: phone, query: [['q', 'cards']] }));

    // Assert
    should(response.status).equal(200);
    should(calls).have.length(1);
  });

  it('should keep cards and agenda items from a paired device without board access', async () => {
    // Arrange
    const { calls, search } = recording();
    const closed = await dispatcher(search, { use: false, configure: false });

    // Act
    const searched = await closed.dispatch(request({ path: '/v1/search', device: phone, query: [['q', 'cards']] }));
    const related = await closed.dispatch(
      request({
        method: 'POST',
        path: '/v1/search/related',
        device: phone,
        body: JSON.stringify({ kind: 'task', title: 'x' }),
      }),
    );

    // Assert
    should(searched.status).equal(403);
    should(related.status).equal(403);
    should(calls).eql([]);
  });

  it('should give a shared-catalog member nothing, even over loopback', async () => {
    // Arrange
    const { calls, search } = recording();
    const open = await dispatcher(search);

    const related = { method: 'POST', path: '/v1/search/related', body: JSON.stringify({ kind: 'task', title: 'x' }) };

    // Act
    const answers = await Promise.all(
      [{ headers: human }, { loopback: true, privilegedLoopback: true }].flatMap(carried => [
        open.dispatch({ ...request({ path: '/v1/search', query: [['q', 'cards']], ...carried }), member: MEMBER }),
        open.dispatch({ ...request({ ...related, ...carried }), member: MEMBER }),
      ]),
    );

    // Assert
    should(answers.map(answer => answer.status)).eql([403, 403, 403, 403]);
    should(calls).eql([]);
  });

  it('should refuse a caller with no credential', async () => {
    // Arrange
    const { calls, search } = recording();
    const open = await dispatcher(search);

    // Act
    const searched = await open.dispatch(request({ path: '/v1/search', query: [['q', 'cards']] }));
    const related = await open.dispatch(
      request({ method: 'POST', path: '/v1/search/related', body: JSON.stringify({ kind: 'task', title: 'x' }) }),
    );

    // Assert
    should([searched.status, related.status]).eql([401, 401]);
    should(calls).eql([]);
  });
});

describe('POST /v1/search/related', () => {
  it('should hand the service the new title and ask', async () => {
    // Arrange
    const { calls, search } = recording();

    // Act
    const response = await (
      await dispatcher(search)
    ).dispatch(
      request({
        method: 'POST',
        path: '/v1/search/related',
        headers: human,
        body: JSON.stringify({ kind: 'agenda', title: 'Search cards', ask: 'make it fast' }),
      }),
    );

    // Assert
    should(response.status).equal(200);
    should(calls).eql([{ route: 'related', value: { kind: 'agenda', title: 'Search cards', ask: 'make it fast' } }]);
    should(jsonBody(response)).eql({ matches: [{ strength: 'strong', hit: HIT }] });
  });

  it('should refuse a request with fields it does not know', async () => {
    // Arrange
    const { calls, search } = recording();

    // Act
    const response = await (
      await dispatcher(search)
    ).dispatch(
      request({
        method: 'POST',
        path: '/v1/search/related',
        headers: human,
        body: JSON.stringify({ kind: 'task', title: 'x', session: 'someone-else' }),
      }),
    );

    // Assert
    should(response.status).equal(400);
    should(calls).eql([]);
  });
});
