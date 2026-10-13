import '../../../support/dom.ts';
import { describe, expect, it } from 'bun:test';
import type { AuditRecord, AuditView } from '@ferretry/protocol';
import {
  DEVICES_LOOKED_EVENT,
  type DevicesLookedDetail,
} from '../../../../src/features/device-notice/devices-looked.ts';
import type { SecurityLogClient } from '../../../../src/features/settings/security-api.ts';
import {
  SECURITY_REFUSED_INTRO,
  SECURITY_REFUSED_REMEDY,
  type SecurityLogClientFactory,
  SecuritySurface,
  securitySettingsTab,
} from '../../../../src/features/settings/security-settings.tsx';
import { SETTINGS_LINKS, settingsPaletteEntries } from '../../../../src/features/settings/settings-catalog.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { mount, must } from '../../../support/dom.ts';
import { settleUntil } from '../../../support/settle.ts';
import { runAsync } from '../../../support/react.ts';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const now = () => NOW;
const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'alpha-token',
});
const beta = daemonConnection({ daemonId: 'beta', baseUrl: 'https://beta.example.test', deviceToken: 'beta-token' });

const record = (overrides: Partial<AuditRecord> = {}): AuditRecord => ({
  at: new Date(NOW - 5 * 60_000).toISOString(),
  event: 'device.paired',
  actor: { kind: 'host' },
  outcome: 'succeeded',
  ...overrides,
});

const answering =
  (answer: (connection: typeof alpha) => Promise<AuditView>): SecurityLogClientFactory =>
  async connection =>
    ({ request: (async () => await answer(connection)) as SecurityLogClient['request'] }) satisfies SecurityLogClient;

const settled = async (container: HTMLElement, selector: string): Promise<void> => {
  await settleUntil(() => container.querySelector(selector) !== null, selector, runAsync);
};

class HttpRefusal extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

