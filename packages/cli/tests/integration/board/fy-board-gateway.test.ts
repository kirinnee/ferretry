import { describe, it } from 'bun:test';
import type { IFyApiClient } from '@ferretry/protocol';
import should from 'should';
import { FyBoardGateway } from '../../../src/adapters/board/fy-board-gateway';
import { boardResponse, card, listing, taskResponse } from './fixtures';

const client = (answer: unknown, sessions: unknown[] = []) => {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const request = ((path: string, schema: { parse(value: unknown): unknown }, init?: RequestInit) => {
    calls.push({ path, init });
    return Promise.resolve(schema.parse(answer));
  }) as unknown as IFyApiClient['request'];
  const list = (() => Promise.resolve(sessions)) as unknown as IFyApiClient['list'];
  return { calls, client: { request, list } };
};

const headersOf = (init: RequestInit | undefined): Record<string, string> =>
  Object.fromEntries(new Headers(init?.headers).entries());

describe('the board gateway', () => {
  it('should read the board with its query in the URL, leaving out what was not asked', async () => {
    const { client: fake, calls } = client(boardResponse());

    const response = await new FyBoardGateway(fake).board({ project: 'unfiled', state: 'closed', limit: 500 });

    should(response.cards).have.length(1);
    should(calls[0]?.path).equal('/v1/board?project=unfiled&state=closed&limit=500');
  });

  it('should read the whole board when no query is given', async () => {
    const { client: fake, calls } = client(boardResponse());
    await new FyBoardGateway(fake).board({});
    should(calls[0]?.path).equal('/v1/board');
  });

  it('should read one card by id', async () => {
    const { client: fake, calls } = client(taskResponse());
    await new FyBoardGateway(fake).task('F412');
    should(calls[0]?.path).equal('/v1/board/tasks/F412');
  });

  it('should post a create as the acting session', async () => {
    const { client: fake, calls } = client(taskResponse());

    await new FyBoardGateway(fake).create('session-7', {
      kind: 'feature',
      title: 'Rename the widget',
      ask: { text: 'please rename it', source: 'chat://1' },
    });

    should(calls[0]?.path).equal('/v1/board/tasks');
    should(calls[0]?.init?.method).equal('POST');
    should(headersOf(calls[0]?.init)).containEql({ 'x-ferretry-session-id': 'session-7', 'x-ferretry-client': 'cli' });
    should(JSON.parse(String(calls[0]?.init?.body))).have.property('kind', 'feature');
  });

  it('should post an action to the card, with no session header for the owner', async () => {
    const { client: fake, calls } = client(taskResponse({ laneId: 'doing' }));

    await new FyBoardGateway(fake).act(undefined, 'F412', { action: 'move', to: 'doing' });

    should(calls[0]?.path).equal('/v1/board/tasks/F412');
    should(headersOf(calls[0]?.init)).not.have.property('x-ferretry-session-id');
    should(JSON.parse(String(calls[0]?.init?.body))).eql({ action: 'move', to: 'doing' });
  });

  it('should ask for the projects as the acting session, so the daemon can name its board', async () => {
    const { client: fake, calls } = client(listing());

    await new FyBoardGateway(fake).projects('session-7');

    should(calls[0]?.path).equal('/v1/board/projects');
    should(headersOf(calls[0]?.init)).have.property('x-ferretry-session-id', 'session-7');
  });

  it('should list sessions as an id and a callsign', async () => {
    const { client: fake } = client(null, [
      { config: { id: 'session-7', teammate: 'denisha' } },
      { config: { id: 'session-8' } },
    ]);

    const directory = await new FyBoardGateway(fake).sessions();

    should(directory).eql([
      { id: 'session-7', callsign: 'denisha' },
      { id: 'session-8', callsign: undefined },
    ]);
  });

  it('should not send a request the protocol would refuse', async () => {
    const { client: fake } = client(taskResponse());
    await should(new FyBoardGateway(fake).act('session-7', card().id, { action: 'move' } as never)).be.rejected();
  });
});
