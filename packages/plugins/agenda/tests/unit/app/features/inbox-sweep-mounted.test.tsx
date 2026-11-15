/**
 * THE INBOX VIEW MOUNTS THE SWEEP (C2, GAP(sign-in-rule-sweep) closed): the Inbox a view of this half draws reads each
 * machine's owner suggestion list through that machine's own client, and a suggestion card the list no longer holds
 * leaves the Inbox though it stays open on the ferret's agenda.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { type AgendaItem, MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import {
  deviceViewHarness,
  ensureDom,
  fakeReachRow,
  interact,
  type Mounted,
  mount,
  noteClientDaemon,
  settleUntil,
} from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { useRuntimeInbox } from '../../../../app/hooks/use-agenda-inbox.ts';
import { fleetIn } from '../../../../app/lib/agenda-fleet.ts';
import { agendaItem } from '../../../support/app/agenda-inbox.tsx';

ensureDom();

const A = `fy_daemon_${'a'.repeat(43)}`;
// The answered set is the app's one, so each test names suggestions of its own.
const ids = (n: number) => ({ open: `srg_0000000000000${n}a1`, answered: `srg_0000000000000${n}a2` });
const at = '2026-08-01T11:00:00.000Z';

const suggestionCard = (id: string, suggestion: string): AgendaItem =>
  agendaItem(id, {
    kind: 'permission',
    subject: `Rule ${suggestion}`,
    signInRuleSuggestion: { suggestion },
  } as Partial<AgendaItem>);

/** A machine whose Inbox holds two suggestion cards and whose owner list holds only `still`. */
function machine(own: ReturnType<typeof ids>, still: readonly string[], listAnswers: 'list' | 'refuses' = 'list') {
  const calls: string[] = [];
  const items = [suggestionCard('A1', own.open), suggestionCard('A2', own.answered)];
  const client = {
    call: async (route: string) => {
      calls.push(route);
      if (route === 'GET /v1/machine/agenda')
        return {
          v: 1,
          sessionId: MACHINE_AGENDA_ID,
          items,
          resolved: [],
          count: items.length,
          parseErrors: 0,
          updatedAt: at,
        };
      if (route === 'GET /v1/ferrets') return [];
      if (route === 'GET /v1/agenda/open') return { sessions: [] };
      if (route === 'GET /v1/sign-in-rules/suggestions') {
        if (listAnswers === 'refuses') throw Object.assign(new Error('forbidden'), { status: 403 });
        return { suggestions: still.map(id => ({ id })) };
      }
      throw new Error(`no route ${route}`);
    },
    subscribe: () => () => undefined,
  } as unknown as PluginClient;
  noteClientDaemon(client as never, A);
  return { client, calls };
}

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

async function draw(client: PluginClient) {
  const harness = deviceViewHarness({ plugin: 'agenda', fragments: [] });
  harness.setRows([fakeReachRow({ daemon: A, client, machine: 'laptop' })]);
  const fleet = fleetIn({});
  const runtime = fleet.runtimeOf(client);
  const Probe = () => {
    const inbox = useRuntimeInbox(runtime, undefined, fleet);
    return <p data-cards={inbox.cards.map(card => card.item.id).join(',')} />;
  };
  view = await mount(
    <harness.Harness place="daemon">
      <Probe />
    </harness.Harness>,
  );
  const cards = (): string => view?.container.querySelector('[data-cards]')?.getAttribute('data-cards') ?? '';
  return { cards, runtime };
}

describe('the Inbox’s answered-suggestion sweep, mounted', () => {
  it('reads the machine’s owner list and takes the card it no longer holds out of the Inbox', async () => {
    const owner = machine(ids(1), [ids(1).open]);
    const { cards, runtime } = await draw(owner.client);
    await settleUntil(
      () => cards() === 'A1',
      () => `the answered suggestion stayed in the Inbox: ${cards()}`,
      interact,
    );
    expect(owner.calls).toContain('GET /v1/sign-in-rules/suggestions');
    runtime.ferrets.stop();
  });

  it('hides nothing when the machine refuses its owner list', async () => {
    const owner = machine(ids(2), [], 'refuses');
    const { cards, runtime } = await draw(owner.client);
    await settleUntil(
      () => owner.calls.includes('GET /v1/sign-in-rules/suggestions'),
      () => 'the owner list was never read',
      interact,
    );
    await interact(() => new Promise(resolve => setTimeout(resolve, 20)));
    expect(cards()).toBe('A1,A2');
    runtime.ferrets.stop();
  });
});
