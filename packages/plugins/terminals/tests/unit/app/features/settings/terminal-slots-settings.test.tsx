import '@ferretry/app/testing';
import { describe, expect, it } from 'bun:test';
import type {
  CloseFinishedTerminalsResponse,
  TerminalHolder,
  TerminalHoldersView,
} from '../../../../../contract/index.ts';
import { SETTINGS_LINKS, settingsPaletteEntries } from '@ferretry/app';
import type { TerminalSlotsClient } from '../../../../../app/features/settings/terminal-slots-api.ts';
import {
  TerminalSlotsSettings,
  terminalSlotsSettingsTab,
} from '../../../../../app/features/settings/terminal-slots-settings.tsx';
import { daemonConnection } from '../../../../../../../core/ferrets/app/lib/daemon-connection.ts';
import { interact, mount, must } from '@ferretry/app/testing';
import { runAsync } from '@ferretry/app/testing';
import { settleUntil } from '@ferretry/app/testing';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'fy_device_id_alpha00000000000000000',
});
const beta = daemonConnection({
  daemonId: 'beta',
  baseUrl: 'https://beta.example.test',
  deviceId: 'fy_device_id_beta000000000000000000',
});

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
  const createClient = async (): Promise<TerminalSlotsClient> =>
    ({
      request: (async (path: string, _schema: unknown, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${path}`);
        const next = init?.method === 'POST' ? closed : reads.shift();
        if (next === undefined) throw new Error('no read scripted');
        if (next instanceof Error) throw next;
        return next;
      }) as TerminalSlotsClient['request'],
    }) satisfies TerminalSlotsClient;
  return { calls, createClient };
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
    const shown = await mount(<TerminalSlotsSettings connection={alpha} createClient={daemon.createClient} />);
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
    const withLive = await mount(<TerminalSlotsSettings connection={alpha} createClient={live1.createClient} />);
    await settled(withLive.container, '[data-terminal-slots]');
    const empty = await mount(<TerminalSlotsSettings connection={alpha} createClient={none.createClient} />);
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
    const first = await mount(<TerminalSlotsSettings connection={alpha} createClient={refused.createClient} />);
    await settled(first.container, '[data-terminal-slots-failed]');
    const second = await mount(<TerminalSlotsSettings connection={alpha} createClient={silent.createClient} />);
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
    const thrown = {
      createClient: async (): Promise<TerminalSlotsClient> =>
        ({
          request: (async () => {
            throw 'plain';
          }) as TerminalSlotsClient['request'],
        }) satisfies TerminalSlotsClient,
    };

    // Act
    const failing = await mount(<TerminalSlotsSettings connection={alpha} createClient={closing.createClient} />);
    await settled(failing.container, '[data-terminal-slots]');
    await interact(() =>
      must(failing.container.querySelector<HTMLButtonElement>('[data-terminal-slots-close]'), 'close').click(),
    );
    await settled(failing.container, '[data-terminal-slots-failed]');
    const plain = await mount(<TerminalSlotsSettings connection={alpha} createClient={thrown.createClient} />);
    await settled(plain.container, '[data-terminal-slots-failed]');

    // Assert
    expect(failing.container.textContent).toContain('tmux is gone');
    expect(plain.container.textContent).toContain('This machine did not say why.');
    await failing.unmount();
    await plain.unmount();
  });

  it('never shows one machine’s terminals under another', async () => {
    // Arrange
    const first = machine([{ limit: 24, open: 7, holders: [finished] }], new Error('unreachable'));
    const shown = await mount(<TerminalSlotsSettings connection={alpha} createClient={first.createClient} />);
    await settled(shown.container, '[data-terminal-slots]');

    // Act — switch machine: the old list goes at once, the new machine's replaces it.
    const second = machine([{ limit: 8, open: 1, holders: [live] }], new Error('unreachable'));
    await shown.render(<TerminalSlotsSettings connection={beta} createClient={second.createClient} />);
    await settleUntil(
      () => shown.container.querySelector('[data-terminal-slots-summary]')?.textContent?.includes('of 8') === true,
      'beta list',
      runAsync,
    );

    // Assert
    expect(shown.container.querySelector('[data-terminal-holder="s-1"]')).toBeNull();
    expect(shown.container.querySelector('[data-terminal-holder="s-2"]')).not.toBeNull();
    await shown.unmount();
  });

  it('is offered as a Machine panel and in the palette', async () => {
    // Arrange
    const daemon = machine([{ limit: 24, open: 0, holders: [] }], new Error('unreachable'));
    const tab = terminalSlotsSettingsTab(daemon.createClient);

    // Act
    const shown = await mount(<tab.Surface connection={alpha} />);
    await settled(shown.container, '[data-terminal-slots]');
    const link = must(
      SETTINGS_LINKS.find(entry => entry.id === 'terminals'),
      'the terminals palette link',
    );

    // Assert
    expect(tab.id).toBe('terminals');
    expect(tab.label).toBe('Terminals');
    for (const query of ['terminal', 'capacity'])
      expect(
        settingsPaletteEntries(alpha.daemonId, query).find(item => item.id === 'setting-link-terminals')?.href,
      ).toBe(link.href(alpha.daemonId));
    await shown.unmount();
  });
});
