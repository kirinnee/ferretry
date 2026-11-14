import { describe, it } from 'bun:test';
import { PAIRING_SCREEN_REFUSAL } from '@ferretry/std/pairing-screen';
import should from 'should';
import type { BrowserTools } from '../../../daemon/tools/service.ts';
import type { ToolCaller } from '../../../daemon/tools/types.ts';
import type { BrowserToolCall } from '../../../daemon/tools/wire.ts';
import { APP_ORIGIN, FAKE_CODE, pairingWorld, START } from '../../support/pairing-world.ts';
import { cleanNavigation, type Tabs } from '../../support/tabs.ts';

/**
 * THE EVIDENCE A PAIRING SCREEN IS PROTECTED BY IS NOT IN THE PAGE (docs/pairing.md, "Never show it to an agent").
 *
 * The REAL runtime and tools over a faked browser, with the daemon's own ledgers of when a pairing code or a share invite
 * was live and the browser's own navigation evidence per page. The DOM marker is deliberately WRONG in most cases here —
 * absent, forged to zero, deleted — because a page script can write it: the daemon's facts still hold. The code is the
 * repo's fixed fake and never a minted one.
 */
const agent: ToolCaller = { kind: 'agent', sessionId: 's1' };
const SECOND = 1_000;

const attempt = async (tools: BrowserTools, call: BrowserToolCall) =>
  await tools.call(agent, call).then(
    answer => ({ answer, error: undefined }),
    (error: unknown) => ({ answer: undefined, error: error as Error }),
  );

const CONTENT_CALLS = /^(read|screenshot|pointer-highlight|pdf|evaluate|lifecycle-(console|network|wait))/u;
const contentCalls = (tabs: Tabs): string[] => tabs.calls.filter(call => CONTENT_CALLS.test(call));

const READS: readonly BrowserToolCall[] = [
  { tool: 'browser.read', name: 'app' },
  { tool: 'browser.read', name: 'app', mode: 'snapshot' },
  { tool: 'browser.screenshot', name: 'app' },
  { tool: 'browser.highlight', name: 'app', selector: '#code' },
  { tool: 'browser.pdf', name: 'app' },
  { tool: 'browser.console', name: 'app' },
  { tool: 'browser.network', name: 'app', action: 'list' },
  { tool: 'browser.wait_for', name: 'app', text: FAKE_CODE },
];

