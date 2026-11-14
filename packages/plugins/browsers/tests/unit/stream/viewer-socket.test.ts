import { afterEach, describe, it } from 'bun:test';
import { device } from '@ferretry/kernel/testing';
import type { TestHost } from '@ferretry/kernel/testing';
import should from 'should';
import { pageTarget } from '../../../daemon/pages/acts.ts';
import { handoverHost } from '../../support/handover-host.ts';
import type { Tabs } from '../../support/tabs.ts';

const STREAM = '/v1/sessions/f1/browser/stream';
/** The page the agent's person views is the one `browser_open` just made (the browser's own first page is not it). */
const viewed = (tabs: Tabs): { id: string } => tabs.pages.at(-1) as { id: string };
const TYPE = JSON.stringify({ kind: 'insertText', text: 'typed at the viewer' });

/**
 * The viewer socket at its boundary: the real route, the real stream and Gate's stand-in admission over a fake browser.
 * The socket is declared `caller: 'any'` at the operator minimum, so a ferret's own credential reaches it; what a hold
 * protects a page from is that ferret, so only a proved person's input is ever delivered to the page.
 */
describe('the browser viewer socket — whose input reaches a page', () => {
  let running: TestHost | undefined;
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  async function held(): Promise<{ host: TestHost; tabs: Tabs; as: Awaited<ReturnType<typeof handoverHost>>['as'] }> {
    const world = await handoverHost();
    running = world.host;
    await world.host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, world.as('f1'));
    // The page is under an input hold: a card pending, or a private value just typed into it.
    world.host.hold(pageTarget(viewed(world.tabs).id), 'held');
    return world;
  }

  /** What `tabs` was told, once everything the socket queued has settled. */
  async function delivered(host: TestHost, tabs: Tabs): Promise<readonly string[]> {
    await host.settle();
    await new Promise<void>(resolve => setImmediate(resolve));
    await host.settle();
    return tabs.inputs.map(({ input }) => input.kind);
  }

  it('R549 never refuses the owner’s own input on a held page', async () => {
    // Arrange
    const { host, tabs } = await held();
    const socket = await host.socket(STREAM);

    // Act
    socket.handler?.fromClient(TYPE);

    // Assert
    should(await delivered(host, tabs)).deepEqual(['insertText']);
  });

  it('R549 delivers a paired person’s input on a held page', async () => {
    // Arrange
    const { host, tabs } = await held();
    const socket = await host.socket(STREAM, { as: device('phone') });

    // Act
    socket.handler?.fromClient(TYPE);

    // Assert
    should(await delivered(host, tabs)).deepEqual(['insertText']);
  });

  it('R549 delivers a ferret on the viewer socket no input at all on a held page, and ends its stream', async () => {
    // Arrange
    const { host, tabs, as } = await held();
    const socket = await host.socket(STREAM, as('f1'));

    // Act
    socket.handler?.fromClient(TYPE);
    const inputs = await delivered(host, tabs);

    // Assert
    should(inputs).deepEqual([]);
    should(socket.closed?.code).equal(1008);
  });

  it('R549 delivers a ferret on the viewer socket no input on a page nothing holds either', async () => {
    // Arrange
    const { host, tabs, as } = await held();
    host.release(pageTarget(viewed(tabs).id));
    const socket = await host.socket(STREAM, as('f1'));

    // Act
    socket.handler?.fromClient(TYPE);

    // Assert
    should(await delivered(host, tabs)).deepEqual([]);
  });
});
