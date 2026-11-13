import { afterEach, describe, expect, test } from 'bun:test';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { implementDaemon, type DaemonHalf } from '@ferretry/kernel/manifest';
import { ferret, type TestHost, testHost } from '@ferretry/kernel/testing';
import type { ReferenceCatalogProvider } from '@ferretry/plugin-conversation/contract';
import daemon, { buildBrowsers } from '../../daemon/index.ts';
import { HIDDEN_FRAGMENT } from '../../daemon/address-rule.ts';
import type manifest from '../../manifest.ts';
import { Tabs } from '../support/tabs.ts';

/**
 * ONE RULE, EVERY SURFACE: each test boots the real daemon half (`buildBrowsers`, where the rule is composed onto
 * `kernel.redaction`), puts a page on a FAKE pairing-shaped address, and reads the page back through one kind of
 * surface. None names the rule; each proves the seam is the one in use.
 */
const FAKE_FRAGMENT = '#v1;a=127.0.0.1:9;c=FAKEFAKE;fp=00';
const FAKE_CODE = 'FAKEFAKE';
const PAIRING_URL = `https://app.example.test/pair?lang=en${FAKE_FRAGMENT}`;
const HIDDEN_URL = `https://app.example.test/pair?lang=en${HIDDEN_FRAGMENT}`;

let host: TestHost | undefined;
let built: DaemonHalf<typeof manifest> | undefined;

async function boot(): Promise<{ readonly host: TestHost; readonly tabs: Tabs }> {
  const tabs = new Tabs();
  const half = implementDaemon(daemon.manifest, {
    build: ctx => {
      built = buildBrowsers(ctx, { launcher: { launch: async () => tabs.automation } });
      return built;
    },
  });
  host = await testHost({
    plugins: [half],
    uses: {
      ferrets: { get: async (id: string) => (id === 'f1' ? { name: id } : undefined) },
      agentControl: { allows: async () => true },
    },
    fakes: { vault: new FakeVault(), gate: new FakeGate() },
    gate: new StandInAdmission(request =>
      request.arrival.kind === 'local' && request.arrival.privileged
        ? ferretStanding('f1' as FerretId)
        : ownerStanding(),
    ),
  });
  return { host, tabs };
}

/** Moves the opened page to `url` with `title`, as a page that navigated itself (or echoed a link into its title) does. */
function setPage(tabs: Tabs, url: string, title = ''): void {
  tabs.pages = tabs.pages.map(page => (page.id === 'p1' ? { ...page, url, title } : page));
}

const agent = { as: ferret('f1') };

afterEach(async () => {
  await host?.stop();
  host = undefined;
  built = undefined;
});

describe('every surface of the browsers plugin returns an address through the one rule', () => {
  test('agent tool results (open, navigate, read, screenshot headers) never print the fragment', async () => {
    const world = await boot();
    const opened = await world.host.tool('browser_open', { name: 'app', url: PAIRING_URL }, agent);
    const navigated = await world.host.tool('browser_navigate', { name: 'app', url: PAIRING_URL }, agent);
    const read = await world.host.tool('browser_read', { name: 'app' }, agent);
    const shot = await world.host.tool('browser_screenshot', { name: 'app' }, agent);

    for (const answer of [opened, navigated, read, shot]) {
      expect(answer.isError).not.toBe(true);
      expect(answer.text).not.toContain(FAKE_CODE);
      expect(answer.text).not.toContain('#v1;');
      expect(answer.text).toContain(HIDDEN_URL);
    }
    expect(JSON.stringify(opened)).not.toContain(FAKE_CODE);
  });

  test('the agent’s page list (browser_list, browser_tabs) names a pairing-shaped address and title with the marker', async () => {
    const world = await boot();
    await world.host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, agent);
    setPage(world.tabs, PAIRING_URL, `Pair ${FAKE_FRAGMENT}`);

    const listed = await world.host.tool('browser_list', {}, agent);
    const tabbed = await world.host.tool('browser_tabs', { action: 'list' }, agent);

    // The rows (address, title) are the structured part of the answer, not its summary line.
    for (const answer of [listed, tabbed]) {
      expect(JSON.stringify(answer)).not.toContain(FAKE_CODE);
      expect(JSON.stringify(answer)).toContain(HIDDEN_FRAGMENT);
    }
  });

  test('the owner’s status route masks the address, the title and the page error', async () => {
    const world = await boot();
    await world.host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, agent);
    setPage(world.tabs, PAIRING_URL, `Pair ${FAKE_FRAGMENT}`);
    const page = world.tabs.pages.find(each => each.id === 'p1');
    if (page === undefined) throw new Error('the page should be open');
    page.pageState = 'error';
    world.tabs.pageError = `page.goto: failed at ${PAIRING_URL}`;
    await world.host.request('POST', '/v1/sessions/f1/browser', { body: { action: 'activate-page', pageId: 'p1' } });

    const status = await world.host.request('GET', '/v1/sessions/f1/browser');

    expect(status.status).toBe(200);
    expect(status.body).not.toContain(FAKE_CODE);
    const body = status.json<{
      url: string;
      title: string;
      pageError?: string;
      pages: { url: string; title: string }[];
    }>();
    expect(body.url).toBe(HIDDEN_URL);
    expect(body.title).toBe(`Pair ${HIDDEN_FRAGMENT}`);
    expect(body.pageError).toContain(HIDDEN_URL);
    expect(body.pages[0]?.url).toBe(HIDDEN_URL);
  });

  test('the owner’s action route answers a navigation with the address hidden', async () => {
    const world = await boot();
    await world.host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, agent);
    await world.host.request('POST', '/v1/sessions/f1/browser', { body: { action: 'activate-page', pageId: 'p1' } });

    const acted = await world.host.request('POST', '/v1/sessions/f1/browser', {
      body: { action: 'navigate', url: PAIRING_URL },
    });

    expect(acted.status).toBe(200);
    expect(acted.body).not.toContain(FAKE_CODE);
    expect(acted.body).toContain(HIDDEN_FRAGMENT);
  });

  test('the %browser reference menu labels a page by its title with the pairing fragment hidden', async () => {
    const world = await boot();
    await world.host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, agent);
    setPage(world.tabs, PAIRING_URL, `Pair ${FAKE_FRAGMENT}`);

    const menu = built?.hooks['reference.catalog:%browser'] as ReferenceCatalogProvider | undefined;
    const entries = (await menu?.entries({ ferret: 'f1', caller: {} })) ?? [];

    expect(JSON.stringify(entries)).not.toContain(FAKE_CODE);
    expect(entries.map(entry => entry.label)).toEqual([`Pair ${HIDDEN_FRAGMENT}`]);
  });

  test('a failed call’s message (the error / hold path) is masked: a worker error can echo the address', async () => {
    const world = await boot();
    await world.host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, agent);
    world.tabs.automation.click = async () => {
      throw new Error(`click failed on ${PAIRING_URL}`);
    };

    // The test host throws a failed call's error; a refused one answers `isError`. The message is what is checked.
    const failed = await world.host.tool('browser_click', { name: 'app', selector: '#go' }, agent).then(
      answer => answer.text,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(failed).not.toContain(FAKE_CODE);
    expect(failed).toContain(HIDDEN_URL);
  });
});