describe('P1-1: the authority is the daemon’s live window, not the page’s marker', () => {
  it('should refuse every read while a pairing code is live even when the page script deleted or forged its marker', async () => {
    // Arrange — the page reports no marker and a sighting count of zero, as a page script can make it
    const { tabs, tools, app, pairing, clock } = await pairingWorld();
    pairing.open('pairing-1', clock.at + 120 * SECOND);
    tabs.pairing.set(app.id, { marked: false, seen: 0 });

    for (const call of READS) {
      // Act
      const { answer, error } = await attempt(tools, call);

      // Assert
      should(answer).be.undefined();
      should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
      should(error?.message).not.containEql(FAKE_CODE);
    }
    should(contentCalls(tabs)).eql([]);
  });

  it('should refuse while a share invite is live, which is a credential of its own', async () => {
    const { tabs, tools, share, clock } = await pairingWorld();
    share.open('shr_1', clock.at + 3_600 * SECOND);

    const { answer, error } = await attempt(tools, { tool: 'browser.read', name: 'app' });

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
    should(contentCalls(tabs)).eql([]);
  });

  it('should answer again once the code is over and nothing in the call overlapped it', async () => {
    const { tools, pairing, clock } = await pairingWorld();
    pairing.open('pairing-1', clock.at + 120 * SECOND);
    clock.at += 10 * SECOND;
    pairing.close('pairing-1');
    clock.at += SECOND;

    const read = await tools.call(agent, { tool: 'browser.read', name: 'app' });

    should(read.output).equal('hello');
  });

  it('should discard a read that a code was minted DURING, and one that was minted and spent during it', async () => {
    for (const spent of [false, true]) {
      // Arrange — nothing is live when the read starts; the code appears in the middle of it and may be gone by the end
      const { tabs, tools, pairing, clock } = await pairingWorld();
      tabs.whileActing = acted => {
        if (!acted.startsWith('read-')) return;
        pairing.open('pairing-1', clock.at + 120 * SECOND);
        clock.at += SECOND;
        if (spent) pairing.close('pairing-1');
        clock.at += SECOND;
      };

      // Act
      const { answer, error } = await attempt(tools, { tool: 'browser.read', name: 'app' });

      // Assert
      should(answer).be.undefined();
      should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
    }
  });

  it('should not touch a page on another origin while a code is live', async () => {
    const { tools, pairing, clock, browser } = await pairingWorld();
    await browser.openPage('s1', 'docs', {
      openedBy: { by: 'agent', sessionId: 's1' },
      url: 'https://docs.example.test/',
    });
    pairing.open('pairing-1', clock.at + 120 * SECOND);

    const read = await tools.call(agent, { tool: 'browser.read', name: 'docs' });

    should(read.output).equal('hello');
  });

  it('should FAIL CLOSED when a provider is not there, but only for the app’s own pages', async () => {
    for (const missing of [{ noPairingWindow: true }, { noShareWindow: true }] as const) {
      const { tools, browser } = await pairingWorld(missing);
      await browser.openPage('s1', 'docs', {
        openedBy: { by: 'agent', sessionId: 's1' },
        url: 'https://docs.example.test/',
      });

      const app = await attempt(tools, { tool: 'browser.read', name: 'app' });
      const docs = await attempt(tools, { tool: 'browser.read', name: 'docs' });

      should(app.error?.message).equal(PAIRING_SCREEN_REFUSAL);
      should(docs.answer?.output).equal('hello');
    }
  });

  it('should take the app’s origins from what Connections advertises, not from one hard-coded address', async () => {
    // Arrange — a local listener the machine advertises; the page is on it, and it is NOT the hosted origin
    const local = 'http://127.0.0.1:7077';
    const { tools, pairing, clock } = await pairingWorld({ allowed: [APP_ORIGIN, local], appUrl: `${local}/` });
    pairing.open('pairing-1', clock.at + 120 * SECOND);

    const { answer, error } = await attempt(tools, { tool: 'browser.read', name: 'app' });

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should take every page for the app’s when Connections cannot say (unknown is the app)', async () => {
    const { tools, pairing, clock, browser } = await pairingWorld({ noConnections: true });
    await browser.openPage('s1', 'docs', {
      openedBy: { by: 'agent', sessionId: 's1' },
      url: 'https://docs.example.test/',
    });
    pairing.open('pairing-1', clock.at + 120 * SECOND);

    const { answer, error } = await attempt(tools, { tool: 'browser.read', name: 'docs' });

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should refuse a page when another window of the SAME origin with no opener link shows the (hint) marker', async () => {
    // Arrange — v4's rule: every same-origin window can reach the document, opener or not
    const { tabs, tools, browser } = await pairingWorld();
    await browser
      .openPage('s1', 'second', { openedBy: { by: 'agent', sessionId: 's1' }, url: `${APP_ORIGIN}/other` })
      .then(second => {
        tabs.pairing.set(second.id, { marked: true, seen: 1 });
      });

    const { answer, error } = await attempt(tools, { tool: 'browser.read', name: 'app' });

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });
});

