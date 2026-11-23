/**
 * THE "FOUND ON THIS COMPUTER" CHIP READS THE SHARED SCAN: the panel asks the machine's shared scan store (one read per machine,
 * never one per page), shows the chip only beside a harness that is installed here, and writes nothing.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { ensureDom, type Mounted, mount } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { REAL_PROVIDER_PRESET_CATALOG } from '@ferretry/plugin-logins/contract/testing';
import { createAgentsPanel } from '../../../app/features/agents/agents-panel.tsx';
import { hostScan } from '../../fixtures/host-scan.ts';

ensureDom();

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

const SCAN = 'GET /v1/runtimes/setup/scan';

const machine = (installed: boolean) => {
  const calls: string[] = [];
  const client = {
    call: async (route: string) => {
      calls.push(route);
      if (route === 'GET /v1/logins/presets') return REAL_PROVIDER_PRESET_CATALOG;
      if (route === SCAN) return hostScan(installed);
      if (route === 'GET /v1/claude-code/update') return { installed: { state: 'ok', version: '2.1.0' } };
      if (route === 'GET /v1/codex/update') return { installed: null };
      throw new Error(`unexpected route ${route}`);
    },
  } as unknown as PluginClient;
  return { client, scans: () => calls.filter(route => route === SCAN).length };
};

const step = {
  ready: () => undefined,
  segment: {},
  remember: () => undefined,
  commit: () => undefined,
} as never;

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 20));
const chips = (): (string | null | undefined)[] =>
  [...(view?.container.querySelectorAll('[data-agent-found]') ?? [])].map(chip =>
    chip.closest('[data-agent-row]')?.getAttribute('data-agent-row'),
  );

describe('the "Found on this computer" chip', () => {
  it('shows beside Claude when it is installed here, and beside nothing else (no Codex here)', async () => {
    const { client } = machine(true);
    const Panel = createAgentsPanel(client);
    view = await mount(<Panel step={step} />);
    await settle();
    expect(chips()).toEqual(['claude']);
  });

  it('is absent when Claude is not installed here', async () => {
    const { client } = machine(false);
    const Panel = createAgentsPanel(client);
    view = await mount(<Panel step={step} />);
    await settle();
    expect(chips()).toEqual([]);
  });

  it('asks the machine once: a back-step to the picker draws the same read again, never another scan', async () => {
    const { client, scans } = machine(true);
    const Panel = createAgentsPanel(client);
    view = await mount(<Panel step={step} />);
    await settle();
    await view.unmount();
    view = await mount(<Panel step={step} />);
    await settle();
    expect(chips()).toEqual(['claude']);
    expect(scans()).toBe(1);
  });
});
