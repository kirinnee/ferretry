import { describe, it } from 'bun:test';
import should from 'should';
import { type AgentToolCall, PAIRING_SCREEN_REFUSAL } from '@ferretry/protocol';
import { agent, agentToolWorld, person } from './support.ts';

/** The repo's committed fake code (`HARNESS_INVITE`, the pair fixtures): never a minted one. */
const FAKE_CODE = '7F3K-Q2ND';
const PAGE_TEXT = `Pairing code\n${FAKE_CODE}\nScan with your phone`;

const everything = (value: unknown): string => JSON.stringify(value);

/** A page that shows a live pairing code: it carries the marker, and its text, picture and script result hold the code. */
const showingACode = async () => {
  const world = agentToolWorld();
  await world.service.call(agent, { tool: 'browser.open', name: 'app' });
  world.browser.readText = PAGE_TEXT;
  world.browser.lifecycleReplies.push(...Array.from({ length: 10 }, () => ({ reply: { text: `code ${FAKE_CODE}` } })));
  world.browser.pairingScreen = true;
  return world;
};

const CONTENT_CALLS: readonly AgentToolCall[] = [
  { tool: 'browser.read', name: 'app' },
  { tool: 'browser.read', name: 'app', mode: 'snapshot' },
  { tool: 'browser.read', name: 'app', mode: 'a11y' },
  { tool: 'browser.screenshot', name: 'app' },
  { tool: 'browser.pdf', name: 'app' },
  { tool: 'browser.eval', name: 'app', function: '() => document.body.innerText' },
  { tool: 'browser.console', name: 'app' },
  { tool: 'browser.network', name: 'app', action: 'list' },
  { tool: 'browser.network', name: 'app', action: 'get', id: 'r1' },
];

const refusalOf = async (call: Promise<unknown>): Promise<Error | undefined> =>
  await call.then(
    () => undefined,
    (error: unknown) => error as Error,
  );

describe('AgentToolService — a page that can reach a window showing a live pairing code', () => {
  it('should refuse every read, picture, script and content wait of an UNMARKED page, whose same-origin opener or popup shows one', async () => {
    // Arrange — the page asked about carries no marker; a window its script can reach does
    const world = await showingACode();
    world.browser.pairingScreen = false;
    world.browser.relatedPairingScreen = true;

    for (const call of [...CONTENT_CALLS, ...CONTENT_WAITS]) {
      // Act
      const refusal = await refusalOf(world.service.call(agent, call));

      // Assert
      should(refusal?.message).equal(PAIRING_SCREEN_REFUSAL);
    }
    should(world.browser.scripts).eql([]);
  });

  it('should answer once that window no longer shows one, and an owner at any time', async () => {
    // Arrange
    const world = await showingACode();
    world.browser.pairingScreen = false;
    world.browser.relatedPairingScreen = true;

    // Act
    const owner = await world.service.call(person, { tool: 'browser.read', name: 'app' });
    world.browser.relatedPairingScreen = false;
    const agentRead = await world.service.call(agent, { tool: 'browser.read', name: 'app' });

    // Assert
    should(owner.output).equal(PAGE_TEXT);
    should(agentRead.output).equal(PAGE_TEXT);
  });
});