describe('P1-1: a navigation or a swapped frame during a call is seen', () => {
  it('should discard a read that began on another origin and was moved onto the app while a code was live', async () => {
    // Arrange
    const { tabs, tools, browser, pairing, clock } = await pairingWorld();
    const docs = await browser.openPage('s1', 'docs', {
      openedBy: { by: 'agent', sessionId: 's1' },
      url: 'https://docs.example.test/',
    });
    pairing.open('pairing-1', clock.at + 120 * SECOND);
    tabs.whileActing = acted => {
      if (!acted.startsWith('read-')) return;
      const nav = cleanNavigation('https://docs.example.test/', 0);
      tabs.navigation.set(docs.id, {
        ...nav,
        seq: 2,
        origins: [...nav.origins, { origin: APP_ORIGIN, firstAt: clock.at, lastSeq: 2 }],
        frames: [APP_ORIGIN],
      });
    };

    // Act
    const { answer, error } = await attempt(tools, { tool: 'browser.read', name: 'docs' });

    // Assert
    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should discard a read that began on the app and was moved away while a code appeared (the document is gone, the history is not)', async () => {
    const { tabs, tools, app, pairing, clock } = await pairingWorld();
    tabs.whileActing = acted => {
      if (!acted.startsWith('read-')) return;
      pairing.open('pairing-1', clock.at + 120 * SECOND);
      const nav = cleanNavigation(`${APP_ORIGIN}/`, 0);
      tabs.navigation.set(app.id, {
        ...nav,
        seq: 2,
        origins: [...nav.origins, { origin: 'https://docs.example.test', firstAt: clock.at, lastSeq: 2 }],
        frames: ['https://docs.example.test'],
      });
    };

    const { answer, error } = await attempt(tools, { tool: 'browser.read', name: 'app' });

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should discard a read when a frame of the app was swapped in and out of a docs page during it', async () => {
    const { tabs, tools, browser, pairing, clock } = await pairingWorld();
    const docs = await browser.openPage('s1', 'docs', {
      openedBy: { by: 'agent', sessionId: 's1' },
      url: 'https://docs.example.test/',
    });
    pairing.open('pairing-1', clock.at + 120 * SECOND);
    tabs.whileActing = acted => {
      if (!acted.startsWith('read-')) return;
      const nav = cleanNavigation('https://docs.example.test/', 0);
      // attached (seq 2), navigated to the app (seq 3), detached (seq 4): the frame is gone by the time anyone looks
      tabs.navigation.set(docs.id, {
        ...nav,
        seq: 4,
        origins: [...nav.origins, { origin: APP_ORIGIN, firstAt: clock.at, lastSeq: 3 }],
        frames: ['https://docs.example.test'],
      });
    };

    const { answer, error } = await attempt(tools, { tool: 'browser.read', name: 'docs' });

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should answer a read that moved between two other origins with no code live (a navigation alone is not a refusal)', async () => {
    const { tabs, tools, browser } = await pairingWorld();
    const docs = await browser.openPage('s1', 'docs', {
      openedBy: { by: 'agent', sessionId: 's1' },
      url: 'https://docs.example.test/',
    });
    tabs.whileActing = acted => {
      if (!acted.startsWith('read-')) return;
      const nav = cleanNavigation('https://docs.example.test/', 0);
      tabs.navigation.set(docs.id, {
        ...nav,
        seq: 2,
        origins: [...nav.origins, { origin: 'https://wiki.example.test', firstAt: START, lastSeq: 2 }],
        frames: ['https://wiki.example.test'],
      });
    };

    const read = await tools.call(agent, { tool: 'browser.read', name: 'docs' });

    should(read.output).equal('hello');
  });

  it('should refuse when a window of the group that had been on the app closed during the call and a code is live', async () => {
    const { tabs, tools, app, browser, pairing, clock } = await pairingWorld();
    const popup = await browser.openPage('s1', 'popup', {
      openedBy: { by: 'agent', sessionId: 's1' },
      url: `${APP_ORIGIN}/pair`,
    });
    tabs.pages = tabs.pages.map(page => (page.id === popup.id ? { ...page, openerId: app.id } : page));
    pairing.open('pairing-1', clock.at + 120 * SECOND);
    tabs.whileActing = acted => {
      if (acted.startsWith('read-')) tabs.pages = tabs.pages.filter(page => page.id !== popup.id);
    };

    const { answer, error } = await attempt(tools, { tool: 'browser.read', name: 'app' });

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should NOT refuse an act on a page away from the app whose click opened a window, even with a code live', async () => {
    const { tabs, tools, browser, pairing, clock } = await pairingWorld();
    const docs = await browser.openPage('s1', 'docs', {
      openedBy: { by: 'agent', sessionId: 's1' },
      url: 'https://docs.example.test/',
    });
    pairing.open('pairing-1', clock.at + 120 * SECOND);
    tabs.whileActing = acted => {
      if (acted.startsWith('read-')) tabs.pages = [...tabs.pages, { ...docs, id: 'popup-away', name: undefined }];
    };

    const { answer, error } = await attempt(tools, { tool: 'browser.read', name: 'docs' });

    should(error).be.undefined();
    should(answer).not.be.undefined();
  });
});