describe('Settings › Security', () => {
  it('lists the log newest first, in words, with a badge only where something was refused', async () => {
    const view: AuditView = {
      records: [
        record({ event: 'pairing.refused', actor: { kind: 'anonymous' }, outcome: 'refused' }),
        record({ event: 'secrets.used', actor: { kind: 'device', deviceId: 'd', deviceName: 'Pixel 8' } }),
        record({ event: 'grants.changed', actor: { kind: 'warden' }, outcome: 'failed', at: 'garbled' }),
      ],
      unreadable: 0,
    };
    const shown = await mount(
      <SecuritySurface connection={alpha} createClient={answering(async () => view)} now={now} />,
    );
    await settled(shown.container, '[data-security-log]');

    const rows = [...shown.container.querySelectorAll('[data-security-event]')];
    expect(rows.map(row => row.textContent)).toEqual([
      'A pairing attempt was refusedRefused5 minutes ago · by someone who is not paired',
      'A secret was used5 minutes ago · by Pixel 8',
      'Remote permissions were changedFailedat an unknown time · by a supervising agent',
    ]);
    expect(must(rows[0]?.querySelector('time'), 'time').getAttribute('title')).toBe(
      new Date(NOW - 5 * 60_000).toLocaleString(),
    );
    expect(shown.container.querySelector('[data-security-gaps]')).toBeNull();
    await shown.unmount();
  });

  it('says the history has gaps, and says an empty log is empty', async () => {
    const shown = await mount(
      <SecuritySurface
        connection={alpha}
        createClient={answering(async () => ({ records: [], unreadable: 2 }))}
        now={now}
      />,
    );
    await settled(shown.container, '[data-security-log]');
    expect(shown.container.querySelector('[data-security-gaps]')?.textContent).toBe(
      '2 entries in this log could not be read. The history has gaps.',
    );
    expect(shown.container.querySelector('[data-security-empty]')?.textContent).toBe('Nothing has happened yet.');
    await shown.unmount();
  });

  it('explains a refusal in words rather than showing an empty log', async () => {
    const shown = await mount(
      <SecuritySurface
        connection={alpha}
        createClient={answering(async () => {
          throw new HttpRefusal('Pairing is switched off for other devices.', 403);
        })}
        now={now}
      />,
    );
    await settled(shown.container, '[data-security-refused]');
    const text = shown.container.textContent ?? '';
    expect(text).toContain(SECURITY_REFUSED_INTRO);
    expect(text).toContain('Pairing is switched off for other devices.');
    expect(text).toContain(SECURITY_REFUSED_REMEDY);
    expect(shown.container.querySelector('[data-security-empty]')).toBeNull();
    await shown.unmount();
  });

  it('a refusal with no sentence still explains itself', async () => {
    const shown = await mount(
      <SecuritySurface
        connection={alpha}
        createClient={answering(async () => {
          throw new HttpRefusal('  ', 403);
        })}
        now={now}
      />,
    );
    await settled(shown.container, '[data-security-refused]');
    expect(shown.container.querySelectorAll('[data-security-refused] p')).toHaveLength(2);
    await shown.unmount();
  });

  it('says a failed read is not an empty history', async () => {
    const shown = await mount(
      <SecuritySurface
        connection={alpha}
        createClient={async () => {
          throw new Error('Nothing answered.');
        }}
        now={now}
      />,
    );
    await settled(shown.container, '[data-security-failed]');
    expect(shown.container.textContent).toContain('Nothing answered. This is not an empty history');
    await shown.unmount();

    const silent = await mount(
      <SecuritySurface
        connection={alpha}
        createClient={async () => {
          // A thrown value that is not an Error still has to be said.
          throw '';
        }}
        now={now}
      />,
    );
    await settled(silent.container, '[data-security-failed]');
    expect(silent.container.textContent).toContain('This machine did not say why.');
    await silent.unmount();
  });

  it('marks the devices looked at for this machine on open, and never shows another machine’s log', async () => {
    const seen: DevicesLookedDetail[] = [];
    const listener = (event: Event): void => void seen.push((event as CustomEvent<DevicesLookedDetail>).detail);
    window.addEventListener(DEVICES_LOOKED_EVENT, listener);
    let releaseAlpha: (view: AuditView) => void = () => undefined;
    const createClient = answering(async connection =>
      connection.daemonId === alpha.daemonId
        ? await new Promise<AuditView>(resolve => {
            releaseAlpha = resolve;
          })
        : { records: [record({ event: 'terminal.opened' })], unreadable: 0 },
    );
    const shown = await mount(
      <SecuritySurface connection={alpha} createClient={createClient} now={now} storage={undefined} />,
    );
    expect(shown.container.textContent).toContain('Reading this machine’s security log');
    await shown.render(<SecuritySurface connection={beta} createClient={createClient} now={now} storage={undefined} />);
    await settled(shown.container, '[data-security-log]');
    // Alpha's answer arrives late, after the reader moved to beta, and is dropped.
    await runAsync(async () => releaseAlpha({ records: [record({ event: 'secrets.used' })], unreadable: 0 }));
    expect(shown.container.querySelector('[data-security-event]')?.getAttribute('data-security-event')).toBe(
      'terminal.opened',
    );
    window.removeEventListener(DEVICES_LOOKED_EVENT, listener);
    expect(seen).toEqual([
      { daemonId: alpha.daemonId, at: NOW },
      { daemonId: beta.daemonId, at: NOW },
    ]);
    await shown.unmount();
  });

  it('drops a late failure for a machine the reader left', async () => {
    let failAlpha: (cause: Error) => void = () => undefined;
    const createClient: SecurityLogClientFactory = async connection =>
      connection.daemonId === alpha.daemonId
        ? await new Promise<SecurityLogClient>((_, reject) => {
            failAlpha = reject;
          })
        : { request: (async () => ({ records: [], unreadable: 0 })) as SecurityLogClient['request'] };
    const shown = await mount(<SecuritySurface connection={alpha} createClient={createClient} now={now} />);
    await shown.render(<SecuritySurface connection={beta} createClient={createClient} now={now} />);
    await settled(shown.container, '[data-security-log]');
    await runAsync(async () => failAlpha(new Error('late')));
    expect(shown.container.querySelector('[data-security-failed]')).toBeNull();
    await shown.unmount();
  });

  it('is offered as a daemon panel and in the palette', async () => {
    const tab = securitySettingsTab(answering(async () => ({ records: [], unreadable: 0 })));
    expect(tab.id).toBe('security');
    expect(tab.label).toBe('Security');
    const shown = await mount(<tab.Surface connection={alpha} />);
    await settled(shown.container, '[data-security-empty]');
    await shown.unmount();

    const link = must(
      SETTINGS_LINKS.find(entry => entry.id === 'security'),
      'the security palette link',
    );
    for (const query of ['audit', 'who paired', 'security log']) {
      expect(
        settingsPaletteEntries(alpha.daemonId, query).find(item => item.id === 'setting-link-security')?.href,
      ).toBe(link.href(alpha.daemonId));
    }
  });
});
