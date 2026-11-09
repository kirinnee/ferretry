/**
 * What a launch ran under, as fingerprints: the same inputs always give the same record, any input that matters moves
 * exactly its own section, and a comparison names the sections that moved and nothing else. Pure.
 */
import { describe, expect, it } from 'bun:test';
import type { HooksItem, SettingsItem } from '../../../contract/index.ts';
import { compareLaunchSettings, launchSettingsRecord } from '../../../daemon/lib/harness/launch-settings.ts';

const settings = (...entries: [string, SettingsItem][]): ReadonlyMap<string, SettingsItem> => new Map(entries);
const hooks = (...entries: [string, HooksItem][]): ReadonlyMap<string, HooksItem> => new Map(entries);

const BASE = {
  permissionMode: 'auto' as const,
  settings: settings(['theme', { settings: { theme: 'dark' } }]),
  hooks: hooks(['audit', { hooks: { PreToolUse: [{ matcher: 'Bash' }] } }]),
};

describe('launchSettingsRecord', () => {
  it('fingerprints each section as a SHA-256 and is the same for the same inputs', () => {
    const record = launchSettingsRecord(BASE);

    expect(record.format).toBe(1);
    for (const section of ['permission-mode', 'fixed-layer', 'settings', 'hooks'] as const)
      expect(record.sections[section]).toMatch(/^[0-9a-f]{64}$/u);
    expect(launchSettingsRecord({ ...BASE })).toEqual(record);
  });

  it('moves the permission mode and the fixed layer when the mode changes, and nothing else', () => {
    const before = launchSettingsRecord(BASE);
    const after = launchSettingsRecord({ ...BASE, permissionMode: 'skip' });

    expect(compareLaunchSettings(before, after)).toEqual({
      kind: 'drifted',
      sections: ['permission-mode', 'fixed-layer'],
    });
  });

  it('moves only the settings section when a settings item changes', () => {
    const before = launchSettingsRecord(BASE);
    const after = launchSettingsRecord({
      ...BASE,
      settings: settings(['theme', { settings: { theme: 'light' } }]),
    });

    expect(compareLaunchSettings(before, after)).toEqual({ kind: 'drifted', sections: ['settings'] });
  });

  it('moves only the hooks section when a hooks item changes', () => {
    const before = launchSettingsRecord(BASE);
    const after = launchSettingsRecord({
      ...BASE,
      hooks: hooks(['audit', { hooks: { PreToolUse: [{ matcher: 'Write' }] } }]),
    });

    expect(compareLaunchSettings(before, after)).toEqual({ kind: 'drifted', sections: ['hooks'] });
  });

  it('fingerprints a launch with no settings and no hooks at all', () => {
    const record = launchSettingsRecord({ permissionMode: 'auto', settings: settings(), hooks: hooks() });

    expect(record.sections.settings).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.sections.hooks).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('refuses with a fixed sentence, naming no key, a setting that has no canonical spelling', () => {
    expect(() =>
      launchSettingsRecord({
        ...BASE,
        settings: settings(['bad', { settings: { secretKeyName: Number.NaN } }]),
      }),
    ).toThrow('a launch setting has no canonical spelling');
  });
});

describe('compareLaunchSettings', () => {
  it('is current when no section moved', () => {
    const record = launchSettingsRecord(BASE);

    expect(compareLaunchSettings(record, launchSettingsRecord(BASE))).toEqual({ kind: 'current' });
  });
});
