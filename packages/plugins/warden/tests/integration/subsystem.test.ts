import { describe, it } from 'bun:test';
import should from 'should';
import { FakeAsks, entryId, sourceKey } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId, T0 } from '@ferretry/core-ferrets/contract/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import type { ApiRequest, CallContext, ConfigWriteOutcome } from '@ferretry/kernel/contract';
import { WardenFlagSchema } from '../../contract/index.ts';
import { wardenRoutes } from '../../daemon/routes.ts';
import { createWardenSubsystem } from '../../daemon/subsystem.ts';
import { fakeKernel, wardenConfig } from '../support/kernel.ts';

const call = (method: string, path: string, body?: unknown, query: Record<string, string> = {}): CallContext => ({
  request: {
    method,
    path,
    query: new Map(Object.entries(query).map(([key, value]) => [key, [value]])),
    headers: new Map(),
    arrival: { kind: 'carried', carrier: 'relay' },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as ApiRequest,
  params: new Map(),
});

function warden(options: { readonly config?: unknown; readonly written?: ConfigWriteOutcome } = {}) {
  const config = wardenConfig(options.config);
  const written = options.written;
  const port =
    written === undefined ? config : Object.assign(config, { write: async () => written, remove: async () => written });
  const fake = fakeKernel({ config: port, start: '2026-11-07T12:00:00.000Z' });
  const ferrets = new FakeFerrets();
  const conversation = fakeConversation();
  const asks = new FakeAsks();
  const subsystem = createWardenSubsystem({
    kernel: fake.kernel,
    ferrets,
    conversation,
    asks,
    usage: () => undefined,
    board: () => undefined,
  });
  return { ...fake, ferrets, conversation, asks, subsystem, routes: wardenRoutes(subsystem) };
}

/**
 * A helper that asked a question nobody has answered: the one trouble Ferrets and Asks can show together. It was
 * started in `auto` mode: a ferret with no recorded mode is read as a person's terminal, which the sweep never flags.
 */
async function ask(world: ReturnType<typeof warden>, id: string): Promise<void> {
  world.ferrets.add({ id: ferretId(id), parent: ferretId('lead'), mode: 'auto', state: 'idle', stateAt: T0 });
  await world.asks.raise({
    source: sourceKey('ferret'),
    entry: entryId(`${id}-q`),
    ref: {},
    kind: 'yesno',
    subject: 'Ship it?',
    why: 'it needs a decision',
    raisedBy: { kind: 'ferret', ferret: id },
    ferret: id,
  });
}

const json = (response: { body: string }): any => JSON.parse(response.body);

describe('the warden over the ports it is handed', () => {
  it('should answer a sweep of an empty machine with no flags and a time', async () => {
    // Arrange
    const { routes } = warden();

    // Act
    const response = await routes['POST /v1/warden/run'](call('POST', '/v1/warden/run'));

    // Assert
    should(response.status).equal(200);
    should(json(response).flags).eql([]);
    should(typeof json(response).sweptAt).equal('string');
  });

  it('should flag a question nobody answered, in the contract words, and say so on status too', async () => {
    // Arrange
    const world = warden();
    await ask(world, 'f1');
    await world.clock.advance(3 * 60 * 60 * 1000);

    // Act
    const run = json(await world.routes['POST /v1/warden/run'](call('POST', '/v1/warden/run')));
    const status = json(await world.routes['GET /v1/warden/status'](call('GET', '/v1/warden/status')));

    // Assert
    should(run.flags.map((flag: { kind: string; ferret: string }) => [flag.kind, flag.ferret])).eql([
      ['unattended_question', 'f1'],
    ]);
    for (const flag of run.flags) should(WardenFlagSchema.safeParse(flag).success).equal(true);
    should(status.flags.length).equal(1);
    should(JSON.stringify(status)).not.containEql('sessionId');
    should(world.published.filter(entry => entry.event === 'warden.flagged').length).equal(1);
  });

  it('should never start an investigator or call the guard model on a run, however it is asked', async () => {
    // Arrange: both triage layers on, a flagged ferret, and the owner asking for a spawn.
    const world = warden({ config: { layers: { jev: true, llm: true }, caps: { investigationUsdPerDay: 50 } } });
    await ask(world, 'f1');
    await world.clock.advance(3 * 60 * 60 * 1000);
    const before = (await world.ferrets.list()).length;

    // Act
    const response = await world.routes['POST /v1/warden/run'](call('POST', '/v1/warden/run', { spawn: true }));

    // Assert: no ferret was started and nothing was stopped; the kernel fake has no fetch, so no request could be made.
    should(response.status).equal(200);
    should(json(response).spawned).be.undefined();
    should((await world.ferrets.list()).length).equal(before);
    should((await world.ferrets.list()).every(ferret => ferret.state !== 'stopped')).equal(true);
  });

  it('should raise its notice as an ask once and leave it alone on the next sweep', async () => {
    // Arrange
    const world = warden();
    await ask(world, 'f1');
    await world.clock.advance(3 * 60 * 60 * 1000);

    // Act
    await world.routes['POST /v1/warden/run'](call('POST', '/v1/warden/run'));
    const first = (await world.asks.open({ source: sourceKey('daemon') })).length;
    await world.routes['POST /v1/warden/run'](call('POST', '/v1/warden/run'));
    const second = (await world.asks.open({ source: sourceKey('daemon') })).length;

    // Assert
    should(second).equal(first);
  });

  it('should refuse a report path that leaves the reports folder and a request with no path', async () => {
    // Arrange
    const { routes } = warden();

    // Act
    const missing = routes['GET /v1/warden/report'](call('GET', '/v1/warden/report'));
    const escaping = await routes['GET /v1/warden/report'](
      call('GET', '/v1/warden/report', undefined, { path: '../../state.json' }),
    ).catch((error: { status: number }) => error);

    // Assert
    await missing.then(
      () => should.fail('', '', 'a path is required'),
      (error: { status: number }) => should(error.status).equal(400),
    );
    should((escaping as { status: number }).status).equal(404);
  });

  it('should answer a config change the kernel refused as invalid_request, in its words', async () => {
    // Arrange
    const { routes } = warden({
      written: {
        kind: 'refused',
        reason: 'schema',
        issues: [{ path: 'warden.yaml', message: 'enabled must be true or false' }],
      },
    });

    // Act
    const patch = routes['PATCH /v1/warden/config'](call('PATCH', '/v1/warden/config', { enabled: false }));

    // Assert
    await patch.then(
      () => should.fail('', '', 'should have refused'),
      (error: { status: number; code: string; message: string }) => {
        should(error.status).equal(400);
        should(error.code).equal('invalid_request');
        should(error.message).containEql('enabled must be true or false');
      },
    );
  });

  it('should refuse to investigate a ferret it does not know', async () => {
    // Arrange
    const { routes } = warden();

    // Act
    const asking = routes['POST /v1/warden/investigate'](call('POST', '/v1/warden/investigate', { ferret: 'nobody' }));

    // Assert
    await asking.then(
      () => should.fail('', '', 'should have refused'),
      (error: { status: number }) => should([404, 409]).containEql(error.status),
    );
  });

  it('should remember a ferret left alone and show it on status', async () => {
    // Arrange
    const world = warden();
    await ask(world, 'f1');
    await world.clock.advance(3 * 60 * 60 * 1000);
    await world.routes['POST /v1/warden/run'](call('POST', '/v1/warden/run'));

    // Act
    const left = await world.routes['POST /v1/warden/leave'](
      call('POST', '/v1/warden/leave', { ferret: 'f1', duration: '1h' }),
    );
    const status = json(await world.routes['GET /v1/warden/status'](call('GET', '/v1/warden/status')));

    // Assert
    should(left.status).equal(200);
    should(status.blessings.map((blessing: { ferret: string }) => blessing.ferret)).eql(['f1']);
  });
});