describe('P1-1: a pairing link committed in any frame', () => {
  it('should refuse a read of a page still on the app a pairing link arrived on, with no code live and no marker', async () => {
    const { tabs, tools, app } = await pairingWorld();
    tabs.navigation.set(app.id, { ...cleanNavigation(`${APP_ORIGIN}/`, 0), seq: 2, taintSeq: 2 });

    const { answer, error } = await attempt(tools, { tool: 'browser.read', name: 'app' });

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should refuse a read during which a link of the pairing grammar was committed, wherever the page went after', async () => {
    const { tabs, tools, browser } = await pairingWorld();
    const docs = await browser.openPage('s1', 'docs', {
      openedBy: { by: 'agent', sessionId: 's1' },
      url: 'https://docs.example.test/',
    });
    tabs.whileActing = acted => {
      if (acted.startsWith('read-'))
        tabs.navigation.set(docs.id, { ...cleanNavigation('https://docs.example.test/', 0), seq: 3, taintSeq: 2 });
    };

    const { answer, error } = await attempt(tools, { tool: 'browser.read', name: 'docs' });

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });
});

describe('P1-2: a script outlives its own answer, so it is refused for the page’s life', () => {
  const EVAL: BrowserToolCall = { tool: 'browser.eval', name: 'app', function: '() => document.body.innerText' };

  it('should refuse a script on an app page while a code is live, running nothing', async () => {
    const { tabs, tools, pairing, clock } = await pairingWorld();
    pairing.open('pairing-1', clock.at + 120 * SECOND);

    const { answer, error } = await attempt(tools, EVAL);

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
    should(tabs.calls.filter(call => call.startsWith('evaluate'))).eql([]);
  });

  it('should STILL refuse a script on that page after the code is over: a callback it left behind could be reading the next', async () => {
    const { tabs, tools, pairing, clock } = await pairingWorld();
    pairing.open('pairing-1', clock.at + 120 * SECOND);
    clock.at += 10 * SECOND;
    pairing.close('pairing-1');
    clock.at += 10 * SECOND;

    const { answer, error } = await attempt(tools, EVAL);

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
    should(tabs.calls.filter(call => call.startsWith('evaluate'))).eql([]);
  });

  it('should still let a READ of that page answer once the code is over, which is what still works', async () => {
    const { tools, pairing, clock } = await pairingWorld();
    pairing.open('pairing-1', clock.at + 120 * SECOND);
    clock.at += 10 * SECOND;
    pairing.close('pairing-1');
    clock.at += 10 * SECOND;

    const read = await tools.call(agent, { tool: 'browser.read', name: 'app' });

    should(read.output).equal('hello');
  });

  it('should allow a script on an app page no code has been live since it showed the app', async () => {
    const { tabs, tools, app, pairing, clock } = await pairingWorld();
    pairing.open('pairing-1', clock.at);
    clock.at += SECOND;
    pairing.close('pairing-1');
    clock.at += 10 * SECOND;
    // the page first committed the app AFTER the code was over
    tabs.navigation.set(app.id, {
      ...cleanNavigation(`${APP_ORIGIN}/`, clock.at - 5 * SECOND),
      watchedSince: clock.at - 6 * SECOND,
    });

    const answer = await tools.call(agent, EVAL);

    should(answer.summary).be.a.String();
  });

  it('should allow a script on a page that has never been on an app origin, whatever is live', async () => {
    const { tools, browser, pairing, clock } = await pairingWorld();
    await browser.openPage('s1', 'docs', {
      openedBy: { by: 'agent', sessionId: 's1' },
      url: 'https://docs.example.test/',
    });
    pairing.open('pairing-1', clock.at + 120 * SECOND);

    const answer = await tools.call(agent, { tool: 'browser.eval', name: 'docs', function: '() => 1' });

    should(answer.summary).be.a.String();
  });

  it('should refuse a script for the rest of a page’s life once a pairing link was committed in it, even after it moved on', async () => {
    const { tabs, tools, browser } = await pairingWorld();
    const docs = await browser.openPage('s1', 'docs', {
      openedBy: { by: 'agent', sessionId: 's1' },
      url: 'https://docs.example.test/',
    });
    tabs.navigation.set(docs.id, { ...cleanNavigation('https://docs.example.test/', 0), seq: 3, taintSeq: 2 });

    const { answer, error } = await attempt(tools, { tool: 'browser.eval', name: 'docs', function: '() => 1' });

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should refuse a script in a page whose same-origin window is on the app and has had a code, with the page itself clean', async () => {
    const { tabs, tools, app, browser, pairing, clock } = await pairingWorld();
    const popup = await browser.openPage('s1', 'popup', {
      openedBy: { by: 'agent', sessionId: 's1' },
      url: 'https://docs.example.test/',
    });
    tabs.pages = tabs.pages.map(page => (page.id === popup.id ? { ...page, openerId: app.id } : page));
    pairing.open('pairing-1', clock.at);
    clock.at += SECOND;
    pairing.close('pairing-1');
    clock.at += 10 * SECOND;

    const { answer, error } = await attempt(tools, { tool: 'browser.eval', name: 'popup', function: '() => 1' });

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });
});

