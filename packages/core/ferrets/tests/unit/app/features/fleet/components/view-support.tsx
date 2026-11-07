/** A scripted machine for the Profiles and Components page suites: its catalogue, its change routes, every call. */

import type { FleetMachineView } from '@ferretry/protocol';
import type { ReactElement } from 'react';
import type { AccountCatalog } from '../../../../../src/features/fleet/components/account-catalog.ts';
import type { FleetClientFactory } from '../../../../../src/features/fleet/fleet-client.ts';
import type { MachineTabProps } from '../../../../../src/features/fleet/shell/machines-surface.tsx';
import { daemonConnection } from '../../../../../src/lib/daemon-connection.ts';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';
import { APPLY_PATH, type Call, machineAnswer, OUTCOME, STAGED, scriptedClient } from '../shell/change-support.ts';
import { studioCatalog, studioMachine } from './catalog-fixture.ts';

const STUDIO = daemonConnection({
  daemonId: 'studio',
  baseUrl: 'https://studio.example.test',
  deviceId: 't',
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
  /** Answers `GET /v1/fleet/mcp-auth`; absent answers that nothing is signed in. */
  mcpSignIns?: unknown;
  /** Answers `GET /v1/mcp`, the machine's MCP inventory; absent answers that no runtime has a server. */
  mcpServers?: unknown;
  /** Answers `POST /v1/mcp/check`; absent fails it like a dead machine. */
  mcpCheck?: unknown;
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
const machineFactory =
  (machine: Machine): FleetClientFactory =>
  async () => {
    const catalog = (answer: () => unknown) => () => machine.readFails ?? answer();
    return scriptedClient(
      {
        '/v1/fleet/components': catalog(() => machine.catalog.components),
        '/v1/fleet/profiles': catalog(() => machine.catalog.profiles),
        '/v1/fleet/runtimes': catalog(() => machine.catalog.runtimes),
        '/v1/fleet/profiles/preview': () => machine.preview ?? new Error('unreachable'),
        '/v1/fleet/machine': machineAnswer(),
        '/v1/fleet/mcp-auth': () => machine.mcpSignIns ?? { connections: [] },
        '/v1/mcp': () => machine.mcpServers ?? { servers: [], problems: [] },
        '/v1/mcp/check': () => machine.mcpCheck ?? new Error('could not reach fyd at 127.0.0.1:7777'),
        '/v1/fleet/proposals': (call: Call) =>
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
    .filter(call => call.path === '/v1/fleet/proposals')
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

/** Follows a link the way the Settings page does: a new hash and its event. */
export const followHash = async (hash: string): Promise<void> =>
  settled(() => {
    window.history.replaceState(null, '', `/${hash}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
