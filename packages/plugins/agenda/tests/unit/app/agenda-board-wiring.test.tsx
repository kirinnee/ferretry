/**
 * THE REAL CALLERS OF BOARD'S HOOKS: the `agenda` screen, the `agenda-ask` screen and the `ferret-agenda` panel, built
 * by the half the shell builds and mounted over a shell that gives the three app hooks (`agenda.card-answer`,
 * `agenda.lane-proposal`, `agenda.card-reference`). Each assertion fails when its caller drops the wiring (the
 * `AgendaBoardProviders` around the page, or the lane editor handed to `useRuntimeInbox`): Done · closes vanishes, `&F12`
 * stays prose, Edit opens nothing. Without a provider each draws as it does without Board (the fail-closed half).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { type AgendaItem, MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import {
  ensureDom,
  interact,
  type Mounted,
  mount,
  RouterProvider,
  settleUntil,
  WithAppHooks,
} from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { type ComponentType, Suspense } from 'react';
import app from '../../../app/index.ts';
import manifest from '../../../manifest.ts';
import {
  AGENDA_CARD_ANSWER_HOOK,
  AGENDA_CARD_REFERENCE_HOOK,
  AGENDA_LANE_PROPOSAL_HOOK,
} from '../../../contract/app-hooks.ts';
import { agendaItem, choices, LANE_PROPOSAL_ANSWERS, testLaneEditor } from '../../support/app/agenda-inbox.tsx';
import { fakeAnswer, fakeReference } from '../../support/app/board-hooks.ts';

ensureDom();

const FERRET = 'session';
const at = '2026-08-01T11:00:00.000Z';

const snapshot = (sessionId: string, items: readonly AgendaItem[]) => ({
  v: 1,
  sessionId,
  items,
  resolved: [],
  count: items.length,
  parseErrors: 0,
  updatedAt: at,
});

/** A daemon with `items` on the machine's agenda and on one ferret's, answering nothing it was not asked. */
const daemon = (items: readonly AgendaItem[]): PluginClient =>
  ({
    call: async (route: string) => {
      if (route === 'GET /v1/machine/agenda') return snapshot(MACHINE_AGENDA_ID, items);
      if (route === 'GET /v1/ferrets/:ferretId/agenda') return snapshot(FERRET, items);
      if (route === 'GET /v1/ferrets') return [];
      throw new Error(`no route ${route}`);
    },
    subscribe: () => () => undefined,
  }) as unknown as PluginClient;

const closing = agendaItem('A9', {
  subject: 'Pair a second phone',
  why: 'Try &F12 on a second phone.',
  ask: choices('Ship', 'Hold'),
  task: { id: 'F12' },
  offerClose: true,
} as Partial<AgendaItem>);
const proposal = agendaItem('A7', {
  subject: 'Change the lanes',
  sourceRef: 'lanes:P1:3',
  ask: choices(LANE_PROPOSAL_ANSWERS.accept, LANE_PROPOSAL_ANSWERS.edit),
} as Partial<AgendaItem>);

const WIDTH = window.innerWidth;
let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  window.innerWidth = WIDTH;
  window.history.replaceState({}, '', '/');
});

type Provided = Record<string, unknown>;

const drawn = async (
  surface: 'screen' | 'ask' | 'panel',
  items: readonly AgendaItem[],
  provided: Provided,
  ready: (root: HTMLElement) => boolean,
): Promise<HTMLElement> => {
  // A phone: the opened ask is the deck's card, with its answer row.
  window.innerWidth = 400;
  const half = app.build?.({ manifest, client: daemon(items) });
  const component =
    surface === 'screen'
      ? half?.screens.agenda
      : surface === 'ask'
        ? half?.screens['agenda-ask']
        : half?.panels['ferret-agenda'];
  const props =
    surface === 'ask'
      ? { params: { ferret: MACHINE_AGENDA_ID, ask: 'A9' } }
      : surface === 'panel'
        ? { subject: FERRET }
        : { params: {} };
  const Surface = component as unknown as ComponentType<Record<string, unknown>>;
  view = await mount(
    <WithAppHooks provided={provided}>
      <RouterProvider>
        <Suspense fallback={null}>
          <Surface {...props} />
        </Suspense>
      </RouterProvider>
    </WithAppHooks>,
  );
  const root = view.container;
  await settleUntil(
    () => ready(root),
    () => `the surface did not settle; drew: ${root.textContent ?? ''}`,
    interact,
  );
  return root;
};

