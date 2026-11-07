import { describe, expect, test } from 'bun:test';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { implementDaemon, type DaemonHalf } from '@ferretry/kernel/manifest';
import { ferret, testHost } from '@ferretry/kernel/testing';
import {
  REFERENCE_CATALOG_MAX_ENTRIES,
  ReferenceCatalogEntrySchema,
  type ReferenceCatalogInput,
  type ReferenceCatalogProvider,
  referenceCatalogLimit,
} from '@ferretry/plugin-conversation/contract';
import type { BrowserPageSummary, BrowserStatus } from '../../../contract/wire/browser.ts';
import daemon, { buildBrowsers } from '../../../daemon/index.ts';
import { BrowsersReferenceMenu } from '../../../daemon/pages/reference-menu.ts';
import { BrowserSessionError } from '../../../daemon/pages/service.ts';
import manifest from '../../../manifest.ts';
import { browserKernel } from '../../support/kernel.ts';
import { Tabs } from '../../support/tabs.ts';

const FERRET = 'f1';
const SECRET = 'hunter2-token';

const page = (overrides: Partial<BrowserPageSummary> & Pick<BrowserPageSummary, 'id'>): BrowserPageSummary => ({
  url: 'https://example.test/docs',
  title: 'Docs',
  ...overrides,
});

const running = (pages: readonly BrowserPageSummary[]): BrowserStatus =>
  ({ state: 'running', pages, sessionId: FERRET }) as unknown as BrowserStatus;

const menu = (pages: readonly BrowserPageSummary[], secrets: readonly string[] = []) =>
  new BrowsersReferenceMenu({ status: async () => running(pages) }, browserKernel({ secrets }).kernel.redaction);

const ask = (query?: string): ReferenceCatalogInput => ({
  ferret: FERRET,
  ...(query === undefined ? {} : { query }),
  caller: {},
});

describe('browsers provides the %browser reference menu (reference.catalog)', () => {
  test('a ferret’s pages are offered in the order Browsers lists them: the key is the name (else the id), the label the page’s own tab copy', async () => {
    const entries = await menu([
      page({ id: 'p1', name: 'app', title: 'My app' }),
      page({ id: 'p2', title: '  ', url: 'about:blank' }),
      page({ id: 'p3', title: '', url: 'https://example.test/x' }),
    ]).entries(ask());
    expect(entries.map(entry => [entry.token, entry.label])).toEqual([
      ['app', 'My app'],
      ['p2', 'New tab'],
      ['p3', 'example.test'],
    ]);
    for (const entry of entries) expect(ReferenceCatalogEntrySchema.safeParse(entry).success).toBe(true);
  });

  test('a title or address a page set past the entry bound is cut, so the menu still answers', async () => {
    const entries = await menu([
      page({ id: 'p1', title: 'x'.repeat(5_000) }),
      page({ id: 'p2', title: '', url: `data:text/plain,${'y'.repeat(5_000)}` }),
    ]).entries(ask());
    expect(entries.map(entry => entry.label.length)).toEqual([256, 256]);
    expect(ReferenceCatalogEntrySchema.array().safeParse(entries).success).toBe(true);
  });

  test('the detail says whether the page is incognito and who opened it; an unrecorded opener reads unrecorded, never a guess', async () => {
    const entries = await menu([
      page({ id: 'p1', openedBy: { by: 'agent', sessionId: 's1' } }),
      page({ id: 'p2', openedBy: { by: 'human', deviceId: 'dev-1' }, incognito: true }),
      page({ id: 'p3', openedBy: { by: 'local' } }),
      page({ id: 'p4' }),
    ]).entries(ask());
    expect(entries.map(entry => entry.detail)).toEqual([
      'opened by an agent',
      'incognito · opened from a paired device',
      'opened on the daemon host',
      'owner unrecorded',
    ]);
  });

  test('no address, device id or session id leaves in an entry, and a secret in a title is masked', async () => {
    const entries = await menu(
      [
        page({
          id: 'p1',
          url: 'https://secret-host.test/path?q=1',
          title: `login ${SECRET}`,
          openedBy: { by: 'human', deviceId: 'device-secret-id' },
        }),
        page({ id: 'p2', openedBy: { by: 'agent', sessionId: 'session-secret-id' } }),
      ],
      [SECRET],
    ).entries(ask());
    const text = JSON.stringify(entries);
    expect(text).not.toContain('device-secret-id');
    expect(text).not.toContain('session-secret-id');
    expect(text).not.toContain('secret-host');
    expect(text).not.toContain(SECRET);
    expect(entries[0]?.label).toBe(`login ${'*'.repeat(SECRET.length)}`);
  });

  test('the query narrows by the key or the label, case ignored', async () => {
    const all = [
      page({ id: 'p1', name: 'app', title: 'My app' }),
      page({ id: 'p2', name: 'docs', title: 'Reference manual' }),
      page({ id: 'p3', title: 'Plain' }),
    ];
    const tokens = async (query: string) => (await menu(all).entries(ask(query))).map(entry => entry.token);
    expect(await tokens('APP')).toEqual(['app']);
    expect(await tokens('manual')).toEqual(['docs']);
    expect(await tokens('p3')).toEqual(['p3']);
    expect(await tokens('  ')).toEqual(['app', 'docs', 'p3']);
    expect(await tokens('nothing')).toEqual([]);
  });

  test('a menu never passes the prefix’s limit', async () => {
    const many = Array.from({ length: REFERENCE_CATALOG_MAX_ENTRIES + 25 }, (_, index) =>
      page({ id: `p${String(index)}` }),
    );
    expect(referenceCatalogLimit('%browser')).toBe(REFERENCE_CATALOG_MAX_ENTRIES);
    expect(await menu(many).entries(ask())).toHaveLength(REFERENCE_CATALOG_MAX_ENTRIES);
  });

  test('no entry is closed: a stopped browser holds no pages and Browsers lists only open ones', async () => {
    const entries = await menu([page({ id: 'p1' })]).entries(ask());
    expect(entries.some(entry => entry.closed !== undefined)).toBe(false);
    const stopped = new BrowsersReferenceMenu(
      { status: async () => ({ state: 'stopped', pages: [] }) as unknown as BrowserStatus },
      browserKernel().kernel.redaction,
    );
    expect(await stopped.entries(ask())).toEqual([]);
  });

  test('a ferret Browsers does not know has an empty menu, and any other failure is the route’s own refusal', async () => {
    const unknown = new BrowsersReferenceMenu(
      {
        status: async () => {
          throw new BrowserSessionError('not_found', 'no such session');
        },
      },
      browserKernel().kernel.redaction,
    );
    expect(await unknown.entries(ask())).toEqual([]);
    const failing = new BrowsersReferenceMenu(
      {
        status: async () => {
          throw new BrowserSessionError('launch_failed', 'no chrome');
        },
      },
      browserKernel().kernel.redaction,
    );
    await expect(failing.entries(ask())).rejects.toMatchObject({ status: 503 });
  });

  test('the demand declared is exactly what the direct page-list route declares', () => {
    const direct = manifest.actions.routes.find(route => route.key === 'GET /v1/sessions/:sessionId/browser');
    expect(direct?.capability).toBeDefined();
    expect(direct?.capability).toEqual(menu([]).demand);
  });
});

