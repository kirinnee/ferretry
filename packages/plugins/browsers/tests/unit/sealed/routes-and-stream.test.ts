import { afterEach, describe, it } from 'bun:test';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { AgentControlReader, FerretId } from '@ferretry/kernel/contract';
import { implementDaemon, type Needer } from '@ferretry/kernel/manifest';
import { ferret, type TestHost, testHost } from '@ferretry/kernel/testing';
import should from 'should';
import { BrowsersPort, type BrowsersCopyApi } from '../../../contract/port.ts';
import daemon, { buildBrowsers } from '../../../daemon/index.ts';
import { SealedGate } from '../../../daemon/sealed/gate.ts';
import { SealedPages } from '../../../daemon/sealed/page-guards.ts';
import { heldViewerHost } from '../../../daemon/stream/held-host.ts';
import { Tabs } from '../../support/tabs.ts';

/**
 * FINDING 1 (secure-clip-2 fix round 1): the HTTP action route and the viewer socket are agent paths too. The daemon half is
 * built exactly as production builds it (`buildBrowsers`), over a fake browser; an AGENT's own credential and a PERSON's
 * are told apart by the standing Gate stamps, and a person always passes. Never a real credential.
 */
const SENTINEL = 'FAKE-SC-7f3a91';
const SOURCE = 'https://keys.example.test';
const ALL_ON: AgentControlReader = { allows: async () => true };
const FERRETS = { get: async (id: string) => (id === 'f1' || id === 'f2' ? { name: id } : undefined) };
const ACT = '/v1/sessions/f1/browser';

const calling = 'f1' as FerretId;
const needer = (id: string): Needer => ({
  id,
  permissions: { network: [], spawn: [], secrets: [] } as unknown as Needer['permissions'],
  ownedSecretReferences: () => new Set(),
});

let held: TestHost | undefined;
afterEach(async () => {
  await held?.stop();
  held = undefined;
});

async function built(): Promise<{ host: TestHost; tabs: Tabs; copy: BrowsersCopyApi }> {
  const tabs = new Tabs();
  const half = implementDaemon(daemon.manifest, {
    build: ctx => buildBrowsers(ctx, { launcher: { launch: async () => tabs.automation } }),
  });
  const gate = new StandInAdmission(request =>
    request.arrival.kind === 'local' && request.arrival.privileged ? ferretStanding(calling) : ownerStanding(),
  );
  const host = await testHost({
    plugins: [half],
    uses: { ferrets: FERRETS, agentControl: ALL_ON },
    fakes: { vault: new FakeVault(), gate: new FakeGate() },
    gate,
  });
  held = host;
  const copy = host.provided(BrowsersPort, needer('accounts')).copy;
  if (copy === undefined) throw new Error('Accounts should be handed the copy reach');
  return { host, tabs, copy };
}

/** A ferret with a page on the source site, viewed by its session, and a live copy that sits there. */
async function sealedWorld() {
  const world = await built();
  const { host, tabs, copy } = world;
  await host.tool('browser_open', { name: 'keys', url: `${SOURCE}/new?token=${SENTINEL}` }, { as: ferret('f1') });
  await host.request('POST', ACT, { body: { action: 'activate-page', pageId: 'p1' }, as: ferret('f1') });
  tabs.documentHost = 'keys.example.test';
  tabs.pages = tabs.pages.map(page => (page.id === 'p1' ? { ...page, title: `Your key ${SENTINEL}` } : page));
  copy.sealed.hold('f1' as FerretId, 'token', [SOURCE], () => Date.now() + 60_000);
  return world;
}

const asAgent = { as: ferret('f1') };
const body = (action: Record<string, unknown>) => ({ body: action, ...asAgent });

