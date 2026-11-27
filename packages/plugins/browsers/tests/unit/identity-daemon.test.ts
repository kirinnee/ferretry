import { afterEach, describe, it } from 'bun:test';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { ferret, type TestHost, testHost } from '@ferretry/kernel/testing';
import should from 'should';
import daemon, { buildBrowsers } from '../../daemon/index.ts';
import { TypedIdentities } from '../../daemon/target/sign-in/identities.ts';
import { Tabs } from '../support/tabs.ts';

const FERRETS = { get: async (id: string) => (id === 'f1' ? { name: id } : undefined) };

/** The daemon half as `build` composes it, with one fake Chrome per identity: what the launcher is asked for is the identity. */
async function built() {
  const chromes = new Map<string, Tabs>();
  const launched: string[] = [];
  const chromeOf = (identity: string): Tabs => {
    let tabs = chromes.get(identity);
    if (tabs === undefined) {
      tabs = new Tabs();
      tabs.idSuffix = `-${identity}`;
      chromes.set(identity, tabs);
    }
    return tabs;
  };
  const identities = new TypedIdentities(() => Date.parse('2026-11-27T10:00:00.000Z'));
  const half = implementDaemon(daemon.manifest, {
    build: ctx =>
      buildBrowsers(ctx, {
        launcher: {
          launch: async (_viewport, identity) => {
            launched.push(identity ?? 'agent');
            return chromeOf(identity ?? 'agent').automation;
          },
        },
        identities,
      }),
  });
  const gate = new StandInAdmission(request =>
    request.arrival.kind === 'local' && request.arrival.privileged ? ferretStanding('f1' as FerretId) : ownerStanding(),
  );
  const host = await testHost({
    plugins: [half],
    uses: { ferrets: FERRETS, agentControl: { allows: async () => true } },
    fakes: { vault: new FakeVault(), gate: new FakeGate() },
    gate,
    secrets: [],
    // `a` and `b` are configured; `old` is a retired identity whose profile folder may still be on disk.
    config: { 'browsers.yaml': { identities: { a: {}, b: {} } } },
  });
  return { host, chromeOf, launched };
}

describe('the browsers daemon half, per identity', () => {
  let host: TestHost | undefined;
  afterEach(async () => {
    await host?.stop();
    host = undefined;
  });

  it('should open a page in the identity browser_open names and list its identity', async () => {
    // Arrange
    const world = await built();
    host = world.host;

    // Act
    const opened = await host.tool('browser_open', { name: 'work', identity: 'b' }, { as: ferret('f1') });
    const listed = await host.tool('browser_list', {}, { as: ferret('f1') });

    // Assert
    should(opened.isError).not.be.true();
    should(world.chromeOf('b').pages.length).be.above(0);
    should(JSON.stringify(listed)).containEql('"identity":"b"');
  });

  it('should leave identity B’s live pages untouched when the login window for A is opened', async () => {
    // Arrange — one page in A, one in B
    const world = await built();
    host = world.host;
    await host.tool('browser_open', { name: 'in-a', identity: 'a' }, { as: ferret('f1') });
    await host.tool('browser_open', { name: 'in-b', identity: 'b' }, { as: ferret('f1') });
    let closedB = false;
    const bChrome = world.chromeOf('b').automation;
    const close = bChrome.close;
    bChrome.close = async () => {
      closedB = true;
      await close();
    };

    // Act — the window cannot really open here (no X server, no VNC), but it closes A's agent browser before it tries
    await host.request('POST', '/v1/browser/login', { query: { identity: 'a' }, body: { action: 'start' } });
    const listed = JSON.stringify(await host.tool('browser_list', {}, { as: ferret('f1') }));

    // Assert — A's page is gone, B's is still listed and B's Chrome was never closed
    should(listed).containEql('in-b');
    should(listed).not.containEql('in-a');
    should(closedB).equal(false);
  });

  it('should refuse browser_open for an identity the configuration does not name, before any Chrome starts', async () => {
    // Arrange
    const world = await built();
    host = world.host;

    // Act
    const opened = await host.tool('browser_open', { name: 'x', identity: 'old' }, { as: ferret('f1') });
    const listed = JSON.stringify(await host.tool('browser_list', {}, { as: ferret('f1') }));

    // Assert
    should(opened.isError).be.true();
    should(JSON.stringify(opened)).containEql('old');
    should(world.launched).deepEqual([]);
    should(listed).not.containEql('"identity":"old"');
  });

  it('should refuse every login route for an identity the configuration does not name', async () => {
    // Arrange
    const world = await built();
    host = world.host;

    // Act
    const read = await host.request('GET', '/v1/browser/login', { query: { identity: 'old' } });
    const started = await host.request('POST', '/v1/browser/login', {
      query: { identity: 'old' },
      body: { action: 'start' },
    });
    const confirmed = await host.request('POST', '/v1/browser/login', {
      query: { identity: 'old' },
      body: { action: 'confirm' },
    });

    // Assert — a refusal in words, and the built-in identity's window is still answered
    for (const answered of [read, started, confirmed]) should(answered.status).equal(400);
    should(JSON.stringify(read.body)).containEql('no browser identity named old');
    should((await host.request('GET', '/v1/browser/login', { query: { identity: 'a' } })).status).equal(200);
    should((await host.request('GET', '/v1/browser/login')).status).equal(200);
  });

  it('should refuse a login window for something that is no identity key', async () => {
    // Arrange
    const world = await built();
    host = world.host;

    // Act
    const answered = await host.request('GET', '/v1/browser/login', { query: { identity: '../agent' } });

    // Assert
    should(answered.status).equal(400);
  });
});
