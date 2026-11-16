import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, RouterProvider } from '@ferretry/app/testing';
import { LinksScreen } from '../../../../app/links/links-screen.tsx';
import { type FakeClient, fakeClient } from '../../../support/app/fake-client.ts';
import { withClient } from '../../../support/app/client.tsx';
import { conversation, ferret, hoursAgo, listing, settle, type } from '../../../support/app/links.ts';

const RESUME = 'POST /v1/ferrets/:ferretId/resume';
const KEEP = 'POST /v1/links/conversations/keep';

const FERRETS = [
  ferret('run-ferret', { name: 'shop', state: 'working', stateAt: hoursAgo(1) }),
  ferret('nap-ferret', { name: 'notes', folder: '/work/notes', state: 'stopped', stateAt: hoursAgo(2) }),
];

const daemon = (): FakeClient =>
  fakeClient(
    {
      'GET /v1/ferrets': () => FERRETS,
      // Continue searches the synced listing; Keep reads one CLI’s, which is empty here so no runtime slot is drawn.
      'GET /v1/links/conversations': call =>
        call.query.harness === undefined
          ? listing([conversation('shop-cart', { keptBy: 'run-ferret' }), conversation('new-idea')])
          : listing([]),
      'GET /v1/links/conversations/:harness/:conversationId/preview': call => ({
        id: call.params.conversationId,
        harness: call.params.harness,
        messages: [],
      }),
      'GET /v1/links/history': () => ({ entries: [], skipped: 0 }),
      [RESUME]: () => ({}),
      [KEEP]: () => ({
        kept: [{ id: 'new-idea', ferret: 'idea-ferret', name: 'idea', state: 'starting' }],
        refused: [],
      }),
    },
    'd1',
  );

let view: Mounted | null = null;
let client: FakeClient = daemon();
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const open = async (): Promise<void> => {
  client = daemon();
  view = await mount(<RouterProvider>{withClient(client, <LinksScreen />)}</RouterProvider>);
  await settle();
};
const find = <T extends Element = HTMLElement>(selector: string): T =>
  must(view?.container.querySelector<T>(selector), selector);
const click = async (selector: string): Promise<void> => {
  const element = find(selector);
  await interact(() => element.click());
  await settle();
};
const part = (id: string): string => `[data-segmented="links-part"] [data-segment="${id}"]`;

describe('LinksScreen', () => {
  it('switches between Continue, Keep and History', async () => {
    await open();
    expect(find(part('continue')).getAttribute('aria-pressed')).toBe('true');
    expect(view?.container.querySelector('[data-continue-conversation]')).not.toBeNull();

    await click(part('keep'));
    expect(find(part('keep')).getAttribute('aria-pressed')).toBe('true');
    expect(view?.container.querySelector('[data-continue-conversation]')).toBeNull();
    expect(find('[data-keep-conversations]').textContent).toContain('Keep conversations');
    expect(find('[data-setup-note="conversations-empty"]').textContent).toBe(
      'No Claude Code conversations on this machine.',
    );

    await click(part('history'));
    expect(view?.container.querySelector('[data-keep-conversations]')).toBeNull();
    expect(find('#link-history-heading').textContent).toBe('Harness history');
    expect(view?.container.textContent).toContain('No readable harness conversations were found on this daemon.');
    expect(client.callsTo('GET /v1/links/history')).toHaveLength(1);
    expect(client.callsTo('GET /v1/runtimes')).toHaveLength(0);
  });

  it('opens the ferret a conversation is kept by on Conversation’s chat screen', async () => {
    await open();
    await click('[data-continue-row="shop-cart"]');
    const actionButton = '[data-continue-action="conversation:claude-code:shop-cart"]';
    expect(find(actionButton).textContent).toBe('Open ferret');
    await click(actionButton);
    expect(window.location.pathname).toBe('/d1/conversation/chat');
    expect(new URLSearchParams(window.location.search).get('ferret')).toBe('run-ferret');
    expect(client.callsTo(RESUME)).toHaveLength(0);
  });

  it('outside a shell with no runtime picker placed, Continue takes a typed runtime name', async () => {
    await open();
    await click('[data-continue-row="new-idea"]');
    await click('[data-continue-action="conversation:claude-code:new-idea"]');
    const typed = find<HTMLInputElement>('[data-continue-runtimes="new-idea"] [data-runtime-typed]');
    expect(find('[data-continue-on-runtime]').hasAttribute('disabled')).toBe(true);
    await type(typed, ' claude-main ');
    await click('[data-continue-on-runtime="claude-main"]');
    const [kept] = client.callsTo(KEEP);
    expect(kept?.body).toEqual({
      harness: 'claude-code',
      runtime: 'claude-main',
      conversations: [{ id: 'new-idea', start: true }],
    });
  });

  it('resumes a stopped ferret through Ferrets’ resume route, then opens it', async () => {
    await open();
    await click('[data-continue-ferret="nap-ferret"]');
    await click('[data-continue-action="ferret:nap-ferret"]');
    const [resumed] = client.callsTo(RESUME);
    expect(resumed?.params).toEqual({ ferretId: 'nap-ferret' });
    expect(resumed?.body).toEqual({});
    expect(typeof resumed?.headers['x-fy-request-id']).toBe('string');
    expect(window.location.pathname).toBe('/d1/conversation/chat');
    expect(new URLSearchParams(window.location.search).get('ferret')).toBe('nap-ferret');
  });
});
