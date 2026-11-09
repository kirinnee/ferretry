/**
 * m2 — a just-paired machine with steps not looked at yet opens its steps page by itself (Onboarding's device view).
 * Drawn as the shell draws a device view: the rows and the paired list are the test's, the router is a real one.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  deviceViewHarness,
  ensureDom,
  fakeReachRow,
  interact,
  type Mounted,
  mount,
  noteClientDaemon,
} from '@ferretry/app/testing';
import { RouterProvider } from '@ferretry/app/testing/router';
import type { PluginClient } from '@ferretry/kernel/manifest';
import half from '../../../app/index.ts';
import { createStepsOpener } from '../../../app/views/steps-opener.tsx';

ensureDom();

const A = `fy_daemon_${'a'.repeat(43)}`;
const B = `fy_daemon_${'b'.repeat(43)}`;

const step = (state: 'pending' | 'found' | 'done') => ({
  plugin: 'logins',
  id: 'login',
  title: 'Sign in',
  order: 30,
  state,
});

/** One machine's Onboarding client: `GET /v1/onboarding` answers these step states (or fails). */
function machineClient(daemon: string, state: 'pending' | 'found' | 'done' | 'fails') {
  const calls: string[] = [];
  const client = {
    call: async (route: string) => {
      calls.push(route);
      if (state === 'fails') throw new Error('unreachable');
      return { steps: [step(state)], complete: state !== 'pending' };
    },
    subscribe: () => () => {},
  } as unknown as PluginClient;
  noteClientDaemon(client as never, daemon);
  return { client, calls };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

const FIRST_RUN = { plugin: 'onboarding', id: 'onboarding', path: '/onboarding', label: 'Onboarding' } as const;

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  window.history.replaceState(null, '', '/');
});

/** The view drawn with `already` paired at the start; returns the harness and every address it was sent to. */
async function open(already: readonly string[], address = '/') {
  window.history.replaceState(null, '', address);
  const harness = deviceViewHarness({ plugin: 'onboarding', fragments: [] });
  harness.setPaired(already);
  const went: string[] = [];
  const replaced: (boolean | undefined)[] = [];
  const View = createStepsOpener();
  view = await mount(
    <RouterProvider screens={[FIRST_RUN]}>
      <harness.Harness>
        <View
          navigate={(to, options) => {
            went.push(to);
            replaced.push(options?.replace);
          }}
        />
      </harness.Harness>
    </RouterProvider>,
  );
  await settle();
  return { harness, went, replaced };
}

/** A machine joins the paired list while the tab is open and its row comes. */
async function pairNow(
  harness: Awaited<ReturnType<typeof open>>['harness'],
  paired: readonly string[],
  rows: readonly ReturnType<typeof fakeReachRow>[],
) {
  await interact(() => {
    harness.setPaired(paired);
    harness.setRows(rows);
  });
  await settle();
}

describe('m2 a just-paired machine opens its steps page by itself', () => {
  it('declares its one device view', () => {
    expect(Object.keys(half.shell.device ?? {})).toEqual(['steps-opener']);
  });

  it('opens the steps page of a machine paired now that has steps not looked at yet, once', async () => {
    const b = machineClient(B, 'pending');
    const { harness, went } = await open([]);
    await pairNow(harness, [B], [fakeReachRow({ daemon: B, client: b.client })]);
    expect(went).toEqual([`/d/${B}/onboarding/steps`]);
    // A later change of the list or the rows decides nothing again.
    await pairNow(harness, [B], [fakeReachRow({ daemon: B, client: b.client })]);
    expect(went).toHaveLength(1);
    expect(b.calls).toEqual(['GET /v1/onboarding']);
  });

  it('m2 opens by REPLACING the entry Access navigated to, so Back never lands on a second one', async () => {
    const b = machineClient(B, 'pending');
    const { harness, went, replaced } = await open([]);
    await pairNow(harness, [B], [fakeReachRow({ daemon: B, client: b.client })]);
    expect(went).toHaveLength(1);
    expect(replaced).toEqual([true]);
  });

  it('opens nothing for a machine already paired when the view first drew, and never reads it', async () => {
    const a = machineClient(A, 'pending');
    const { harness, went } = await open([A]);
    await interact(() => harness.setRows([fakeReachRow({ daemon: A, client: a.client })]));
    await settle();
    expect(went).toEqual([]);
    expect(a.calls).toEqual([]);
  });

  it('opens nothing when the machine has nothing left to look at', async () => {
    const b = machineClient(B, 'found');
    const { harness, went } = await open([]);
    await pairNow(harness, [B], [fakeReachRow({ daemon: B, client: b.client })]);
    expect(b.calls).toEqual(['GET /v1/onboarding']);
    expect(went).toEqual([]);
  });

  it('opens nothing when the steps cannot be read', async () => {
    const b = machineClient(B, 'fails');
    const { harness, went } = await open([]);
    await pairNow(harness, [B], [fakeReachRow({ daemon: B, client: b.client })]);
    expect(went).toEqual([]);
  });

  it('reads no locked machine (nothing may prompt)', async () => {
    const b = machineClient(B, 'pending');
    const { harness, went } = await open([]);
    await pairNow(harness, [B], [fakeReachRow({ daemon: B, client: b.client, locked: true })]);
    expect(b.calls).toEqual([]);
    expect(went).toEqual([]);
  });

  it('leaves the first run alone: its own last stage is the way to the steps page', async () => {
    const b = machineClient(B, 'pending');
    const { harness, went } = await open([], '/onboarding');
    await pairNow(harness, [B], [fakeReachRow({ daemon: B, client: b.client })]);
    expect(went).toEqual([]);
  });
});
