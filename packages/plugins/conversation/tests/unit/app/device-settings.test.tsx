import { describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, render, run, settleUntil } from '@ferretry/app/testing';
import type { AppComponent, PluginClient } from '@ferretry/kernel/manifest';
import { type ReactNode, Suspense } from 'react';
import half from '../../../app/index.ts';
import manifest from '../../../manifest.ts';

/**
 * CONVERSATION'S TWO `device.settings` PANELS (shell contract S4, R1 M3): Conversation width and Message marks are this
 * device's, drawn with no machine and no client from `shell.deviceSettings` (loaded on first use), in v4's order; the
 * half's per-daemon entries for them draw nothing, so a machine's page never repeats them.
 */

const deviceSettings = half.shell.deviceSettings ?? {};
const built = (
  half.build as unknown as (context: { client: PluginClient }) => { panels: Record<string, AppComponent<never>> }
)({
  client: {} as PluginClient,
});

/** The first draw imports the whole surfaces chunk, which can take well over the default turns on a cold start. */
const LOAD_TURNS = 20_000;
const LOAD_TIMEOUT_MS = 60_000;

/** The first draw loads the surfaces chunk, which can take many turns. */
const draw = async (id: 'chat-width' | 'message-marks', ready: (view: Mounted) => boolean): Promise<Mounted> => {
  const View = deviceSettings[id] as unknown as () => ReactNode;
  const view = await mount(
    <Suspense fallback={null}>
      <View />
    </Suspense>,
  );
  await settleUntil(() => ready(view), `${id} to draw`, interact, LOAD_TURNS);
  return view;
};

describe('Conversation’s device settings panels', () => {
  it('shell S4: both panels are provided to the shell for the slots the manifest declares, Message marks after the width', () => {
    expect(Object.keys(deviceSettings).sort()).toEqual(['chat-width', 'message-marks']);
    const declared = manifest.ui.panels.filter(panel => panel.slot === 'device.settings');
    expect(declared.map(panel => panel.id)).toEqual(['chat-width', 'message-marks']);
    const order = (id: string): number => declared.find(panel => panel.id === id)?.order ?? 0;
    expect(order('message-marks')).toBeGreaterThan(order('chat-width'));
  });

  it(
    'shell S4: Conversation width loads on first use and draws with no machine (the three modes)',
    async () => {
      const view = await draw('chat-width', each => each.container.querySelector('input') !== null);
      expect(view.container.querySelectorAll('input[type="radio"]')).toHaveLength(3);
      expect(view.container.textContent).toContain('Conversation width');
      await view.unmount();
    },
    LOAD_TIMEOUT_MS,
  );

  it(
    'shell S4: Message marks is a collapsed disclosure with v4’s hint, and opens to the key',
    async () => {
      const view = await draw('message-marks', each => each.container.querySelector('button') !== null);
      expect(view.container.textContent).toContain('Message marks');
      expect(view.container.textContent).toContain('What the clock, ticks and ! mean');
      expect(view.container.querySelector('[data-message-marks-legend]')).toBeNull();
      await interact(() => (view.container.querySelector('button') as HTMLElement).click());
      expect(view.container.querySelector('[data-message-marks-legend]')).not.toBeNull();
      await view.unmount();
    },
    LOAD_TIMEOUT_MS,
  );

  it('shell S4: the per-daemon entries for the two panels draw nothing', () => {
    for (const id of ['chat-width', 'message-marks']) {
      const Entry = built.panels[id] as unknown as () => ReactNode;
      const surface = render(<Entry />);
      expect(surface.toJSON()).toBeNull();
      run(() => surface.unmount());
    }
  });
});
