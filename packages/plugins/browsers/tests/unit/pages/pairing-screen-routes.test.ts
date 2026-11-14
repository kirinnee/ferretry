import { describe, it } from 'bun:test';
import { PAIRING_SCREEN_REFUSAL } from '@ferretry/std/pairing-screen';
import should from 'should';
import { BrowserSessionService } from '../../../daemon/pages/service.ts';
import { pageRoutes, streamSocket } from '../../../daemon/pages/routes.ts';
import { LiveWindowLedger } from '@ferretry/std/live-window';
import { protectionWindows } from '../../../daemon/protection/windows.ts';
import { callOf } from '../../support/call.ts';
import { browserKernel } from '../../support/kernel.ts';
import { Tabs } from '../../support/tabs.ts';

/**
 * The legacy per-session browser routes and the viewer stream, for a FERRET and for a person, over a page that shows a
 * live pairing code (docs/pairing.md, "Never show it to an agent"). The code is the repo's fixed fake.
 */
const FAKE_CODE = 'FAKE-PAIR-0000';

async function world() {
  const tabs = new Tabs();
  const clock = { at: Date.parse('2026-11-13T10:00:00.000Z') };
  const pairing = new LiveWindowLedger(() => clock.at);
  const protection = protectionWindows({
    now: () => clock.at,
    connections: () => ({
      advertisement: () =>
        ({
          advertisement: { kind: 'none', refusal: {} },
          appOrigin: 'https://app.example.test',
          allowedOrigins: ['https://app.example.test'],
        }) as never,
    }),
    windows: [() => pairing],
  });
  const browser = new BrowserSessionService(
    { get: async id => (id === 's1' ? {} : undefined) },
    { launch: async () => tabs.automation },
    () => clock.at,
  );
  const app = await browser.openPage('s1', 'app', { url: 'https://app.example.test/' });
  await browser.act('s1', { action: 'activate-page', pageId: app.id });
  const kernel = browserKernel().kernel as never;
  const routes = pageRoutes(kernel, {} as never, browser, protection);
  const stream = streamSocket((kernel as { redaction: never }).redaction, browser, async () => ({
    open: async () => undefined,
    fromClient: () => undefined,
    close: () => undefined,
  }));
  return { tabs, browser, app, routes, stream, pairing, clock };
}

const request = (kind: 'agent' | 'host', body?: unknown) => {
  const { call } = callOf({ method: body === undefined ? 'GET' : 'POST', path: '/v1/sessions/s1/browser', body, kind });
  (call as { params: unknown }).params = new Map([['sessionId', 's1']]);
  return call;
};

const failure = async (work: Promise<unknown>): Promise<{ status?: number; message?: string; code?: string }> =>
  (await work.then(
    () => ({}),
    (error: unknown) => error as { status?: number; message?: string; code?: string },
  )) as { status?: number; message?: string; code?: string };

describe('the per-session browser route, for a page showing a live pairing code', () => {
  it('should refuse a ferret’s read, screenshot and highlight with the one sentence, before the page is touched', async () => {
    // Arrange
    const { tabs, app, routes } = await world();
    tabs.pairing.set(app.id, { marked: true, seen: 1 });

    for (const action of [{ action: 'read' }, { action: 'screenshot' }, { action: 'highlight', selector: '#code' }]) {
      // Act
      const refused = await failure(routes['POST /v1/sessions/:sessionId/browser'](request('agent', action)));

      // Assert
      should(refused.status).equal(403);
      should(refused.message).equal(PAIRING_SCREEN_REFUSAL);
      should(refused.message).not.containEql(FAKE_CODE);
    }
    should(tabs.calls.filter(call => /^(read|screenshot|pointer-highlight)/u.test(call))).eql([]);
  });

  it('should refuse a ferret’s read that was in flight while the page came to show a code', async () => {
    // Arrange
    const { tabs, app, routes } = await world();
    tabs.whileActing = acted => {
      if (acted.startsWith('read-')) tabs.pairing.set(app.id, { marked: true, seen: 1 });
    };

    // Act
    const refused = await failure(routes['POST /v1/sessions/:sessionId/browser'](request('agent', { action: 'read' })));

    // Assert
    should(refused.status).equal(403);
    should(refused.message).equal(PAIRING_SCREEN_REFUSAL);
  });

  it('should refuse a ferret’s read while the DAEMON says a code is live, whatever the page says of itself', async () => {
    // Arrange
    const { tabs, app, routes, pairing, clock } = await world();
    pairing.open('pairing-1', clock.at + 120_000);
    tabs.pairing.set(app.id, { marked: false, seen: 0 });

    // Act
    const refused = await failure(routes['POST /v1/sessions/:sessionId/browser'](request('agent', { action: 'read' })));
    const owner = await routes['POST /v1/sessions/:sessionId/browser'](request('host', { action: 'read' }));

    // Assert
    should(refused.status).equal(403);
    should(refused.message).equal(PAIRING_SCREEN_REFUSAL);
    should(owner.status).equal(200);
  });

  it('should refuse a ferret’s element acts by selector or text, and let a coordinate act through, while a code is live', async () => {
    // Arrange
    const { tabs, routes, pairing, clock } = await world();
    pairing.open('pairing-1', clock.at + 120_000);

    for (const action of [
      { action: 'click', selector: '#code' },
      { action: 'hover', selector: '#code' },
      { action: 'scroll', text: FAKE_CODE },
      { action: 'type', selector: '#code', text: 'x' },
      { action: 'select', selector: '#code', values: ['a'] },
      { action: 'fill-form', fields: [{ selector: '#code', value: 'x' }] },
    ]) {
      // Act
      const refused = await failure(routes['POST /v1/sessions/:sessionId/browser'](request('agent', action)));

      // Assert
      should(refused.status).equal(403);
      should(refused.message).equal(PAIRING_SCREEN_REFUSAL);
    }
    should(tabs.calls.filter(call => call.startsWith('pointer-'))).eql([]);
    const coordinates = await routes['POST /v1/sessions/:sessionId/browser'](
      request('agent', { action: 'scroll', deltaY: 100 }),
    );
    should(coordinates.status).equal(200);
  });

  it('should let a ferret navigate away, and leave a person’s toolbar read of it untouched', async () => {
    // Arrange
    const { tabs, app, routes } = await world();
    tabs.pairing.set(app.id, { marked: true, seen: 1 });

    // Act
    const away = await routes['POST /v1/sessions/:sessionId/browser'](
      request('agent', { action: 'navigate', url: 'https://docs.example.test/' }),
    );
    const owner = await routes['POST /v1/sessions/:sessionId/browser'](request('host', { action: 'read' }));

    // Assert
    should(away.status).equal(200);
    should(owner.status).equal(200);
  });

  it('should read a page that shows no code for a ferret as it always did', async () => {
    // Arrange
    const { routes } = await world();

    // Act
    const answer = await routes['POST /v1/sessions/:sessionId/browser'](request('agent', { action: 'read' }));

    // Assert
    should(answer.status).equal(200);
  });
});

describe('the viewer picture stream', () => {
  it('should refuse a ferret before it asks the browser anything: a frame could show a pairing code', async () => {
    // Arrange
    const { stream } = await world();

    // Act
    const refused = await failure(stream(request('agent')));

    // Assert
    should(refused.status).equal(403);
    should(refused.code).equal('owner_only');
  });

  it('should still open for a person', async () => {
    // Arrange
    const { stream } = await world();

    // Act
    const opened = await stream(request('host'));

    // Assert
    should(opened).be.a.Function();
  });
});
