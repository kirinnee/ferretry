import { describe, expect, it } from 'bun:test';
import { DAEMON_FEATURES } from '@ferretry/protocol';
import { AgendaInboxPage } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import type { ClearPort } from '../../../src/lib/agenda-clear-agents.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import type { DaemonHealthRead } from '../../../src/lib/daemon-health.ts';
import { agendaItem, fakeInbox, InboxHarness, inboxCard } from '../../support/agenda-inbox.tsx';
import { chooseFromMenu } from '../../support/inbox-menus.ts';
import { interact, mount, must } from '../../support/dom.ts';
import { healthOf } from '../../support/health.ts';
import { sessionView } from '../../support/sessions.ts';
import { settleUntil } from '../../support/settle.ts';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const WORKSHOP = daemonConnection({ daemonId: 'workshop', baseUrl: 'https://workshop.example.test', deviceId: 't1' });
const LAPTOP = daemonConnection({ daemonId: 'laptop', baseUrl: 'https://laptop.example.test', deviceId: 't2' });
const OFFERS: DaemonHealthRead = { kind: 'read', health: healthOf('5.0.0', [DAEMON_FEATURES.agendaClearAgents]) };
const OLD: DaemonHealthRead = { kind: 'read', health: healthOf('4.9.0', []) };

const agentCard = inboxCard(
  agendaItem('A1', { subject: 'Agent asks' }),
  sessionView('agent-1', { config: { mode: 'auto', teammate: 'zoe', name: 'Nightly run' } }),
);
const humanCard = inboxCard(
  agendaItem('A2', { subject: 'Friend asks' }),
  sessionView('chat-1', { config: { mode: 'interactive', teammate: 'kai', name: 'Pairing' } }),
);
const laptopCard = inboxCard(
  agendaItem('A3', { subject: 'Laptop agent asks' }),
  sessionView('agent-2', { config: { mode: 'auto', teammate: 'moe', name: 'Sweep' } }),
  'Laptop',
  LAPTOP.daemonId,
);

/**
 * Waits until the count or the clear has finished — nothing says "Counting…" or "Clearing…" any more. A fixed
 * number of microtask turns only finished when this file ran alone: the reads' promises reach the page through
 * the unit tier's ordered task queue, so the wait is on the condition, a turn of that queue at a time.
 */
const settle = async (): Promise<void> =>
  await settleUntil(
    () => !/Counting…|Clearing…/u.test(document.body.textContent ?? ''),
    'the clear dialog to finish counting or clearing',
    interact,
  );