describe('FINDING 1: the HTTP action route is an agent path, and meets the sealed gate', () => {
  it('should refuse an agent credential’s read of a page that holds a sealed value, and a person’s own passes', async () => {
    const { host, tabs } = await sealedWorld();

    const agent = await host.request('POST', ACT, body({ action: 'read' }));
    const person = await host.request('POST', ACT, { body: { action: 'read' } });

    should(agent.status).equal(403);
    should(agent.body).containEql('browser.read is refused');
    should(agent.body).containEql('sealed:token');
    should(agent.body).not.containEql(SENTINEL);
    should(person.status).equal(200);
    should(tabs.calls.filter(call => call.startsWith('read-'))).have.length(1);
  });

  it('should refuse an agent credential’s picture of that page, taking none, and let a person have theirs', async () => {
    const { host, tabs } = await sealedWorld();

    const agent = await host.request('POST', ACT, body({ action: 'screenshot' }));
    const taken = tabs.calls.filter(call => call.startsWith('screenshot')).length;
    const person = await host.request('POST', ACT, { body: { action: 'screenshot' } });

    should(agent.status).equal(403);
    should(agent.body).containEql('browser.screenshot is refused');
    should(taken).equal(0);
    should(person.status).equal(200);
    should(person.json<{ result: { screenshotBase64: string } }>().result.screenshotBase64.length).be.above(0);
  });

  it('should withhold a picture of ANOTHER page, through the route, when the page’s text (frames too) cannot be read while a value lives', async () => {
    const { host, tabs, copy } = await built();
    await host.tool('browser_open', { name: 'dash', url: 'https://dash.example.test/' }, asAgent);
    await host.request('POST', ACT, { body: { action: 'activate-page', pageId: 'p1' }, ...asAgent });
    tabs.documentHost = 'dash.example.test';
    tabs.pageText = undefined;
    copy.sealed.hold('f1' as FerretId, 'token', [SOURCE], () => Date.now() + 60_000);

    const agent = await host.request('POST', ACT, body({ action: 'screenshot' }));
    const person = await host.request('POST', ACT, { body: { action: 'screenshot' } });
    tabs.pageText = 'Documentation';
    const readable = await host.request('POST', ACT, body({ action: 'screenshot' }));

    should(agent.status).equal(403);
    should(agent.body).containEql('browser.screenshot is withheld');
    should(person.status).equal(200);
    should(readable.status).equal(200);
  });

  it('should refuse a content-dependent selector on a closed page through the route, and allow structure', async () => {
    const { host } = await sealedWorld();

    const text = await host.request('POST', ACT, body({ action: 'click', selector: 'text=Copy' }));
    const structure = await host.request('POST', ACT, body({ action: 'click', selector: '#done' }));
    const person = await host.request('POST', ACT, { body: { action: 'click', selector: 'text=Copy' } });

    should(text.status).equal(403);
    should(text.body).containEql('depends on what the page says');
    should(structure.status).equal(200);
    should(person.status).equal(200);
  });

  it('should refuse inside the page’s queue when the page moved onto the origin after the route looked', async () => {
    const { host, tabs } = await sealedWorld();
    // The route's look (the status) says the viewed page is on the docs site; by the time its turn comes it is on the source site.
    tabs.pages = tabs.pages.map(page => (page.id === 'p1' ? { ...page, url: 'https://docs.example.test/' } : page));

    const agent = await host.request('POST', ACT, body({ action: 'read' }));

    should(agent.status).equal(403);
    should(agent.body).containEql('browser.read is refused');
  });

  it('should read a page no copy covers through the route, for an agent', async () => {
    const { host, tabs } = await sealedWorld();
    tabs.pages = tabs.pages.map(page => (page.id === 'p1' ? { ...page, url: 'https://docs.example.test/' } : page));
    tabs.documentHost = 'docs.example.test';

    const agent = await host.request('POST', ACT, body({ action: 'read' }));

    should(agent.status).equal(200);
  });

  it('should show an agent credential a closed page’s origin and no title in the status, and a person the whole of it', async () => {
    const { host } = await sealedWorld();

    const agent = await host.request('GET', ACT, asAgent);
    const person = await host.request('GET', ACT);

    should(agent.status).equal(200);
    should(agent.body).not.containEql(SENTINEL);
    should(agent.body).containEql('this page holds a sealed value');
    should(agent.body).containEql(`${SOURCE}/…`);
    should(person.body).containEql('/new?token=');
  });

  it('should answer a failure on a closed page with one fixed sentence, not the browser’s words', async () => {
    const { host, tabs } = await sealedWorld();
    tabs.automation.click = async () => {
      throw new Error(`strict mode violation: <input value="${SENTINEL}">`);
    };

    const agent = await host.request('POST', ACT, body({ action: 'click', selector: '#done' }));

    should(agent.status).be.aboveOrEqual(400);
    should(agent.body).not.containEql(SENTINEL);
    should(agent.body).not.containEql('strict mode');
    should(agent.body).containEql('does not pass on what the browser said');
  });

  it('should refuse a keyboard paste through the route while the clipboard could not be emptied, for an agent only', async () => {
    const { host, tabs, copy } = await built();
    await host.tool('browser_open', { name: 'form', url: 'https://form.example.test/' }, asAgent);
    await host.request('POST', ACT, { body: { action: 'activate-page', pageId: 'p1' }, ...asAgent });
    tabs.documentHost = 'form.example.test';
    tabs.clearAnswer = false;
    tabs.clipboardAnswer = { ok: false, reason: 'empty', kept: true };
    await copy.clipboardRead('f1' as FerretId, 'form', { seal: () => undefined });

    const agent = await host.request('POST', ACT, body({ action: 'press', keys: ['Control+V'] }));
    const person = await host.request('POST', ACT, { body: { action: 'press', keys: ['Control+V'] } });
    tabs.clearAnswer = true;
    const after = await host.request('POST', ACT, body({ action: 'press', keys: ['Control+V'] }));

    should(agent.status).equal(403);
    should(agent.body).containEql('keyboard paste is refused');
    should(person.status).equal(200);
    should(after.status).equal(200);
  });
});