describe('P1-3: an act that finds its element by what the page holds is a read of it', () => {
  const GUARDED: readonly BrowserToolCall[] = [
    { tool: 'browser.scroll', name: 'app', text: FAKE_CODE },
    { tool: 'browser.scroll', name: 'app', selector: '#code' },
    { tool: 'browser.click', name: 'app', selector: '#code' },
    { tool: 'browser.click', name: 'app', ref: 'e12' },
    { tool: 'browser.hover', name: 'app', selector: '#code' },
    { tool: 'browser.drag', name: 'app', fromSelector: '#code', toSelector: '#target' },
    { tool: 'browser.select', name: 'app', selector: '#code', values: ['a'] },
    { tool: 'browser.check', name: 'app', selector: '#code', checked: true },
    { tool: 'browser.type', name: 'app', selector: '#code', text: 'x' },
    { tool: 'browser.press', name: 'app', keys: ['Enter'], selector: '#code' },
    { tool: 'browser.fill_form', name: 'app', fields: [{ selector: '#code', value: 'x' }] as never },
    { tool: 'browser.wait_for', name: 'app', selector: '#code' },
  ];
  const LEFT_ALONE: readonly BrowserToolCall[] = [
    { tool: 'browser.click', name: 'app', x: 10, y: 10 },
    { tool: 'browser.hover', name: 'app', x: 10, y: 10 },
    { tool: 'browser.scroll', name: 'app', deltaY: 200 },
    { tool: 'browser.press', name: 'app', keys: ['Escape'] },
    { tool: 'browser.wait_for', name: 'app', time: 100 },
    { tool: 'browser.navigate', name: 'app', url: 'https://docs.example.test/' },
  ];

  it('should refuse every one of them on an app page while a code is live, before any of them reaches the page', async () => {
    const { tabs, tools, pairing, clock } = await pairingWorld();
    pairing.open('pairing-1', clock.at + 120 * SECOND);

    for (const call of GUARDED) {
      const { answer, error } = await attempt(tools, call);

      should(answer).be.undefined();
      should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
    }
    should(tabs.calls.filter(call => call.startsWith('pointer-') || call.startsWith('lifecycle-wait'))).eql([]);
  });

  it('should leave the ones that read nothing of the page alone while a code is live', async () => {
    for (const call of LEFT_ALONE) {
      const { tools, pairing, clock } = await pairingWorld();
      pairing.open('pairing-1', clock.at + 120 * SECOND);

      const { error } = await attempt(tools, call);

      should(error?.message).not.equal(PAIRING_SCREEN_REFUSAL);
    }
  });

  it('should say nothing of why a scroll-to-text failed when a code came up during it: not "that text is not on the page"', async () => {
    const { tabs, tools, pairing, clock } = await pairingWorld();
    tabs.whileActing = acted => {
      if (!acted.startsWith('pointer-')) return;
      pairing.open('pairing-1', clock.at + 120 * SECOND);
      throw new Error('that text is not on the page');
    };

    const { answer, error } = await attempt(tools, { tool: 'browser.scroll', name: 'app', text: FAKE_CODE });

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should answer the same acts normally when nothing was ever live', async () => {
    const { tools } = await pairingWorld();

    for (const call of GUARDED.filter(each => each.tool !== 'browser.fill_form')) {
      const { error } = await attempt(tools, call);

      should(error?.message).not.equal(PAIRING_SCREEN_REFUSAL);
    }
  });
});

describe('P2: evidence the browser did not give is refused', () => {
  it('should refuse a read when the browser gave no navigation evidence for the page', async () => {
    const { tabs, tools, app } = await pairingWorld();
    tabs.navigationBroken.add(app.id);

    const { answer, error } = await attempt(tools, { tool: 'browser.read', name: 'app' });

    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });
});
