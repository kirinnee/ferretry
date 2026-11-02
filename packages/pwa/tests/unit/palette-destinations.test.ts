import { describe, expect, it } from 'bun:test';
import { QrCode } from 'lucide-react';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import { daemonSettingsPath } from '../../src/lib/pages/routes.ts';
import { APP_BAR_DESTINATIONS } from '../../src/shell/app-bar.tsx';
import {
  type AppBarDestinationLike,
  BOARD_FOR_FERRET_SEARCH_TERMS,
  boardForFerretPaletteCommand,
  destinationExists,
  destinationPaletteEntries,
  PAIR_PHONE_SEARCH_TERMS,
  pairPhonePaletteCommand,
  SHELL_DESTINATIONS,
} from '../../src/shell/palette-destinations.ts';
import { matchesPaletteCommand } from '../../src/shell/palette-model.ts';

const alpha = daemonId('alpha');
const beta = daemonId('beta');

describe('destinationExists', () => {
  it('accepts a path the router resolves back to itself', () => {
    expect(destinationExists('/d/alpha')).toBe(true);
    expect(destinationExists('/d/alpha/settings')).toBe(true);
  });

  it('ignores a hash or a query when guarding the path', () => {
    expect(destinationExists('/d/alpha/settings#density')).toBe(true);
    expect(destinationExists('/d/alpha/settings?tab=theme')).toBe(true);
  });

  it('refuses anything that is not an absolute path', () => {
    expect(destinationExists('settings')).toBe(false);
    expect(destinationExists('')).toBe(false);
  });

  it('refuses a compatibility redirect rather than advertising it as a page', () => {
    expect(destinationExists('/d/alpha/tasks')).toBe(false);
  });

  it('refuses a path the router quietly resolves to somewhere else', () => {
    expect(destinationExists('/d/alpha/not-a-page')).toBe(false);
  });
});

describe('destinationPaletteEntries', () => {
  it('offers every destination for an empty query, dashboard first and new session last', () => {
    const entries = destinationPaletteEntries('', APP_BAR_DESTINATIONS, alpha);

    expect(entries.map(entry => entry.id)).toEqual([
      'destination-sessions',
      'destination-attention',
      'destination-board',
      'destination-projects',
      'destination-sharing',
      'destination-sharing-shared',
      'destination-sharing-skills',
      'destination-analytics',
      'destination-warden',
      'destination-learning',
      'destination-settings',
      'destination-new-session',
    ]);
  });

  it('offers the two Sharing doors with the tab in their address', () => {
    const entries = destinationPaletteEntries('', APP_BAR_DESTINATIONS, alpha);
    const hrefOf = (id: string) => entries.find(entry => entry.id === id)?.href;

    expect(hrefOf('destination-sharing')).toBe('/d/alpha/sharing');
    expect(hrefOf('destination-sharing-shared')).toBe('/d/alpha/sharing/shared');
    expect(hrefOf('destination-sharing-skills')).toBe('/d/alpha/sharing/skills');
    expect(entries.find(entry => entry.id === 'destination-sharing-shared')?.label).toBe('Shared with me');
    expect(entries.find(entry => entry.id === 'destination-sharing-skills')?.label).toBe('Share a skill…');
    expect(destinationPaletteEntries('share a skill', APP_BAR_DESTINATIONS, alpha).map(entry => entry.id)).toContain(
      'destination-sharing-skills',
    );
  });

  it('leaves the Sharing doors out when the destinations carry no Sharing place', () => {
    const without = APP_BAR_DESTINATIONS.filter(destination => destination.id !== 'sharing');
    expect(destinationPaletteEntries('', without, alpha).map(entry => entry.id)).not.toContain(
      'destination-sharing-shared',
    );
  });

  it('builds every href from the daemon the palette is on', () => {
    const forAlpha = destinationPaletteEntries('', APP_BAR_DESTINATIONS, alpha);
    const forBeta = destinationPaletteEntries('', APP_BAR_DESTINATIONS, beta);

    for (const entry of forAlpha) expect(entry.href.startsWith('/d/alpha')).toBe(true);
    for (const entry of forBeta) expect(entry.href.startsWith('/d/beta')).toBe(true);
    expect(forAlpha.map(entry => entry.href)).not.toEqual(forBeta.map(entry => entry.href));
  });

  it('reuses the top bar’s own tooltip copy as the description', () => {
    const settings = destinationPaletteEntries('settings', APP_BAR_DESTINATIONS, alpha).find(
      entry => entry.id === 'destination-settings',
    );
    const barEntry = APP_BAR_DESTINATIONS.find(destination => destination.id === 'settings');

    expect(settings?.description).toBe(barEntry?.title ?? '');
  });

  it('describes a destination without the old tool’s role word', () => {
    // "teammate" stays a search keyword for people who still reach for it; it is never shown.
    for (const destination of SHELL_DESTINATIONS) expect(destination.title.toLowerCase()).not.toContain('teammate');
    expect(SHELL_DESTINATIONS.find(destination => destination.id === 'new-session')?.title).toBe(
      'Start an agent in a working directory',
    );
  });

  it('matches on the label, on the description, and on a keyword in neither', () => {
    const byLabel = destinationPaletteEntries('analytics', APP_BAR_DESTINATIONS, alpha);
    const byDescription = destinationPaletteEntries('working directory', APP_BAR_DESTINATIONS, alpha);
    const byKeyword = destinationPaletteEntries('spend', APP_BAR_DESTINATIONS, alpha);

    expect(byLabel.map(entry => entry.id)).toEqual(['destination-analytics']);
    expect(byDescription.map(entry => entry.id)).toEqual(['destination-new-session']);
    expect(byKeyword.map(entry => entry.id)).toEqual(['destination-analytics']);
  });

  /**
   * NO DESTINATION ANSWERS TO "accounts": Accounts is a settings panel (the settings links find it), and Warden is
   * about the AI login a ferret works under, so it answers to "ai login" and no longer to "accounts". If a future
   * change re-adds an accounts row to the bar, or Warden claims the word again, this fails and says so.
   */
  it('answers “accounts” with no destination, and “ai login” with Warden', () => {
    expect(destinationPaletteEntries('accounts', APP_BAR_DESTINATIONS, alpha)).toEqual([]);
    expect(destinationPaletteEntries('ai login', APP_BAR_DESTINATIONS, alpha).map(entry => entry.id)).toEqual([
      'destination-warden',
    ]);
  });

  it('returns nothing when the query matches no destination', () => {
    expect(destinationPaletteEntries('zzzz', APP_BAR_DESTINATIONS, alpha)).toEqual([]);
  });

  it('suppresses an href another group is already offering', () => {
    const entries = destinationPaletteEntries('settings', APP_BAR_DESTINATIONS, alpha, {
      taken: [daemonSettingsPath(alpha)],
    });

    expect(entries.map(entry => entry.id)).toEqual([]);
  });

  it('suppresses only the daemon whose href was taken', () => {
    const entries = destinationPaletteEntries('settings', APP_BAR_DESTINATIONS, beta, {
      taken: [daemonSettingsPath(alpha)],
    });

    expect(entries.map(entry => entry.id)).toEqual(['destination-settings']);
  });

  it('drops a destination whose path the router would not resolve to itself', () => {
    const broken: readonly AppBarDestinationLike[] = [
      { id: 'broken', label: 'Broken', title: 'Goes nowhere the router knows', path: () => '/d/alpha/not-a-page' },
    ];

    expect(destinationPaletteEntries('broken', broken, alpha)).toEqual([]);
  });

  it('searches a destination with no keyword list on its own text alone', () => {
    const extra: readonly AppBarDestinationLike[] = [
      {
        id: 'sessions-extra',
        label: 'Extra',
        title: 'A destination nobody wrote keywords for',
        path: daemonSettingsPath,
      },
    ];

    expect(destinationPaletteEntries('nobody wrote', extra, alpha).map(entry => entry.id)).toEqual([
      'destination-sessions-extra',
    ]);
    expect(destinationPaletteEntries('spend', extra, alpha)).toEqual([]);
  });
});