/** Taps the ask's row, which opens it as the deck's card (a phone), and waits for `ready` there. */
const opened = async (root: HTMLElement, ready: (root: HTMLElement) => boolean): Promise<void> => {
  await interact(() => root.querySelector<HTMLElement>('[data-agenda-row]')?.click());
  await settleUntil(
    () => ready(root),
    () => `the ask did not open; drew: ${root.textContent ?? ''}`,
    interact,
  );
};

const doneClose = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('[data-agenda-done-close]');

const proved = (root: HTMLElement) => [...root.querySelectorAll('a')].filter(a => a.textContent === '&F12');
const doneCalls = (calls: readonly string[]) => calls.filter(call => call.startsWith('done:'));

for (const surface of ['screen', 'ask'] as const) {
  describe(`the ${surface === 'ask' ? 'agenda-ask' : 'agenda'} screen`, () => {
    const ask = (items: readonly AgendaItem[], provided: Provided, ready: (root: HTMLElement) => boolean) =>
      drawn(surface, items, provided, node => node.querySelector('[data-agenda-row]') !== null).then(async root => {
        await opened(root, ready);
        return root;
      });

    test('offers Done · closes through Board’s hook, and one tap sends one done', async () => {
      const { answer, calls } = fakeAnswer();
      const root = await ask([closing], { [AGENDA_CARD_ANSWER_HOOK]: answer }, node => doneClose(node) !== null);
      await interact(() => doneClose(root)?.click());
      await interact(() => new Promise<void>(done => setTimeout(done, 0)));
      expect(doneCalls(calls)).toEqual(['done:F12']);
    });

    test('offers no Done · closes without Board’s hook (it fails closed)', async () => {
      const root = await ask([closing], {}, node => node.textContent?.includes('Try') === true);
      expect(doneClose(root)).toBeNull();
    });

    test('links `&F12` when Board proves it, and leaves it prose without the hook', async () => {
      const reference = fakeReference();
      const root = await ask(
        [closing],
        { [AGENDA_CARD_REFERENCE_HOOK]: reference },
        node => node.textContent?.includes('Try') === true,
      );
      expect(reference.watched).toEqual(['ids']);
      expect(proved(root)).toHaveLength(1);
      await view?.unmount();
      view = null;
      const bare = await ask([closing], {}, node => node.textContent?.includes('Try') === true);
      expect(proved(bare)).toHaveLength(0);
    });

    test('opens Board’s lane editor on Edit; without the hook Edit only answers', async () => {
      const edit = (node: HTMLElement) => node.querySelector<HTMLButtonElement>('[data-agenda-option="Edit"]');
      const root = await ask(
        [proposal],
        { [AGENDA_LANE_PROPOSAL_HOOK]: { editorFor: testLaneEditor } },
        node => edit(node) !== null,
      );
      const before = window.location.pathname;
      await interact(() => edit(root)?.click());
      expect(window.location.pathname).toBe('/lane-editor/lanes:P1:3');
      await view?.unmount();
      view = null;
      window.history.replaceState({}, '', before);
      const bare = await ask([proposal], {}, node => edit(node) !== null);
      await interact(() => edit(bare)?.click());
      expect(window.location.pathname).toBe(before);
    });
  });
}

describe('the ferret-agenda panel', () => {
  test('keeps the card ids Board proves live through its hook, and reads none without it', async () => {
    const reference = fakeReference();
    await drawn(
      'panel',
      [closing],
      { [AGENDA_CARD_REFERENCE_HOOK]: reference },
      node => node.querySelector('[data-agenda-tab-row]') !== null,
    );
    expect(reference.watched).toEqual(['ids']);
    await view?.unmount();
    view = null;
    const none = fakeReference();
    await drawn('panel', [closing], {}, node => node.querySelector('[data-agenda-tab-row]') !== null);
    expect(none.watched).toEqual([]);
  });
});
