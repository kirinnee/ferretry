import { afterEach, describe, it } from 'bun:test';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { ferret, type TestHost, testHost } from '@ferretry/kernel/testing';
import should from 'should';
import { BrowserIdentitiesViewSchema } from '../../contract/index.ts';
import daemon, { buildBrowsers } from '../../daemon/index.ts';
import { Tabs } from '../support/tabs.ts';

const FERRETS = { get: async (id: string) => (id === 'f1' ? { name: id } : undefined) };

/** Synthetic identities: `work` has a proxy of its own that signs in with secret references, `docs` has none. */
const CONFIG = {
  proxy: { url: 'https://machine-proxy.example.test:8443' },
  identities: {
    work: {
      proxy: {
        url: 'http://work-proxy.example.test:8080',
        username: '${secret:WORK_PROXY_USER}',
        password: '${secret:WORK_PROXY_PASS}',
      },
    },
    docs: {},
  },
};

interface Row {
  readonly identity: string;
  readonly running: boolean;
  readonly starting?: boolean;
  readonly startedAt?: string;
  readonly proxy?: unknown;
  readonly liveProxy?: unknown;
}
/** The rows an answer carries: the daemon answers JSON text. */
const rowsOf = (answered: { body: unknown }): readonly Row[] =>
  (JSON.parse(answered.body as string) as { identities: Row[] }).identities;

async function built(config: unknown = CONFIG, hold?: { readonly until: Promise<void>; readonly entered: () => void }) {
  const chromes = new Map<string, Tabs>();
  const closed: string[] = [];
  const chromeOf = (identity: string): Tabs => {
    let tabs = chromes.get(identity);
    if (tabs === undefined) {
      tabs = new Tabs();
      tabs.idSuffix = `-${identity}`;
      const close = tabs.automation.close;
      tabs.automation.close = async () => {
        closed.push(identity);
        await close();
      };
      chromes.set(identity, tabs);
    }
    return tabs;
  };
  const half = implementDaemon(daemon.manifest, {
    build: ctx =>
      buildBrowsers(ctx, {
        launcher: {
          launch: async (_viewport, identity) => {
            if (hold !== undefined) {
              hold.entered();
              await hold.until;
            }
            return chromeOf(identity ?? 'agent').automation;
          },
        },
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
    config: { 'browsers.yaml': config },
  });
  return { host, closed };
}

describe('GET /v1/browser/identities and the stop of one identity', () => {
  let host: TestHost | undefined;
  afterEach(async () => {
    await host?.stop();
    host = undefined;
  });

  it('should list the real identities, built-in first, with the proxy each goes through by name only', async () => {
    // Arrange
    host = (await built()).host;

    // Act
    const answered = await host.request('GET', '/v1/browser/identities');

    // Assert
    should(answered.status).equal(200);
    const rows = rowsOf(answered);
    should(rows.map(row => row.identity)).deepEqual(['agent', 'work', 'docs']);
    should(rows.map(row => row.running)).deepEqual([false, false, false]);
    should(rows[0]?.proxy).deepEqual({ name: 'machine-proxy.example.test:8443', own: false });
    should(rows[1]?.proxy).deepEqual({ name: 'work-proxy.example.test:8080', own: true });
    should(JSON.stringify(answered.body)).not.containEql('WORK_PROXY');
    should(JSON.stringify(answered.body)).not.containEql('secret');
  });

  it('should show which identity runs once a page is open in it', async () => {
    // Arrange
    const world = await built();
    host = world.host;
    await host.tool('browser_open', { name: 'in-work', identity: 'work' }, { as: ferret('f1') });

    // Act
    const rows = rowsOf(await host.request('GET', '/v1/browser/identities'));

    // Assert
    should(rows.map(row => [row.identity, row.running])).deepEqual([
      ['agent', false],
      ['work', true],
      ['docs', false],
    ]);
    should(rows[1]?.startedAt).be.a.String();
  });

  it('should stop only the identity named and keep every other identity’s pages live', async () => {
    // Arrange
    const world = await built();
    host = world.host;
    await host.tool('browser_open', { name: 'in-work', identity: 'work' }, { as: ferret('f1') });
    await host.tool('browser_open', { name: 'in-docs', identity: 'docs' }, { as: ferret('f1') });

    // Act
    const stopped = await host.request('POST', '/v1/browser/identities/work/stop');
    const listed = JSON.stringify(await host.tool('browser_list', {}, { as: ferret('f1') }));
    const rows = rowsOf(await host.request('GET', '/v1/browser/identities'));

    // Assert
    should(stopped.status).equal(200);
    should(world.closed).deepEqual(['work']);
    should(listed).containEql('in-docs');
    should(listed).not.containEql('in-work');
    should(rows.map(row => [row.identity, row.running])).deepEqual([
      ['agent', false],
      ['work', false],
      ['docs', true],
    ]);
  });

  it('should refuse to stop an identity the configuration does not name', async () => {
    // Arrange
    const world = await built();
    host = world.host;

    // Act
    const answered = await host.request('POST', '/v1/browser/identities/old/stop');
    const inherited = await host.request('POST', '/v1/browser/identities/constructor/stop');

    // Assert
    should(answered.status).equal(404);
    should(JSON.stringify(answered.body)).containEql('no browser identity named old');
    should(inherited.status).equal(404);
    should(world.closed).deepEqual([]);
  });

  it('should report the launch proxy while a saved proxy change waits for a restart', async () => {
    const world = await built({ identities: { docs: {} } });
    host = world.host;
    await host.tool('browser_open', { name: 'direct', identity: 'docs' }, { as: ferret('f1') });
    // The stand-in launcher started direct. A later config change cannot reroute that Chrome.
    host.setConfig('browsers.yaml', {
      ...CONFIG,
      identities: {
        ...CONFIG.identities,
        docs: { proxy: { url: 'http://next-proxy.example.test:8080' } },
      },
    });
    const rows = rowsOf(await host.request('GET', '/v1/browser/identities'));
    const docs = rows.find(row => row.identity === 'docs');
    should(docs?.running).be.true();
    should(docs?.liveProxy).equal(null);
    should(docs?.proxy).deepEqual({ name: 'next-proxy.example.test:8080', own: true });
  });

  it('should report a launch in progress as starting, never running, with no live proxy while its egress is unknown', async () => {
    // Arrange: a direct launch that is paused, then a config change that adds a proxy.
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const until = new Promise<void>(resolve => {
      release = resolve;
    });
    const launching = new Promise<void>(resolve => {
      entered = resolve;
    });
    const world = await built({ identities: { docs: {} } }, { until, entered });
    host = world.host;
    const opening = host.tool('browser_open', { name: 'direct', identity: 'docs' }, { as: ferret('f1') });
    await launching;
    host.setConfig('browsers.yaml', {
      ...CONFIG,
      identities: { ...CONFIG.identities, docs: { proxy: { url: 'http://next-proxy.example.test:8080' } } },
    });

    // Act
    const duringAnswer = await host.request('GET', '/v1/browser/identities');
    const during = rowsOf(duringAnswer).find(row => row.identity === 'docs');
    release();
    await opening;
    const after = rowsOf(await host.request('GET', '/v1/browser/identities')).find(row => row.identity === 'docs');

    // Assert
    should(BrowserIdentitiesViewSchema.safeParse(JSON.parse(duringAnswer.body as string)).success).be.true();
    should(during?.starting).be.true();
    should(during?.running).be.false();
    should(during?.liveProxy).be.undefined();
    should(during?.startedAt).be.undefined();
    should(after?.running).be.true();
    should(after?.starting).be.undefined();
    should(after?.liveProxy).equal(null);
  });
});
