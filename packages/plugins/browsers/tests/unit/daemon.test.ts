import { afterEach, describe, it } from 'bun:test';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { AgentControlKind, AgentControlReader, FerretId } from '@ferretry/kernel/contract';
import { implementDaemon, type Needer } from '@ferretry/kernel/manifest';
import { fakeRuntimes, type FakeRuntimes } from '@ferretry/plugin-runtimes/contract/testing';
import { ferret, type TestCaller, type TestHost, testHost } from '@ferretry/kernel/testing';
import should from 'should';
import { BrowsersPort } from '../../contract/port.ts';
import daemon, { buildBrowsers } from '../../daemon/index.ts';
import type { LoopbackMarkerReader } from '../../daemon/proxy/firewall/state.ts';
import type { LoopbackFirewallMarker } from '../../daemon/proxy/wire/ports.ts';
import { TypedIdentities } from '../../daemon/target/sign-in/identities.ts';
import { Tabs } from '../support/tabs.ts';

/** A vault secret the stand-in redaction masks. */
const SECRET = 'hunter2-token';

/** The owner's switches with every kind on (the fixture default); a test names the kinds it leaves off. */
const ALL_ON: AgentControlReader = { allows: async () => true };
const only = (...on: readonly AgentControlKind[]): AgentControlReader => ({
  allows: async (_ferret, kind) => on.includes(kind),
});

/** The ferrets Browsers knows of: a page belongs to one, and a call about any other is refused. */
const FERRETS = { get: async (id: string) => (id === 'f1' || id === 'f2' ? { name: id } : undefined) };

/**
 * The daemon half exactly as `build` composes it, over a fake agent browser and a ledger the test can read. Gate's
 * stand-in admission stamps the standing a real daemon gives: a ferret's own token (the test host's privileged local
 * arrival, for the ferret `as` last named) or the owner's admin token.
 */
let calling = 'f1' as FerretId;
const as = (id: string): { readonly as: TestCaller } => {
  calling = id as FerretId;
  return { as: ferret(id) };
};

async function built(
  control: AgentControlReader | null = ALL_ON,
): Promise<{ host: TestHost; tabs: Tabs; identities: TypedIdentities; vault: FakeVault }> {
  const vault = new FakeVault();
  const tabs = new Tabs();
  const identities = new TypedIdentities(() => Date.parse('2026-11-07T10:00:00.000Z'));
  const half = implementDaemon(daemon.manifest, {
    build: ctx => buildBrowsers(ctx, { launcher: { launch: async () => tabs.automation }, identities }),
  });
  const gate = new StandInAdmission(request =>
    request.arrival.kind === 'local' && request.arrival.privileged ? ferretStanding(calling) : ownerStanding(),
  );
  const host = await testHost({
    plugins: [half],
    uses: { ferrets: FERRETS, ...(control === null ? {} : { agentControl: control }) },
    fakes: { vault, gate: new FakeGate() },
    gate,
    secrets: [SECRET],
  });
  return { host, tabs, identities, vault };
}

/** A needer of the Browsers port, named as the kernel names the plugin that asks. */
const needer = (id: string): Needer => ({
  id,
  permissions: { network: [], spawn: [], secrets: [] } as unknown as Needer['permissions'],
  ownedSecretReferences: () => new Set(),
});

/**
 * The daemon half over a Runtimes that serves the machine's ports (or none), with the marker and the uid it judges them
 * by stood in, so no test reads `/run` or depends on who runs it. No marker by default.
 */
async function firewallHost(
  runtimes: FakeRuntimes | undefined,
  seams: { readonly marker?: LoopbackMarkerReader; readonly uid?: () => number | undefined } = {},
): Promise<TestHost> {
  const half = implementDaemon(daemon.manifest, {
    build: ctx => buildBrowsers(ctx, { marker: { read: async () => undefined }, uid: () => 1000, ...seams }),
  });
  return await testHost({
    plugins: [half],
    uses: runtimes === undefined ? {} : { runtimes },
    fakes: { vault: new FakeVault(), gate: new FakeGate() },
  });
}

/**
 * The daemon half as the kernel builds it: every route, socket and tool the manifest declares has its handler, and
 * building it starts nothing — no Chrome, no worker thread, no timer — until a page is opened.
 */
