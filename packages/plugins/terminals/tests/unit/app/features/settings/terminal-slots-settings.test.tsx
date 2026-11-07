import '@ferretry/app/testing';
import { describe, expect, it } from 'bun:test';
import type {
  CloseFinishedTerminalsResponse,
  TerminalHolder,
  TerminalHoldersView,
} from '../../../../../contract/index.ts';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { interact, mount, must, runAsync, settleUntil } from '@ferretry/app/testing';
import { TerminalSlotsSettings } from '../../../../../app/features/settings/terminal-slots-settings.tsx';
import terminalsApp from '../../../../../app/index.ts';
import manifest from '../../../../../manifest.ts';

const finished: TerminalHolder = {
  sessionId: 's-1',
  label: 'fitzgerald',
  standing: 'finished',
  status: 'stopped',
  count: 6,
};
const live: TerminalHolder = { sessionId: 's-2', label: 'wren', standing: 'live', status: 'running', count: 1 };

/** A machine whose reads answer from the list in turn, and whose close answers `closed`. */
const machine = (reads: (TerminalHoldersView | Error)[], closed: CloseFinishedTerminalsResponse | Error) => {
  const calls: string[] = [];
  const client: PluginClient = {
    call: (async (route: string) => {
      calls.push(route);
      const next = route.startsWith('POST') ? closed : reads.shift();
      if (next === undefined) throw new Error('no read scripted');
      if (next instanceof Error) throw next;
      return next;
    }) as PluginClient['call'],
    subscribe: () => () => undefined,
  };
  return { calls, client };
};

const settled = async (container: HTMLElement, selector: string): Promise<void> => {
  await settleUntil(() => container.querySelector(selector) !== null, selector, runAsync);
};

