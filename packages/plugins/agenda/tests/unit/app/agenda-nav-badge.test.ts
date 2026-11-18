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
import { RepliedAgenda } from '../../../app/lib/agenda-replied.ts';
import { deriveInbox } from '../../../app/lib/inbox-count.ts';
import { agendaItem, inboxCard } from '../../support/app/agenda-inbox.tsx';
import { sessionView } from '../../support/app/sessions.ts';

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
const machine = (
  ferret: ReturnType<typeof agendaItem>[],
  ledger: ReturnType<typeof agendaItem>[],
  daemon: string = DAEMON,
  /** While set, the machine's ferret list is not answered: the ledger is read, the conversations are not yet. */
  hold: { release?: () => void; gate?: Promise<void> } = {},
) => {
  const routes: string[] = [];
  /** The transport events the machine's runtime listens to, by the event it asked for. */
  const listeners = new Set<(payload: unknown) => void>();
  const client = {
    call: async (route: string) => {
      routes.push(route);
      if (route === 'GET /v1/ferrets') {
        await hold.gate;
        return [{ id: 'zoe', name: 'zoe', title: 'Release train' }];
      }
      if (route === 'GET /v1/agenda/open') return { sessions: [{ sessionId: 'zoe', items: ferret }] };
      if (route === 'GET /v1/sign-in-rules/suggestions') return { suggestions: [] };
      if (route === 'GET /v1/machine/agenda') return snapshot(MACHINE_AGENDA_ID, ledger);
      if (route.includes('/agenda')) return snapshot('zoe', ferret);
      throw new Error(`no route ${route}`);
    },
    subscribe: (_event: unknown, listener: (payload: unknown) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  noteClientDaemon(client as never, daemon as never);
  return {
    client: client as never,
    routes,
    listening: () => listeners.size,
    /** Fires every event a live subscriber would hear. */
    emit: () => {
      for (const listener of [...listeners]) listener({ ferret: 'zoe' });
    },
  };
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

  it('lets go of the machine’s events and queued reads on the last unsubscribe, and watches again on the next', async () => {
    const { client, routes, listening, emit } = machine([ASK], []);
    const badge = inboxBadgeOf(client, { local: new InboxLocal() });
    const stop = badge.subscribe(() => undefined);
    await until(() => badge.count() === 1);
    expect(listening()).toBe(2);
    // An event inside the refresh cooldown leaves a read queued; the last unsubscribe must cancel it too.
    emit();
    stop();
    expect(listening()).toBe(0);
    // The last COMPLETE count is kept (see "never drops to a partial value" below), not reset to 0.
    expect(badge.count()).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const quiet = routes.length;
    emit();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(routes.length).toBe(quiet);

    const again = badge.subscribe(() => undefined);
    expect(listening()).toBe(2);
    await until(() => badge.count() === 1);
    expect(badge.count()).toBe(1);
    expect(routes.length).toBeGreaterThan(quiet);
    const resumed = routes.length;
    emit();
    await until(() => routes.length > resumed);
    expect(routes.length).toBeGreaterThan(resumed);
    again();
    expect(listening()).toBe(0);
  });
});

describe('the Inbox count never drops to a partial value (E4b: 12 -> 2 -> 12 on opening an ask)', () => {
  it('keeps the last complete count while a rebuilt badge has read only the machine ledger, not yet the conversations', async () => {
    // The nav entry is unmounted and mounted again when an ask opens: the last unsubscribe tears the badge's runtime down and
    // the next subscribe builds a fresh one, which reads the machine ledger before the conversations list.
    const hold: { gate?: Promise<void>; release?: () => void } = {};
    const { client, routes } = machine([ASK, NOTICE], [LEDGER], DAEMON, hold);
    const badge = inboxBadgeOf(client, { local: new InboxLocal() });
    const stop = badge.subscribe(() => undefined);
    await until(() => badge.count() === 3);
    expect(badge.count()).toBe(3);
    stop();

    hold.gate = new Promise<void>(resolve => {
      hold.release = resolve;
    });
    const seen: number[] = [];
    const again = badge.subscribe(() => seen.push(badge.count()));
    seen.push(badge.count());
    // The ledger (1 item) is read while the conversations (2 items) are still on the way.
    await until(() => routes.filter(route => route === 'GET /v1/machine/agenda').length >= 2);
    await new Promise(resolve => setTimeout(resolve, 30));
    seen.push(badge.count());
    hold.release?.();
    await until(() => badge.count() === 3);
    seen.push(badge.count());

    expect(seen.every(count => count === 3)).toBe(true);
    again();
  });
});

describe('the Inbox count across machines: a reply Undo belongs to its own machine', () => {
  const A = `fy_daemon_${'d'.repeat(43)}`;
  const B = `fy_daemon_${'e'.repeat(43)}`;
  const view = sessionView('zoe', { config: { teammate: 'zoe', name: 'Release train' } });
  const aCard = inboxCard(ASK, view, 'A', A as never);

  /** A reply sent from A's card and taken back with Undo, as the Inbox page does it, published to the device's local state. */
  const undone = async (local: InboxLocal) => {
    const replied = new RepliedAgenda({ withdraw: async () => 'withdrawn', unsnooze: async () => undefined });
    expect(replied.mark(aCard, { words: 'yes', sendId: 'send-1' })).toBe(true);
    await replied.undo(aCard.key);
    expect(replied.getSnapshot().entries.map(entry => entry.phase)).toEqual(['back']);
    local.publish({}, { hidden: new Set(), replied: replied.getSnapshot() });
  };

  it('counts A’s card once across two unlocked machines: the nav is the Inbox', async () => {
    const local = new InboxLocal();
    const a = machine([ASK], [], A);
    const b = machine([], [], B);
    const badgeA = inboxBadgeOf(a.client, { local });
    const badgeB = inboxBadgeOf(b.client, { local });
    const stops = [badgeA.subscribe(() => undefined), badgeB.subscribe(() => undefined)];
    await until(() => badgeA.count() === 1);
    await undone(local);
    expect(badgeA.count()).toBe(1);
    expect(badgeB.count()).toBe(0);
    expect(badgeA.count() + badgeB.count()).toBe(1);
    for (const stop of stops) stop();
  });

  it('does not count a card of a machine that is locked or unpaired', async () => {
    const local = new InboxLocal();
    await undone(local);
    const machineOf = (daemon: string, name: string) => ({
      connection: { daemonId: daemon as never },
      name,
      sessions: [],
    });
    const a = machineOf(A, 'A');
    const b = machineOf(B, 'B');
    const total = (machines: (typeof a)[]) =>
      deriveInbox(machines, () => undefined, { ...local.getSnapshot(), answered: new Set() }).total;
    // Unlocked, A's replied card is its own to count; with A gone, B counts nothing of it.
    expect(total([a, b])).toBe(total([a]));
    expect(total([b])).toBe(0);
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
