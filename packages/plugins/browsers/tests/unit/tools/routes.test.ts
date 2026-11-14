import { afterEach, describe, it } from 'bun:test';
import type { TestHost } from '@ferretry/kernel/testing';
import should from 'should';
import { SurfaceControlViewSchema } from '../../../contract/wire/control.ts';
import manifest from '../../../manifest.ts';
import { handoverHost } from '../../support/handover-host.ts';
import type { Tabs } from '../../support/tabs.ts';

const CONTROL = '/v1/ferrets/f1/surfaces/browser/control';
const TOOLS = '/v1/ferrets/f1/surfaces/browser/tools';

/**
 * Take over, hand back and hand over, as the daemon answers them: the real routes, the real tools and Gate's stand-in
 * admission over a fake browser. The stand-in refuses a ferret the routes the manifest declares `caller: 'person'`; it
 * proves the routes' declaration and the half's answers, not Gate's own enforcement.
 */
describe('take over and hand back — the control routes', () => {
  let running: TestHost | undefined;
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  async function opened(): Promise<{ host: TestHost; tabs: Tabs; as: Awaited<ReturnType<typeof handoverHost>>['as'] }> {
    const world = await handoverHost();
    running = world.host;
    await world.host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, world.as('f1'));
    return world;
  }

  const view = (response: { json<T>(): T }) => SurfaceControlViewSchema.parse(response.json());

  it('answers a takeover refusal in the words the agent is shown, as a tool error and as a 409', async () => {
    // Arrange
    const { host, as } = await opened();
    await host.request('POST', CONTROL, { body: { action: 'takeover', key: 'app' } });

    // Act
    const tool = await host.tool('browser_click', { name: 'app', selector: '#go' }, as('f1'));
    const read = await host.tool('browser_read', { name: 'app' }, as('f1'));

    // Assert
    should(tool).deepEqual({ text: 'A person has taken over %browser:app; wait or ask them.', isError: true });
    should(read).deepEqual({ text: 'A person has taken over %browser:app; wait or ask them.', isError: true });
  });

  it('records a takeover, lists it, and clears it on hand back', async () => {
    // Arrange
    const { host } = await opened();

    // Act
    const taken = await host.request('POST', CONTROL, { body: { action: 'takeover', key: 'app' } });
    const listed = await host.request('GET', CONTROL);
    const handedBack = await host.request('POST', CONTROL, { body: { action: 'handback', key: '%browser:app' } });

    // Assert
    should(taken.status).equal(200);
    should(view(taken).takeovers).match([{ surface: 'browser', name: 'app', by: { by: 'local' } }]);
    should(view(listed).takeovers).have.length(1);
    should(view(handedBack)).match({ sessionId: 'f1', takeovers: [] });
  });

  it('hands a person’s page to the agent, which may then use it', async () => {
    // Arrange
    const { host, as } = await opened();
    await host.request('POST', TOOLS, { body: { tool: 'browser.open', name: 'mine' } });
    const before = await host.tool('browser_click', { name: 'mine', selector: '#go' }, as('f1'));

    // Act
    const handed = await host.request('POST', CONTROL, { body: { action: 'handover', key: 'mine' } });
    const after = await host.tool('browser_click', { name: 'mine', selector: '#go' }, as('f1'));

    // Assert
    should(before.isError).be.true();
    should(before.text).containEql("is a person's, not yours");
    should(view(handed).handed).match([{ name: 'mine', by: { by: 'local' } }]);
    should(after.isError).not.be.true();
  });

  it('answers a takeover, hand back or hand over of a page that is not there as not found', async () => {
    // Arrange
    const { host } = await opened();

    // Act
    const answers = await Promise.all(
      (['takeover', 'handback', 'handover'] as const).map(
        async action => await host.request('POST', CONTROL, { body: { action, key: 'ghost' } }),
      ),
    );

    // Assert
    should(answers.map(answer => answer.status)).deepEqual([404, 404, 404]);
    should(answers[0]?.body).containEql('There is no %browser:ghost in this session');
  });

  it('refuses an agent the person’s control and tool routes, and takes nothing over for it', async () => {
    // Arrange
    const { host, as } = await opened();

    // Act
    const refused = await Promise.all(
      (['takeover', 'handback', 'handover'] as const).map(
        async action => await host.request('POST', CONTROL, { body: { action, key: 'app' }, ...as('f1') }),
      ),
    );
    const tools = await host.request('POST', TOOLS, { body: { tool: 'browser.list' }, ...as('f1') });
    const own = await host.request('GET', CONTROL);

    // Assert
    should(refused.map(answer => answer.status)).deepEqual([403, 403, 403]);
    should(tools.status).equal(403);
    should(view(own).takeovers).deepEqual([]);
    const callerOf = (key: string) => manifest.actions.routes.find(route => route.key === key)?.caller;
    should(callerOf('POST /v1/ferrets/:ferretId/surfaces/browser/control')).equal('person');
    should(callerOf('POST /v1/ferrets/:ferretId/surfaces/browser/tools')).equal('person');
  });

  describe('a takeover does not outlive its page', () => {
    const BROWSER = '/v1/ferrets/f1/browser';

    it('forgets a takeover and an ask the moment the person closes the held page in the viewer', async () => {
      // Arrange
      const { host, as } = await opened();
      await host.tool('browser_ask_owner', { name: 'app', message: 'Your turn' }, as('f1'));
      await host.request('POST', CONTROL, { body: { action: 'takeover', key: 'app' } });
      const held = view(await host.request('GET', CONTROL));

      // Act
      const closed = await host.request('POST', BROWSER, { body: { action: 'close-page', pageId: 'p1' } });
      const after = view(await host.request('GET', CONTROL));

      // Assert
      should(held.takeovers).have.length(1);
      should(closed.status).equal(200);
      should(after.takeovers).deepEqual([]);
      should(after.asked).deepEqual([]);
      should(after.opened).deepEqual([]);
    });

    it('does not hold a NEW page that reuses the closed page’s id', async () => {
      // Arrange — the held page closes in the viewer; the browser later starts again and numbers its pages from the start.
      const { host, tabs, as } = await opened();
      await host.request('POST', CONTROL, { body: { action: 'takeover', key: 'app' } });
      await host.request('POST', BROWSER, { body: { action: 'close-page', pageId: 'p1' } });
      tabs.restart();

      // Act
      const reopened = await host.tool('browser_open', { name: 'fresh', url: 'https://example.test/next' }, as('f1'));
      const typed = await host.tool('browser_type', { name: 'fresh', selector: '#q', text: 'hi' }, as('f1'));
      const listed = await host.tool('browser_list', {}, as('f1'));
      const control = view(await host.request('GET', CONTROL));

      // Assert — the new page is `p1` again, and it is the agent's to use.
      should(reopened.text).startWith('Opened %browser:fresh');
      should(tabs.pages.map(page => page.id)).containEql('p1');
      should(typed).deepEqual({ text: 'Done on %browser:fresh.' });
      should(listed.text).containEql('fresh');
      should(control.takeovers).deepEqual([]);
      should(tabs.typed).deepEqual([{ pageId: 'p1', text: 'hi' }]);
    });

    it('forgets a takeover when the ferret’s session ends and its pages close with it', async () => {
      // Arrange
      const { host, tabs, as } = await opened();
      await host.request('POST', CONTROL, { body: { action: 'takeover', key: 'app' } });

      // Act
      const stopped = await host.request('POST', BROWSER, { body: { action: 'stop' } });
      const after = view(await host.request('GET', CONTROL));
      tabs.restart();
      await host.tool('browser_open', { name: 'again', url: 'https://example.test/' }, as('f1'));
      const typed = await host.tool('browser_type', { name: 'again', selector: '#q', text: 'hi' }, as('f1'));

      // Assert
      should(stopped.status).equal(200);
      should(after.takeovers).deepEqual([]);
      should(typed).deepEqual({ text: 'Done on %browser:again.' });
    });
  });
});