describe('TerminalSlotsSettings', () => {
  it('lists who holds the slots, closes the finished ferrets’ terminals, and shows what is left', async () => {
    // Arrange
    const daemon = machine(
      [
        { limit: 24, open: 7, holders: [finished, live] },
        { limit: 24, open: 1, holders: [live] },
      ],
      { closed: 6, failed: 0, holders: [live] },
    );
    const shown = await mount(<TerminalSlotsSettings client={daemon.client} />);
    await settled(shown.container, '[data-terminal-slots]');

    // Act
    const before = shown.container.querySelector('[data-terminal-slots-summary]')?.textContent;
    const rows = [...shown.container.querySelectorAll('[data-terminal-holder]')].map(row => row.textContent);
    await interact(() =>
      must(shown.container.querySelector<HTMLButtonElement>('[data-terminal-slots-close]'), 'close').click(),
    );
    await settled(shown.container, '[data-terminal-slots-closed]');

    // Assert
    expect(before).toContain('7 terminals open of 24.');
    expect(rows).toEqual(['fitzgeraldstopped6 terminals', 'wrenrunning1 terminal']);
    expect(shown.container.querySelector('[data-terminal-slots-closed]')?.textContent).toBe('Closed 6 terminals.');
    expect(shown.container.querySelectorAll('[data-terminal-holder]').length).toBe(1);
    expect(
      must(shown.container.querySelector<HTMLButtonElement>('[data-terminal-slots-close]'), 'close').disabled,
    ).toBe(true);
    expect(daemon.calls).toEqual(['GET /v1/terminals', 'POST /v1/terminals/close-finished', 'GET /v1/terminals']);
    await shown.unmount();
  });

  it('offers nothing to close when only live ferrets hold terminals, and says nothing is open when none is', async () => {
    // Arrange
    const live1 = machine([{ limit: 24, open: 1, holders: [live] }], new Error('unreachable'));
    const none = machine([{ limit: 24, open: 0, holders: [] }], new Error('unreachable'));

    // Act
    const withLive = await mount(<TerminalSlotsSettings client={live1.client} />);
    await settled(withLive.container, '[data-terminal-slots]');
    const empty = await mount(<TerminalSlotsSettings client={none.client} />);
    await settled(empty.container, '[data-terminal-slots]');

    // Assert
    expect(
      must(withLive.container.querySelector<HTMLButtonElement>('[data-terminal-slots-close]'), 'close').disabled,
    ).toBe(true);
    expect(withLive.container.querySelector('[data-terminal-slots-summary]')?.textContent).toBe(
      '1 terminal open of 24.',
    );
    expect(empty.container.querySelector('[data-terminal-holder]')).toBeNull();
    await withLive.unmount();
    await empty.unmount();
  });

  it('says so when the terminals could not be read, with the machine’s reason or a plain one', async () => {
    // Arrange
    const refused = machine([new Error('Not allowed from this device.')], new Error('unreachable'));
    const silent = machine([new Error('')], new Error('unreachable'));

    // Act
    const first = await mount(<TerminalSlotsSettings client={refused.client} />);
    await settled(first.container, '[data-terminal-slots-failed]');
    const second = await mount(<TerminalSlotsSettings client={silent.client} />);
    await settled(second.container, '[data-terminal-slots-failed]');

    // Assert
    expect(first.container.textContent).toContain('Not allowed from this device.');
    expect(second.container.textContent).toContain('This machine did not say why.');
    await first.unmount();
    await second.unmount();
  });

  it('says so when a non-error is thrown, and when closing fails', async () => {
    // Arrange
    const closing = machine([{ limit: 24, open: 6, holders: [finished] }], new Error('tmux is gone'));
    const thrown: PluginClient = {
      call: (async () => {
        throw 'plain';
      }) as PluginClient['call'],
      subscribe: () => () => undefined,
    };

    // Act
    const failing = await mount(<TerminalSlotsSettings client={closing.client} />);
    await settled(failing.container, '[data-terminal-slots]');
    await interact(() =>
      must(failing.container.querySelector<HTMLButtonElement>('[data-terminal-slots-close]'), 'close').click(),
    );
    await settled(failing.container, '[data-terminal-slots-failed]');
    const plain = await mount(<TerminalSlotsSettings client={thrown} />);
    await settled(plain.container, '[data-terminal-slots-failed]');

    // Assert
    expect(failing.container.textContent).toContain('tmux is gone');
    expect(plain.container.textContent).toContain('This machine did not say why.');
    await failing.unmount();
    await plain.unmount();
  });

  it('shows the new client’s terminals at once when the client changes, never the old one’s', async () => {
    // Arrange
    const first = machine([{ limit: 24, open: 7, holders: [finished] }], new Error('unreachable'));
    const shown = await mount(<TerminalSlotsSettings client={first.client} />);
    await settled(shown.container, '[data-terminal-slots]');

    // Act — another machine's client: the old list goes at once, the new machine's replaces it.
    const second = machine([{ limit: 8, open: 1, holders: [live] }], new Error('unreachable'));
    await shown.render(<TerminalSlotsSettings client={second.client} />);
    await settleUntil(
      () => shown.container.querySelector('[data-terminal-slots-summary]')?.textContent?.includes('of 8') === true,
      'second list',
      runAsync,
    );

    // Assert
    expect(shown.container.querySelector('[data-terminal-holder="s-1"]')).toBeNull();
    expect(shown.container.querySelector('[data-terminal-holder="s-2"]')).not.toBeNull();
    await shown.unmount();
  });

  it('is the half’s Terminals settings tab, riding the client the shell built', async () => {
    // Arrange
    const daemon = machine([{ limit: 24, open: 0, holders: [] }], new Error('unreachable'));
    const half = terminalsApp.build?.({ manifest, client: daemon.client });
    const Tab = must(half?.settings?.terminals, 'the terminals settings tab') as () => React.ReactElement;

    // Act
    const shown = await mount(<Tab />);
    await settled(shown.container, '[data-terminal-slots]');

    // Assert
    expect(manifest.ui?.settings?.map(tab => tab.id)).toContain('terminals');
    expect(daemon.calls).toEqual(['GET /v1/terminals']);
    await shown.unmount();
  });
});
