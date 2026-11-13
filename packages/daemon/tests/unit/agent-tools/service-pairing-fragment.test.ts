import { describe, it } from 'bun:test';
import should from 'should';
import { type AgentToolCall, PAIRING_FRAGMENT_HIDDEN } from '@ferretry/protocol';
import { BrowserTransportError } from '../../../src/lib/index.ts';
import { agent, agentToolWorld, person } from './support.ts';

/** The repo's committed fake code (`HARNESS_INVITE`, the pair fixtures): never a minted one. */
const FAKE_CODE = '7F3K-Q2ND';
const FAKE_FRAGMENT = `#v1;url=${encodeURIComponent('https://box.example.test')};code=${FAKE_CODE};fp=fy_daemon_${'a'.repeat(43)}`;
const FAKE_LINK = `https://ferretry.pages.dev/pair${FAKE_FRAGMENT}`;
const HIDDEN_LINK = `https://ferretry.pages.dev/pair${PAIRING_FRAGMENT_HIDDEN}`;
const ORDINARY_LINK = 'https://docs.example.test/guide#section-2';

/** Whatever a caller could read of the result: every field, as the wire would write it. */
const everything = (value: unknown): string => JSON.stringify(value);

const seeNothingOf = (value: unknown): void => {
  const text = everything(value);
  should(text).not.containEql(FAKE_CODE);
  should(text).not.containEql('#v1;');
  should(text).not.containEql(encodeURIComponent('https://box.example.test'));
};

const opened = async () => {
  const world = agentToolWorld();
  await world.service.call(agent, { tool: 'browser.open', name: 'app' });
  return world;
};

describe('AgentToolService — a pairing fragment in a browser result', () => {
  it('should hide it in the open echo and in the page list, where the page was opened at the link', async () => {
    // Arrange
    const world = agentToolWorld();

    // Act
    const open = await world.service.call(agent, { tool: 'browser.open', name: 'app', url: FAKE_LINK });
    const list = await world.service.call(agent, { tool: 'browser.list' });
    const tabs = await world.service.call(agent, { tool: 'browser.tabs', action: 'list' });

    // Assert
    for (const result of [open, list, tabs]) seeNothingOf(result);
    should(open.summary).containEql(HIDDEN_LINK);
    should(everything(list)).containEql(PAIRING_FRAGMENT_HIDDEN);
    should(everything(tabs)).containEql(PAIRING_FRAGMENT_HIDDEN);
  });

  it('should hide it in the address every act reports, whoever asks', async () => {
    // Arrange
    const world = await opened();
    world.browser.actedUrl = FAKE_LINK;
    world.browser.readText = `Pair this device\nYou are at ${FAKE_LINK}`;
    const calls: AgentToolCall[] = [
      { tool: 'browser.navigate', name: 'app', url: FAKE_LINK },
      { tool: 'browser.click', name: 'app', selector: 'button' },
      { tool: 'browser.type', name: 'app', selector: 'input', text: 'x' },
      { tool: 'browser.read', name: 'app' },
      { tool: 'browser.read', name: 'app', mode: 'snapshot' },
      { tool: 'browser.read', name: 'app', mode: 'a11y' },
      { tool: 'browser.screenshot', name: 'app' },
      { tool: 'browser.eval', name: 'app', function: '() => location.href' },
    ];

    // Act
    for (const caller of [agent, person])
      for (const call of calls) {
        const result = await world.service.call(caller, call);

        // Assert
        seeNothingOf(result);
      }
    const read = await world.service.call(agent, { tool: 'browser.read', name: 'app' });
    should(read.summary).equal(`Read %browser:app (now at ${HIDDEN_LINK}).`);
    should(read.output).equal(`Pair this device\nYou are at ${HIDDEN_LINK}`);
  });

  it('should hide it in a wait, the console, the network list and one request, and a file the page handed over', async () => {
    // Arrange
    const world = await opened();
    world.browser.actedUrl = FAKE_LINK;
    world.browser.lifecycleReplies.push(
      { reply: { text: `condition met at ${FAKE_LINK}`, matched: true } },
      { reply: { text: `#1 [log] opened ${FAKE_LINK}\nlast entry #1` } },
      { reply: { text: `#7 GET 200 document ${FAKE_LINK}` } },
      { reply: { text: `GET ${FAKE_LINK}\nreferer: ${FAKE_LINK}` } },
    );

    // Act
    const results = [
      await world.service.call(agent, { tool: 'browser.wait_for', name: 'app', url: '/pair' }),
      await world.service.call(agent, { tool: 'browser.console', name: 'app' }),
      await world.service.call(agent, { tool: 'browser.network', name: 'app', action: 'list' }),
      await world.service.call(agent, { tool: 'browser.network', name: 'app', action: 'get', id: 'r7' }),
      await world.service.call(agent, { tool: 'browser.download', name: 'app' }),
      await world.service.call(agent, { tool: 'browser.pdf', name: 'app' }),
    ];

    // Assert
    for (const result of results) seeNothingOf(result);
    should(everything(results[1])).containEql(PAIRING_FRAGMENT_HIDDEN);
    should(everything(results[2])).containEql(PAIRING_FRAGMENT_HIDDEN);
    should(everything(results[3])).containEql(PAIRING_FRAGMENT_HIDDEN);
  });

  it('should hide it in an error that names the page’s address', async () => {
    // Arrange
    const world = await opened();
    world.browser.failure = new BrowserTransportError(
      'upstream_failed',
      `browser action failed: navigation to ${FAKE_LINK} failed`,
      502,
    );

    // Act
    const failure = await world.service.call(agent, { tool: 'browser.navigate', name: 'app', url: FAKE_LINK }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    // Assert
    should(failure).be.instanceOf(Error);
    should(failure?.message).not.containEql(FAKE_CODE);
    should(failure?.message).not.containEql('#v1;');
    should(failure?.message).containEql(PAIRING_FRAGMENT_HIDDEN);
  });

  it('should leave an ordinary fragment, and the page itself, untouched', async () => {
    // Arrange
    const world = await opened();
    world.browser.actedUrl = ORDINARY_LINK;
    world.browser.readText = `See ${ORDINARY_LINK}`;

    // Act
    const read = await world.service.call(agent, { tool: 'browser.read', name: 'app' });
    await world.service.call(agent, { tool: 'browser.navigate', name: 'app', url: FAKE_LINK });

    // Assert
    should(read.summary).equal(`Read %browser:app (now at ${ORDINARY_LINK}).`);
    should(read.output).equal(`See ${ORDINARY_LINK}`);
    // Output only: the navigation itself was asked for the real address, not the hidden one.
    should(world.browser.actions.at(-1)).match({ action: 'navigate', url: FAKE_LINK });
  });
});
