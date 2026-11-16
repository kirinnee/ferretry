import { describe, it } from 'bun:test';
import { APP_EVAL_REFUSAL, PAIRING_SCREEN_REFUSAL } from '@ferretry/std/pairing-screen';
import should from 'should';
import type { BrowserTools } from '../../../daemon/tools/service.ts';
import type { ToolCaller } from '../../../daemon/tools/types.ts';
import type { BrowserToolCall } from '../../../daemon/tools/wire.ts';
import { APP_ORIGIN, FAKE_CODE, pairingWorld } from '../../support/pairing-world.ts';

/**
 * FIX ROUND 2 (docs/pairing.md, "Never show it to an agent"): what the WORKER has counted across every page it has ever
 * watched — pairing links committed by origin, navigations it lost track of — and the one rule for an agent's script on
 * the app. The REAL runtime and tools over a faked browser; the code is the repo's fixed fake and never a minted one.
 */
const agent: ToolCaller = { kind: 'agent', sessionId: 's1' };
const DOCS = 'https://docs.example.test/';

const attempt = async (tools: BrowserTools, call: BrowserToolCall) =>
  await tools.call(agent, call).then(
    answer => ({ answer, error: undefined }),
    (error: unknown) => ({ answer: undefined, error: error as Error }),
  );

const READ_DOCS: BrowserToolCall = { tool: 'browser.read', name: 'docs' };
const openDocs = async (browser: Awaited<ReturnType<typeof pairingWorld>>['browser']) =>
  await browser.openPage('s1', 'docs', { openedBy: { by: 'agent', sessionId: 's1' }, url: DOCS });

describe('1: ANY change in the app-origin pairing commits discards the call, wherever it began and ended', () => {
  it('should discard a read on another origin when a link committed on the app meanwhile, with every endpoint off the app and no code live', async () => {
    // Arrange — outside -> app -> outside: the page, its frames and its history all look unchanged to the guard's group
    const { tabs, tools, browser } = await pairingWorld();
    await openDocs(browser);
    tabs.whileActing = acted => {
      if (acted.startsWith('read-')) tabs.totals = { links: { [APP_ORIGIN]: 1 }, lost: 0 };
    };

    // Act
    const { answer, error } = await attempt(tools, READ_DOCS);

    // Assert
    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should discard the ERROR of such a call too, so the failure says nothing of the page', async () => {
    const { tabs, tools, browser } = await pairingWorld();
    await openDocs(browser);
    tabs.whileActing = acted => {
      if (!acted.startsWith('read-')) return;
      tabs.totals = { links: { [APP_ORIGIN]: 1 }, lost: 0 };
      throw new Error(`the page said ${FAKE_CODE}`);
    };

    const { answer, error } = await attempt(tools, READ_DOCS);

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
    should(error?.message).not.containEql(FAKE_CODE);
  });

  it('should count a link on an opaque or unplaced origin, and the overflow bucket, as the app’s', async () => {
    for (const origin of ['null', '?', '*']) {
      const { tabs, tools, browser } = await pairingWorld();
      await openDocs(browser);
      tabs.whileActing = acted => {
        if (acted.startsWith('read-')) tabs.totals = { links: { [origin]: 2 }, lost: 0 };
      };

      const { answer, error } = await attempt(tools, READ_DOCS);

      should(answer).be.undefined();
      should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
    }
  });

  it('should answer when the counts did not move, and when the link was on an origin that is not the app’s', async () => {
    const { tabs, tools, browser } = await pairingWorld();
    await openDocs(browser);
    tabs.totals = { links: { [APP_ORIGIN]: 3 }, lost: 0 };
    tabs.whileActing = acted => {
      if (acted.startsWith('read-'))
        tabs.totals = { links: { [APP_ORIGIN]: 3, 'https://wiki.example.test': 1 }, lost: 0 };
    };

    const { answer, error } = await attempt(tools, READ_DOCS);

    should(error).be.undefined();
    should(answer?.output).equal('hello');
  });
});

describe('3: a navigation the browser lost is counted, and the blindness outlives the page that lost it', () => {
  it('should discard a read during which a navigation was lost, even on a page away from the app', async () => {
    const { tabs, tools, browser } = await pairingWorld();
    await openDocs(browser);
    tabs.whileActing = acted => {
      if (acted.startsWith('read-')) tabs.totals = { links: {}, lost: 1 };
    };

    const { answer, error } = await attempt(tools, READ_DOCS);

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should discard the loss even when the page that lost it left the group meanwhile', async () => {
    const { tabs, tools, browser } = await pairingWorld();
    const docs = await openDocs(browser);
    const wiki = await browser.openPage('s1', 'wiki', {
      openedBy: { by: 'agent', sessionId: 's1' },
      url: 'https://docs.example.test/other',
    });
    tabs.whileActing = acted => {
      if (!acted.startsWith('read-')) return;
      tabs.totals = { links: {}, lost: 1 };
      tabs.pages = tabs.pages.filter(page => page.id !== wiki.id);
    };

    const { answer, error } = await attempt(tools, { tool: 'browser.read', name: 'docs' });

    should(docs.id).not.equal(wiki.id);
    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should refuse the app’s pages while blind, with no code live, however empty or different the page group is', async () => {
    // Arrange — the browser lost a navigation once, in a page that is long gone
    const { tabs, tools, browser } = await pairingWorld();
    await openDocs(browser);
    tabs.totals = { links: {}, lost: 1 };

    // Act
    const app = await attempt(tools, { tool: 'browser.read', name: 'app' });
    const docs = await attempt(tools, READ_DOCS);

    // Assert — the app's content is refused; a page nowhere near the app still answers
    should(app.answer).be.undefined();
    should(app.error?.message).equal(PAIRING_SCREEN_REFUSAL);
    should(docs.answer?.output).equal('hello');
  });

  it('should stay blind for every later call and answer again only against a fresh, complete ledger', async () => {
    const { tabs, tools } = await pairingWorld();
    tabs.totals = { links: {}, lost: 4 };
    for (let round = 0; round < 3; round++) {
      const { error } = await attempt(tools, { tool: 'browser.read', name: 'app' });
      should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
    }

    // a fresh worker: nothing lost
    tabs.totals = { links: {}, lost: 0 };
    const read = await tools.call(agent, { tool: 'browser.read', name: 'app' });

    should(read.output).equal('hello');
  });

  it('should refuse the acts that find an element by what the page holds, on the app, while blind', async () => {
    const { tabs, tools } = await pairingWorld();
    tabs.totals = { links: {}, lost: 1 };

    const { answer, error } = await attempt(tools, { tool: 'browser.click', name: 'app', selector: '#code' });

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });
});

