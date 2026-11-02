import { describe, it } from 'bun:test';
import type { IFyApiClient, TidyPlan } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import { FyTidyGateway } from '../../../src/adapters/tidy/fy-tidy-gateway';

const PLAN: TidyPlan = { v: 1, sessionId: 'session-7', subFerret: false, drop: [], close: [], keep: [] };

const client = (answer: unknown) => {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const request = ((path: string, schema: { parse(value: unknown): unknown }, init?: RequestInit) => {
    calls.push({ path, init });
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(schema.parse(answer));
  }) as unknown as IFyApiClient['request'];
  return { calls, client: { request } };
};

const headersOf = (init: RequestInit | undefined): Record<string, string> =>
  Object.fromEntries(new Headers(init?.headers).entries());

describe('the tidy gateway', () => {
  it('should post to the plan route as the acting session and parse the plan', async () => {
    // Arrange
    const { client: fake, calls } = client(PLAN);

    // Act
    const plan = await new FyTidyGateway(fake).plan('session-7');

    // Assert
    should(plan).deepEqual(PLAN);
    should(calls[0]?.path).equal('/v1/tidy/plan');
    should(calls[0]?.init?.method).equal('POST');
    should(headersOf(calls[0]?.init)).containEql({ 'x-ferretry-session-id': 'session-7', 'x-ferretry-client': 'cli' });
  });

  it('should send no session header when there is no acting session', async () => {
    // Arrange
    const { client: fake, calls } = client(PLAN);

    // Act
    await new FyTidyGateway(fake).plan(undefined);
    await new FyTidyGateway(fake).plan('');

    // Assert
    should(headersOf(calls[0]?.init)).not.have.property('x-ferretry-session-id');
    should(headersOf(calls[1]?.init)).not.have.property('x-ferretry-session-id');
  });

  it('should answer undefined when the daemon has no such route, and pass other failures on', async () => {
    // Arrange
    const missing = client(new FyHttpError('not found', 404, 'not-found'));
    const broken = client(new FyHttpError('boom', 500, 'internal'));
    const other = client(new Error('offline'));

    // Act
    const answer = await new FyTidyGateway(missing.client).plan('s');

    // Assert
    should(answer).be.undefined();
    await new FyTidyGateway(broken.client).plan('s').should.be.rejected();
    await new FyTidyGateway(other.client).plan('s').should.be.rejected();
  });
});
