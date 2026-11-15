/**
 * Opening an ask is told to the `agenda.item-opened` hook (Access provides it) with the machine's seen mark in hand:
 * the ferret and the ask reach it, nothing is posted until the provider makes the mark, a provider that fails changes
 * nothing, and with no provider (or a value without the shape) nothing is said.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { ensureDom, type Mounted, mount, WithAppHooks } from '@ferretry/app/testing';
import { AGENDA_ITEM_OPENED_HOOK, type AgendaSeenMark } from '../../../contract/app-hooks.ts';
import { useItemOpened } from '../../../app/hooks/use-item-opened.ts';
import { daemonId } from '../../../app/shell.ts';

ensureDom();

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const routes: string[] = [];
const client = {
  call: async (route: string) => {
    routes.push(route);
    return { cleared: true, tags: [] };
  },
} as never;

const open = async (provided: Record<string, unknown>): Promise<void> => {
  routes.length = 0;
  let tell: (ferret: string, ask: string) => void = () => undefined;
  function Probe() {
    tell = useItemOpened(daemonId('home'), client);
    return null;
  }
  mounted = await mount(
    <WithAppHooks provided={provided}>
      <Probe />
    </WithAppHooks>,
  );
  tell('f1', 'A3');
  for (let spin = 0; spin < 3; spin += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

describe('useItemOpened', () => {
  it('tells the provider which ferret and which ask were opened, and posts nothing until it makes the mark', async () => {
    const told: string[] = [];
    await open({
      [AGENDA_ITEM_OPENED_HOOK]: async (ferret: string, ask: string) => void told.push(`${ferret}/${ask}`),
    });
    expect(told).toEqual(['f1/A3']);
    expect(routes).toEqual([]);
  });

  it('hands the provider the machine’s seen mark, which posts Agenda’s own route when made', async () => {
    const answers: unknown[] = [];
    await open({
      [AGENDA_ITEM_OPENED_HOOK]: async (_f: string, _a: string, seen: AgendaSeenMark) => answers.push(await seen()),
    });
    expect(routes).toEqual(['POST /v1/push/seen']);
    expect(answers).toEqual([{ cleared: true, tags: [] }]);
  });

  it('does not mind a provider that fails', async () => {
    let called = 0;
    await open({
      [AGENDA_ITEM_OPENED_HOOK]: async () => {
        called += 1;
        throw new Error('no push worker');
      },
    });
    expect(called).toBe(1);
  });

  it('says nothing when no provider gives the hook, or the value is not a function', async () => {
    await open({});
    await mounted?.unmount();
    await open({ [AGENDA_ITEM_OPENED_HOOK]: { not: 'a function' } });
    expect(routes).toEqual([]);
  });
});
