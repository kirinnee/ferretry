import { afterEach, describe, it } from 'bun:test';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { AgentControlReader, FerretId } from '@ferretry/kernel/contract';
import { implementDaemon, type Needer } from '@ferretry/kernel/manifest';
import { ferret, type TestCaller, type TestHost, testHost } from '@ferretry/kernel/testing';
import should from 'should';
import { type BrowserCopyAnswer, type BrowsersCopyApi, BrowsersPort } from '../../contract/port.ts';
import daemon, { buildBrowsers } from '../../daemon/index.ts';
import { Tabs } from '../support/tabs.ts';

/** A value no real credential looks like: it crosses the seam once, in the read's answer, and appears nowhere else. */
const SENTINEL = 'FAKE-SC-7f3a91';

const ALL_ON: AgentControlReader = { allows: async () => true };
const FERRETS = { get: async (id: string) => (id === 'f1' ? { name: id } : undefined) };

let calling = 'f1' as FerretId;
const as = (id: string): { readonly as: TestCaller } => {
  calling = id as FerretId;
  return { as: ferret(id) };
};

const FOUND = {
  ok: true as const,
  value: SENTINEL,
  origin: 'https://example.test',
  frameOrigin: 'https://example.test',
  navigationId: 'loader-1',
};

async function built(
  control: AgentControlReader = ALL_ON,
): Promise<{ host: TestHost; tabs: Tabs; copy: BrowsersCopyApi; vault: FakeVault }> {
  const tabs = new Tabs();
  const vault = new FakeVault();
  const half = implementDaemon(daemon.manifest, {
    build: ctx => buildBrowsers(ctx, { launcher: { launch: async () => tabs.automation } }),
  });
  const gate = new StandInAdmission(request =>
    request.arrival.kind === 'local' && request.arrival.privileged ? ferretStanding(calling) : ownerStanding(),
  );
  const host = await testHost({
    plugins: [half],
    uses: { ferrets: FERRETS, agentControl: control },
    fakes: { vault, gate: new FakeGate() },
    gate,
  });
  const copy = host.provided(BrowsersPort, needer('accounts')).copy;
  if (copy === undefined) throw new Error('Accounts should be handed the copy reach');
  return { host, tabs, copy, vault };
}

/** A plugin that needs the port, as the kernel hands it over (the host loads no `accounts` plugin here). */
const needer = (id: string): Needer => ({
  id,
  permissions: { network: [], spawn: [], secrets: [] } as unknown as Needer['permissions'],
  ownedSecretReferences: () => new Set(),
});

const takeOver = async (host: TestHost, key: string): Promise<void> => {
  const taken = await host.request('POST', '/v1/sessions/f1/surfaces/browser/control', {
    body: { action: 'takeover', key },
  });
  should(taken.status).equal(200);
};

const READ = [{ kind: 'ref', ref: 'e3' }, 'text', undefined] as const;

