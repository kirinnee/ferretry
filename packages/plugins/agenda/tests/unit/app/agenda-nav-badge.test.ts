/**
 * THE INBOX DOOR'S COUNT (`navBadges.agenda`, S4): one machine's share of the number on the Agenda nav entry. It is the
 * Inbox page's own number (`inbox-count.ts`), so what the page leaves out or adds — a machine's notice, a notification,
 * an item in discussion, an answer inside its undo window — it leaves out or adds too. The page and the nav side by side
 * are `features/nav-inbox-agreement.test.tsx`.
 */
import { describe, expect, it } from 'bun:test';
import { MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import { noteClientDaemon } from '@ferretry/app/testing';
import app from '../../../app/index.ts';
import { inboxBadgeOf, needsYouOf } from '../../../app/lib/agenda-nav-badge.ts';
import { inboxCardKey } from '../../../app/lib/agenda-inbox.ts';
import { InboxLocal } from '../../../app/lib/inbox-local.ts';
import manifest from '../../../manifest.ts';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';

const DAEMON = `fy_daemon_${'c'.repeat(43)}`;

const snapshot = (sessionId: string, items: ReturnType<typeof agendaItem>[]) => ({
  v: 1,
  sessionId,
  items,
  resolved: [],
  count: items.length,
  parseErrors: 0,
  updatedAt: '2026-11-01T10:00:00.000Z',
});

/** A machine with one ferret and a machine ledger, counting what it is asked. */
const machine = (ferret: ReturnType<typeof agendaItem>[], ledger: ReturnType<typeof agendaItem>[]) => {
  const routes: string[] = [];
  const client = {
    call: async (route: string) => {
      routes.push(route);
      if (route === 'GET /v1/ferrets') return [{ id: 'zoe', name: 'zoe', title: 'Release train' }];
      if (route === 'GET /v1/agenda/open') return { sessions: [{ sessionId: 'zoe', items: ferret }] };
      if (route === 'GET /v1/sign-in-rules/suggestions') return { suggestions: [] };
      if (route === 'GET /v1/machine/agenda') return snapshot(MACHINE_AGENDA_ID, ledger);
      if (route.includes('/agenda')) return snapshot('zoe', ferret);
      throw new Error(`no route ${route}`);
    },
    subscribe: () => () => undefined,
  };
  noteClientDaemon(client as never, DAEMON);
  return { client: client as never, routes };
};

const until = async (ready: () => boolean): Promise<void> => {
  for (let turn = 0; turn < 400 && !ready(); turn += 1) await new Promise(resolve => setTimeout(resolve, 5));
};

const ASK = agendaItem('A1', { subject: 'Ship?', raisedBySession: 'zoe' });
const NOTICE = agendaItem('A2', { subject: 'Done', notice: true, raisedBySession: 'zoe' });
const LEDGER = agendaItem('A3', { subject: 'Machine notice', notice: true });

describe('the Inbox count on the nav entry', () => {
  it('reads nothing until the shell subscribes, and counts 0 meanwhile', () => {
    const { client, routes } = machine([ASK], []);
    const badge = inboxBadgeOf(client);
    expect(badge.count()).toBe(0);
    expect(routes).toEqual([]);
  });

  it('counts the Inbox: asks, notifications and the machine’s own ledger, once their boards are read', async () => {
    const { client } = machine([ASK, NOTICE], [LEDGER]);
    const badge = inboxBadgeOf(client, { local: new InboxLocal() });
    let heard = 0;
    const stop = badge.subscribe(() => {
      heard += 1;
    });
    await until(() => badge.count() === 3);
    expect(badge.count()).toBe(3);
    expect(heard).toBeGreaterThan(0);
    stop();
  });

  it('leaves out an answer still inside its undo window, as the page does, and hears it change', async () => {
    const { client } = machine([ASK, NOTICE], [LEDGER]);
    const local = new InboxLocal();
    const badge = inboxBadgeOf(client, { local });
    const stop = badge.subscribe(() => undefined);
    await until(() => badge.count() === 3);
    let heard = 0;
    const stopHearing = badge.subscribe(() => {
      heard += 1;
    });
    const owner = {};
    local.publish(owner, {
      hidden: new Set([inboxCardKey(DAEMON as never, 'zoe', 'A1' as never)]),
      replied: { entries: [], notice: null, restores: [] },
    });
    expect(heard).toBe(1);
    expect(badge.count()).toBe(2);
    local.publish(owner, null);
    expect(badge.count()).toBe(3);
    stopHearing();
    stop();
  });

  it('drops a rule suggestion the owner already answered, with no Inbox page mounted', async () => {
    const suggestion = agendaItem('A1', {
      subject: 'Standing rule?',
      kind: 'permission',
      signInRuleSuggestion: { suggestion: 'srg_0000000000000007' },
      raisedBySession: 'zoe',
    } as never);
    const { client, routes } = machine([suggestion], []);
    const badge = inboxBadgeOf(client, { local: new InboxLocal() });
    const stop = badge.subscribe(() => undefined);
    await until(() => routes.includes('GET /v1/sign-in-rules/suggestions') && badge.count() === 0);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(badge.count()).toBe(0);
    stop();
  });

  it('stops watching when the last listener goes', async () => {
    const { client, routes } = machine([ASK], []);
    const badge = inboxBadgeOf(client, { local: new InboxLocal() });
    const stop = badge.subscribe(() => undefined);
    await until(() => badge.count() === 1);
    stop();
    const quiet = routes.length;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(routes.length).toBe(quiet);
  });
});

describe('the Agenda half’s shell parts', () => {
  const client = {
    call: async (route: string) => {
      if (route === 'GET /v1/agenda/open')
        return { sessions: [{ sessionId: 'khristina', items: [agendaItem('A1'), agendaItem('A2')] }] };
      throw new Error(`no route ${route}`);
    },
    subscribe: () => () => undefined,
  } as never;

  it('declares the Inbox count for its nav screen and the Needs you panel for the nav slot', () => {
    expect(Object.keys(app.shell.navBadges ?? {})).toEqual(['agenda']);
    expect(Object.keys(app.shell.navPanels ?? {})).toEqual(['needs-you']);
    const navScreens = (manifest.ui?.screens ?? []).filter(screen => screen.nav !== undefined).map(screen => screen.id);
    expect(navScreens).toContain('agenda');
    expect((manifest.ui?.panels ?? []).filter(panel => panel.slot === 'nav').map(panel => panel.id)).toEqual([
      'needs-you',
    ]);
  });

  it('builds the count over the machine’s client, reading nothing until it is subscribed', () => {
    const badge = app.shell.navBadges?.agenda?.({ client } as never);
    expect(badge?.count()).toBe(0);
  });

  it('shares one needs-you value per client with Ferrets’ list', () => {
    expect(needsYouOf(client)).toBe(needsYouOf(client));
    expect(needsYouOf({ call: (async () => ({ sessions: [] })) as never })).not.toBe(needsYouOf(client));
  });
});
