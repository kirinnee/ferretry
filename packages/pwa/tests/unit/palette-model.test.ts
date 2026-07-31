import { describe, expect, it } from 'bun:test';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import { APP_BAR_DESTINATIONS } from '../../src/shell/app-bar.tsx';
import {
  baseName,
  clampActiveIndex,
  matchesPaletteCommand,
  nextActiveIndex,
  type PaletteCommand,
  paletteCountLabel,
  paletteFocusPolicy,
  paletteGroupHeading,
  paletteResultId,
  paletteResults,
  paletteSessionEntries,
  type PaletteSettingsEntry,
  paletteSettingHref,
  settingsDestinationHrefs,
} from '../../src/shell/palette-model.ts';
import { sessionView } from '../support/sessions.ts';

const alpha = daemonId('alpha');
const beta = daemonId('beta');

const command = (overrides: Partial<PaletteCommand> = {}): PaletteCommand => ({
  id: 'browser-login',
  label: 'Open browser login window',
  description: 'Sign in to shared Chrome through the private browser-login window',
  searchTerms: 'browser login sign in shared chrome',
  run: () => undefined,
  ...overrides,
});

const setting = (overrides: Partial<PaletteSettingsEntry> = {}): PaletteSettingsEntry => ({
  id: 'setting-density',
  label: 'Density',
  description: 'How tightly rows pack',
  settingId: 'density',
  ...overrides,
});

const noGroups = { destinations: [], commands: [], settings: [] };

describe('baseName', () => {
  it('names a project by its last path segment', () => {
    expect(baseName('/home/k/Workspace/ferretry')).toBe('ferretry');
  });

  it('reads a trailing separator the same as none', () => {
    expect(baseName('/home/k/Workspace/ferretry/')).toBe('ferretry');
  });

  it('leaves a bare name alone', () => {
    expect(baseName('ferretry')).toBe('ferretry');
  });
});

describe('paletteSessionEntries', () => {
  it('keeps the searchable callsign RAW and the rendered headline title-cased', () => {
    const [entry] = paletteSessionEntries([sessionView('s1', { config: { teammate: 'ms-98' } })]);

    expect(entry?.teammate).toBe('ms-98');
    expect(entry?.headline).toBe('Ms-98');
  });

  it('falls back to the session name, then to a short id, when there is no callsign', () => {
    const [named] = paletteSessionEntries([sessionView('s1', { config: { name: 'Fix the scroller' } })]);
    const [anonymous] = paletteSessionEntries([
      sessionView('ms9hi4ts-b22751c4', { config: { name: '', teammate: '' } }),
    ]);

    expect(named?.headline).toBe('Fix the scroller');
    expect(anonymous?.headline).toBe('ms9hi4ts…');
  });

  it('strips the bracketed prefix off the searchable task', () => {
    const [entry] = paletteSessionEntries([sessionView('s1', { config: { name: '[Hayden] Fix the scroller' } })]);

    expect(entry?.task).toBe('Fix the scroller');
  });

  it('searches the project folder by its name AND by its whole path', () => {
    const [entry] = paletteSessionEntries([sessionView('s1', { config: { cwd: '/home/k/Workspace/ferretry' } })]);

    expect(entry?.folderName).toBe('ferretry');
    expect(entry?.folder).toBe('ferretry /home/k/Workspace/ferretry');
  });

  it('reads the life sign from the state, then from the config, then gives up on it', () => {
    const [fromState] = paletteSessionEntries([
      sessionView('s1', { state: { lastActivityAt: '2026-07-31T00:00:00.000Z' } }),
    ]);
    const [fromConfig] = paletteSessionEntries([
      sessionView('s2', {
        config: { updatedAt: '2026-07-30T00:00:00.000Z' },
        state: { lastActivityAt: undefined },
      }),
    ]);
    const [unknown] = paletteSessionEntries([
      sessionView('s3', { config: { updatedAt: undefined }, state: { lastActivityAt: undefined } }),
    ]);

    expect(fromState?.activityAt).toBe(Date.parse('2026-07-31T00:00:00.000Z'));
    expect(fromConfig?.activityAt).toBe(Date.parse('2026-07-30T00:00:00.000Z'));
    expect(unknown?.activityAt).toBe(0);
  });

  it('marks live work as active and a terminal session as finished', () => {
    const [running] = paletteSessionEntries([sessionView('s1', { state: { status: 'running' } })]);
    const [done] = paletteSessionEntries([sessionView('s2', { state: { status: 'completed' } })]);

    expect(running).toMatchObject({ active: true, finished: false });
    expect(done).toMatchObject({ active: false, finished: true });
  });

  it('survives a session with neither a directory nor a label', () => {
    const [entry] = paletteSessionEntries([sessionView('s1', { config: { cwd: '', label: undefined } })]);

    expect(entry).toMatchObject({ folderName: '', folder: '', label: '' });
  });

  it('carries the label through, trimmed', () => {
    const [entry] = paletteSessionEntries([sessionView('s1', { config: { label: '  shell  ' } })]);

    expect(entry?.label).toBe('shell');
  });
});

