import { describe, expect, it } from 'bun:test';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import {
  type AppBarDestinationLike,
  destinationExists,
  destinationPaletteEntries,
  SHELL_DESTINATIONS,
} from '../../src/shell/palette-destinations.ts';
import { APP_BAR_DESTINATIONS } from '../../src/shell/app-bar.tsx';
import { daemonSettingsPath } from '../../src/lib/pages/routes.ts';

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
      'destination-projects',
      'destination-accounts',
      'destination-analytics',
      'destination-warden',
      'destination-learning',
      'destination-settings',
      'destination-new-session',
    ]);
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

  it('matches on the label, on the description, and on a keyword in neither', () => {
    const byLabel = destinationPaletteEntries('analytics', APP_BAR_DESTINATIONS, alpha);
    const byDescription = destinationPaletteEntries('working directory', APP_BAR_DESTINATIONS, alpha);
    const byKeyword = destinationPaletteEntries('spend', APP_BAR_DESTINATIONS, alpha);

    expect(byLabel.map(entry => entry.id)).toEqual(['destination-analytics']);
    expect(byDescription.map(entry => entry.id)).toEqual(['destination-new-session']);
    expect(byKeyword.map(entry => entry.id)).toEqual(['destination-analytics']);
  });

  /**
   * TWO DESTINATIONS GENUINELY ANSWER TO "accounts", and the order is the whole answer.
   *
   * Warden has always claimed the keyword, because its verdicts are about accounts. The Accounts page
   * IS the accounts, so it must come first — and this module ranks nothing: it filters in navigation
   * order, so "first" is decided entirely by where the entry sits in `APP_BAR_DESTINATIONS`. Reordering
   * that array would silently send somebody typing the name of a page to a different page, which is why
   * this is pinned here rather than left to the bar's own ordering test.
   */
  it('answers “accounts” with the Accounts page first, ahead of Warden’s claim on the word', () => {
    const entries = destinationPaletteEntries('accounts', APP_BAR_DESTINATIONS, alpha);

    expect(entries.map(entry => entry.id)).toEqual(['destination-accounts', 'destination-warden']);
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
  it('carries the two routes the top bar deliberately does not', () => {
    expect(SHELL_DESTINATIONS.map(destination => destination.id)).toEqual(['sessions', 'new-session']);
    expect(SHELL_DESTINATIONS.map(destination => destination.path(alpha))).toEqual(['/d/alpha', '/d/alpha/new']);
  });
});
