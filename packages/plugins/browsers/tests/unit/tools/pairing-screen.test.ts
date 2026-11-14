import { describe, it } from 'bun:test';
import { PAIRING_SCREEN_REFUSAL } from '@ferretry/std/pairing-screen';
import should from 'should';
import type { BrowserTools } from '../../../daemon/tools/service.ts';
import type { ToolCaller } from '../../../daemon/tools/types.ts';
import type { BrowserToolCall } from '../../../daemon/tools/wire.ts';
import { FAKE_CODE, pairingWorld } from '../../support/pairing-world.ts';
import type { Tabs } from '../../support/tabs.ts';

/**
 * AN AGENT NEVER READS A PAGE THAT SHOWS A LIVE PAIRING CODE (docs/pairing.md, "Never show it to an agent").
 *
 * The REAL runtime and the REAL tools over a faked browser (`Tabs`) whose pages say, as the worker's DOM search would,
 * whether the app's marker is in them and how many codes they have shown. The code is the repo's fixed fake and never a
 * minted one.
 */
const agent: ToolCaller = { kind: 'agent', sessionId: 's1' };
const person: ToolCaller = { kind: 'person', sessionId: 's1', openedBy: { by: 'local' } };

/** The browser calls that would put a page's content in front of the caller. */
const CONTENT_CALLS = /^(read|screenshot|pointer-highlight|pdf|evaluate|lifecycle-(console|network|wait))/u;

const world = pairingWorld;

/** A call's refusal, or the answer when it was not refused. */
const attempt = async (tools: BrowserTools, caller: ToolCaller, call: BrowserToolCall) =>
  await tools.call(caller, call).then(
    answer => ({ answer, error: undefined }),
    (error: unknown) => ({ answer: undefined, error: error as Error }),
  );

const contentCalls = (tabs: Tabs): string[] => tabs.calls.filter(call => CONTENT_CALLS.test(call));

const READS: readonly BrowserToolCall[] = [
  { tool: 'browser.read', name: 'app' },
  { tool: 'browser.read', name: 'app', mode: 'snapshot' },
  { tool: 'browser.read', name: 'app', mode: 'a11y' },
  { tool: 'browser.screenshot', name: 'app' },
  { tool: 'browser.highlight', name: 'app', selector: '#code' },
  { tool: 'browser.pdf', name: 'app' },
  { tool: 'browser.eval', name: 'app', function: '() => document.body.innerText' },
  { tool: 'browser.console', name: 'app' },
  { tool: 'browser.network', name: 'app', action: 'list' },
  { tool: 'browser.network', name: 'app', action: 'get', id: 'r1' },
];

describe('a page showing a live pairing code, read by an agent', () => {
  it('should refuse every read, picture and script of it with the one sentence, before anything reaches the page', async () => {
    // Arrange
    const { tabs, tools, app } = await world();
    tabs.pairing.set(app.id, { marked: true, seen: 1 });

    for (const call of READS) {
      // Act
      const { answer, error } = await attempt(tools, agent, call);

      // Assert
      should(answer).be.undefined();
      should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
      should(error?.message).startWith('hidden: this page shows a pairing code');
      should(error?.message).not.containEql(FAKE_CODE);
    }
    should(contentCalls(tabs)).eql([]);
  });

  it('should answer the same calls once the page carries no marker', async () => {
    // Arrange
    const { tabs, tools, app } = await world();
    tabs.pairing.set(app.id, { marked: false, seen: 3 });

    // Act
    const read = await tools.call(agent, { tool: 'browser.read', name: 'app' });
    const shot = await tools.call(agent, { tool: 'browser.screenshot', name: 'app' });
    const script = await tools.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' });

    // Assert
    should(read.output).equal('hello');
    should(shot.picture?.bytes.byteLength).be.above(0);
    should(script.summary).be.a.String();
  });

  it('should FAIL CLOSED when the browser cannot say whether the page is marked', async () => {
    // Arrange
    const { tabs, tools } = await world();
    tabs.documentFails = true;

    for (const call of READS) {
      // Act
      const { answer, error } = await attempt(tools, agent, call);

      // Assert
      should(answer).be.undefined();
      should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
    }
    should(contentCalls(tabs)).eql([]);
  });

  it('should let an agent leave the page: navigating and closing still work', async () => {
    // Arrange
    const { tabs, tools, app } = await world();
    tabs.pairing.set(app.id, { marked: true, seen: 1 });

    // Act
    const navigated = await tools.call(agent, {
      tool: 'browser.navigate',
      name: 'app',
      url: 'https://docs.example.test/',
    });
    const closed = await tools.call(agent, { tool: 'browser.close', name: 'app' });

    // Assert
    should(navigated.summary).be.a.String();
    should(closed.summary).be.a.String();
  });

  it('should leave a person’s own reads of it untouched', async () => {
    // Arrange
    const { tabs, tools, app } = await world();
    tabs.pairing.set(app.id, { marked: true, seen: 1 });

    // Act
    const read = await tools.call(person, { tool: 'browser.read', name: 'app' });
    const shot = await tools.call(person, { tool: 'browser.screenshot', name: 'app' });

    // Assert
    should(read.output).equal('hello');
    should(shot.picture?.bytes.byteLength).be.above(0);
  });
});