describe('the browsers daemon half', () => {
  let host: TestHost | undefined;
  afterEach(async () => {
    await host?.stop();
    host = undefined;
  });

  it('should build over the test host and answer the machine browser state with nothing running', async () => {
    // Arrange
    host = await testHost({ plugins: [daemon], fakes: { vault: new FakeVault(), gate: new FakeGate() } });

    // Act
    const state = await host.request('GET', '/v1/browser/state');

    // Assert
    should(state.status).equal(200);
    should(state.json()).containEql({ state: 'stopped' });
  });

  it('should offer the browserPorts fact to Logins alone, so no other needer is told whether the host shares its ports', async () => {
    // Arrange
    const runtimes = fakeRuntimes();
    host = await firewallHost(runtimes);

    // Act
    const forLogins = host.provided(BrowsersPort, needer('logins'));
    const forOthers = host.provided(BrowsersPort, needer('accounts'));

    // Assert
    should(typeof forLogins.browserPorts).equal('function');
    should(forOthers.browserPorts).be.undefined();
    should(typeof forOthers.pagesOf).equal('function');
  });

  it('should say the host is not shared while the machine’s ports are random, and shared for per-user and explicit ports', async () => {
    // Arrange
    const runtimes = fakeRuntimes();
    host = await firewallHost(runtimes);
    const logins = host.provided(BrowsersPort, needer('logins'));

    // Act
    const random = await logins.browserPorts?.();
    runtimes.setMachineBrowserPorts({ browserPorts: 'per-user', browserFirewallFailure: 'warn' });
    const perUser = await logins.browserPorts?.();
    runtimes.setMachineBrowserPorts({
      browserPorts: { cdp: 9300, relay: 9301, vnc: 5901 },
      browserFirewallFailure: 'warn',
    });
    const explicit = await logins.browserPorts?.();

    // Assert — read live on every ask, never kept.
    should(random).deepEqual({ shared: false });
    should(perUser).deepEqual({ shared: true });
    should(explicit).deepEqual({ shared: true });
  });

  it('should say the host is shared when Runtimes is off or cannot say (fails closed)', async () => {
    // Arrange
    const runtimes = fakeRuntimes();
    runtimes.machineBrowserPorts = async () => {
      throw new Error('the catalogue cannot be opened');
    };
    const unreadable = await firewallHost(runtimes);
    const off = await firewallHost(undefined);

    // Act
    const whenUnreadable = await unreadable.provided(BrowsersPort, needer('logins')).browserPorts?.();
    const whenOff = await off.provided(BrowsersPort, needer('logins')).browserPorts?.();
    await unreadable.stop();
    host = off;

    // Assert
    should(whenUnreadable).deepEqual({ shared: true });
    should(whenOff).deepEqual({ shared: true });
  });

  it('should say nothing in the loopback-firewall doctor row while the machine’s ports are random, and read no marker', async () => {
    // Arrange
    const runtimes = fakeRuntimes();
    let markerReads = 0;
    host = await firewallHost(runtimes, {
      marker: {
        read: async () => {
          markerReads += 1;
          return undefined;
        },
      },
    });

    // Act
    const finding = await host.doctor('browsers', 'loopback-firewall');

    // Assert
    should(finding).be.undefined();
    should(markerReads).equal(0);
  });

  it('should warn in the doctor row, with the remedy for this uid, when the ports are fixed and no rule is installed', async () => {
    // Arrange
    const runtimes = fakeRuntimes();
    runtimes.setMachineBrowserPorts({ browserPorts: 'per-user', browserFirewallFailure: 'warn' });
    host = await firewallHost(runtimes, { uid: () => 1001 });

    // Act
    const finding = await host.doctor('browsers', 'loopback-firewall');

    // Assert
    should(finding).containEql({ name: 'loopback firewall', requirement: 'capability', state: 'warn' });
    should(finding?.fix).containEql('add `user 1001` to /etc/ferretry/loopback-firewall.conf');
  });

  it('should show the marker’s verdict for this uid in the doctor row: applied is ok, a failed check is a warning, and it is read afresh', async () => {
    // Arrange
    const runtimes = fakeRuntimes();
    runtimes.setMachineBrowserPorts({ browserPorts: 'per-user', browserFirewallFailure: 'warn' });
    let marker: LoopbackFirewallMarker | undefined;
    host = await firewallHost(runtimes, { uid: () => 1001, marker: { read: async () => marker } });
    const fresh = host.clock.now();
    const listed = [{ uid: 1001, ports: [20004, 20005, 20006] as [number, number, number] }];
    const written = { version: 1 as const, appliedAt: fresh, base: 20000, entries: listed, verifiedAt: fresh };

    // Act
    marker = { ...written, perUser: { '1001': 'ok' } };
    const applied = await host.doctor('browsers', 'loopback-firewall');
    marker = { ...written, perUser: { '1001': 'failed' } };
    const failed = await host.doctor('browsers', 'loopback-firewall');

    // Assert
    should(applied).containEql({ state: 'ok', detail: 'applied' });
    should(failed).containEql({
      state: 'warn',
      detail: 'the last check reached this account’s ports from another user',
    });
  });

  it('should say nothing in the doctor row on a host with no uids, or when Runtimes is off', async () => {
    // Arrange
    const runtimes = fakeRuntimes();
    runtimes.setMachineBrowserPorts({ browserPorts: 'per-user', browserFirewallFailure: 'warn' });
    const noUids = await firewallHost(runtimes, { uid: () => undefined });
    const off = await firewallHost(undefined, { uid: () => 1001 });

    // Act
    const withoutUids = await noUids.doctor('browsers', 'loopback-firewall');
    const withoutRuntimes = await off.doctor('browsers', 'loopback-firewall');
    await noUids.stop();
    host = off;

    // Assert
    should(withoutUids).be.undefined();
    should(withoutRuntimes).be.undefined();
  });

  it('should type into the ferret’s own page through browser_type, as one type act on the page, and answer Done', async () => {
    // Arrange
    const world = await built();
    host = world.host;
    const opened = await host.tool('browser_open', { name: 'app', url: 'https://example.test/login' }, as('f1'));

    // Act
    const typed = await host.tool('browser_type', { name: 'app', selector: '#user', text: 'alice' }, as('f1'));

    // Assert
    should(opened.isError).not.be.true();
    should(typed).deepEqual({ text: 'Done on %browser:app.' });
    should(world.tabs.typed).deepEqual([{ pageId: 'p1', text: 'alice' }]);
    should(host.acts.filter(act => act.op === 'type').map(act => act.target)).deepEqual([{ kind: 'page', key: 'p1' }]);
  });

  it('I100 should tell the Vault of a ferret’s page act before it runs, and place it on the page and the hosts it was on once it ends', async () => {
    // Arrange
    const world = await built();
    host = world.host;
    await host.tool('browser_open', { name: 'app', url: 'https://accounts.example.test/login' }, as('f1'));
    const before = world.vault.pageActs.length;

    // Act — a navigation (one of today's 25 tools) and a type (one of the four page tools), by the ferret.
    await host.tool('browser_navigate', { name: 'app', url: 'https://mail.example.test/' }, as('f1'));
    await host.tool('browser_type', { name: 'app', selector: '#user', text: 'alice' }, as('f1'));
    await host.tool('browser_read', { name: 'app' }, as('f1'));

    // Assert — both acts were told and placed on page p1 with the hosts around them; a read tells nothing.
    const acts = world.vault.pageActs.slice(before);
    should(acts.map(act => [act.ferret, act.script, act.placed?.id])).deepEqual([
      ['f1', false, 'p1'],
      ['f1', false, 'p1'],
    ]);
    should(acts[0]?.placed?.hosts).containEql('mail.example.test');
    should(world.vault.scriptedHosts).deepEqual([]);
  });

  it('I99 should still tell the Vault of an act a ferret aimed at a page that turned out not to be theirs, placed nowhere', async () => {
    // Arrange
    const world = await built();
    host = world.host;
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/login' }, as('f1'));
    const before = world.vault.pageActs.length;

    // Act — another ferret aims at a name that is not in its session.
    const refused = await host.tool('browser_click', { name: 'app', selector: '#go' }, as('f2'));

    // Assert — told before it ran; no page could be looked up, so it counts on every page (null).
    should(refused.isError).be.true();
    should(world.vault.pageActs.slice(before).map(act => [act.ferret, act.placed])).deepEqual([['f2', null]]);
  });

  it('should refuse browser_type on a page of another ferret, naming no page of theirs', async () => {
    // Arrange
    const world = await built();
    host = world.host;
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/login' }, as('f1'));

    // Act
    const typed = await host.tool('browser_type', { name: 'app', selector: '#user', text: 'alice' }, as('f2'));

    // Assert
    should(typed.isError).be.true();
    should(typed.text).containEql('There is no %browser:app in this session');
    should(world.tabs.typed).deepEqual([]);
  });

  it('AC1 refuses a ferret browser_open with today’s sentence when "What agents may control › Browsers" is off', async () => {
    // Arrange
    const world = await built(only('files', 'scripts'));
    host = world.host;

    // Act
    const refused = await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));

    // Assert
    should(refused.isError).be.true();
    should(refused.text).containEql(
      'This machine does not let agents control browsers: "What agents may control › Browsers" is off',
    );
  });

  it('AC3 refuses a ferret browser_open when Ferrets is not serving the agent-control port (fails closed)', async () => {
    // Arrange
    const world = await built(null);
    host = world.host;

    // Act
    const refused = await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));

    // Assert
    should(refused.isError).be.true();
    should(refused.text).containEql(
      'This machine does not let agents control browsers: "What agents may control › Browsers" is off',
    );
  });

  it('I155 should keep the one ledger: a ferret’s type into an identifier box is kept, and the runtime clears it on a toolbar act', async () => {
    // Arrange
    const world = await built();
    host = world.host;
    world.tabs.typeAnswer = { identifierHost: 'example.test' };
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/login' }, as('f1'));
    await host.tool('browser_type', { name: 'app', selector: '#user', text: 'alice@example.test' }, as('f1'));
    const kept = world.identities.at('f1', 'p1', 'example.test');

    // Act: the person's toolbar reloads the page this ferret's session is viewing.
    await host.request('POST', '/v1/ferrets/f1/browser', { body: { action: 'activate-page', pageId: 'p1' } });
    const reloaded = await host.request('POST', '/v1/ferrets/f1/browser', { body: { action: 'reload' } });

    // Assert
    should(kept).equal('alice@example.test');
    should(reloaded.status).equal(200);
    should(world.identities.at('f1', 'p1', 'example.test')).be.undefined();
  });

  it('S16 should mask the error of a page that failed to load in its status, as it masks the address', async () => {
    // Arrange
    const world = await built();
    host = world.host;
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));
    const page = world.tabs.pages.find(each => each.id === 'p1');
    if (page === undefined) throw new Error('the page should be open');
    page.pageState = 'error';
    page.url = `https://login.example.test/?token=${SECRET}`;
    world.tabs.pageError = `page.goto: net::ERR_NAME_NOT_RESOLVED at https://login.example.test/?token=${SECRET}`;
    await host.request('POST', '/v1/ferrets/f1/browser', { body: { action: 'activate-page', pageId: 'p1' } });

    // Act
    const status = await host.request('GET', '/v1/ferrets/f1/browser');

    // Assert
    should(status.status).equal(200);
    should(status.body).not.containEql(SECRET);
    should(status.json<{ pageError?: string }>().pageError).equal(
      'page.goto: net::ERR_NAME_NOT_RESOLVED at https://login.example.test/?token=*************',
    );
  });

  it('SF3 should publish PageChanged driving when a ferret acts on a page, so the typing chip shows at once', async () => {
    // Arrange
    const world = await built();
    host = world.host;

    // Act
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));
    const drivings = host.published
      .filter(entry => entry.event === 'browsers.page-changed')
      .map(entry => entry.payload as { change: string; page: string; ferret: string })
      .filter(change => change.change === 'driving');

    // Assert
    should(drivings).deepEqual([{ ferret: 'f1', page: 'p1', change: 'driving' }]);
  });

  it('should publish PageChanged closed when a ferret closes its page, and for every page its session ends with', async () => {
    // Arrange
    const world = await built();
    host = world.host;
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));
    await host.tool('browser_open', { name: 'docs', url: 'https://example.test/docs' }, as('f1'));
    const closes = () =>
      host?.published
        .filter(entry => entry.event === 'browsers.page-changed')
        .map(entry => entry.payload as { change: string; page: string; ferret: string })
        .filter(change => change.change === 'closed');

    // Act
    const closed = await host.tool('browser_close', { name: 'app' }, as('f1'));
    const afterClose = closes();
    const stopped = await host.request('POST', '/v1/ferrets/f1/browser', { body: { action: 'stop' } });

    // Assert
    should(closed.isError).not.be.true();
    should(stopped.status).equal(200);
    should(afterClose).deepEqual([{ ferret: 'f1', page: 'p1', change: 'closed' }]);
    should(closes()).deepEqual([
      { ferret: 'f1', page: 'p1', change: 'closed' },
      { ferret: 'f1', page: 'p2', change: 'closed' },
    ]);
  });
});