describe('4: an agent’s script is never run on a Ferretry app origin', () => {
  const EVAL: BrowserToolCall = { tool: 'browser.eval', name: 'app', function: '() => document.body.innerText' };

  it('should refuse it on the app with no code live, no history and no marker, and never reach the driver', async () => {
    const { tabs, tools } = await pairingWorld();

    const { answer, error } = await attempt(tools, EVAL);

    should(answer).be.undefined();
    should(error?.message).equal("eval is not available on Ferretry's own app pages");
    should(error?.message).equal(APP_EVAL_REFUSAL);
    should(tabs.calls.filter(call => call.startsWith('evaluate'))).eql([]);
  });

  it('should refuse it the same when the script would have wiped the marker and the counter (nothing the page says is asked)', async () => {
    const { tabs, tools, app } = await pairingWorld();
    tabs.pairing.set(app.id, { marked: false, seen: 0 });

    const { error } = await attempt(tools, {
      tool: 'browser.eval',
      name: 'app',
      function: "() => document.querySelectorAll('meta[name^=ferretry-pairing]').forEach(meta => meta.remove())",
    });

    should(error?.message).equal(APP_EVAL_REFUSAL);
    should(tabs.calls.filter(call => call.startsWith('evaluate'))).eql([]);
  });

  it('should refuse it on every Ferretry app origin Connections names, and on the daemon’s loopback app under a wildcard bind', async () => {
    const local = 'http://127.0.0.1:7077';
    const { tabs, tools } = await pairingWorld({ allowed: [APP_ORIGIN, local], appUrl: `${local}/` });

    const { error } = await attempt(tools, EVAL);

    should(error?.message).equal(APP_EVAL_REFUSAL);
    should(tabs.calls.filter(call => call.startsWith('evaluate'))).eql([]);
  });

  it('should refuse it when Connections cannot say which origins are the app’s (unknown is the app)', async () => {
    const { tabs, tools, browser } = await pairingWorld({ noConnections: true });
    await openDocs(browser);

    const { error } = await attempt(tools, { tool: 'browser.eval', name: 'docs', function: '() => 1' });

    should(error?.message).equal(APP_EVAL_REFUSAL);
    should(tabs.calls.filter(call => call.startsWith('evaluate'))).eql([]);
  });

  it('should refuse it when a related window of the page is on the app', async () => {
    const { tabs, tools, app, browser } = await pairingWorld();
    const popup = await browser.openPage('s1', 'popup', { openedBy: { by: 'agent', sessionId: 's1' }, url: DOCS });
    tabs.pages = tabs.pages.map(page => (page.id === popup.id ? { ...page, openerId: app.id } : page));

    const { error } = await attempt(tools, { tool: 'browser.eval', name: 'popup', function: '() => 1' });

    should(error?.message).equal(APP_EVAL_REFUSAL);
    should(tabs.calls.filter(call => call.startsWith('evaluate'))).eql([]);
  });

  it('should discard the answer and the error of a script on another origin that ended on the app', async () => {
    for (const fails of [false, true]) {
      const { tabs, tools, browser } = await pairingWorld();
      const docs = await openDocs(browser);
      tabs.whileActing = acted => {
        if (!acted.startsWith('evaluate')) return;
        tabs.pages = tabs.pages.map(page => (page.id === docs.id ? { ...page, url: `${APP_ORIGIN}/` } : page));
        if (fails) throw new Error(`boom ${FAKE_CODE}`);
      };

      const { answer, error } = await attempt(tools, { tool: 'browser.eval', name: 'docs', function: '() => 1' });

      should(answer).be.undefined();
      should(error?.message).equal(APP_EVAL_REFUSAL);
    }
  });

  it('should still run a script on another origin, with a code live and a page that has never been on the app', async () => {
    const { tools, browser, pairing, clock } = await pairingWorld();
    await openDocs(browser);
    pairing.open('pairing-1', clock.at + 120_000);

    const answer = await tools.call(agent, { tool: 'browser.eval', name: 'docs', function: '() => 1' });

    should(answer.summary).be.a.String();
  });

  it('should still answer the app’s reads and screenshots when nothing was live (what still works)', async () => {
    const { tools } = await pairingWorld();

    const read = await tools.call(agent, { tool: 'browser.read', name: 'app' });
    const shot = await tools.call(agent, { tool: 'browser.screenshot', name: 'app' });

    should(read.output).equal('hello');
    should(shot).not.be.undefined();
  });

  it('should leave a person’s own script alone: the rule is the agent’s', async () => {
    const { tabs, tools, app } = await pairingWorld();

    const answer = await tools.call({ kind: 'person', sessionId: 's1' }, EVAL);

    should(answer.summary).be.a.String();
    should(tabs.calls.filter(call => call.startsWith('evaluate'))).eql([`evaluate:${app.id}`]);
  });
});