describe('P1-1: a wait on what a page shows is a read of it', () => {
  const CONTENT_WAITS: readonly BrowserToolCall[] = [
    { tool: 'browser.wait_for', name: 'app', text: FAKE_CODE },
    { tool: 'browser.wait_for', name: 'app', textGone: FAKE_CODE },
    { tool: 'browser.wait_for', name: 'app', selector: '#code' },
    { tool: 'browser.wait_for', name: 'app', selector: '#code', state: 'hidden' },
  ];
  const NON_CONTENT_WAITS: readonly BrowserToolCall[] = [
    { tool: 'browser.wait_for', name: 'app', url: 'example' },
    { tool: 'browser.wait_for', name: 'app', load: 'load' },
    { tool: 'browser.wait_for', name: 'app', time: 100 },
  ];

  it('should refuse a wait on text, text gone or an element of a marked page, and answer neither matched nor not', async () => {
    // Arrange
    const { tabs, tools, app } = await world();
    tabs.pairing.set(app.id, { marked: true, seen: 1 });

    for (const call of CONTENT_WAITS) {
      // Act
      const { answer, error } = await attempt(tools, agent, call);

      // Assert
      should(answer).be.undefined();
      should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
    }
    should(tabs.calls.filter(call => call.startsWith('lifecycle-wait'))).eql([]);
  });

  it('should still allow a wait that reads nothing of the page: its address, its load state, or a time', async () => {
    // Arrange
    const { tabs, tools, app } = await world();
    tabs.pairing.set(app.id, { marked: true, seen: 1 });

    for (const call of NON_CONTENT_WAITS) {
      // Act
      const { answer, error } = await attempt(tools, agent, call);

      // Assert
      should(error).be.undefined();
      should(answer?.summary).be.a.String();
    }
  });

  it('should answer a content wait normally on a page that shows no code', async () => {
    // Arrange
    const { tools } = await world();

    // Act
    const answer = await tools.call(agent, { tool: 'browser.wait_for', name: 'app', text: 'hello' });

    // Assert
    should(answer.matched).be.true();
  });
});