describe('paletteResultId', () => {
  it('gives each kind of row its own stable id space', () => {
    expect(paletteResultId({ kind: 'command', entry: command() })).toBe('fy-palette-option-command-browser-login');
    expect(
      paletteResultId({
        kind: 'destination',
        entry: { id: 'destination-warden', label: 'Warden', description: '', href: '/d/alpha/warden' },
      }),
    ).toBe('fy-palette-option-destination-warden');
    expect(paletteResultId({ kind: 'settings', entry: setting() })).toBe('fy-palette-option-setting-density');
    expect(paletteResultId({ kind: 'session', entry: paletteSessionEntries([sessionView('s1')])[0]! })).toBe(
      'fy-palette-option-session-s1',
    );
  });
});

describe('paletteGroupHeading', () => {
  it('names capabilities at rest and what matched once the reader types', () => {
    expect(paletteGroupHeading('destinations', false)).toBe('Go to');
    expect(paletteGroupHeading('destinations', true)).toBe('Go to');
    expect(paletteGroupHeading('commands', false)).toBe('Actions');
    expect(paletteGroupHeading('commands', true)).toBe('Commands');
    expect(paletteGroupHeading('settings', false)).toBe('Commands');
    expect(paletteGroupHeading('settings', true)).toBe('Settings');
    expect(paletteGroupHeading('sessions', false)).toBe('Recent sessions');
    expect(paletteGroupHeading('sessions', true)).toBe('Sessions');
  });
});

describe('matchesPaletteCommand', () => {
  it('offers every command to an empty query', () => {
    expect(matchesPaletteCommand(command(), '  ')).toBe(true);
  });

  it('matches the label, the description and a search term in neither', () => {
    expect(matchesPaletteCommand(command(), 'browser login window')).toBe(true);
    expect(matchesPaletteCommand(command(), 'shared Chrome')).toBe(true);
    expect(matchesPaletteCommand(command(), 'sign in')).toBe(true);
  });

  it('refuses a query the command answers to in none of the three', () => {
    expect(matchesPaletteCommand(command(), 'warden')).toBe(false);
  });
});

describe('paletteSettingHref and settingsDestinationHrefs', () => {
  it('anchors a setting inside its own daemon’s settings page', () => {
    expect(paletteSettingHref(alpha, 'density')).toBe('/d/alpha/settings#density');
    expect(paletteSettingHref(beta, 'density')).toBe('/d/beta/settings#density');
  });

  it('prefers a link row’s own href over an anchor it does not have', () => {
    expect(settingsDestinationHrefs(alpha, [setting(), setting({ href: '/d/alpha/warden#config' })])).toEqual([
      '/d/alpha/settings#density',
      '/d/alpha/warden#config',
    ]);
  });
});