describe('browsers with the real half', () => {
  let built: DaemonHalf<typeof manifest> | undefined;
  const boot = async (calling: FerretId) => {
    const tabs = new Tabs();
    const half = implementDaemon(daemon.manifest, {
      build: ctx => {
        built = buildBrowsers(ctx, { launcher: { launch: async () => tabs.automation } });
        return built;
      },
    });
    const host = await testHost({
      plugins: [half],
      uses: { ferrets: { get: async (id: string) => (id === 'f1' || id === 'f2' ? { name: id } : undefined) } },
      fakes: { vault: new FakeVault(), gate: new FakeGate() },
      gate: new StandInAdmission(request =>
        request.arrival.kind === 'local' && request.arrival.privileged ? ferretStanding(calling) : ownerStanding(),
      ),
    });
    return host;
  };
  const provider = (): ReferenceCatalogProvider =>
    built?.hooks['reference.catalog:%browser'] as ReferenceCatalogProvider;

  test('a page the ferret opened is offered, held under the one key Conversation asks, and another ferret’s is not', async () => {
    const host = await boot('f1' as FerretId);
    const opened = await host.tool(
      'browser_open',
      { name: 'app', url: 'https://example.test/login' },
      { as: ferret('f1') },
    );
    expect(opened.isError).not.toBe(true);
    const entries = await provider().entries({ ferret: 'f1', caller: {} });
    expect(entries.map(entry => entry.token)).toEqual(['app']);
    for (const entry of entries) expect(ReferenceCatalogEntrySchema.safeParse(entry).success).toBe(true);
    expect(await provider().entries({ ferret: 'f2', caller: {} })).toEqual([]);
    await host.stop();
  });

  test('with Conversation absent the plugin boots, still serves its own reads, and nothing asks the menu', async () => {
    const host = await boot('f1' as FerretId);
    expect(host.logs.filter(entry => entry.level === 'error')).toEqual([]);
    const own = await host.request('GET', `/v1/sessions/${FERRET}/browser`);
    expect(own.status).toBe(200);
    // The only asker of the menu is Conversation's references route; with Conversation off the host holds no such route.
    const references = await host.request('GET', `/v1/ferrets/${FERRET}/references?prefix=%25browser`);
    expect(references.status).toBe(404);
    await host.stop();
  });
});