describe('FINDING 1: the viewer socket’s pictures are an agent path, and meet the sealed gate', () => {
  const SOCKET = '/v1/sessions/f1/browser/stream';

  it('should refuse an agent credential’s stream while a sealed value lives, and let a person watch', async () => {
    const { host } = await sealedWorld();

    const agent = await host.socket(SOCKET, asAgent);
    const person = await host.socket(SOCKET);

    should(agent.response?.status).equal(403);
    should(agent.response?.body).containEql('closed to agents while a value sealed in this browser lives');
    should(person.response).equal(undefined);
    await person.handler?.close();
  });

  it('should open an agent’s stream when no copy lives', async () => {
    const { host } = await built();
    await host.tool('browser_open', { name: 'keys', url: `${SOURCE}/` }, asAgent);
    await host.request('POST', ACT, { body: { action: 'activate-page', pageId: 'p1' }, ...asAgent });

    const agent = await host.socket(SOCKET, asAgent);

    should(agent.response).equal(undefined);
    await agent.handler?.close();
  });
});

describe('FINDING 1: every frame leaves through one boundary, however its socket was reached', () => {
  const shot = { dataBase64: 'AAAA', width: 1, height: 1, pageId: 'p1' };

  function fixture(live: boolean, agent: boolean) {
    const sealed = new SealedPages();
    if (live) sealed.hold('f1', 'token', [SOURCE], () => Date.now() + 60_000);
    const gate = new SealedGate({ sealed, mask: async text => text });
    let deliver: ((frame: typeof shot) => void) | undefined;
    const host = {
      attachViewer: async (_session: string, onFrame: (frame: typeof shot) => void) => {
        deliver = onFrame;
        return { detach: () => undefined };
      },
    };
    const kernel = { act: async () => ({ ok: true as const, value: { kind: 'content' as const } }) };
    const viewer = heldViewerHost(kernel as never, host as never, agent ? gate : undefined);
    const frames: unknown[] = [];
    const ended: { code: number; reason: string }[] = [];
    return {
      async attach() {
        await viewer.attachViewer(
          'f1',
          each => frames.push(each),
          signal => ended.push(signal),
        );
        deliver?.(shot);
        await new Promise(resolve => setTimeout(resolve, 5));
      },
      frames,
      ended,
      sealed,
      send: () => deliver?.(shot),
    };
  }

  it('should deliver no frame to an agent’s viewer while a value lives, and end its stream with a sentence', async () => {
    const world = fixture(true, true);

    await world.attach();

    should(world.frames).eql([]);
    should(world.ended).have.length(1);
    should(world.ended[0]?.code).equal(1008);
    should(world.ended[0]?.reason).containEql('picture of a page cannot be masked');
  });

  it('should stop an already-connected agent stream the moment a value comes to live', async () => {
    const world = fixture(false, true);
    await world.attach();
    should(world.frames).have.length(1);

    world.sealed.hold('f1', 'token', [SOURCE], () => Date.now() + 60_000);
    world.send();
    await new Promise(resolve => setTimeout(resolve, 5));

    should(world.frames).have.length(1);
    should(world.ended).have.length(1);
  });

  it('should deliver every frame to a person’s viewer, whatever lives', async () => {
    const world = fixture(true, false);

    await world.attach();

    should(world.frames).have.length(1);
    should(world.ended).eql([]);
  });
});