describe('SHELL_DESTINATIONS', () => {
  it('carries the routes the top bar deliberately does not', () => {
    expect(SHELL_DESTINATIONS.map(destination => destination.id)).toEqual(['sessions', 'new-session', 'queue']);
    expect(SHELL_DESTINATIONS.map(destination => destination.path(alpha))).toEqual([
      '/d/alpha/sessions',
      '/d/alpha/new',
      '/d/alpha/queue',
    ]);
  });
});

describe('pairPhonePaletteCommand', () => {
  it('is an act, not a page, found by the words a reader reaches for', () => {
    let ran = 0;
    const command = pairPhonePaletteCommand('Pair a phone with alpha', 'Show a QR code', QrCode, () => (ran += 1));
    expect(command).toMatchObject({
      id: 'pair-phone',
      label: 'Pair a phone with alpha',
      description: 'Show a QR code',
      searchTerms: PAIR_PHONE_SEARCH_TERMS,
      Icon: QrCode,
    });
    for (const word of ['pair', 'phone', 'qr', 'scan', 'device'])
      expect(matchesPaletteCommand(command, word)).toBe(true);
    command.run();
    expect(ran).toBe(1);
  });
});

describe('boardForFerretPaletteCommand', () => {
  it('names the ferret, is found by "board", and runs what the host gave it', () => {
    let ran = 0;
    const command = boardForFerretPaletteCommand('Ferretry lead', QrCode, () => (ran += 1));
    expect(command).toMatchObject({
      id: 'board-for-ferret',
      label: 'Board for Ferretry lead',
      searchTerms: BOARD_FOR_FERRET_SEARCH_TERMS,
      Icon: QrCode,
    });
    for (const word of ['board', 'cards', 'kanban']) expect(matchesPaletteCommand(command, word)).toBe(true);
    command.run();
    expect(ran).toBe(1);
  });
});
