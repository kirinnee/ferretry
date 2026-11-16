import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { ACT, asAgent, built, type SealedWorld, sealedWorld } from '../../support/sealed-world.ts';

/**
 * R5 (secure-clip-2 fix round 2): an AGENT's URL action over the Browsers HTTP route takes only http(s), for every URL alias
 * (`open`, `navigate`, `new-page`), before anything is dispatched: the same rule the MCP tools hold. A person's is unchanged.
 */
const SENTINEL = 'FAKE-SC-7f3a91';
const SCRIPT_URLS = [
  'javascript:alert(1)',
  'JavaScript:void(0)',
  'data:text/html,<b>x</b>',
  'file:///etc/hostname',
  'chrome://settings',
  'about:blank',
  'blob:https://keys.example.test/abc',
];

let world: SealedWorld | undefined;
afterEach(async () => {
  await world?.host.stop();
  world = undefined;
});

describe('R5: agent URL actions over HTTP take only http and https', () => {
  for (const action of ['navigate', 'open', 'new-page'] as const)
    for (const url of SCRIPT_URLS)
      it(`should refuse an agent's ${action} to ${url} before dispatch, on a page that holds a sealed value`, async () => {
        world = await sealedWorld(SENTINEL);
        const before = [...world.tabs.calls];

        const agent = await world.host.request('POST', ACT, { body: { action, url }, ...asAgent });

        should(agent.status).equal(400);
        should(agent.body).containEql('only http and https URLs');
        should(agent.body).not.containEql(SENTINEL);
        should(world.tabs.calls).eql(before);
      });

  it('should refuse them with no sealed value too: the rule is the transport’s, not the gate’s', async () => {
    world = await built();
    await world.host.tool('browser_open', { name: 'dash', url: 'https://dash.example.test/' }, asAgent);
    const before = [...world.tabs.calls];

    const agent = await world.host.request('POST', ACT, {
      body: { action: 'navigate', url: 'javascript:alert(1)' },
      ...asAgent,
    });

    should(agent.status).equal(400);
    should(world.tabs.calls).eql(before);
  });

  it('should still let an agent go to an http(s) address', async () => {
    world = await built();
    await world.host.tool('browser_open', { name: 'dash', url: 'https://dash.example.test/' }, asAgent);

    const https = await world.host.request('POST', ACT, {
      body: { action: 'navigate', url: 'https://docs.example.test/' },
      ...asAgent,
    });
    const http = await world.host.request('POST', ACT, {
      body: { action: 'new-page', url: 'http://docs.example.test/' },
      ...asAgent,
    });

    should(https.status).equal(200);
    should(http.status).equal(200);
  });

  it('should leave a PERSON’s own navigation as it was', async () => {
    world = await built();
    await world.host.tool('browser_open', { name: 'dash', url: 'https://dash.example.test/' }, asAgent);

    const person = await world.host.request('POST', ACT, { body: { action: 'navigate', url: 'about:blank' } });

    should(person.status).equal(200);
  });
});
