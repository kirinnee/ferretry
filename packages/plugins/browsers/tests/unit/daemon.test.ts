import { afterEach, describe, it } from 'bun:test';
import { ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { ferret, type TestCaller, type TestHost, testHost } from '@ferretry/kernel/testing';
import should from 'should';
import daemon, { buildBrowsers } from '../../daemon/index.ts';
import { TypedIdentities } from '../../daemon/target/sign-in/identities.ts';
import { Tabs } from '../support/tabs.ts';

/** A vault secret the stand-in redaction masks. */
const SECRET = 'hunter2-token';

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

async function built(): Promise<{ host: TestHost; tabs: Tabs; identities: TypedIdentities }> {
  const tabs = new Tabs();
  const identities = new TypedIdentities(() => Date.parse('2026-11-07T10:00:00.000Z'));
  const half = implementDaemon(daemon.manifest, {
    build: ctx => buildBrowsers(ctx, { launcher: { launch: async () => tabs.automation }, identities }),
  });
  const gate = new StandInAdmission(request =>
    request.arrival.kind === 'local' && request.arrival.privileged ? ferretStanding(calling) : ownerStanding(),
  );
  const host = await testHost({ plugins: [half], uses: { ferrets: FERRETS }, gate, secrets: [SECRET] });
  return { host, tabs, identities };
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
    host = await testHost({ plugins: [daemon] });

    // Act
    const state = await host.request('GET', '/v1/browser/state');

    // Assert
    should(state.status).equal(200);
    should(state.json()).containEql({ state: 'stopped' });
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

  it('I155 should keep the one ledger: a ferret’s type into an identifier box is kept, and the runtime clears it on a toolbar act', async () => {
    // Arrange
    const world = await built();
    host = world.host;
    world.tabs.typeAnswer = { identifierHost: 'example.test' };
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/login' }, as('f1'));
    await host.tool('browser_type', { name: 'app', selector: '#user', text: 'alice@example.test' }, as('f1'));
    const kept = world.identities.at('f1', 'p1', 'example.test');

    // Act: the person's toolbar reloads the page this ferret's session is viewing.
    await host.request('POST', '/v1/sessions/f1/browser', { body: { action: 'activate-page', pageId: 'p1' } });
    const reloaded = await host.request('POST', '/v1/sessions/f1/browser', { body: { action: 'reload' } });

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
    await host.request('POST', '/v1/sessions/f1/browser', { body: { action: 'activate-page', pageId: 'p1' } });

    // Act
    const status = await host.request('GET', '/v1/sessions/f1/browser');

    // Assert
    should(status.status).equal(200);
    should(status.body).not.containEql(SECRET);
    should(status.json<{ pageError?: string }>().pageError).equal(
      'page.goto: net::ERR_NAME_NOT_RESOLVED at https://login.example.test/?token=*************',
    );
  });
});
