import { describe, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import type { IFyApiClient } from '@ferretry/protocol';
import should from 'should';
import { FyWorkSearchGateway } from '../../../src/adapters/work-search/fy-work-search-gateway';
import { listing, FERRETRY_ID } from '../../unit/board/fixtures';
import { agendaHit, response, taskHit } from '../../unit/work-search/fixtures';

const client = (answer: unknown) => {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const request = ((path: string, schema: { parse(value: unknown): unknown }, init?: RequestInit) => {
    calls.push({ path, init });
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(schema.parse(answer));
  }) as unknown as IFyApiClient['request'];
  const list = (() => Promise.resolve([])) as unknown as IFyApiClient['list'];
  return { calls, client: { request, list } };
};

const headersOf = (init: RequestInit | undefined): Record<string, string> =>
  Object.fromEntries(new Headers(init?.headers).entries());

describe('the work-search gateway', () => {
  it('should search with the query in the URL, leaving out what was not asked, as the acting session', async () => {
    const { client: fake, calls } = client(response([taskHit(), agendaHit()]));

    const answer = await new FyWorkSearchGateway(fake).search(
      { q: 'relay choice', kind: 'agenda', open: true, limit: 5 },
      'session-7',
    );

    should(answer.hits).have.length(2);
    should(calls[0]?.path).equal('/v1/search?q=relay+choice&kind=agenda&open=true&limit=5');
    should(headersOf(calls[0]?.init)).containEql({ 'x-ferretry-session-id': 'session-7', 'x-ferretry-client': 'cli' });
  });

  it('should search with the bare query and no session header for the owner', async () => {
    const { client: fake, calls } = client(response([]));

    await new FyWorkSearchGateway(fake).search({ q: 'x', open: false }, undefined);

    should(calls[0]?.path).equal('/v1/search?q=x');
    should(headersOf(calls[0]?.init)).not.have.property('x-ferretry-session-id');
  });

  it('should carry the project and the limit, and read the project list and the session directory', async () => {
    const { client: fake, calls } = client(response([]));

    await new FyWorkSearchGateway(fake).search(
      { q: 'x', open: false, project: FERRETRY_ID as never, limit: 3 },
      undefined,
    );
    should(calls[0]?.path).equal(`/v1/search?q=x&project=${FERRETRY_ID}&limit=3`);

    const projects = client(listing());
    await new FyWorkSearchGateway(projects.client).projects('session-7');
    should(projects.calls[0]?.path).equal('/v1/board/projects');
    should(headersOf(projects.calls[0]?.init)).containEql({ 'x-ferretry-session-id': 'session-7' });

    const listed = {
      request: fake.request,
      list: (() =>
        Promise.resolve([{ config: { id: 's1', teammate: 'adrienne' } }])) as unknown as IFyApiClient['list'],
    };
    should(await new FyWorkSearchGateway(listed).sessions()).deepEqual([{ id: 's1', callsign: 'adrienne' }]);
  });

  it('should post the related check as JSON', async () => {
    const { client: fake, calls } = client({ matches: [{ strength: 'strong', hit: taskHit() }] });

    const answer = await new FyWorkSearchGateway(fake).related({ kind: 'task', title: 'Work search' }, 'session-7');

    should(answer?.matches[0]?.strength).equal('strong');
    should(calls[0]?.path).equal('/v1/search/related');
    should(calls[0]?.init?.method).equal('POST');
    should(JSON.parse(String(calls[0]?.init?.body))).eql({ kind: 'task', title: 'Work search' });
    should(headersOf(calls[0]?.init)).have.property('content-type', 'application/json');
  });

  it('should answer nothing, not fail, when the daemon has no related check (404)', async () => {
    const { client: fake } = client(new FyHttpError('not found', 404, 'not-found'));

    should(await new FyWorkSearchGateway(fake).related({ kind: 'task', title: 'x' }, undefined)).be.undefined();
  });

  it('should let any other failure through', async () => {
    const { client: fake } = client(new FyHttpError('boom', 500, 'internal'));

    await should(new FyWorkSearchGateway(fake).related({ kind: 'task', title: 'x' }, undefined)).be.rejected();
  });
});
