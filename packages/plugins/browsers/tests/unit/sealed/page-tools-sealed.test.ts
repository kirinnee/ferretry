import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import type { TestHost } from '@ferretry/kernel/testing';
import { ACT, asAgent, built, LIVE, type SealedWorld, SOURCE, sealedWorld } from '../../support/sealed-world.ts';
import type { FerretId } from '@ferretry/kernel/contract';

/**
 * R2 (secure-clip-2 fix round 2): the REAL exported `browser_type` and `browser_fill_form` handlers (not a stand-in call to
 * BrowserTools) meet the sealed gate: content-dependent and unproven selectors are refused, what they answer on a failure is
 * the common gated sentence, and the listing/status metadata is frame-aware. Fake values only.
 */
const SENTINEL = 'FAKE-SC-7f3a91';
const ENCODED = btoa(SENTINEL);

let world: SealedWorld | undefined;
afterEach(async () => {
  await (world?.host as TestHost | undefined)?.stop();
  world = undefined;
});

describe('R2: browser_type and browser_fill_form go through the sealed gate', () => {
  it('should refuse browser_type with a selector that depends on what the page says, typing nothing', async () => {
    world = await sealedWorld(SENTINEL);
    const answer = await world.host.tool('browser_type', { name: 'keys', selector: 'text=Copy', text: 'x' }, asAgent);

    should(answer.isError).equal(true);
    should(answer.text).containEql('depends on what the page says');
    should(world.tabs.typed).eql([]);
  });

  it('should refuse browser_fill_form when ANY field names such a selector, filling none', async () => {
    world = await sealedWorld(SENTINEL);
    const answer = await world.host.tool(
      'browser_fill_form',
      {
        name: 'keys',
        fields: [
          { selector: '#a', text: 'x' },
          { selector: 'button:has-text("Save")', text: 'y' },
        ],
      },
      asAgent,
    );

    should(answer.isError).equal(true);
    should(answer.text).containEql('depends on what the page says');
    should(world.tabs.typed).eql([]);
  });

  it('should refuse a selector it cannot prove structural (fail closed), for type and for fill', async () => {
    world = await sealedWorld(SENTINEL);
    for (const selector of ['input:focus', 'div:empty', 'a:is(.x)', '"quoted text"']) {
      const typed = await world.host.tool('browser_type', { name: 'keys', selector, text: 'x' }, asAgent);
      const filled = await world.host.tool(
        'browser_fill_form',
        { name: 'keys', fields: [{ selector, text: 'x' }] },
        asAgent,
      );
      should(typed.isError).equal(true);
      should(filled.isError).equal(true);
    }
    should(world.tabs.typed).eql([]);
  });

  it('should still type into an element named by structure so the agent can finish', async () => {
    world = await sealedWorld(SENTINEL);
    const answer = await world.host.tool('browser_type', { name: 'keys', selector: '#done', text: 'x' }, asAgent);

    should(answer.isError).not.equal(true);
    should(world.tabs.typed).have.length(1);
  });

  it('should answer a failure of browser_type on a closed page with one fixed sentence, never the page’s words in any form', async () => {
    world = await sealedWorld(SENTINEL);
    world.tabs.automation.type = async () => {
      throw new Error(`strict mode violation: <input value="${ENCODED}"> ${SENTINEL.split('').join(' ')}`);
    };

    const answer = await world.host.tool('browser_type', { name: 'keys', selector: '#done', text: 'x' }, asAgent);

    should(answer.isError).equal(true);
    should(answer.text).not.containEql(ENCODED);
    should(answer.text).not.containEql('strict mode');
    should(answer.text).containEql('does not pass on what the browser said');
  });

  it('should answer a failure of browser_fill_form on a page a FRAME of which holds the value with the same fixed sentence', async () => {
    world = await built();
    await world.host.tool('browser_open', { name: 'dash', url: 'https://dash.example.test/' }, asAgent);
    await world.host.request('POST', ACT, { body: { action: 'activate-page', pageId: 'p1' }, ...asAgent });
    world.tabs.documentHost = 'dash.example.test';
    world.tabs.frameHosts = ['keys.example.test'];
    world.copy.sealed.hold('f1' as FerretId, 'token', [SOURCE], LIVE);
    // A form fill runs through the browser's pointer seam.
    world.tabs.automation.pointer = async () => {
      throw new Error(`no element <b>${ENCODED}</b>`);
    };

    const answer = await world.host.tool(
      'browser_fill_form',
      { name: 'dash', fields: [{ selector: '#a', text: 'x' }] },
      asAgent,
    );

    should(answer.isError).equal(true);
    should(answer.text).not.containEql(ENCODED);
    should(answer.text).containEql('does not pass on what the browser said');
  });

  it('should keep an uncovered page’s errors as they were, so the agent can fix its selector', async () => {
    world = await built();
    await world.host.tool('browser_open', { name: 'dash', url: 'https://dash.example.test/' }, asAgent);
    world.tabs.documentHost = 'dash.example.test';
    world.copy.sealed.hold('f1' as FerretId, 'token', [SOURCE], LIVE);
    world.tabs.automation.type = async () => {
      throw new Error('the selector #nope matched nothing');
    };

    const answer = await world.host.tool('browser_type', { name: 'dash', selector: '#nope', text: 'x' }, asAgent);

    should(answer.isError).equal(true);
    should(answer.text).containEql('matched nothing');
  });
});

describe('R2: the listing and status metadata is frame-aware', () => {
  async function framed(): Promise<SealedWorld> {
    const made = await built();
    await made.host.tool('browser_open', { name: 'dash', url: 'https://dash.example.test/inbox' }, asAgent);
    await made.host.request('POST', ACT, { body: { action: 'activate-page', pageId: 'p1' }, ...asAgent });
    made.tabs.documentHost = 'dash.example.test';
    made.tabs.frameHosts = ['keys.example.test'];
    made.tabs.pages = made.tabs.pages.map(page =>
      page.id === 'p1'
        ? { ...page, url: `https://dash.example.test/inbox?k=${ENCODED}`, title: `Key ${ENCODED}` }
        : page,
    );
    made.copy.sealed.hold('f1' as FerretId, 'token', [SOURCE], LIVE);
    return made;
  }

  it('should list a page whose FRAME is on the copy’s site by origin only, with no title or path', async () => {
    world = await framed();
    const list = await world.host.tool('browser_list', {}, asAgent);
    const tabs = await world.host.tool('browser_tabs', { action: 'list' }, asAgent);

    for (const answer of [list, tabs]) {
      should(answer.text).not.containEql(ENCODED);
      should(JSON.stringify(answer)).not.containEql(ENCODED);
    }
  });

  it('should show the HTTP status of that page to an agent without title or path, and to a person whole', async () => {
    world = await framed();
    const agent = await world.host.request('GET', ACT, asAgent);
    const person = await world.host.request('GET', ACT);

    should(agent.body).not.containEql(ENCODED);
    should(person.body).containEql(ENCODED);
  });
});
