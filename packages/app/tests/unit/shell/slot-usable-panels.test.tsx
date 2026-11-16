import { afterEach, describe, expect, test } from 'bun:test';
import { WithSlotPanels } from '../../../src/testing/slot-panels.tsx';
import { useSlotHasUsablePanels } from '../../../src/shell/views.tsx';
import { type Mounted, mount } from '../../support/dom.ts';

/**
 * `useSlotHasUsablePanels`: placed AND runnable on the daemon, for an optional row or toolbar slot that must draw
 * nothing — not the shell's "is off on this daemon" line — where its plugin is off there.
 */

const view = () => null;
const SLOT = 'runtimes.component-mcp';

function Probe() {
  return <span data-usable={String(useSlotHasUsablePanels('d1', SLOT))} />;
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const usable = async (element: React.ReactElement): Promise<string | null> => {
  mounted = await mount(element);
  return mounted.container.querySelector('[data-usable]')?.getAttribute('data-usable') ?? null;
};

describe('useSlotHasUsablePanels', () => {
  test('is true when a panel is placed and its plugin may run on the daemon', async () => {
    const slots = { [SLOT]: [{ plugin: 'mcp', id: 'component-status', view }] };
    expect(
      await usable(
        <WithSlotPanels slots={slots}>
          <Probe />
        </WithSlotPanels>,
      ),
    ).toBe('true');
  });

  test('is false when the only placed panel’s plugin is blocked on the daemon', async () => {
    const slots = { [SLOT]: [{ plugin: 'mcp', id: 'component-status', view }] };
    expect(
      await usable(
        <WithSlotPanels slots={slots} blocked={{ mcp: 'MCP servers is off on this daemon.' }}>
          <Probe />
        </WithSlotPanels>,
      ),
    ).toBe('false');
  });

  test('is true while any placed panel’s plugin may run, even if another is blocked', async () => {
    const slots = {
      [SLOT]: [
        { plugin: 'mcp', id: 'component-status', view },
        { plugin: 'other', id: 'x', view },
      ],
    };
    expect(
      await usable(
        <WithSlotPanels slots={slots} blocked={{ mcp: 'off' }}>
          <Probe />
        </WithSlotPanels>,
      ),
    ).toBe('true');
  });

  test('is false where no panel is placed', async () => {
    expect(
      await usable(
        <WithSlotPanels slots={{}}>
          <Probe />
        </WithSlotPanels>,
      ),
    ).toBe('false');
  });

  test('is false outside a shell', async () => {
    expect(await usable(<Probe />)).toBe('false');
  });
});
