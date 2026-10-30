import { describe, it } from 'bun:test';
import type { IFyApiClient } from '@ferretry/protocol';
import should from 'should';
import { FyLaneGateway } from '../../../src/adapters/board-lanes/fy-lane-gateway';
import { FERRETRY_ID, laneSet, listing, project } from './fixtures';

const client = (answer: unknown) => {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const request = ((path: string, schema: { parse(value: unknown): unknown }, init?: RequestInit) => {
    calls.push({ path, init });
    return Promise.resolve(schema.parse(answer));
  }) as unknown as IFyApiClient['request'];
  return { calls, client: { request } };
};

describe('the lane gateway', () => {
  it('should read the project list', async () => {
    const { client: fake, calls } = client(listing());
    should((await new FyLaneGateway(fake).projects()).projects).have.length(2);
    should(calls[0]).eql({ path: '/v1/board/projects', init: undefined });
  });

  it('should read one project by its id', async () => {
    const { client: fake, calls } = client(project());
    await new FyLaneGateway(fake).project(FERRETRY_ID as never);
    should(calls[0]?.path).equal(`/v1/board/projects/${FERRETRY_ID}/lanes`);
  });

  it('should post a lane change as JSON', async () => {
    const { client: fake, calls } = client({ laneSet: laneSet(), agenda: 'raised' });
    await new FyLaneGateway(fake).change(FERRETRY_ID as never, { action: 'propose', template: 'pr', renames: {} });
    should(calls[0]?.init?.method).equal('POST');
    should(JSON.parse(String(calls[0]?.init?.body))).eql({ action: 'propose', template: 'pr', renames: {} });
  });
});
