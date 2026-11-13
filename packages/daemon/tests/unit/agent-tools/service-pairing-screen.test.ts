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
