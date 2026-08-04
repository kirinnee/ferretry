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

const alpha = daemonId('daemon-alpha');
const beta = daemonId('daemon-beta');

describe('shared settings catalog', () => {
  test('owns the rendered controls in stable order', () => {
    expect(SETTINGS_DEFINITIONS.map(setting => setting.id)).toEqual([
      'text-size',
      'density',
      'chat-width',
      'composer-markdown',
      'theme',
      'dictation',
      'notifications',
    ]);
    expect(new Set(SETTINGS_DEFINITIONS.map(setting => setting.id)).size).toBe(SETTINGS_DEFINITIONS.length);
    for (const setting of SETTINGS_DEFINITIONS) {
      expect(setting.label.length).toBeGreaterThan(0);
      expect(setting.description.length).toBeGreaterThan(0);
      expect(setting.keywords.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('groups every control exactly once under the three stable logical sections', () => {
    expect(SETTINGS_SECTIONS.map(section => section.id)).toEqual(['appearance', 'behaviour', 'daemons']);
    expect(SETTINGS_SECTIONS.map(section => section.label)).toEqual(['Appearance', 'Behaviour', 'Daemons']);
    expect(SETTINGS_SECTIONS.map(section => section.settingIds)).toEqual([
      ['text-size', 'theme', 'density', 'chat-width'],
      ['composer-markdown', 'dictation', 'notifications'],
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
    expect(isSettingsSectionId('daemons')).toBe(true);
    expect(isSettingsSectionId('notifications')).toBe(false);
    expect(isSettingsSectionId(null)).toBe(false);
    expect(isSettingsSectionId(undefined)).toBe(false);

    expect(settingsSectionForSetting('text-size')).toBe('appearance');
    expect(settingsSectionForSetting('theme')).toBe('appearance');
    expect(settingsSectionForSetting('composer-markdown')).toBe('behaviour');
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
        description: 'Appearance, behaviour, and connected daemons for this browser.',
        settingId: null,
      },
    ]);
  });

  test('searches the same catalog and targets the matching control', () => {
    expect(settingsPaletteEntries(alpha, 'text size')[0]?.settingId).toBe('text-size');
    expect(settingsPaletteEntries(alpha, 'density')[0]?.settingId).toBe('density');
    expect(settingsPaletteEntries(alpha, 'conversation width')[0]?.settingId).toBe('chat-width');
    expect(settingsPaletteEntries(alpha, 'full-bleed')[0]?.settingId).toBe('chat-width');
    expect(settingsPaletteEntries(alpha, 'balanced')[0]?.settingId).toBe('chat-width');
    expect(settingsPaletteEntries(alpha, 'markdown preview')[0]?.settingId).toBe('composer-markdown');
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

  test('keeps link-row destinations bound to the daemon being searched', () => {
    const warden = SETTINGS_LINKS.find(link => link.id === 'warden');
    expect(warden?.href(alpha)).toBe('/d/daemon-alpha/settings#daemons');
    expect(warden?.href(beta)).toBe('/d/daemon-beta/settings#daemons');
    for (const query of ['failover', 'round robin', 'warden', 'fallback']) {
      expect(settingsPaletteEntries(alpha, query).find(item => item.id === 'setting-link-warden')?.href).toBe(
        '/d/daemon-alpha/settings#daemons',
      );
    }
    expect(settingsPaletteEntries(alpha, '').some(item => item.id === 'setting-link-warden')).toBe(false);
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