describe('AgentToolService — a page showing a live pairing code', () => {
  it('should refuse every agent read, picture and script of it, and return no content', async () => {
    // Arrange
    const world = await showingACode();

    for (const call of CONTENT_CALLS) {
      // Act
      const refusal = await refusalOf(world.service.call(agent, call));

      // Assert
      should(refusal).be.instanceOf(Error);
      should(refusal?.message).equal(PAIRING_SCREEN_REFUSAL);
      should(refusal?.message).containEql('hidden: this page shows a pairing code');
      should(refusal?.message).not.containEql(FAKE_CODE);
    }
    // Nothing reached the page: the check runs before the act, so even a script never ran.
    should(world.browser.scripts).eql([]);
    should(world.browser.lifecycles).eql([]);
    should(world.browser.actions.filter(action => action.action === 'read' || action.action === 'screenshot')).eql([]);
  });

  it('should answer the same calls normally once the page carries no marker', async () => {
    // Arrange
    const world = await showingACode();
    world.browser.pairingScreen = false;

    // Act
    const read = await world.service.call(agent, { tool: 'browser.read', name: 'app' });
    const shot = await world.service.call(agent, { tool: 'browser.screenshot', name: 'app' });
    const script = await world.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' });

    // Assert
    should(read.output).equal(PAGE_TEXT);
    should(shot.screenshotBase64).be.a.String();
    should(script.summary).be.a.String();
  });

  it('should let an agent leave the page: navigating and closing still work', async () => {
    // Arrange
    const world = await showingACode();

    // Act
    const navigated = await world.service.call(agent, {
      tool: 'browser.navigate',
      name: 'app',
      url: 'https://docs.example.test/',
    });
    const closed = await world.service.call(agent, { tool: 'browser.close', name: 'app' });

    // Assert
    should(navigated.summary).be.a.String();
    should(closed.summary).be.a.String();
  });

  it('should leave a person’s own reads of it untouched', async () => {
    // Arrange
    const world = await showingACode();

    // Act
    const read = await world.service.call(person, { tool: 'browser.read', name: 'app' });
    const shot = await world.service.call(person, { tool: 'browser.screenshot', name: 'app' });

    // Assert
    should(read.output).equal(PAGE_TEXT);
    should(shot.screenshotBase64).be.a.String();
  });

  it('should carry no code in any refusal an agent can read, audited or not', async () => {
    // Arrange
    const world = await showingACode();

    // Act
    const refusals = await Promise.all(CONTENT_CALLS.map(call => refusalOf(world.service.call(agent, call))));

    // Assert
    should(everything(refusals.map(error => error?.message))).not.containEql(FAKE_CODE);
  });
});

const CONTENT_WAITS: readonly AgentToolCall[] = [
  { tool: 'browser.wait_for', name: 'app', text: FAKE_CODE },
  { tool: 'browser.wait_for', name: 'app', text: 'no such words' },
  { tool: 'browser.wait_for', name: 'app', textGone: FAKE_CODE },
  { tool: 'browser.wait_for', name: 'app', selector: '[data-pair-code]' },
  { tool: 'browser.wait_for', name: 'app', selector: '[data-pair-code]', state: 'hidden' },
];

const CONTENT_FREE_WAITS: readonly AgentToolCall[] = [
  { tool: 'browser.wait_for', name: 'app', time: 1 },
  { tool: 'browser.wait_for', name: 'app', url: 'pair' },
  { tool: 'browser.wait_for', name: 'app', load: 'load' },
];

describe('AgentToolService — a wait on a page showing a live pairing code', () => {
  it('should refuse a wait on text or on an element, matched or not, instead of answering whether it is there', async () => {
    // Arrange
    const world = await showingACode();

    for (const call of CONTENT_WAITS) {
      // Act
      const refusal = await refusalOf(world.service.call(agent, call));

      // Assert
      should(refusal?.message).equal(PAIRING_SCREEN_REFUSAL);
    }
    should(world.browser.lifecycles).eql([]);
  });

  it('should refuse EVERY slice of a wait: one that began on an ordinary page and met a code', async () => {
    // Arrange
    const world = await showingACode();
    world.browser.pairingScreen = false;
    world.browser.lifecycleReplies.length = 0;
    world.browser.lifecycleReplies.push(
      { reply: { text: '', matched: false } },
      { reply: { text: '', matched: false } },
      { reply: { text: '', matched: true } },
    );
    world.browser.whileWorking.push(
      () => undefined,
      () => {
        world.browser.pairingScreen = true;
      },
    );

    // Act
    const refusal = await refusalOf(
      world.service.call(agent, { tool: 'browser.wait_for', name: 'app', text: FAKE_CODE, timeoutMs: 5000 }),
    );

    // Assert — the third slice would have answered true; the second one was already refused
    should(refusal?.message).equal(PAIRING_SCREEN_REFUSAL);
    should(world.browser.lifecycles.length).equal(2);
  });

  it('should leave a wait that says nothing of the page’s content open: a time, an address, a load', async () => {
    // Arrange
    const world = await showingACode();

    for (const call of CONTENT_FREE_WAITS) {
      // Act
      const done = await world.service.call(agent, call);

      // Assert
      should(done.summary).be.a.String();
    }
  });

  it('should answer a wait on text of an ordinary page, and an owner’s wait on this one', async () => {
    // Arrange
    const world = await showingACode();
    world.browser.lifecycleReplies.length = 0;
    world.browser.lifecycleReplies.push({ reply: { text: '', matched: true } });

    // Act
    const owner = await world.service.call(person, { tool: 'browser.wait_for', name: 'app', text: FAKE_CODE });
    world.browser.pairingScreen = false;
    world.browser.lifecycleReplies.push({ reply: { text: '', matched: true } });
    const ordinary = await world.service.call(agent, { tool: 'browser.wait_for', name: 'app', text: 'Welcome' });

    // Assert
    should(owner.matched).equal(true);
    should(ordinary.matched).equal(true);
  });
});

