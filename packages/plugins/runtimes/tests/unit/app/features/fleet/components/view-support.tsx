/** A scripted machine for the Profiles and Model sets page suites: its catalogue, its change routes, every call. */

import type { ReactElement } from 'react';
import type { AccountCatalog } from '../../../../../../app/features/fleet/components/account-catalog.ts';
import type { MachineTabProps } from '../../../../../../app/features/fleet/shell/machine-tab.ts';
import type { RuntimesClient } from '../../../../../../app/lib/client.ts';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';
import { APPLIED, type Call, CHANGE_ID, machine as machineView, scripted, stagedFrom } from '../account-support.ts';
import { studioCatalog, studioMachine } from './catalog-fixture.ts';

export interface Machine {
  /** What the next catalogue read answers; a test swaps it to show what a change made. */
  catalog: AccountCatalog;
  /** Fails every catalogue read while set. */
  readFails?: Error;
  /** Answers the draft preview; absent fails it. */
  preview?: unknown;
  /** Answers the staging of a change; default is the staged change. */
  stage?: unknown;
  /** Runs after a change is applied, before the next read. */
  onApply?: (machine: Machine) => void;
  readonly calls: Call[];
}

export const PREVIEW = 'POST /v1/runtimes/profiles/preview';
export const PROPOSE = 'POST /v1/runtimes/proposals';

export const scriptedMachine = (overrides: Partial<Machine> = {}): Machine => ({
  catalog: studioCatalog(),
  calls: [],
  ...overrides,
});

/** The client a tab is handed, answering from `machine`. */
export const machineClient = (machine: Machine): RuntimesClient => {
  const catalog = (answer: () => unknown) => () => machine.readFails ?? answer();
  return scripted(
    {
      'GET /v1/runtimes/components': catalog(() => machine.catalog.components),
      'GET /v1/runtimes/profiles': catalog(() => machine.catalog.profiles),
      'GET /v1/runtimes': catalog(() => machine.catalog.runtimes),
      [PREVIEW]: () => machine.preview ?? new Error('unreachable'),
      'GET /v1/runtimes/machine': () => machineView(),
      [PROPOSE]: (call: Call) => machine.stage ?? stagedFrom(call),
      [`POST /v1/runtimes/proposals/${CHANGE_ID}/apply`]: () => {
        machine.onApply?.(machine);
        return APPLIED;
      },
    },
    machine.calls,
  );
};

/** The changes the tab staged, in order. */
export const stagedChanges = (machine: Machine): unknown[] =>
  machine.calls.filter(call => call.route === PROPOSE).map(call => (call.body as { change: unknown }).change);

export const tabProps = (machine: Machine, overrides: Partial<MachineTabProps> = {}): MachineTabProps => ({
  client: machineClient(machine),
  machineName: 'studio-mac',
  machine: studioMachine(),
  online: true,
  checking: false,
  onRetry: () => undefined,
  ...overrides,
});

const drain = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

/** Runs an action and lets every read and write it started finish, all inside one `act`. */
const settled = async (action: () => unknown): Promise<void> => {
  await interact(async () => {
    await action();
    await drain();
  });
};

export const settle = async (): Promise<void> => settled(() => undefined);

export const click = async (root: ParentNode, selector: string): Promise<void> => {
  const target = must(root.querySelector<HTMLElement>(selector), selector);
  await settled(() => target.click());
};

/** Types into an input or a text area the way React hears it. */
export const type = async (root: ParentNode, selector: string, value: string): Promise<void> => {
  const field = must(root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector), selector);
  await settled(() => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

export const choose = async (root: ParentNode, selector: string, value: string): Promise<void> => {
  const field = must(root.querySelector<HTMLSelectElement>(selector), selector);
  await settled(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

export const text = (root: ParentNode, selector: string): string =>
  must(root.querySelector(selector), selector).textContent ?? '';

export const submit = async (root: ParentNode): Promise<void> => click(root, '[data-change-submit]');

/** Mounts and lets the first catalogue read land, inside one `act`. */
export const mountSettled = async (element: ReactElement): Promise<Mounted> => {
  let mounted: Mounted | undefined;
  await settled(async () => {
    mounted = await mount(element);
  });
  return must(mounted, 'the mounted tab');
};

/** The Settings page the Machines tabs are drawn on, for the daemon the tests call `d1`. */
export const TAB_PATH = '/d/d1/settings/runtimes/profiles';

/** Follows a link the way the Settings page does: a new hash on the same page, and its event. */
export const followHash = async (hash: string): Promise<void> =>
  settled(() => {
    window.history.replaceState(null, '', `${window.location.pathname}${hash}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
