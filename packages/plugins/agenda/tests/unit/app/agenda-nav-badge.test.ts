/**
 * THE INBOX DOOR'S COUNT (`navBadges.agenda`, S4): one machine's share of the number on the Agenda nav entry — the open
 * items of the ferrets that wait on the owner, live while the shell subscribes, and nothing read before it does.
 */
import { describe, expect, it } from 'bun:test';
import type { FerretNeedsYou, FerretsNeedsYou } from '@ferretry/core-ferrets/contract';
import app from '../../../app/index.ts';
import { inboxBadgeOf, needsYouOf } from '../../../app/lib/agenda-nav-badge.ts';
import manifest from '../../../manifest.ts';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';

const waiting = (count: number): FerretNeedsYou => ({ count, latestAt: '2026-11-01T10:00:00.000Z', ask: 'Pick one' });

/** A needs-you value over a map the test moves, counting who watches. */
const scripted = (initial: ReadonlyMap<string, FerretNeedsYou>) => {
  let held = initial;
  const listeners = new Set<() => void>();
  let watching = 0;
  const needsYou: FerretsNeedsYou = {
    subscribe: listener => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    watch: () => {
      watching += 1;
      return () => {
        watching -= 1;
      };
    },
    needing: () => held,
  };
  return {
    needsYou,
    move: (next: ReadonlyMap<string, FerretNeedsYou>) => {
      held = next;
      for (const listener of [...listeners]) listener();
    },
    watching: () => watching,
    listening: () => listeners.size,
  };
};

describe('the Inbox count on the nav entry', () => {
  it('sums the open items of every ferret that waits on the owner', () => {
    const machine = scripted(
      new Map([
        ['khristina', waiting(3)],
        ['judson', waiting(1)],
      ]),
    );
    expect(inboxBadgeOf(machine.needsYou).count()).toBe(4);
  });

  it('is zero when nothing waits, and follows the machine while subscribed', () => {
    const machine = scripted(new Map());
    const badge = inboxBadgeOf(machine.needsYou);
    expect(badge.count()).toBe(0);
    let heard = 0;
    const stop = badge.subscribe(() => {
      heard += 1;
    });
    machine.move(new Map([['zoe', waiting(2)]]));
    expect(heard).toBe(1);
    expect(badge.count()).toBe(2);
    stop();
  });

  it('keeps the machine watched only while the shell is subscribed', () => {
    const machine = scripted(new Map());
    const badge = inboxBadgeOf(machine.needsYou);
    expect(machine.watching()).toBe(0);
    const stop = badge.subscribe(() => undefined);
    expect(machine.watching()).toBe(1);
    expect(machine.listening()).toBe(1);
    stop();
    expect(machine.watching()).toBe(0);
    expect(machine.listening()).toBe(0);
  });
});

describe('the Agenda half’s shell parts', () => {
  const client = {
    call: async (route: string) => {
      if (route === 'GET /v1/agenda/open')
        return {
          sessions: [{ sessionId: 'khristina', items: [agendaItem('A1'), agendaItem('A2')] }],
        };
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

  it('builds the count over the machine’s roll-up, reading nothing until it is subscribed', async () => {
    const badge = app.shell.navBadges?.agenda?.({ client } as never);
    expect(badge?.count()).toBe(0);
    let heard = 0;
    const stop = badge?.subscribe(() => {
      heard += 1;
    });
    for (let turn = 0; turn < 20 && badge?.count() === 0; turn += 1)
      await new Promise(resolve => setTimeout(resolve, 5));
    expect(badge?.count()).toBe(2);
    expect(heard).toBeGreaterThan(0);
    stop?.();
  });

  it('shares one needs-you value per client between the nav count and Ferrets’ list', () => {
    expect(needsYouOf(client)).toBe(needsYouOf(client));
    expect(needsYouOf({ call: (async () => ({ sessions: [] })) as never })).not.toBe(needsYouOf(client));
  });
});