describe('the secure-copy reach into the agent browser', () => {
  let host: TestHost | undefined;
  afterEach(async () => {
    await host?.stop();
    host = undefined;
  });

  it('should hand the copy reach to Accounts alone', async () => {
    const world = await built();
    host = world.host;

    should(host.provided(BrowsersPort, needer('accounts')).copy).not.equal(undefined);
    should(host.provided(BrowsersPort, needer('terminals')).copy).equal(undefined);
    should(host.provided(BrowsersPort, needer('vault')).copy).equal(undefined);
    should(host.provided(BrowsersPort).copy).equal(undefined);
  });

  it('should read an element of a ferret’s own page in the page’s queue, and seal before the queue moves on', async () => {
    const { host: made, tabs, copy } = await built();
    host = made;
    tabs.copyAnswer = FOUND;
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));
    const order: string[] = [];

    const answer = await copy.copyRead('f1' as FerretId, 'app', ...READ, {
      guard: async page => {
        order.push(`guard:${String(await page.document())}`);
      },
      seal: read => {
        order.push(`seal:${read.pageId}`);
      },
    });

    should(answer).match({ ok: true, pageId: 'p1', origin: 'https://example.test', navigationId: 'loader-1' });
    should(order).eql(['guard:loader-1', 'seal:p1']);
    should(tabs.calls.filter(call => call.startsWith('copyRead'))).eql(['copyRead:p1']);
  });

  it('should pass a read that found nothing through as the browser said it, sealing nothing', async () => {
    const { host: made, tabs, copy } = await built();
    host = made;
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));
    let sealed = 0;

    const answer = await copy.copyRead('f1' as FerretId, 'app', ...READ, {
      seal: () => {
        sealed += 1;
      },
    });

    should(answer).eql({ ok: false, reason: 'empty' });
    should(sealed).equal(0);
    should(tabs.calls).containEql('copyRead:p1');
  });

  it('should refuse a copy from a page a person has taken over, before the read, with the browser’s sentence', async () => {
    const { host: made, tabs, copy } = await built();
    host = made;
    tabs.copyAnswer = FOUND;
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));
    await takeOver(host, 'app');

    const answer = await copy.copyRead('f1' as FerretId, 'app', ...READ, { seal: () => undefined });

    should(answer).match({ ok: false, reason: 'refused', code: 'taken_over' });
    should((answer as Extract<BrowserCopyAnswer, { reason: 'refused' }>).message).containEql('taken over');
    should(tabs.calls.filter(call => call.startsWith('copyRead'))).eql([]);
    should(JSON.stringify(answer)).not.containEql(SENTINEL);
  });

  it('should refuse a copy whose takeover lands while it waits its turn in the page’s queue, reading nothing', async () => {
    const { host: made, tabs, copy } = await built();
    host = made;
    tabs.copyAnswer = FOUND;
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));
    // The page's queue is busy with a slow read; the copy is cleared, then queued behind it.
    const release = Promise.withResolvers<void>();
    tabs.readGate = release.promise;
    const reading = host.tool('browser_read', { name: 'app' }, as('f1'));
    const queued = copy.copyRead('f1' as FerretId, 'app', ...READ, { seal: () => undefined });

    await takeOver(host, 'app');
    release.resolve();
    const answer = await queued;
    await reading;

    should(answer).match({ ok: false, reason: 'refused', code: 'taken_over' });
    should(tabs.calls.filter(call => call.startsWith('copyRead'))).eql([]);
  });

  it('should tell the Vault when a person takes a page over, naming it by name and by id (P2-5)', async () => {
    const { host: made, vault } = await built();
    host = made;
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));

    await takeOver(host, 'app');

    should(vault.pageTakeovers).have.length(1);
    should(vault.pageTakeovers[0]?.ferret).equal('f1');
    should(vault.pageTakeovers[0]?.keys).containEql('app');
    should(vault.pageTakeovers[0]?.keys.length).equal(2);
  });

  it('should refuse a queued read when the Browsers switch is turned off after it was admitted (P2-8)', async () => {
    const switches = { on: true };
    const { host: made, tabs, copy } = await built({ allows: async () => switches.on });
    host = made;
    tabs.copyAnswer = FOUND;
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));
    const release = Promise.withResolvers<void>();
    tabs.readGate = release.promise;
    const reading = host.tool('browser_read', { name: 'app' }, as('f1'));
    const queued = copy.copyRead('f1' as FerretId, 'app', ...READ, { seal: () => undefined });

    switches.on = false;
    release.resolve();
    const answer = await queued;
    await reading.catch(() => undefined);

    should(answer).match({ ok: false, reason: 'refused', code: 'forbidden' });
    should(tabs.calls.filter(call => call.startsWith('copyRead'))).eql([]);
    should(JSON.stringify(answer)).not.containEql(SENTINEL);
  });

  it('should clear a paste target as a browser tool would: free, taken over, unknown, and Browsers switched off', async () => {
    const { host: made, copy } = await built();
    host = made;
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));

    const free = await copy.pasteTarget('f1' as FerretId, 'app');
    const unknown = await copy.pasteTarget('f1' as FerretId, 'nowhere');
    await takeOver(host, 'app');
    const held = await copy.pasteTarget('f1' as FerretId, 'app');

    should(free).eql({ ok: true, key: 'app' });
    should(unknown).match({ ok: false, code: 'not_found' });
    should(held).match({ ok: false, code: 'taken_over' });
    should(await copy.takenOver('f1' as FerretId, 'app')).equal(true);
    should(await copy.takenOver('f1' as FerretId, 'nowhere')).equal(true);
  });

  it('should refuse every use of the reach when the owner turned Browsers off', async () => {
    const world = await built({ allows: async (_ferret, kind) => kind !== 'browser' });
    host = world.host;

    const read = await world.copy.copyRead('f1' as FerretId, 'app', ...READ, { seal: () => undefined });
    const paste = await world.copy.pasteTarget('f1' as FerretId, 'app');

    should(read).match({ ok: false, reason: 'refused', code: 'forbidden' });
    should(paste).match({ ok: false, code: 'forbidden' });
  });

  it('should say a page a person has handed back is free again', async () => {
    const { host: made, copy } = await built();
    host = made;
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));
    await takeOver(host, 'app');
    should(await copy.takenOver('f1' as FerretId, 'app')).equal(true);

    const back = await host.request('POST', '/v1/sessions/f1/surfaces/browser/control', {
      body: { action: 'handback', key: 'app' },
    });

    should(back.status).equal(200);
    should(await copy.takenOver('f1' as FerretId, 'app')).equal(false);
  });
});

