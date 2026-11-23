/**
 * THE "FOUND ON THIS COMPUTER" CHIP READS THE SHARED SCAN: the panel asks the machine's shared scan store (one read per machine,
 * never one per page), shows the chip only beside a harness that is installed here, and writes nothing.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { ensureDom, type Mounted, mount } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { REAL_PROVIDER_PRESET_CATALOG } from '@ferretry/plugin-logins/contract/testing';
import { createAgentsPanel } from '../../../app/features/agents/agents-panel.tsx';
import { forgetSetupScanAhead, readSetupScanAhead, useScan } from '../../../app/features/setup-flow/machine-scan.ts';
import { hostScan } from '../../fixtures/host-scan.ts';

ensureDom();

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

const SCAN = 'GET /v1/runtimes/setup/scan';

/** The machines whose flow this test opened: closed again after each test, as the flow closes its read when it ends. */
const opened: PluginClient[] = [];
afterEach(() => {
  for (const client of opened.splice(0)) forgetSetupScanAhead(client);
});

/** A machine whose scan answers `installed` (or is refused: `null`); the flow's read-ahead is started as the flow starts it. */
const machine = (installed: boolean | null) => {
  const calls: string[] = [];
  const client = {
    call: async (route: string) => {
      calls.push(route);
      if (route === 'GET /v1/logins/presets') return REAL_PROVIDER_PRESET_CATALOG;
      if (route === SCAN) {
        if (installed === null) throw new Error('the scan was refused');
        return hostScan(installed);
      }
      if (route === 'GET /v1/claude-code/update') return { installed: { state: 'ok', version: '2.1.0' } };
      if (route === 'GET /v1/codex/update') return { installed: null };
      throw new Error(`unexpected route ${route}`);
    },
  } as unknown as PluginClient;
  opened.push(client);
  readSetupScanAhead(client);
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

  it('shows no chip, and asks nothing, when the flow holds no read (the picker never scans for itself)', async () => {
    const { client, scans } = machine(true);
    forgetSetupScanAhead(client);
    await settle();
    const Panel = createAgentsPanel(client);
    view = await mount(<Panel step={step} />);
    await settle();
    expect(chips()).toEqual([]);
    // Only the flow's own read, started before the flow "closed": the picker asked for no other.
    expect(scans()).toBe(1);
  });

  it('a read that was refused shows no chip, and the picker, another reader and the picker again make no extra call', async () => {
    const { client, scans } = machine(null);
    await settle();
    const Panel = createAgentsPanel(client);
    view = await mount(<Panel step={step} />);
    await settle();
    expect(chips()).toEqual([]);
    expect(scans()).toBe(1);
    await view.unmount();
    // Another reader of the machine's scan (the Settings import) asks the machine for itself.
    function Reader(): null {
      useScan(client, { run: 'settings-import', refresh: true });
      return null;
    }
    view = await mount(<Reader />);
    await settle();
    expect(scans()).toBe(2);
    await view.unmount();
    view = await mount(<Panel step={step} />);
    await settle();
    expect(chips()).toEqual([]);
    expect(scans()).toBe(2);
  });
});
