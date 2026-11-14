import { describe, it } from 'bun:test';
import should from 'should';
import { type AgentToolCall, PAIRING_EVAL_REFUSAL, PAIRING_SCREEN_REFUSAL } from '@ferretry/protocol';
import type { BrowserPairingEvidence } from '../../../src/lib/browser/runtime/index.ts';
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

/**
 * THE EVIDENCE NO PAGE CAN TOUCH: the daemon says a code is live, the worker says what pages committed. The marker and the
 * counter the app leaves in its DOM are only a hint, and page script (an agent's own eval included) writes them.
 */
describe("AgentToolService — the daemon's and the worker's evidence, outside the page", () => {
  /** What a Ferretry app page nothing has happened to says: no code live, one ever minted, no link opened. */
  const QUIET: BrowserPairingEvidence = {
    app: true,
    ownApp: true,
    live: false,
    minted: 1,
    commits: 0,
    lost: 0,
    linked: false,
    blind: false,
  };
  /** What an agent is told for a call: an eval on an app page is refused for what it is, everything else for the screen. */
  const refusalFor = (call: AgentToolCall): string =>
    call.tool === 'browser.eval' ? PAIRING_EVAL_REFUSAL : PAIRING_SCREEN_REFUSAL;

  const appPage = async (evidence: Partial<BrowserPairingEvidence> = {}) => {
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });
    world.browser.readText = PAGE_TEXT;
    world.browser.scriptAnswer = JSON.stringify(FAKE_CODE);
    world.browser.lifecycleReplies.push(
      ...Array.from({ length: 10 }, () => ({ reply: { text: `code ${FAKE_CODE}` } })),
    );
    world.browser.pairingEvidence = { ...QUIET, ...evidence };
    return world;
  };

  const everyContentCall = [...CONTENT_CALLS, ...CONTENT_WAITS];

  it('should refuse every content tool while a code is live, whatever the page’s own marker and counter say', async () => {
    for (const call of everyContentCall) {
      // Arrange — a script rewrote the marker and the counter: nothing marked, the counter at nothing
      const world = await appPage({ live: true });
      world.browser.pairingScreen = false;
      world.browser.pairingEpochs = {};

      // Act
      const refusal = await refusalOf(world.service.call(agent, call));

      // Assert
      should(refusal?.message).equal(refusalFor(call));
    }
  });

  it('should keep refusing after an agent’s own script cleared the marker and rewrote the counter', async () => {
    // Arrange — the eval that would wipe the marker never runs on an app page; the page then shows a code anyway
    const world = await appPage();
    world.browser.pairingEpochs = { 'page-1': 3 };
    const wipe = await refusalOf(
      world.service.call(agent, {
        tool: 'browser.eval',
        name: 'app',
        function: "() => { document.querySelector('meta[name=ferretry-pairing-screen]')?.remove(); }",
      }),
    );
    should(wipe?.message).equal(PAIRING_EVAL_REFUSAL);
    should(world.browser.scripts).eql([]);
    world.browser.pairingEvidence = { ...QUIET, live: true };
    world.browser.pairingScreen = false;
    world.browser.pairingEpochs = {};

    // Act
    const read = await refusalOf(world.service.call(agent, { tool: 'browser.read', name: 'app' }));
    const again = await refusalOf(world.service.call(agent, { tool: 'browser.screenshot', name: 'app' }));

    // Assert
    should(read?.message).equal(PAIRING_SCREEN_REFUSAL);
    should(again?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should refuse a read that spans a navigation, which leaves no marker and no counter behind', async () => {
    for (const call of everyContentCall) {
      // Arrange — the page navigates to the pairing link and on: a new document, nothing in its DOM, the worker saw it
      const world = await appPage();
      world.browser.pairingEpochs = { 'page-1': 2 };
      world.browser.whileWorking.push(() => {
        world.browser.pairingEpochs = {};
        world.browser.pairingScreen = false;
        world.browser.pairingEvidence = { ...QUIET, commits: 1 };
      });

      // Act
      const refusal = await refusalOf(world.service.call(agent, call));

      // Assert
      should(refusal?.message).equal(refusalFor(call));
    }
  });

  it('should refuse an eval in an unchanged related window while the window that carries the credential navigates', async () => {
    // Arrange — the page asked about never changes; a same-origin window it can reach is sent a pairing link
    const world = await appPage();
    world.browser.whileWorking.push(() => {
      world.browser.pairingEvidence = { ...QUIET, commits: 1, linked: true };
    });

    // Act
    const refusal = await refusalOf(
      world.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => document.body.innerText' }),
    );

    // Assert
    should(refusal?.message).equal(PAIRING_EVAL_REFUSAL);
  });

  it('should refuse an operation that a mint overlapped, though no code was live when it started or ended', async () => {
    for (const call of everyContentCall) {
      // Arrange — minted and redeemed (or expired) inside the operation
      const world = await appPage();
      world.browser.whileWorking.push(() => {
        world.browser.pairingEvidence = { ...QUIET, minted: 2 };
      });

      // Act
      const refusal = await refusalOf(world.service.call(agent, call));

      // Assert
      should(refusal?.message).equal(refusalFor(call));
      should(refusal?.message).not.containEql(FAKE_CODE);
    }
  });

  it('should refuse an operation whose own error says what the page held, when a mint overlapped it', async () => {
    // Arrange
    const world = await appPage();
    world.browser.whileWorking.push(() => {
      world.browser.pairingEvidence = { ...QUIET, minted: 2 };
      world.browser.failure = new Error(`the page said ${FAKE_CODE}`);
    });

    // Act
    const refusal = await refusalOf(
      world.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => document.body.innerText' }),
    );

    // Assert
    should(refusal?.message).equal(PAIRING_EVAL_REFUSAL);
    should(refusal?.message).not.containEql(FAKE_CODE);
  });

  it('should refuse a read of a document a pairing link opened, with no code live and nothing marked', async () => {
    const world = await appPage({ linked: true });

    const refusal = await refusalOf(world.service.call(agent, { tool: 'browser.read', name: 'app' }));

    should(refusal?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should refuse an eval, and only an eval, once a pairing link was opened on an app origin and no code is live', async () => {
    // Arrange
    const world = await appPage({ commits: 2 });

    // Act
    const script = await refusalOf(
      world.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' }),
    );
    const read = await world.service.call(agent, { tool: 'browser.read', name: 'app' });

    // Assert
    should(script?.message).equal(PAIRING_EVAL_REFUSAL);
    should(read.output).equal(PAGE_TEXT);
    should(world.browser.scripts).eql([]);
  });

  it('should leave pages on other origins alone: a live code, a mint, a blind history and a navigation change nothing for them', async () => {
    // Arrange
    const world = await appPage({ app: false, ownApp: false, live: true, commits: 5, blind: true });
    world.browser.whileWorking.push(() => {
      world.browser.pairingEvidence = {
        ...QUIET,
        app: false,
        ownApp: false,
        live: true,
        minted: 9,
        commits: 5,
        blind: true,
      };
    });

    // Act
    const read = await world.service.call(agent, { tool: 'browser.read', name: 'app' });
    const script = await world.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' });
    const shot = await world.service.call(agent, { tool: 'browser.screenshot', name: 'app' });

    // Assert
    should(read.output).equal(PAGE_TEXT);
    should(script.summary).be.a.String();
    should(shot.screenshotBase64).be.a.String();
  });

  it('should answer an app page read as before when no code is live, none was minted meanwhile and no link was opened', async () => {
    const world = await appPage();

    const read = await world.service.call(agent, { tool: 'browser.read', name: 'app' });

    should(read.output).equal(PAGE_TEXT);
  });

  it('should leave an owner’s own reads alone while a code is live', async () => {
    const world = await appPage({ live: true });

    const read = await world.service.call(person, { tool: 'browser.read', name: 'app' });

    should(read.output).equal(PAGE_TEXT);
  });

  it('should leave a wait on time, address or load open while a code is live, and refuse one on text', async () => {
    const world = await appPage({ live: true });

    for (const call of CONTENT_FREE_WAITS) should((await world.service.call(agent, call)).summary).be.a.String();
    should((await refusalOf(world.service.call(agent, CONTENT_WAITS[0] as AgentToolCall)))?.message).equal(
      PAIRING_SCREEN_REFUSAL,
    );
  });

  it('should refuse an eval on an app page always: nothing live, nothing linked, nothing counted', async () => {
    // Arrange
    const world = await appPage();

    // Act
    const script = await refusalOf(
      world.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => document.title' }),
    );
    const read = await world.service.call(agent, { tool: 'browser.read', name: 'app' });

    // Assert — reads keep the older rules; the script never reaches the page
    should(script?.message).equal(PAIRING_EVAL_REFUSAL);
    should(world.browser.scripts).eql([]);
    should(read.output).equal(PAGE_TEXT);
  });

  it('should refuse a read that began and ended outside the app when an app pairing link committed in between', async () => {
    for (const call of everyContentCall.filter(candidate => candidate.tool !== 'browser.eval')) {
      // Arrange — outside -> app -> outside: the bytes captured on the app page survive the departure
      const world = await appPage({ app: false, ownApp: false });
      world.browser.whileWorking.push(() => {
        world.browser.pairingEvidence = { ...QUIET, app: false, ownApp: false, commits: 1 };
      });

      // Act
      const refusal = await refusalOf(world.service.call(agent, call));

      // Assert
      should(refusal?.message).equal(PAIRING_SCREEN_REFUSAL);
    }
  });

  it('should refuse an operation the navigation ledger lost track during, wherever it began and ended', async () => {
    // Arrange
    const world = await appPage({ app: false, ownApp: false });
    world.browser.whileWorking.push(() => {
      world.browser.pairingEvidence = { ...QUIET, app: false, ownApp: false, lost: 1 };
    });

    // Act
    const refusal = await refusalOf(world.service.call(agent, { tool: 'browser.read', name: 'app' }));

    // Assert
    should(refusal?.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should still let an agent script a page that is not a Ferretry app origin', async () => {
    const world = await appPage({ app: false, ownApp: false });

    const script = await world.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' });

    should(script.summary).be.a.String();
  });
});