const mountPage = async (withPort: boolean, health: Record<string, DaemonHealthRead>, calls: string[] = []) => {
  const fake = fakeInbox();
  const port: ClearPort = {
    readHealth: async connection => health[connection.daemonId] ?? { kind: 'failed' },
    fetcher: async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { dryRun?: boolean };
      calls.push(`${new URL(String(input)).hostname} ${body.dryRun === true ? 'dry' : 'clear'}`);
      return new Response(JSON.stringify({ cleared: body.dryRun === true ? 2 : 2, sessions: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  const view = await mount(
    <InboxHarness
      cards={[agentCard, humanCard, laptopCard]}
      fake={fake}
      render={inbox => (
        <AgendaInboxPage
          clock={fake.clock.now}
          inbox={{
            ...inbox,
            connectionFor: id => [WORKSHOP, LAPTOP].find(connection => connection.daemonId === id),
          }}
          now={NOW}
          onNavigate={() => undefined}
          phone={false}
          {...(withPort ? { clearPort: port } : {})}
        />
      )}
    />,
  );
  const kind = (which: string) => chooseFromMenu(view.container, 'kind', which);
  const button = () => view.container.querySelector<HTMLButtonElement>('[data-agenda-clear-agents-button]');
  const dialog = () => view.container.querySelector('[data-clear-dialog]');
  const rows = (): string[] =>
    [...view.container.querySelectorAll('[data-agenda-row]')].map(row => row.textContent?.match(/!(A\d+)/u)?.[1] ?? '');
  return { view, kind, button, dialog, rows, calls };
};

describe('Inbox kind filter', () => {
  it('shows every ferret by default, then only interactive ones, then only agents', async () => {
    const { view, kind, rows } = await mountPage(true, {});
    expect(view.container.querySelector('[data-agenda-kind] [aria-haspopup="menu"]')?.textContent).toBe('All');
    expect(rows().sort()).toEqual(['A1', 'A2', 'A3']);
    await kind('interactive');
    expect(rows()).toEqual(['A2']);
    await kind('auto');
    expect(rows().sort()).toEqual(['A1', 'A3']);
    await view.unmount();
  });
});

describe('Clear all from agent ferrets (gate)', () => {
  it('offers the button only under Agents', async () => {
    const { view, kind, button } = await mountPage(true, {});
    expect(button()).toBeNull();
    await kind('interactive');
    expect(button()).toBeNull();
    await kind('auto');
    expect(must(button(), 'button').textContent).toBe('Clear all from agent ferrets');
    await view.unmount();
  });

  it('offers nothing when the host gave it no way to reach machines', async () => {
    const { view, kind, button } = await mountPage(false, {});
    await kind('auto');
    expect(button()).toBeNull();
    await view.unmount();
  });
});

describe('Clear all from agent ferrets (confirm, clear, result)', () => {
  it('counts across machines, names the one that needs an update, then clears the others', async () => {
    const calls: string[] = [];
    const { view, kind, button, dialog } = await mountPage(true, { workshop: OFFERS, laptop: OLD }, calls);
    await kind('auto');
    await interact(() => must(button(), 'button').click());
    await settle();
    expect(dialog()?.textContent).toContain('Dismiss 2 agenda items from agent ferrets?');
    expect(dialog()?.textContent).toContain('Laptop needs an update to clear');
    expect(calls).toEqual(['workshop.example.test dry']);

    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-clear-confirm-button]'), 'confirm').click(),
    );
    await settle();
    expect(calls).toEqual(['workshop.example.test dry', 'workshop.example.test clear']);
    const result = must(view.container.querySelector('[data-clear-result]'), 'result').textContent ?? '';
    expect(result).toContain('Dismissed 2 agenda items from 1 ferret.');
    expect(result).toContain('Laptop needs an update to clear');

    await interact(() => must(view.container.querySelector<HTMLButtonElement>('[data-clear-close]'), 'close').click());
    expect(dialog()).toBeNull();
    await view.unmount();
  });

  it('clears every machine that offers the feature', async () => {
    const calls: string[] = [];
    const { view, kind, button } = await mountPage(true, { workshop: OFFERS, laptop: OFFERS }, calls);
    await kind('auto');
    await interact(() => must(button(), 'button').click());
    await settle();
    expect(view.container.querySelector('[data-clear-dialog]')?.textContent).toContain('Dismiss 4 agenda items');
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-clear-confirm-button]'), 'confirm').click(),
    );
    await settle();
    expect(calls.filter(call => call.endsWith('clear'))).toEqual([
      'workshop.example.test clear',
      'laptop.example.test clear',
    ]);
    expect(view.container.querySelector('[data-clear-result]')?.textContent).toContain(
      'Dismissed 4 agenda items from 2 ferrets.',
    );
    await view.unmount();
  });

  it('can be cancelled without sending a clear', async () => {
    const calls: string[] = [];
    const { view, kind, button, dialog } = await mountPage(true, { workshop: OFFERS }, calls);
    await kind('auto');
    await interact(() => must(button(), 'button').click());
    await settle();
    await interact(() => must(view.container.querySelector<HTMLButtonElement>('[data-clear-close]'), 'cancel').click());
    expect(dialog()).toBeNull();
    expect(calls).toEqual(['workshop.example.test dry']);
    await view.unmount();
  });

  it('closes on Escape once it has counted', async () => {
    const { view, kind, button, dialog } = await mountPage(true, { workshop: OFFERS }, []);
    await kind('auto');
    await interact(() => must(button(), 'button').click());
    await settle();
    await interact(() => {
      must(dialog(), 'dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(dialog()).toBeNull();
    await view.unmount();
  });

  it('has nothing to confirm when no machine can clear', async () => {
    const { view, kind, button } = await mountPage(true, { workshop: OLD, laptop: { kind: 'failed' } });
    await kind('auto');
    await interact(() => must(button(), 'button').click());
    await settle();
    const text = view.container.querySelector('[data-clear-dialog]')?.textContent ?? '';
    expect(text).toContain('No open agenda items from agent ferrets.');
    expect(text).toContain('Workshop needs an update to clear');
    expect(text).toContain('Laptop could not be reached');
    expect(view.container.querySelector('[data-clear-confirm-button]')).toBeNull();
    await view.unmount();
  });
});
