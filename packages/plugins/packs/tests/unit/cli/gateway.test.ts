import { describe, it } from 'bun:test';
import should from 'should';
import { ClientPackGateway, type PackClient } from '../../../cli/lib/gateway.ts';
import { packView, recommendation, started, at } from './fixtures.ts';

type Call = { route: string; init?: Parameters<PackClient['call']>[1] };

function build(answer: unknown) {
  const calls: Call[] = [];
  const client: PackClient = {
    call: async <T>(route: string, init?: Parameters<PackClient['call']>[1]) => {
      calls.push({ route, ...(init === undefined ? {} : { init }) });
      return answer as T;
    },
  };
  return { gateway: new ClientPackGateway(client), calls };
}

describe('ClientPackGateway clean-up', () => {
  it('should read the inventory and a run, and post a clean-up, an accept and an undo', async () => {
    // Arrange
    const { gateway, calls } = build({});
    const suggested = { by: 'opus', via: 'claude-work', at: at('2026-10-22T12:00:00.000Z') };

    // Act: each answer is parsed, so an empty one is refused after the call was made
    await gateway.inventory().catch(() => undefined);
    await gateway.cleanUp({ prompt: 'rough', runtime: 'claude-work' }).catch(() => undefined);
    await gateway.job('run 1').catch(() => undefined);
    await gateway.accept({ prompt: 'clean', suggested }).catch(() => undefined);
    await gateway.undo().catch(() => undefined);

    // Assert
    should(calls).eql([
      { route: 'GET /v1/pack/inventory' },
      { route: 'POST /v1/pack/routing/clean-up', init: { body: { prompt: 'rough', runtime: 'claude-work' } } },
      { route: 'GET /v1/pack/routing/jobs/:jobId', init: { params: { jobId: 'run 1' } } },
      { route: 'POST /v1/pack/routing/accept', init: { body: { prompt: 'clean', suggested } } },
      { route: 'POST /v1/pack/routing/undo', init: { body: {} } },
    ]);
  });
});

describe('ClientPackGateway', () => {
  it('should GET the Pack view and parse it with the view schema', async () => {
    // Arrange
    const { gateway, calls } = build(packView());

    // Act
    const answer = await gateway.view();

    // Assert
    should(answer).eql(packView());
    should(calls).eql([{ route: 'GET /v1/pack' }]);
  });

  it('should refuse an answer the schema does not recognise', async () => {
    // Arrange
    const { gateway } = build({ routing: 'nope' });

    // Act
    const failure = await gateway.view().then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.instanceOf(Error);
  });

  it('should POST the recommend request and parse the answer with the recommendation schema', async () => {
    // Arrange
    const { gateway, calls } = build(recommendation());

    // Act
    const answer = await gateway.recommend({ task: 'rename' });

    // Assert
    should(answer).eql(recommendation());
    should(calls).eql([{ route: 'POST /v1/pack/recommend', init: { body: { task: 'rename' } } }]);
  });

  it('should POST a start and parse the outcome', async () => {
    // Arrange
    const { gateway, calls } = build(started());

    // Act
    const answer = await gateway.newChild({ task: 'x', runtime: 'claude-work' });

    // Assert
    should(answer.outcome).equal('started');
    should(calls).eql([{ route: 'POST /v1/pack/new', init: { body: { task: 'x', runtime: 'claude-work' } } }]);
  });

  it('should GET a result and a pack table at the ferret path', async () => {
    // Arrange
    const result = { id: 'a/b', state: 'stopped', finished: true, summary: 'done' };
    const one = build(result);
    const two = build({ root: { id: 'a/b', name: 'a' }, at: at('2026-11-03T12:00:00.000Z'), endedWindowMs: 7_200_000, rows: [] });

    // Act
    const answer = await one.gateway.result('a/b');
    const table = await two.gateway.table('a/b');

    // Assert
    should(answer).eql(result);
    should(one.calls).eql([{ route: 'GET /v1/ferrets/:ferretId/result', init: { params: { ferretId: 'a/b' } } }]);
    should(table.rows).eql([]);
    should(two.calls).eql([{ route: 'GET /v1/ferrets/:ferretId/pack', init: { params: { ferretId: 'a/b' } } }]);
  });

  it('should stop a ferret with the reason', async () => {
    // Arrange
    const { gateway, calls } = build(undefined);

    // Act
    await gateway.stop('child-1', 'its result was collected');

    // Assert
    should(calls).eql([
      {
        route: 'POST /v1/ferrets/:ferretId/stop',
        init: { params: { ferretId: 'child-1' }, body: { reason: 'its result was collected' } },
      },
    ]);
  });
});
