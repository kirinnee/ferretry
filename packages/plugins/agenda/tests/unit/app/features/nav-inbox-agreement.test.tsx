/**
 * THE NAV COUNT AND THE INBOX ARE ONE NUMBER. The shell's real `NavCount` (the pill on the Agenda entry, over
 * `navBadges.agenda`) and the Inbox page's heading are drawn from one fleet — one unlocked machine and one locked one
 * that must never be read — and read side by side through the transitions that used to pull them apart: the machine's own
 * notice and a ferret's notification (the badge once summed raw summaries and said 1 for an Inbox of 3), and a rule
 * suggestion the owner answered (the Inbox emptied, the badge stayed).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import {
  deviceViewHarness,
  fakeReachRow,
  interact,
  type Mounted,
  mount,
  noteClientDaemon,
  settleUntil,
  NavCount,
  ShellContext,
} from '@ferretry/app/testing';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import { useRuntimeInbox } from '../../../../app/hooks/use-agenda-inbox.ts';
import app from '../../../../app/index.ts';
import { fleetIn } from '../../../../app/lib/agenda-fleet.ts';
import { agendaItem } from '../../../support/app/agenda-inbox.tsx';

const A = `fy_daemon_${'a'.repeat(43)}`;
const B = `fy_daemon_${'b'.repeat(43)}`;
const NOW = Date.parse('2026-11-01T12:00:00.000Z');

type Items = ReturnType<typeof agendaItem>[];
const snapshot = (sessionId: string, items: Items) => ({
  v: 1,
  sessionId,
  items,
  resolved: [],
  count: items.length,
  parseErrors: 0,
  updatedAt: '2026-11-01T10:00:00.000Z',
});

interface Fixture {
  readonly ferret: Items;
  readonly machine: Items;
  /** The rule suggestions the daemon's owner list still holds open. */
  readonly openSuggestions: readonly string[];
}

const ASK = agendaItem('A1', { subject: 'Ship the build?', raisedBySession: 'zoe' });
const NOTIFICATION = agendaItem('A2', { subject: 'Release checks passed', notice: true, raisedBySession: 'zoe' });
const MACHINE_NOTICE = agendaItem('A3', { subject: 'Machine notice', notice: true });
const SUGGESTION = agendaItem('A1', {
  subject: 'Answered rule suggestion',
  kind: 'permission',
  signInRuleSuggestion: { suggestion: 'srg_0000000000000042' },
  raisedBySession: 'zoe',
} as never);

const clientOf = (daemon: string, fixture: Fixture, reads: string[]) => {
  const client = {
    call: async (route: string) => {
      reads.push(`${daemon} ${route}`);
      if (daemon === B) throw new Error('A LOCKED MACHINE WAS READ');
      if (route === 'GET /v1/ferrets') return [{ id: 'zoe', name: 'zoe', title: 'Release train' }];
      if (route === 'GET /v1/agenda/open') return { sessions: [{ sessionId: 'zoe', items: fixture.ferret }] };
      if (route === 'GET /v1/machine/agenda') return snapshot(MACHINE_AGENDA_ID, fixture.machine);
      if (route === 'GET /v1/sign-in-rules/suggestions')
        return { suggestions: fixture.openSuggestions.map(id => ({ id })) };
      if (route.includes('/agenda')) return snapshot('zoe', fixture.ferret);
      throw new Error(`Unexpected route ${route}`);
    },
    subscribe: () => () => undefined,
  };
  noteClientDaemon(client as never, daemon);
  return client;
};

/** The shell's nav and the Inbox page, as one fleet draws them. */
const scene = (fixture: Fixture, reads: string[]) => {
  const own = clientOf(A, fixture, reads);
  const rows = [
    fakeReachRow({ daemon: A, machine: 'Laptop', client: own as never }),
    fakeReachRow({ daemon: B, machine: 'Studio (locked)', client: clientOf(B, fixture, reads) as never, locked: true }),
  ];
  // The shell builds a badge only for a machine that is unlocked: the locked one adds nothing and is never read.
  const badge = app.shell.navBadges?.agenda?.({ client: own } as never);
  if (badge === undefined) throw new Error('Agenda declares no nav count');
  const shell = {
    runtime: {
      subscribe: () => () => undefined,
      version: () => 1,
      navBadges: () => [badge],
    },
  };
  const harness = deviceViewHarness({ plugin: 'agenda', fragments: [] });
  harness.setRows(rows);
  const fleet = fleetIn({});
  const runtime = fleet.runtimeOf(own as never);
  function Inbox() {
    const inbox = useRuntimeInbox(runtime, undefined, fleet);
    return <AgendaInboxPage inbox={inbox} now={NOW} onNavigate={() => undefined} phone={false} />;
  }
  return (
    <ShellContext.Provider value={shell as never}>
      <NavCount plugin="agenda" screen="agenda" label="Agenda" />
      <harness.Harness>
        <Inbox />
      </harness.Harness>
    </ShellContext.Provider>
  );
};

const numbers = (mounted: Mounted) => ({
  nav: mounted.container.querySelector('.fy-nav__badge')?.getAttribute('data-count') ?? '0',
  inbox:
    mounted.container.querySelector('h1.fy-attn-inbox__title [data-unread-badge]')?.getAttribute('data-count') ?? '0',
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('the nav count and the Inbox heading', () => {
  it('say the same number for a machine notice, a ferret notification and an ask — and never read a locked machine', async () => {
    const reads: string[] = [];
    view = await mount(scene({ ferret: [ASK, NOTIFICATION], machine: [MACHINE_NOTICE], openSuggestions: [] }, reads));
    const shown = view;
    await settleUntil(
      () => numbers(shown).inbox === '3' && numbers(shown).nav === '3',
      () => JSON.stringify(numbers(shown)),
      interact,
    );
    expect(numbers(view)).toEqual({ nav: '3', inbox: '3' });
    expect(reads.filter(read => read.startsWith(B))).toEqual([]);
  });

  it('both empty when the mounted sweep finds the owner already answered the only suggestion', async () => {
    const reads: string[] = [];
    view = await mount(scene({ ferret: [SUGGESTION], machine: [], openSuggestions: [] }, reads));
    const shown = view;
    await settleUntil(
      () => reads.some(read => read === `${A} GET /v1/sign-in-rules/suggestions`) && numbers(shown).inbox === '0',
      () => `${JSON.stringify(numbers(shown))} ${reads.join(' | ')}`,
      interact,
    );
    await interact(() => new Promise(resolve => setTimeout(resolve, 20)));
    expect(numbers(view)).toEqual({ nav: '0', inbox: '0' });
  });
});
