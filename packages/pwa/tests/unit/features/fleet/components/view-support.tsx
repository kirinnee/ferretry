/** A scripted machine for the Profiles and Components page suites: its catalogue, its change routes, every call. */

import type { FleetMachineView } from '@ferretry/protocol';
import type { AccountCatalog } from '../../../../../src/features/fleet/components/account-catalog.ts';
import type { FleetClientFactory } from '../../../../../src/features/fleet/fleet-configuration-surface.tsx';
import type { MachineTabProps } from '../../../../../src/features/fleet/shell/machines-surface.tsx';
import { daemonConnection } from '../../../../../src/lib/daemon-connection.ts';
import { interact, must } from '../../../../support/dom.ts';
import { APPLY_PATH, type Call, OUTCOME, permissions, STAGED, scriptedClient } from '../shell/change-support.ts';
import { studioCatalog, studioMachine } from './catalog-fixture.ts';

export const STUDIO = daemonConnection({
  daemonId: 'studio',
  baseUrl: 'https://studio.example.test',
  deviceToken: 't',
});

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

export const scriptedMachine = (overrides: Partial<Machine> = {}): Machine => ({
  catalog: studioCatalog(),
  calls: [],
  ...overrides,
});

/** The client factory a tab is handed, answering from `machine`. */
export const machineFactory =
  (machine: Machine): FleetClientFactory =>
  async () => {
    const catalog = (answer: () => unknown) => () => machine.readFails ?? answer();
    return scriptedClient(
      {
        '/v1/fleet/components': catalog(() => machine.catalog.components),
        '/v1/fleet/profile-stacks': catalog(() => machine.catalog.profiles),
        '/v1/fleet/runtimes': catalog(() => machine.catalog.runtimes),
        '/v1/fleet/profile-stacks/preview': () => machine.preview ?? new Error('unreachable'),
        '/v1/fleet/permissions': permissions(),
        '/v1/fleet/changes': (call: Call) =>
          machine.stage ?? { ...STAGED, change: (call.body as { change: unknown }).change },
        [APPLY_PATH]: () => {
          machine.onApply?.(machine);
          return OUTCOME;
        },
      },
      machine.calls,
    );
  };

/** The changes the tab staged, in order. */
export const stagedChanges = (machine: Machine): unknown[] =>
  machine.calls
    .filter(call => call.path === '/v1/fleet/changes')
    .map(call => (call.body as { change: unknown }).change);

export const tabProps = (machine: Machine, overrides: Partial<MachineTabProps> = {}): MachineTabProps => ({
  connection: STUDIO,
  machineName: 'studio-mac',
  machine: studioMachine() satisfies FleetMachineView,
  online: true,
  checking: false,
  onRetry: () => undefined,
  createClient: machineFactory(machine),
  ...overrides,
});

export const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

export const click = async (root: ParentNode, selector: string): Promise<void> => {
  const target = must(root.querySelector<HTMLElement>(selector), selector);
  await interact(() => target.click());
  await settle();
};

/** Types into an input or a text area the way React hears it. */
export const type = async (root: ParentNode, selector: string, value: string): Promise<void> => {
  const field = must(root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector), selector);
  await interact(() => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};

export const choose = async (root: ParentNode, selector: string, value: string): Promise<void> => {
  const field = must(root.querySelector<HTMLSelectElement>(selector), selector);
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
};

/** Ticks a pick row by its label. */
export const tick = async (root: ParentNode, selector: string): Promise<void> => {
  const label = must(root.querySelector<HTMLElement>(selector), selector);
  const input = must(label.querySelector<HTMLInputElement>('input'), `${selector} input`);
  await interact(() => input.click());
  await settle();
};

export const text = (root: ParentNode, selector: string): string =>
  must(root.querySelector(selector), selector).textContent ?? '';

export const submit = async (root: ParentNode): Promise<void> => click(root, '[data-change-submit]');
