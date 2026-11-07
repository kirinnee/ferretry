/**
 * The Terminals-owned S rows of docs/design/rebuild-parity.md, one test per row, each named by its id. The rows the app
 * half implements drive the real component or the half the shell builds, through a scripted client, and assert what a
 * person sees. A row whose surface is not in this half yet is a skip that names the seam it waits on. Nothing here ticks
 * the tsv.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { mount, must, runAsync, settleUntil } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { TerminalSnapshotView } from '../../../app/components/terminal-snapshot.tsx';
import { TerminalSlotsSettings } from '../../../app/features/settings/terminal-slots-settings.tsx';
import app from '../../../app/index.ts';
import manifest from '../../../manifest.ts';

beforeAll(async () => {
  await (await mount(<div />)).unmount();
});

const client = (answer: (route: string) => unknown): PluginClient => ({
  call: (async (route: string) => answer(route)) as PluginClient['call'],
  subscribe: () => () => undefined,
});

const HOLDERS = {
  limit: 24,
  open: 2,
  holders: [{ sessionId: 's-2', label: 'wren', standing: 'live', status: 'running', count: 2 }],
};

const half = () => must(app.build, 'the app half builder')({ manifest, client: client(() => HOLDERS) as never });

describe('terminals app rows', () => {
  test.skip('S-0180 ProcessesSurface — pending port: the ferret side-pane surface that lists a ferret’s processes is not in the Terminals app half (lib/session-processes.ts is its data layer)', () => {});

  test.skip('S-0261 StopDialog — pending port: it is the confirm step of ProcessesSurface and waits on the same surface seam', () => {});

  test('S-0269 TerminalSlotsSettings lists who holds the slots from the machine', async () => {
    const shown = await mount(<TerminalSlotsSettings client={client(() => HOLDERS)} />);
    await settleUntil(
      () => shown.container.querySelector('[data-terminal-slots]') !== null,
      '[data-terminal-slots]',
      runAsync,
    );
    expect(shown.container.querySelector('[data-terminal-slots-summary]')?.textContent).toBe('2 terminals open of 24.');
    expect(shown.container.querySelectorAll('[data-terminal-holder]')).toHaveLength(1);
    await shown.unmount();
  });

  test('S-0270 TerminalSnapshotView prints the pane the daemon holds and says the snapshot is cached', async () => {
    const view = await mount(
      <TerminalSnapshotView
        client={client(() => '')}
        scope={{ sessionId: 'pane-session' }}
        now={() => 0}
        readSnapshot={async () => '$ bun test\nok'}
      />,
    );
    try {
      expect(view.container.textContent).toContain('$ bun test');
      expect(view.container.textContent).toContain('cached');
    } finally {
      await view.unmount();
    }
  });

  test.skip('S-0430 settings panel terminals (group=advanced; tab=machine) — pending port: the shell’s settings catalog places a tab by its own group, which a manifest settingsTab does not carry yet', () => {});

  test('S-0565 Settings has a Terminals tab, declared by the manifest', () => {
    expect(manifest.ui?.settings?.map(tab => [tab.id, tab.label])).toContainEqual(['terminals', 'Terminals']);
  });

  test('S-0566 the Terminals tab is built by the app half', async () => {
    const tab = must(half().settings?.terminals, 'the terminals settings tab');
    expect(tab({})).not.toBeNull();
  });

  test('S-0567 the ferret side pane has a terminals tab that needs a ferret to open', () => {
    expect(manifest.ui?.panels?.map(panel => [panel.slot, panel.id])).toContainEqual(['ferret.side', 'terminals']);
    const panel = must(half().panels?.terminals, 'the terminals panel');
    expect(panel({})).toBeNull();
    expect(panel({ subject: 's-1' })).not.toBeNull();
  });
});