describe('P1-3: a read that was in flight while a code came on screen shows nothing of it', () => {
  /** One read of each kind that is in the page's queue while the page starts showing a code. */
  const IN_FLIGHT: readonly { readonly name: string; readonly call: BrowserToolCall; readonly during: RegExp }[] = [
    { name: 'a text read', call: { tool: 'browser.read', name: 'app' }, during: /^read-/u },
    { name: 'a snapshot read', call: { tool: 'browser.read', name: 'app', mode: 'snapshot' }, during: /^read-/u },
    { name: 'a screenshot', call: { tool: 'browser.screenshot', name: 'app' }, during: /^screenshot$/u },
    {
      name: 'a highlight',
      call: { tool: 'browser.highlight', name: 'app', selector: '#x' },
      during: /^pointer-highlight$/u,
    },
    { name: 'a PDF', call: { tool: 'browser.pdf', name: 'app' }, during: /^pdf$/u },
    { name: 'a page script', call: { tool: 'browser.eval', name: 'app', function: '() => 1' }, during: /^evaluate$/u },
    { name: 'the console', call: { tool: 'browser.console', name: 'app' }, during: /^lifecycle-console$/u },
    {
      name: 'the network log',
      call: { tool: 'browser.network', name: 'app', action: 'list' },
      during: /^lifecycle-network$/u,
    },
    { name: 'a wait on text', call: { tool: 'browser.wait_for', name: 'app', text: 'x' }, during: /^lifecycle-wait$/u },
  ];

  for (const { name, call, during } of IN_FLIGHT) {
    it(`should discard ${name} when the marker arrives while it runs, and say only the one sentence`, async () => {
      // Arrange — the page is unmarked when the call starts and marked by the time the browser answers
      const { tabs, tools, app } = await world();
      tabs.whileActing = acted => {
        if (during.test(acted)) tabs.pairing.set(app.id, { marked: true, seen: 1 });
      };

      // Act
      const { answer, error } = await attempt(tools, agent, call);

      // Assert
      should(answer).be.undefined();
      should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
    });

    it(`should discard ${name} when a code came and went while it ran (the marker is gone, the sighting count moved)`, async () => {
      // Arrange
      const { tabs, tools, app } = await world();
      tabs.whileActing = acted => {
        if (during.test(acted)) tabs.pairing.set(app.id, { marked: false, seen: 1 });
      };

      // Act
      const { answer, error } = await attempt(tools, agent, call);

      // Assert
      should(answer).be.undefined();
      should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
    });
  }

  it('should show nothing of why a call failed when a code was on screen meanwhile: the error carries the page’s words', async () => {
    // Arrange
    const { tabs, tools, app } = await world();
    tabs.whileActing = acted => {
      if (!acted.startsWith('read-')) return;
      tabs.pairing.set(app.id, { marked: true, seen: 1 });
      throw new Error(`the page said ${FAKE_CODE}`);
    };

    // Act
    const { answer, error } = await attempt(tools, agent, { tool: 'browser.read', name: 'app' });

    // Assert
    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
    should(error?.message).not.containEql(FAKE_CODE);
  });

  it('should keep a call’s own failure when nothing was marked during it', async () => {
    // Arrange
    const { tabs, tools } = await world();
    tabs.whileActing = acted => {
      if (acted.startsWith('read-')) throw new Error('the page fell over');
    };

    // Act
    const { error } = await attempt(tools, agent, { tool: 'browser.read', name: 'app' });

    // Assert
    should(error?.message).containEql('the page fell over');
  });

  it('should leave a person’s read alone when a code came on screen while it ran', async () => {
    // Arrange
    const { tabs, tools, app } = await world();
    tabs.whileActing = acted => {
      if (acted.startsWith('read-')) tabs.pairing.set(app.id, { marked: true, seen: 1 });
    };

    // Act
    const read = await tools.call(person, { tool: 'browser.read', name: 'app' });

    // Assert
    should(read.output).equal('hello');
  });
});

describe('P1-4: a window that can reach a marked document is refused with it', () => {
  async function withPopup() {
    const made = await world();
    const popup = await made.browser.openPage('s1', 'popup', { url: 'https://app.example.test/pair' });
    made.tabs.pages = made.tabs.pages.map(page => (page.id === popup.id ? { ...page, openerId: made.app.id } : page));
    return { ...made, popup };
  }

  it('should refuse a script in an unmarked page whose popup is marked', async () => {
    // Arrange
    const { tabs, tools, popup } = await withPopup();
    tabs.pairing.set(popup.id, { marked: true, seen: 1 });

    // Act
    const { answer, error } = await attempt(tools, agent, {
      tool: 'browser.eval',
      name: 'app',
      function: '() => window.open("", "popup").document.body.innerText',
    });

    // Assert
    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
    should(contentCalls(tabs)).eql([]);
  });

  it('should refuse a read of a popup whose opener is marked', async () => {
    // Arrange
    const { tabs, tools, app } = await withPopup();
    tabs.pairing.set(app.id, { marked: true, seen: 1 });

    // Act
    const { answer, error } = await attempt(tools, agent, { tool: 'browser.read', name: 'popup' });

    // Assert
    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should refuse a read that began in an unmarked group while a window of it came to show a code', async () => {
    // Arrange
    const { tabs, tools, popup } = await withPopup();
    tabs.whileActing = acted => {
      if (acted.startsWith('read-')) tabs.pairing.set(popup.id, { marked: true, seen: 1 });
    };

    // Act
    const { answer, error } = await attempt(tools, agent, { tool: 'browser.read', name: 'app' });

    // Assert
    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should refuse when a window of the group closed or opened meanwhile (the group is no longer the one that was checked)', async () => {
    // Arrange
    const { tabs, tools, app, popup } = await withPopup();
    tabs.whileActing = acted => {
      if (acted.startsWith('read-')) tabs.pages = tabs.pages.filter(page => page.id !== popup.id);
    };

    // Act
    const { answer, error } = await attempt(tools, agent, { tool: 'browser.read', name: app.name ?? 'app' });

    // Assert
    should(answer).be.undefined();
    should(error?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should NOT refuse a page for a marked window on ANOTHER origin that cannot reach it', async () => {
    // Arrange
    const { tabs, tools, browser } = await world();
    const other = await browser.openPage('s1', 'other', { url: 'https://docs.example.test/' });
    tabs.pairing.set(other.id, { marked: true, seen: 1 });

    // Act
    const read = await tools.call(agent, { tool: 'browser.read', name: 'app' });

    // Assert
    should(read.output).equal('hello');
  });
});
