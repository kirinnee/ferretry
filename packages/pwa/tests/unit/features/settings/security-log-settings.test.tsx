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
  SecurityLogSurface,
  securityLogSettingsTab,
} from '../../../../src/features/settings/security-log-settings.tsx';
import { SETTINGS_LINKS, settingsPaletteEntries } from '../../../../src/features/settings/settings-catalog.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../support/dom.ts';
import { settleUntil } from '../../../support/settle.ts';
import { runAsync } from '../../../support/react.ts';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const now = () => NOW;
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

const empty = (overrides: Partial<AuditView> = {}): AuditView => ({
  records: [],
  kept: [],
  keptTotal: 0,
  unreadable: 0,
  ...overrides,
});

describe('Settings › Security log', () => {
  it('lists the log newest first, in words, with a badge only where something was refused', async () => {
    const view: AuditView = {
      records: [
        record({ event: 'pairing.refused', actor: { kind: 'anonymous' }, outcome: 'refused' }),
        record({
          event: 'secrets.used',
          actor: { kind: 'device', deviceId: 'fy_device_id_abcdef123456', deviceName: 'Pixel 8' },
          detail: { carrier: 'relay', count: 2 },
        }),
        record({ event: 'grants.changed', actor: { kind: 'warden' }, outcome: 'failed', at: 'garbled' }),
      ],
      kept: [],
      keptTotal: 0,
      unreadable: 0,
    };
    const shown = await mount(
      <SecurityLogSurface connection={alpha} createClient={answering(async () => view)} now={now} />,
    );
    await settled(shown.container, '[data-security-log-panel]');

    const rows = [...shown.container.querySelectorAll('[data-security-log-event]')];
    expect(rows.map(row => row.textContent)).toEqual([
      'A pairing attempt was refusedRefused5 minutes ago · by someone who is not paired',
      'A secret was used5 minutes ago · by device “Pixel 8” (…123456)carrier: relay · count: 2',
      'Remote permissions were changedFailedat an unknown time · by a supervising agent',
    ]);
    // Only a record with detail carries the detail line.
    expect(rows.map(row => row.querySelector('[data-security-log-detail]') !== null)).toEqual([false, true, false]);
    expect(must(rows[0]?.querySelector('time'), 'time').getAttribute('title')).toBe(
      new Date(NOW - 5 * 60_000).toLocaleString(),
    );
    expect(shown.container.querySelector('[data-security-log-gaps]')).toBeNull();
    await shown.unmount();
  });

  it('shows the security changes first, apart from the activity, and pages back through older ones', async () => {
    const paired = (id: string) =>
      record({ event: 'device.paired', subject: id, actor: { kind: 'device', deviceId: id, deviceName: id } });
    const offsets: string[] = [];
    let olderFails = true;
    const createClient: SecurityLogClientFactory = async () => ({
      request: (async (path: string) => {
        offsets.push(path);
        if (!path.includes('keptOffset')) return empty({
          kept: [paired('fy_device_id_new000'), record({ event: 'grants.changed', outcome: 'succeeded' })],
          keptTotal: 3,
          records: Array.from({ length: 3 }, () => record({ event: 'pairing.code-minted' })),
        });
        if (olderFails) throw new Error('');
        return empty({ kept: [paired('fy_device_id_old000')], keptTotal: 3 });
      }) as SecurityLogClient['request'],
    });
    const seen: DevicesLookedDetail[] = [];
    const listener = (event: Event): void => void seen.push((event as CustomEvent<DevicesLookedDetail>).detail);
    window.addEventListener(DEVICES_LOOKED_EVENT, listener);
    const shown = await mount(<SecurityLogSurface connection={alpha} createClient={createClient} now={now} />);
    await settled(shown.container, '[data-security-log-panel]');

    const sections = [...shown.container.querySelectorAll('[data-security-log-section]')];
    expect(sections.map(section => section.getAttribute('data-security-log-section'))).toEqual(['kept', 'activity']);
    const rows = () => [...shown.container.querySelectorAll('[data-security-log-event]')].map(row => row.getAttribute('data-security-log-event'));
    expect(rows()).toEqual(['device.paired', 'grants.changed', 'pairing.code-minted', 'pairing.code-minted', 'pairing.code-minted']);
    const older = must(shown.container.querySelector<HTMLButtonElement>('[data-security-log-older]'), 'show older');
    expect(older.textContent).toBe('Show older (1 more)');

    // A page that fails says so, keeps the button, and marks nothing.
    await interact(() => older.click());
    await settled(shown.container, '[data-security-log-older-failed]');
    expect(shown.container.querySelector('[data-security-log-older-failed]')?.textContent).toBe(
      'The older changes could not be read.',
    );
    olderFails = false;
    await interact(() => must(shown.container.querySelector<HTMLButtonElement>('[data-security-log-older]'), 'retry').click());
    await settleUntil(() => shown.container.querySelector('[data-security-log-older]') === null, 'every change shown', runAsync);
    expect(rows().slice(0, 3)).toEqual(['device.paired', 'grants.changed', 'device.paired']);
    expect(offsets).toEqual(['/v1/audit?limit=100', '/v1/audit?limit=100&keptOffset=2', '/v1/audit?limit=100&keptOffset=2']);
    window.removeEventListener(DEVICES_LOOKED_EVENT, listener);
    // Each look names exactly the pairings that page put on screen.
    expect(seen).toEqual([
      { daemonId: alpha.daemonId, deviceIds: ['fy_device_id_new000'] },
      { daemonId: alpha.daemonId, deviceIds: ['fy_device_id_old000'] },
    ]);
    await shown.unmount();
  });

  it('marks nothing as looked when the read is refused', async () => {
    const seen: DevicesLookedDetail[] = [];
    const listener = (event: Event): void => void seen.push((event as CustomEvent<DevicesLookedDetail>).detail);
    window.addEventListener(DEVICES_LOOKED_EVENT, listener);
    const shown = await mount(
      <SecurityLogSurface
        connection={alpha}
        createClient={answering(async () => {
          throw new HttpRefusal('no', 403);
        })}
        now={now}
      />,
    );
    await settled(shown.container, '[data-security-log-refused]');
    window.removeEventListener(DEVICES_LOOKED_EVENT, listener);
    expect(seen).toEqual([]);
    await shown.unmount();
  });

  it('shows an empty section in words when only the other one has records', async () => {
    const onlyKept = await mount(
      <SecurityLogSurface
        connection={alpha}
        createClient={answering(async () => empty({ kept: [record()], keptTotal: 1 }))}
        now={now}
      />,
    );
    await settled(onlyKept.container, '[data-security-log-panel]');
    expect(onlyKept.container.textContent).toContain('Recent activityNone yet.');
    await onlyKept.unmount();
    const onlyActivity = await mount(
      <SecurityLogSurface
        connection={alpha}
        createClient={answering(async () => empty({ records: [record({ event: 'terminal.opened' })] }))}
        now={now}
      />,
    );
    await settled(onlyActivity.container, '[data-security-log-panel]');
    expect(onlyActivity.container.textContent).toContain('Security changesNone yet.');
    await onlyActivity.unmount();
  });

  it('says the history has gaps, and says an empty log is empty', async () => {
    const shown = await mount(
      <SecurityLogSurface
        connection={alpha}
        createClient={answering(async () => empty({ unreadable: 2 }))}
        now={now}
      />,
    );
    await settled(shown.container, '[data-security-log-panel]');
    expect(shown.container.querySelector('[data-security-log-gaps]')?.textContent).toBe(
      '2 entries in this log could not be read. The history has gaps.',
    );
    expect(shown.container.querySelector('[data-security-log-empty]')?.textContent).toBe('Nothing has happened yet.');
    await shown.unmount();
  });

  it('explains a refusal in words rather than showing an empty log', async () => {
    const shown = await mount(
      <SecurityLogSurface
        connection={alpha}
        createClient={answering(async () => {
          throw new HttpRefusal('Pairing is switched off for other devices.', 403);
        })}
        now={now}
      />,
    );
    await settled(shown.container, '[data-security-log-refused]');
    const text = shown.container.textContent ?? '';
    expect(text).toContain(SECURITY_REFUSED_INTRO);
    expect(text).toContain('Pairing is switched off for other devices.');
    expect(text).toContain(SECURITY_REFUSED_REMEDY);
    expect(shown.container.querySelector('[data-security-log-empty]')).toBeNull();
    await shown.unmount();
  });

  it('a refusal with no sentence still explains itself', async () => {
    const shown = await mount(
      <SecurityLogSurface
        connection={alpha}
        createClient={answering(async () => {
          throw new HttpRefusal('  ', 403);
        })}
        now={now}
      />,
    );
    await settled(shown.container, '[data-security-log-refused]');
    expect(shown.container.querySelectorAll('[data-security-log-refused] p')).toHaveLength(2);
    await shown.unmount();
  });

  it('says a failed read is not an empty history', async () => {
    const shown = await mount(
      <SecurityLogSurface
        connection={alpha}
        createClient={async () => {
          throw new Error('Nothing answered.');
        }}
        now={now}
      />,
    );
    await settled(shown.container, '[data-security-log-failed]');
    expect(shown.container.textContent).toContain('Nothing answered. This is not an empty history');
    await shown.unmount();

    const silent = await mount(
      <SecurityLogSurface
        connection={alpha}
        createClient={async () => {
          // A thrown value that is not an Error still has to be said.
          throw '';
        }}
        now={now}
      />,
    );
    await settled(silent.container, '[data-security-log-failed]');
    expect(silent.container.textContent).toContain('This machine did not say why.');
    await silent.unmount();
  });

  it('marks nothing as looked until a log loads, and never shows another machine’s log', async () => {
    const seen: DevicesLookedDetail[] = [];
    const listener = (event: Event): void => void seen.push((event as CustomEvent<DevicesLookedDetail>).detail);
    window.addEventListener(DEVICES_LOOKED_EVENT, listener);
    let releaseAlpha: (view: AuditView) => void = () => undefined;
    const createClient = answering(async connection =>
      connection.daemonId === alpha.daemonId
        ? await new Promise<AuditView>(resolve => {
            releaseAlpha = resolve;
          })
        : empty({ records: [record({ event: 'terminal.opened' })] }),
    );
    const shown = await mount(<SecurityLogSurface connection={alpha} createClient={createClient} now={now} />);
    expect(shown.container.textContent).toContain('Reading this machine’s security log');
    await shown.render(<SecurityLogSurface connection={beta} createClient={createClient} now={now} />);
    await settled(shown.container, '[data-security-log-panel]');
    // Alpha's answer arrives late, after the reader moved to beta, and is dropped.
    await runAsync(async () => releaseAlpha(empty({ records: [record({ event: 'secrets.used' })] })));
    expect(shown.container.querySelector('[data-security-log-event]')?.getAttribute('data-security-log-event')).toBe(
      'terminal.opened',
    );
    window.removeEventListener(DEVICES_LOOKED_EVENT, listener);
    // Only beta's log loaded while it was shown, and it held no pairing: nothing is marked seen.
    expect(seen).toEqual([{ daemonId: beta.daemonId, deviceIds: [] }]);
    await shown.unmount();
  });

  it('drops a late failure for a machine the reader left', async () => {
    let failAlpha: (cause: Error) => void = () => undefined;
    const createClient: SecurityLogClientFactory = async connection =>
      connection.daemonId === alpha.daemonId
        ? await new Promise<SecurityLogClient>((_, reject) => {
            failAlpha = reject;
          })
        : { request: (async () => empty()) as SecurityLogClient['request'] };
    const shown = await mount(<SecurityLogSurface connection={alpha} createClient={createClient} now={now} />);
    await shown.render(<SecurityLogSurface connection={beta} createClient={createClient} now={now} />);
    await settled(shown.container, '[data-security-log-panel]');
    await runAsync(async () => failAlpha(new Error('late')));
    expect(shown.container.querySelector('[data-security-log-failed]')).toBeNull();
    await shown.unmount();
  });

  it('is offered as a daemon panel and in the palette', async () => {
    const tab = securityLogSettingsTab(answering(async () => empty()));
    expect(tab.id).toBe('security-log');
    expect(tab.label).toBe('Security log');
    const shown = await mount(<tab.Surface connection={alpha} />);
    await settled(shown.container, '[data-security-log-empty]');
    await shown.unmount();

    const link = must(
      SETTINGS_LINKS.find(entry => entry.id === 'security-log'),
      'the security palette link',
    );
    for (const query of ['audit', 'who paired', 'security log']) {
      expect(
        settingsPaletteEntries(alpha.daemonId, query).find(item => item.id === 'setting-link-security-log')?.href,
      ).toBe(link.href(alpha.daemonId));
    }
  });
});
