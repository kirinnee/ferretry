import { describe, expect, test } from 'bun:test';

import {
  isSettingId,
  isSettingsSectionId,
  SETTINGS_DEFINITIONS,
  SETTINGS_LINKS,
  SETTINGS_SECTIONS,
  settingDefinition,
  settingsHref,
  settingsPaletteEntries,
  settingsSectionDefinition,
  settingsSectionForSetting,
} from '../../../../src/features/settings/settings-catalog.ts';
import { daemonId } from '../../../../src/lib/daemon-connection.ts';
import { daemonMachineSetupPath } from '../../../../src/lib/pages/routes.ts';

const alpha = daemonId('daemon-alpha');
const beta = daemonId('daemon-beta');

describe('shared settings catalog', () => {
  test('owns the rendered controls in stable order', () => {
    expect(SETTINGS_DEFINITIONS.map(setting => setting.id)).toEqual([
      'text-size',
      'density',
      'group-needs-you',
      'chat-width',
      'composer-markdown',
      'composer-enter-key',
      'composer-suggestions',
      'theme',
      'dictation',
      'notifications',
      'device-permissions',
      'connection-preference',
      'install-app',
      'clear-cached-data',
      'transcription-log',
      'dictation-debug',
      'about-device',
      'speedup-keys',
      'sessions-list',
      'motion',
      'open-links-in',
      'message-marks',
    ]);
    expect(new Set(SETTINGS_DEFINITIONS.map(setting => setting.id)).size).toBe(SETTINGS_DEFINITIONS.length);
    for (const setting of SETTINGS_DEFINITIONS) {
      expect(setting.label.length).toBeGreaterThan(0);
      expect(setting.description.length).toBeGreaterThan(0);
      expect(setting.keywords.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('groups every control exactly once under the four stable logical sections', () => {
    expect(SETTINGS_SECTIONS.map(section => section.id)).toEqual(['appearance', 'behaviour', 'device', 'machines']);
    expect(SETTINGS_SECTIONS.map(section => section.label)).toEqual([
      'Appearance',
      'Behaviour',
      'This device',
      'Machines',
    ]);
    expect(SETTINGS_SECTIONS.map(section => section.settingIds)).toEqual([
      ['text-size', 'theme', 'motion', 'density', 'group-needs-you', 'chat-width', 'open-links-in', 'message-marks'],
      [
        'sessions-list',
        'composer-markdown',
        'composer-enter-key',
        'composer-suggestions',
        'dictation',
        'notifications',
      ],
      [
        'install-app',
        'device-permissions',
        'connection-preference',
        'speedup-keys',
        'transcription-log',
        'dictation-debug',
        'clear-cached-data',
        'about-device',
      ],
      [],
    ]);

    const grouped = SETTINGS_SECTIONS.flatMap(section => section.settingIds);
    expect(grouped).toHaveLength(SETTINGS_DEFINITIONS.length);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(new Set(grouped)).toEqual(new Set(SETTINGS_DEFINITIONS.map(setting => setting.id)));
    for (const section of SETTINGS_SECTIONS) {
      expect(section.description.length).toBeGreaterThan(0);
      expect(settingsSectionDefinition(section.id)).toBe(section);
    }
  });

  test('resolves section ids and setting ownership without accepting invented values', () => {
    expect(isSettingsSectionId('appearance')).toBe(true);
    expect(isSettingsSectionId('behaviour')).toBe(true);
    // Daemons merged into Machines: its address is a legacy anchor the page redirects, not a section.
    expect(isSettingsSectionId('daemons')).toBe(false);
    expect(isSettingsSectionId('machines')).toBe(true);
    expect(isSettingsSectionId('device')).toBe(true);
    expect(isSettingsSectionId('notifications')).toBe(false);
    expect(isSettingsSectionId(null)).toBe(false);
    expect(isSettingsSectionId(undefined)).toBe(false);

    expect(settingsSectionForSetting('text-size')).toBe('appearance');
    expect(settingsSectionForSetting('theme')).toBe('appearance');
    expect(settingsSectionForSetting('install-app')).toBe('device');
    expect(settingsSectionForSetting('device-permissions')).toBe('device');
    expect(settingsSectionForSetting('connection-preference')).toBe('device');
    expect(settingsSectionForSetting('clear-cached-data')).toBe('device');
    expect(settingsSectionForSetting('composer-markdown')).toBe('behaviour');
    expect(settingsSectionForSetting('composer-enter-key')).toBe('behaviour');
    expect(settingsSectionForSetting('composer-suggestions')).toBe('behaviour');
    expect(settingsSectionForSetting('notifications')).toBe('behaviour');
    expect(() => settingsSectionDefinition('invented' as never)).toThrow('Unknown settings section: invented');
    expect(() => settingsSectionForSetting('invented' as never)).toThrow(
      'Setting invented does not belong to a settings section',
    );
  });

  test('offers an explicit Open settings command before any query', () => {
    expect(settingsPaletteEntries(alpha, '')).toEqual([
      {
        id: 'open-settings',
        label: 'Open settings',
        description: 'Appearance and behaviour on this browser, and every paired machine.',
        settingId: null,
      },
    ]);
  });

  test('searches the same catalog and targets the matching control', () => {
    expect(settingsPaletteEntries(alpha, 'text size')[0]?.settingId).toBe('text-size');
    expect(settingsPaletteEntries(alpha, 'density')[0]?.settingId).toBe('density');
    expect(settingsPaletteEntries(alpha, 'conversation width')[0]?.settingId).toBe('chat-width');
    expect(settingsPaletteEntries(alpha, 'full-bleed')[0]?.settingId).toBe('chat-width');
    expect(settingsPaletteEntries(alpha, 'motion')[0]?.settingId).toBe('motion');
    expect(settingsPaletteEntries(alpha, 'balanced')[0]?.settingId).toBe('chat-width');
    expect(settingsPaletteEntries(alpha, 'editor style')[0]?.settingId).toBe('composer-markdown');
    expect(settingsPaletteEntries(alpha, 'shift enter')[0]?.settingId).toBe('composer-enter-key');
    // Vim shares the composer-editing control rather than hiding in a new page.
    for (const query of ['vim', 'modal', 'hjkl', 'normal mode']) {
      expect(settingsPaletteEntries(alpha, query).map(entry => entry.settingId)).toContain('composer-markdown');
    }
    // The suggestion switches are findable by what a reader would type when a
    // menu is in the way, not only by this project's own nouns.
    for (const query of ['suggestion', 'autocomplete', 'sigil', 'typeahead', 'noise']) {
      expect(settingsPaletteEntries(alpha, query).map(entry => entry.settingId)).toContain('composer-suggestions');
    }
    expect(settingsPaletteEntries(alpha, 'dark').map(entry => entry.settingId)).toContain('theme');
    expect(settingsPaletteEntries(alpha, 'microphone').map(entry => entry.settingId)).toContain('dictation');
  });

  test('makes the enhancement feature findable by its own names', () => {
    for (const query of ['enhance', 'enhancement', 'dictionary', 'vocabulary', 'glossary', 'jargon', 'correction']) {
      expect(settingsPaletteEntries(alpha, query).map(entry => entry.settingId)).toContain('dictation');
    }
  });

  test('shows the current dictation binding in its palette description', () => {
    const entry = settingsPaletteEntries(alpha, 'push to talk', { dictationShortcutLabel: 'Alt + Shift + V' }).find(
      item => item.settingId === 'dictation',
    );
    expect(entry?.description).toContain('Push-to-talk shortcut: Alt + Shift + V');
  });

  test('finds Machines by the account model’s words and the old ones, on the daemon being searched', () => {
    const machines = SETTINGS_LINKS.find(link => link.id === 'machines');
    expect(machines?.href(beta)).toBe('/d/daemon-beta/settings#machines');
    for (const query of ['runtime', 'credential', 'profile', 'component', 'login', 'accounts']) {
      expect(settingsPaletteEntries(alpha, query).find(item => item.id === 'setting-link-machines')?.href).toBe(
        '/d/daemon-alpha/settings#machines',
      );
    }
  });

  test('finds the passkey panel by what a person types after a confirm prompt, on the daemon searched', () => {
    const security = SETTINGS_LINKS.find(link => link.id === 'security');
    expect(security?.href(beta)).toBe('/d/daemon-beta/settings#security');
    for (const query of ['passkey', 'confirm', 'biometric', 'face id']) {
      expect(settingsPaletteEntries(alpha, query).find(item => item.id === 'setting-link-security')?.href).toBe(
        '/d/daemon-alpha/settings#security',
      );
    }
  });

  test('keeps link-row destinations bound to the daemon being searched', () => {
    const warden = SETTINGS_LINKS.find(link => link.id === 'warden');
    expect(warden?.href(alpha)).toBe('/d/daemon-alpha/settings#warden');
    expect(warden?.href(beta)).toBe('/d/daemon-beta/settings#warden');
    for (const query of ['failover', 'round robin', 'warden', 'fallback']) {
      expect(settingsPaletteEntries(alpha, query).find(item => item.id === 'setting-link-warden')?.href).toBe(
        '/d/daemon-alpha/settings#warden',
      );
    }
    expect(settingsPaletteEntries(alpha, '').some(item => item.id === 'setting-link-warden')).toBe(false);
  });

  test('opens each machine panel at its own anchor, never the retired Daemons section', () => {
    const hrefs = Object.fromEntries(SETTINGS_LINKS.map(link => [link.id, link.href(beta)]));
    expect(hrefs).toMatchObject({
      grants: '/d/daemon-beta/settings#grants',
      'security-log': '/d/daemon-beta/settings#security-log',
      warden: '/d/daemon-beta/settings#warden',
      security: '/d/daemon-beta/settings#security',
      'resource-limits': '/d/daemon-beta/settings#resource-limits',
      files: '/d/daemon-beta/settings#files',
    });
    for (const href of Object.values(hrefs)) expect(href).not.toContain('#daemons');
  });

  test('opens New machine setup on its own route and the other three on the Machine tab', () => {
    const hrefs = Object.fromEntries(SETTINGS_LINKS.map(link => [link.id, link.href(beta)]));
    expect(hrefs).toMatchObject({
      'machine-setup': daemonMachineSetupPath(beta),
      'copy-settings': '/d/daemon-beta/settings#clone',
      'export-settings': '/d/daemon-beta/settings#export',
      speedups: '/d/daemon-beta/settings#speedups',
    });
  });

  test('makes each setup link findable by what a person types for it', () => {
    const found = (query: string, id: string) =>
      settingsPaletteEntries(alpha, query).some(item => item.id === `setting-link-${id}`);
    for (const query of ['onboarding', 'wizard', 'first run', 'new machine'])
      expect(found(query, 'machine-setup')).toBe(true);
    for (const query of ['clone', 'migrate', 'another machine']) expect(found(query, 'copy-settings')).toBe(true);
    for (const query of ['export', 'zip', 'backup']) expect(found(query, 'export-settings')).toBe(true);
    for (const query of ['groq', 'cerebras', 'jev', 'cheaper']) expect(found(query, 'speedups')).toBe(true);
    expect(settingsPaletteEntries(alpha, 'wizard').find(item => item.id === 'setting-link-machine-setup')?.href).toBe(
      daemonMachineSetupPath(alpha),
    );
  });

  test('says "on this device" for the two device sections, and that the links are on this machine', () => {
    expect(settingsSectionDefinition('appearance').description).toContain('on this device');
    expect(settingsSectionDefinition('behaviour').description).toContain('on this device');
    for (const id of ['machine-setup', 'copy-settings', 'export-settings', 'speedups']) {
      expect(SETTINGS_LINKS.find(link => link.id === id)?.description).toContain('On this machine');
    }
  });

  test('makes the resource-limit panel findable by the symptoms rather than the kernel word', () => {
    const limits = SETTINGS_LINKS.find(link => link.id === 'resource-limits');
    expect(limits?.href(beta)).toBe('/d/daemon-beta/settings#resource-limits');
    // "cgroup" is the mechanism and is in the list; the others are what a person types when an agent
    // is eating the machine, and matching only the mechanism would leave the control unfindable by
    // exactly the person who needs it.
    for (const query of ['cpu', 'ram', 'memory', 'throttle', 'cgroup', 'slow', 'out of memory', 'runaway']) {
      expect(settingsPaletteEntries(alpha, query).find(item => item.id === 'setting-link-resource-limits')?.href).toBe(
        '/d/daemon-alpha/settings#resource-limits',
      );
    }
  });

  test('builds deep links only for known setting ids and scopes them to one daemon', () => {
    expect(isSettingId('theme')).toBe(true);
    expect(isSettingId('dictation')).toBe(true);
    expect(isSettingId('unknown')).toBe(false);
    expect(settingsHref(alpha)).toBe('/d/daemon-alpha/settings');
    expect(settingsHref(alpha, 'density')).toBe('/d/daemon-alpha/settings#density');
    expect(settingsHref(beta, 'density')).toBe('/d/daemon-beta/settings#density');
  });

  test('returns catalog definitions and refuses an impossible id', () => {
    expect(settingDefinition('theme').label).toBe('Theme');
    expect(() => settingDefinition('not-a-setting' as never)).toThrow('Unknown setting: not-a-setting');
  });

  test('offers the Open settings command when its own vocabulary matches', () => {
    expect(settingsPaletteEntries(alpha, 'preferences')[0]).toMatchObject({
      id: 'open-settings',
      settingId: null,
    });
  });
});
