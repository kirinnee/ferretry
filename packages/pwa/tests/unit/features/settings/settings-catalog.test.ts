import { describe, expect, test } from 'bun:test';

import { daemonId } from '../../../../src/lib/daemon-connection.ts';
import {
  SETTINGS_DEFINITIONS,
  SETTINGS_LINKS,
  isSettingId,
  settingsHref,
  settingsPaletteEntries,
} from '../../../../src/features/settings/settings-catalog.ts';

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

  test('offers an explicit Open settings command before any query', () => {
    expect(settingsPaletteEntries(alpha, '')).toEqual([
      {
        id: 'open-settings',
        label: 'Open settings',
        description: 'Appearance, text size, conversation width, theme, and dashboard density.',
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
    expect(warden?.href(alpha)).toBe('/d/daemon-alpha/warden#config');
    expect(warden?.href(beta)).toBe('/d/daemon-beta/warden#config');
    for (const query of ['failover', 'round robin', 'warden', 'fallback']) {
      expect(settingsPaletteEntries(alpha, query).find(item => item.id === 'setting-link-warden')?.href).toBe(
        '/d/daemon-alpha/warden#config',
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
});
