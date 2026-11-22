/**
 * The Warden's first-run page inside the REAL setup flow (Onboarding's `createSetupFlow` / `FlowPage`), over a fake machine.
 * The page's "Confirm it’s you" must do what the footer's Next does: in the real flow `step.next()` only navigates (it marks
 * the step done and moves on), so the page has to run the registered save itself. What is asserted is what the person can do:
 * a declined passkey stays on the step with nothing written, and a successful one writes `warden.yaml` once and then advances.
 * The flow screen is Onboarding's own (a tests-only carve-out in `context-imports`); the page is this plugin's own, placed in
 * the `onboarding.step` slot with its own deps (the harness shell has no daemon list for the panel's client wiring).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { type ComponentType, Suspense, type ReactNode } from 'react';
import onboardingApp from '@ferretry/plugin-onboarding/app';
import onboardingManifest from '@ferretry/plugin-onboarding/manifest';
import {
  deviceViewHarness,
  ensureDom,
  fakeReachRow,
  interact,
  type Mounted,
  mount,
  must,
  noteClientDaemon,
  type PlacedPanel,
  WithSlotPanels,
} from '@ferretry/app/testing';
import { WardenStepPage, type WardenStepDeps } from '../../../../app/features/onboarding/warden-step-page.tsx';
import type { WardenConfigPatch } from '../../../../app/wire.ts';
import manifest from '../../../../manifest.ts';
import { fakeWardenClient } from '../../../support/app/clients.ts';
import { wardenConfig } from '../../../support/app/warden.ts';

ensureDom();

const DAEMON = 'fy_daemon_a';

/** What the daemon client throws for `403 grant_step_up_required`. */
const stepUpRefusal = (): Error =>
  Object.assign(new Error('grant_step_up_required: this act needs a recent passkey'), {
    status: 403,
    code: 'grant_step_up_required',
  });

/** A machine whose Warden step is the only step, and whose first `declines` writes of `warden.yaml` are refused for the passkey. */
function machine(declines: number) {
  const answers: string[] = [];
  const attempts: WardenConfigPatch[] = [];
  const written: WardenConfigPatch[] = [];
  const steps = (manifest.onboarding ?? []).map(step => ({
    plugin: 'warden',
    id: step.id,
    title: step.title,
    order: step.order,
    side: 'daemon',
    group: 'Warden',
    stepHost: true,
    state: 'pending',
  }));
  const client = {
    async call(route: string, request?: { body?: unknown }) {
      if (route === 'GET /v1/onboarding') return { steps, complete: false, setUp: false };
      if (route.startsWith('POST /v1/onboarding')) {
        answers.push(((request ?? {}) as { body: { state: string } }).body.state);
        return {};
      }
      throw new Error(`no route ${route}`);
    },
    subscribe: () => () => undefined,
  } as unknown as PluginClient;
  noteClientDaemon(client, DAEMON);
  const deps: WardenStepDeps = {
    client: fakeWardenClient({
      updateConfig: async patch => {
        attempts.push(patch);
        if (attempts.length <= declines) throw stepUpRefusal();
        written.push(patch);
        return { config: wardenConfig(), accounts: [], warnings: [] };
      },
    }),
    readFile: async () => ({ exists: false }),
    readKey: async () => 'off',
  };
  return { client, deps, answers, attempts, written };
}

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

/** The real flow screen, with the real Warden page placed in the `onboarding.step` slot. */
async function openFlow(declines: number) {
  const gone = machine(declines);
  const harness = deviceViewHarness({ plugin: 'onboarding', fragments: [] });
  harness.setRows([fakeReachRow({ daemon: DAEMON, machine: 'Studio', client: gone.client })]);
  const panels = (manifest.ui?.panels ?? [])
    .filter(panel => panel.slot === 'onboarding.step')
    .map(
      (panel): PlacedPanel => ({
        plugin: 'warden',
        id: panel.id,
        view: props => <WardenStepPage deps={gone.deps} step={(props as PanelProps).step} keyRow={null} />,
      }),
    );
  const onboardingScreens = must(
    onboardingApp.build?.({ manifest: onboardingManifest, client: gone.client } as never)?.screens,
    'the onboarding screens',
  ) as Record<string, unknown>;
  const Flow = must(onboardingScreens.flow, 'the flow screen') as ComponentType;
  const tree: ReactNode = (
    <harness.Harness place="daemon">
      <WithSlotPanels slots={{ 'onboarding.step': panels }}>
        <Suspense fallback={null}>
          <Flow />
        </Suspense>
      </WithSlotPanels>
    </harness.Harness>
  );
  view = await mount(tree);
  await settle();
  return gone;
}

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 40; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};
const root = (): HTMLElement => must(view, 'a mounted flow').container;
const press = async (selector: string): Promise<void> => {
  await interact(() => must(root().querySelector<HTMLElement>(selector), selector).click());
  await settle();
};
const pageKey = (): string | null | undefined =>
  root().querySelector('[data-flow-page]')?.getAttribute('data-flow-page');
const PATCH: WardenConfigPatch = { enabled: true, layers: { jev: false, llm: false } };

describe('the Warden page inside the real setup flow', () => {
  test('Confirm it’s you stays on the step with nothing written when the passkey is declined again', async () => {
    const machineSide = await openFlow(2);
    expect(pageKey()).toBe('warden.warden');
    await press('[data-step-next]'); // the footer's Next: the machine wants the passkey
    expect(machineSide.attempts).toEqual([PATCH]);
    expect(pageKey()).toBe('warden.warden');
    expect(root().querySelector('[data-flow-commit-error]')?.textContent).toContain('confirm it’s you');
    await press('[data-warden-unlock] button'); // Confirm: the machine asks for the passkey, and it is declined once more
    expect(machineSide.attempts).toEqual([PATCH, PATCH]); // the save really ran again
    expect(machineSide.written).toEqual([]); // nothing was written
    expect(pageKey()).toBe('warden.warden'); // still on the step
    expect(machineSide.answers).toEqual([]); // and it was not marked done
    expect(root().querySelector('[data-warden-unlock] button')).not.toBeNull();
  });

  test('Confirm it’s you writes warden.yaml once on the passkey, and only then goes on', async () => {
    const machineSide = await openFlow(1);
    await press('[data-step-next]'); // refused for want of the passkey
    expect(machineSide.written).toEqual([]);
    expect(pageKey()).toBe('warden.warden');
    expect(machineSide.answers).toEqual([]);
    await press('[data-warden-unlock] button'); // the person confirms: the same save runs and now goes through
    expect(machineSide.written).toEqual([PATCH]); // exactly one write of the file
    expect(machineSide.answers).toEqual(['done']); // the step is recorded done
    expect(pageKey()).not.toBe('warden.warden'); // and the flow has left the Warden's page
    await settle();
    expect(machineSide.attempts).toEqual([PATCH, PATCH]); // nothing wrote again after the move
  });
});