/** What a tool said: its refusal's sentence (an MCP error), or the word for "it ran". */
const said =
  (word: string) =>
  (result: { readonly isError?: boolean; readonly text: string }): string =>
    result.isError === true ? result.text : word;

describe('the secure-copy reach into the clipboard', () => {
  let held: TestHost | undefined;
  afterEach(async () => {
    await held?.stop();
    held = undefined;
  });
  const CLIP = {
    ok: true as const,
    value: SENTINEL,
    origin: 'https://example.test',
    frameOrigin: 'https://example.test',
    navigationId: 'loader-1',
  };

  it('should read the clipboard in the page’s queue, seal before the queue moves on, and file it under the page', async () => {
    const { host, tabs, copy } = await built();
    held = host;
    tabs.clipboardAnswer = CLIP;
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));
    const order: string[] = [];

    const answer = await copy.clipboardRead('f1' as FerretId, 'app', {
      guard: async page => void order.push(`guard:${String(await page.document())}`),
      seal: read => void order.push(`seal:${read.pageId}`),
    });

    should(answer).match({ ok: true, pageId: 'p1', origin: 'https://example.test', navigationId: 'loader-1' });
    should(order).eql(['guard:loader-1', 'seal:p1']);
    should(tabs.calls.filter(call => call.startsWith('copyClipboard'))).eql(['copyClipboard:p1']);
  });

  it('should refuse a capture from a page a person holds before anything is read, and when the takeover lands while it waits', async () => {
    const { host, tabs, copy } = await built();
    held = host;
    tabs.clipboardAnswer = CLIP;
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));
    await takeOver(host, 'app');

    const direct = await copy.clipboardRead('f1' as FerretId, 'app', { seal: () => undefined });
    await host.request('POST', '/v1/sessions/f1/surfaces/browser/control', {
      body: { action: 'handback', key: 'app' },
    });
    const release = Promise.withResolvers<void>();
    tabs.readGate = release.promise;
    const reading = host.tool('browser_read', { name: 'app' }, as('f1'));
    const queued = copy.clipboardRead('f1' as FerretId, 'app', { seal: () => undefined });
    await takeOver(host, 'app');
    release.resolve();
    const waited = await queued;
    await reading;

    should(direct).match({ ok: false, reason: 'refused', code: 'taken_over' });
    should(waited).match({ ok: false, reason: 'refused', code: 'taken_over' });
    should(tabs.calls.filter(call => call.startsWith('copyClipboard'))).eql([]);
    should(JSON.stringify([direct, waited])).not.containEql(SENTINEL);
  });

  it('should pass an empty clipboard and a moved page through, sealing nothing', async () => {
    const { host, tabs, copy } = await built();
    held = host;
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));
    let sealed = 0;
    const seal = (): void => {
      sealed += 1;
    };

    tabs.clipboardAnswer = { ok: false, reason: 'empty' };
    const empty = await copy.clipboardRead('f1' as FerretId, 'app', { seal });
    tabs.clipboardAnswer = { ok: false, reason: 'changed' };
    const moved = await copy.clipboardRead('f1' as FerretId, 'app', { seal });

    should([empty, moved]).eql([
      { ok: false, reason: 'empty' },
      { ok: false, reason: 'changed' },
    ]);
    should(sealed).equal(0);
  });

  it('should refuse, saying why, when this browser’s clipboard is the computer’s own (a real window)', async () => {
    const { host, tabs, copy } = await built();
    held = host;
    tabs.clipboardAnswer = { ok: false, reason: 'shared' };
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));

    const answer = await copy.clipboardRead('f1' as FerretId, 'app', { seal: () => undefined });

    should(answer).match({ ok: false, reason: 'refused', code: 'unavailable' });
    should((answer as Extract<BrowserCopyAnswer, { reason: 'refused' }>).message).containEql("computer's own");
  });

  it('should refuse a page script of the ferret while a capture runs, and only then', async () => {
    const { host, tabs, copy } = await built();
    held = host;
    tabs.clipboardAnswer = CLIP;
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));
    let during: unknown;
    await copy.clipboardRead('f1' as FerretId, 'app', {
      guard: async () => {
        during = await host
          .tool('browser_eval', { name: 'app', function: '() => 1' }, as('f1'))
          .then(said('ran'), (error: unknown) => (error as Error).message);
      },
      seal: () => undefined,
    });
    const after = await host
      .tool('browser_eval', { name: 'app', function: '() => 1' }, as('f1'))
      .then(said('ran'), (error: unknown) => (error as Error).message);

    should(String(during)).containEql('refused while a clipboard capture of yours is running');
    should(after).equal('ran');
  });

  it('should keep a copy’s pages closed to the ferret’s tools from the moment it is told, until the copy ends or the session drops', async () => {
    const { host, copy } = await built();
    held = host;
    await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, as('f1'));
    let ends: number | undefined = Date.now() + 60_000;

    copy.sealed.hold('f1' as FerretId, 'key', ['https://example.test'], () => ends);
    const closed = await host
      .tool('browser_read', { name: 'app' }, as('f1'))
      .then(said('read'), (error: unknown) => (error as Error).message);
    ends = undefined;
    const open = await host
      .tool('browser_read', { name: 'app' }, as('f1'))
      .then(said('read'), (error: unknown) => (error as Error).message);
    copy.sealed.hold('f1' as FerretId, 'key2', ['https://example.test'], () => Date.now() + 60_000);
    copy.sealed.drop('f1' as FerretId);
    const dropped = await host
      .tool('browser_read', { name: 'app' }, as('f1'))
      .then(said('read'), (error: unknown) => (error as Error).message);

    should(closed).containEql('browser.read is refused on %browser:app');
    should(open).equal('read');
    should(dropped).equal('read');
  });

  it('should close the origin of the page a paste went into, where the page is now', async () => {
    const { host, copy, tabs } = await built();
    held = host;
    await host.tool('browser_open', { name: 'form', url: 'https://form.example.test/' }, as('f1'));
    await host.tool('browser_open', { name: 'other', url: 'https://other.example.test/' }, as('f1'));

    await copy.sealed.pastedInto('f1' as FerretId, 'key', 'form', () => Date.now() + 60_000);
    await copy.sealed.pastedInto('f1' as FerretId, 'key', 'nowhere', () => Date.now() + 60_000);
    // Inside the queue each page says where it IS now.
    tabs.documentHost = 'form.example.test';
    const form = await host
      .tool('browser_read', { name: 'form' }, as('f1'))
      .then(said('read'), (error: unknown) => (error as Error).message);
    tabs.documentHost = 'other.example.test';
    const other = await host
      .tool('browser_read', { name: 'other' }, as('f1'))
      .then(said('read'), (error: unknown) => (error as Error).message);

    should(form).containEql('browser.read is refused on %browser:form');
    should(other).equal('read');
  });
});