/** Everything an agent can be answered with while a page is read, pictured or scripted: a code showing up AT ANY POINT. */
describe('AgentToolService — a code that shows up while an operation is running', () => {
  const ordinaryPage = async () => {
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    world.browser.readText = PAGE_TEXT;
    world.browser.scriptAnswer = JSON.stringify(FAKE_CODE);
    world.browser.lifecycleReplies.push(
      ...Array.from({ length: 10 }, () => ({ reply: { text: `code ${FAKE_CODE}` } })),
    );
    return world;
  };

  const appears = (world: Awaited<ReturnType<typeof ordinaryPage>>) =>
    world.browser.whileWorking.push(() => {
      world.browser.pairingScreen = true;
    });

  /** Not marked at either look, only the app's counter moved: the code was shown and taken down again meanwhile. */
  const cameAndWent = (world: Awaited<ReturnType<typeof ordinaryPage>>) =>
    world.browser.whileWorking.push(() => {
      world.browser.pairingEpochs = { 'page-1': 1 };
    });

  for (const [when, trigger] of [
    ['and was still there when it ended', appears],
    ['and was gone again when it ended', cameAndWent],
  ] as const) {
    it(`should refuse every content tool and give none of it back, when a code showed ${when}`, async () => {
      for (const call of [...CONTENT_CALLS, ...CONTENT_WAITS]) {
        // Arrange
        const world = await ordinaryPage();
        trigger(world);

        // Act
        const refusal = await world.service.call(agent, call).then(
          answer => ({ answer }),
          (error: unknown) => ({ error: error as Error }),
        );

        // Assert
        should(refusal).have.property('error');
        should('error' in refusal ? refusal.error.message : '').equal(PAIRING_SCREEN_REFUSAL);
        should(everything(refusal)).not.containEql(FAKE_CODE);
      }
    });
  }

  it('should refuse the error a script threw while a code showed, instead of passing its words on', async () => {
    // Arrange
    const world = await ordinaryPage();
    world.browser.whileWorking.push(() => {
      world.browser.pairingScreen = true;
      world.browser.failure = new Error(`the page said ${FAKE_CODE}`);
    });

    // Act
    const refusal = await refusalOf(
      world.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => document.body.innerText' }),
    );

    // Assert
    should(refusal?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should answer as before when no code showed, though the page had shown one earlier and not since', async () => {
    // Arrange
    const world = await ordinaryPage();
    world.browser.pairingEpochs = { 'page-1': 4 };

    // Act
    const read = await world.service.call(agent, { tool: 'browser.read', name: 'app' });

    // Assert
    should(read.output).equal(PAGE_TEXT);
  });

  it('should leave an owner’s own operation alone when a code shows up in it', async () => {
    // Arrange
    const world = await ordinaryPage();
    appears(world);

    // Act
    const read = await world.service.call(person, { tool: 'browser.read', name: 'app' });

    // Assert
    should(read.output).equal(PAGE_TEXT);
  });
});