describe('paletteResults', () => {
  const sessions = paletteSessionEntries([
    sessionView('s1', { config: { teammate: 'jessica', cwd: '/work/ferretry' } }),
    sessionView('s2', { config: { teammate: 'meghan', name: 'Port the palette', cwd: '/work/kteam' } }),
  ]);

  it('leads with destinations, then commands, then settings, then sessions', () => {
    const groups = paletteResults({
      query: '',
      daemon: alpha,
      sessions,
      destinations: APP_BAR_DESTINATIONS,
      commands: [command()],
      settings: [setting()],
    });

    const kinds: string[] = groups.results.map(result => result.kind);
    const expected: string[] = [
      ...Array.from({ length: groups.destinations.length }, () => 'destination'),
      'command',
      'settings',
      'session',
      'session',
    ];

    expect(kinds).toEqual(expected);
  });

  it('records where each group starts, so a vanished group cannot misplace the active row', () => {
    const groups = paletteResults({
      query: '',
      daemon: alpha,
      sessions,
      destinations: APP_BAR_DESTINATIONS,
      commands: [command()],
      settings: [setting()],
    });

    expect(groups.offsets.destinations).toBe(0);
    expect(groups.offsets.commands).toBe(groups.destinations.length);
    expect(groups.offsets.settings).toBe(groups.destinations.length + 1);
    expect(groups.offsets.sessions).toBe(groups.destinations.length + 2);
    expect(groups.results[groups.offsets.sessions]?.kind).toBe('session');
  });

  it('offers the recents at rest and the ranked matches once the reader types', () => {
    const resting = paletteResults({ query: '', daemon: alpha, sessions, ...noGroups });
    const searching = paletteResults({ query: 'jess', daemon: alpha, sessions, ...noGroups });

    expect(resting.sessions.map(entry => entry.id)).toEqual(['s1', 's2']);
    expect(searching.sessions.map(entry => entry.id)).toEqual(['s1']);
  });

  it('ranks against an injected clock so a recency bonus is reproducible', () => {
    const groups = paletteResults({ query: 'jess', daemon: alpha, sessions, ...noGroups, now: 1_700_000_000_000 });

    expect(groups.sessions.map(entry => entry.id)).toEqual(['s1']);
  });

  it('never lets one daemon’s palette offer another daemon’s hrefs', () => {
    const forAlpha = paletteResults({
      query: '',
      daemon: alpha,
      sessions,
      destinations: APP_BAR_DESTINATIONS,
      commands: [],
      settings: [],
    });
    const forBeta = paletteResults({
      query: '',
      daemon: beta,
      sessions,
      destinations: APP_BAR_DESTINATIONS,
      commands: [],
      settings: [],
    });

    for (const entry of forAlpha.destinations) expect(entry.href.startsWith('/d/alpha')).toBe(true);
    for (const entry of forBeta.destinations) expect(entry.href.startsWith('/d/beta')).toBe(true);
  });

  it('suppresses the destination a settings row is already sending people to', () => {
    const groups = paletteResults({
      query: 'settings',
      daemon: alpha,
      sessions: [],
      destinations: APP_BAR_DESTINATIONS,
      commands: [],
      settings: [
        setting({
          id: 'settings-page',
          label: 'Settings',
          description: 'Open settings',
          settingId: 'page',
          href: '/d/alpha/settings',
        }),
      ],
    });

    expect(groups.destinations.map(entry => entry.id)).not.toContain('destination-settings');
    expect(groups.settings.map(entry => entry.id)).toEqual(['settings-page']);
  });

  it('filters settings on their own label and description', () => {
    const groups = paletteResults({
      query: 'density',
      daemon: alpha,
      sessions: [],
      destinations: [],
      commands: [],
      settings: [setting(), setting({ id: 'setting-theme', label: 'Theme', description: 'Pick a palette' })],
    });

    expect(groups.settings.map(entry => entry.id)).toEqual(['setting-density']);
  });

  it('answers a query nothing matches with an empty list rather than everything', () => {
    const groups = paletteResults({
      query: 'zzzz',
      daemon: alpha,
      sessions,
      destinations: APP_BAR_DESTINATIONS,
      commands: [command()],
      settings: [setting()],
    });

    expect(groups.results).toEqual([]);
  });
});

describe('clampActiveIndex', () => {
  it('points at nothing when there is nothing to point at', () => {
    expect(clampActiveIndex(3, 0)).toBe(-1);
  });

  it('clamps an index the list has shrunk past', () => {
    expect(clampActiveIndex(9, 3)).toBe(2);
  });

  it('refuses a negative index', () => {
    expect(clampActiveIndex(-4, 3)).toBe(0);
  });

  it('leaves an index the list still holds alone', () => {
    expect(clampActiveIndex(1, 3)).toBe(1);
  });
});

describe('nextActiveIndex', () => {
  it('leaves every key alone when the list is empty', () => {
    expect(nextActiveIndex(0, 0, 'ArrowDown')).toBeNull();
  });

  it('wraps the arrows around both ends', () => {
    expect(nextActiveIndex(0, 3, 'ArrowDown')).toBe(1);
    expect(nextActiveIndex(2, 3, 'ArrowDown')).toBe(0);
    expect(nextActiveIndex(1, 3, 'ArrowUp')).toBe(0);
    expect(nextActiveIndex(0, 3, 'ArrowUp')).toBe(2);
  });

  it('jumps to either end', () => {
    expect(nextActiveIndex(1, 3, 'Home')).toBe(0);
    expect(nextActiveIndex(1, 3, 'End')).toBe(2);
  });

  it('moves from where the list actually is, not from a stale index', () => {
    expect(nextActiveIndex(99, 3, 'ArrowDown')).toBe(0);
    expect(nextActiveIndex(-5, 3, 'ArrowUp')).toBe(2);
  });

  it('leaves a key the list does not answer to alone', () => {
    expect(nextActiveIndex(0, 3, 'Tab')).toBeNull();
    expect(nextActiveIndex(0, 3, 'a')).toBeNull();
  });
});

describe('paletteCountLabel', () => {
  it('says what it found, in the reader’s number', () => {
    expect(paletteCountLabel(0)).toBe('No results');
    expect(paletteCountLabel(1)).toBe('1 result');
    expect(paletteCountLabel(4)).toBe('4 results');
  });
});

describe('paletteFocusPolicy', () => {
  it('gives a keyboard reader the query box', () => {
    expect(paletteFocusPolicy(false)).toEqual({ dialogAutoFocus: false, inputAutoFocus: true });
  });

  it('gives a touch reader the dialog, so no keyboard covers the results', () => {
    expect(paletteFocusPolicy(true)).toEqual({ dialogAutoFocus: true, inputAutoFocus: false });
  });
});
