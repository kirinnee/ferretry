import { describe, it } from 'bun:test';
import should from 'should';
import { ClientBoardGateway, ClientLaneGateway } from '../../../cli/lib/gateway.ts';
import manifest from '../../../manifest.ts';
import { card, cardResponse, listing, response } from '../../unit/cli/fixtures.ts';
import { laneSet } from '../../unit/cli/lane-fixtures.ts';

const recording = (answer: unknown) => {
  const calls: { route: string; init: unknown }[] = [];
  return {
    calls,
    client: {
      call: async (route: string, init?: unknown) => {
        calls.push({ route, init });
        return answer;
      },
      subscribe: () => () => {},
    } as never,
  };
};

const declared = new Set<string>(manifest.actions?.routes?.map(route => route.key) ?? []);

describe('the board gateway', () => {
  it('should read the board with its query, leaving out what was not asked', async () => {
    const { client, calls } = recording(response());
    await new ClientBoardGateway(client).board({ project: 'unfiled', state: 'closed', limit: 500 });
    should(calls[0]).eql({
      route: 'GET /v1/board',
      init: { query: { project: 'unfiled', state: 'closed', limit: '500' } },
    });
  });

  it('should carry the visibility filter in the query', async () => {
    const { client, calls } = recording(response());
    await new ClientBoardGateway(client).board({ visibility: 'private', limit: 500 });
    should((calls[0]?.init as { query: unknown }).query).eql({ visibility: 'private', limit: '500' });
  });

  it('should read the whole board when no query is given', async () => {
    const { client, calls } = recording(response());
    await new ClientBoardGateway(client).board({});
    should((calls[0]?.init as { query: unknown }).query).eql({});
  });

  it('should read one card by id', async () => {
    const { client, calls } = recording(cardResponse());
    await new ClientBoardGateway(client).card('F412');
    should(calls[0]).eql({ route: 'GET /v1/board/cards/:cardId', init: { params: { cardId: 'F412' } } });
  });

  it('should post a create without naming any ferret: the credential is the actor', async () => {
    const { client, calls } = recording(cardResponse());
    const request = {
      kind: 'feature',
      title: 'Rename the widget',
      ask: { text: 'please rename it', source: 'chat://1' },
      visibility: 'private',
    } as const;
    await new ClientBoardGateway(client).create(request as never);
    should(calls[0]).eql({ route: 'POST /v1/board/cards', init: { body: request } });
  });

  it('should post an action to the card', async () => {
    const { client, calls } = recording(cardResponse(card({ laneId: 'implement' })));
    await new ClientBoardGateway(client).act('F412', { action: 'move', to: 'implement' } as never);
    should(calls[0]).eql({
      route: 'POST /v1/board/cards/:cardId',
      init: { params: { cardId: 'F412' }, body: { action: 'move', to: 'implement' } },
    });
  });

  it('should post a progress write as one edit', async () => {
    const { client, calls } = recording(cardResponse());
    await new ClientBoardGateway(client).act('F412', { action: 'edit', progress: { now: 'testing' } } as never);
    should((calls[0]?.init as { body: unknown }).body).eql({ action: 'edit', progress: { now: 'testing' } });
  });

  it('should post a skip', async () => {
    const { client, calls } = recording({ ferret: 'f', skip: { reason: 'chat', at: '2026-10-30T10:00:00.000Z' } });
    await new ClientBoardGateway(client).skip({ reason: 'chat' });
    should(calls[0]).eql({ route: 'POST /v1/board/skip', init: { body: { reason: 'chat' } } });
  });

  it('should ask for the merge gate of one PR', async () => {
    const { client, calls } = recording({ pr: 'u', unit: [], waits: [], unreadable: [] });
    await new ClientBoardGateway(client).mergeGate('https://github.com/o/r/pull/1');
    should(calls[0]).eql({
      route: 'GET /v1/board/merge-gate',
      init: { query: { pr: 'https://github.com/o/r/pull/1' } },
    });
  });

  it('should list ferrets as an id and a name, from a bare list or one under `ferrets`', async () => {
    const rows = [{ id: 'f-1', name: 'denisha', extra: 1 }, { id: 'f-2' }, 7];
    const bare = recording(rows);
    const wrapped = recording({ ferrets: rows });
    const expected = [
      { id: 'f-1', name: 'denisha' },
      { id: 'f-2', name: undefined },
    ];
    should(await new ClientBoardGateway(bare.client).ferrets()).eql(expected);
    should(await new ClientBoardGateway(wrapped.client).ferrets()).eql(expected);
    should(bare.calls[0]?.route).equal('GET /v1/ferrets');
  });

  it('should ask Conversation whether a new card is already somebody’s', async () => {
    const { client, calls } = recording({ matches: [] });
    await new ClientBoardGateway(client).related({ kind: 'card', title: 'Search' });
    should(calls[0]).eql({ route: 'POST /v1/search/related', init: { body: { kind: 'card', title: 'Search' } } });
  });

  it('should only call board routes the Board manifest declares (the other plugins’ are Ferrets’ and Conversation’s)', async () => {
    const { client, calls } = recording(listing());
    const gateway = new ClientBoardGateway(client);
    const lanes = new ClientLaneGateway(client);
    await gateway.projects();
    await gateway.mergeGate('u');
    await gateway.skip({ reason: 'x' });
    await lanes.project('p' as never);
    await lanes.change('p' as never, { action: 'propose', template: 'pr' } as never);
    await lanes.switchOf('p' as never);
    await lanes.setSwitch('p' as never, true);
    const own = calls.map(call => call.route);
    should(own.filter(route => !declared.has(route))).eql([]);
  });
});

describe('the lane gateway', () => {
  it('should read the lanes and the switch of one project', async () => {
    const { client, calls } = recording({ id: 'p', name: 'P', path: null, laneSet: laneSet() });
    await new ClientLaneGateway(client).project('p' as never);
    await new ClientLaneGateway(client).switchOf('p' as never);
    should(calls.map(call => [call.route, call.init])).eql([
      ['GET /v1/board/projects/:projectId/lanes', { params: { projectId: 'p' } }],
      ['GET /v1/board/projects/:projectId/switch', { params: { projectId: 'p' } }],
    ]);
  });

  it('should post a lane change and put the switch', async () => {
    const { client, calls } = recording({});
    await new ClientLaneGateway(client).change('p' as never, { action: 'propose', template: 'pr' } as never);
    await new ClientLaneGateway(client).setSwitch('p' as never, false);
    should(calls.map(call => [call.route, call.init])).eql([
      [
        'POST /v1/board/projects/:projectId/lanes',
        { params: { projectId: 'p' }, body: { action: 'propose', template: 'pr' } },
      ],
      ['PUT /v1/board/projects/:projectId/switch', { params: { projectId: 'p' }, body: { on: false } }],
    ]);
  });
});
