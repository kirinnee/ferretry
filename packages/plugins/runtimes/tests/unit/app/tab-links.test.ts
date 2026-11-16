import { describe, expect, test } from 'bun:test';
import { harnessHref, tabHref } from '../../../app/features/fleet/shell/machine-route.ts';
import runtimes from '../../../manifest.ts';

/**
 * A link to another tab is a Settings path the app shell routes (`/d/<daemon>/settings/<plugin>/<tab>`). The shell
 * finds the active tab by plugin AND tab id, so a link only works if a manifest declares exactly that pair. This
 * proves Runtimes' own links name its declared tabs; that Logins' tab exists is proved against the compiled manifests
 * in the app's `plugin-calls` suite. A renamed tab or a mistyped id fails there, not in a browser.
 */

const runtimesTabs = new Set((runtimes.ui?.settings ?? []).map(tab => tab.id as string));

/** The (plugin, tab) a Settings path names, or `null` for anything else. */
const settingsPair = (href: string): readonly [string, string | undefined] | null => {
  const match = /^\/d\/[^/]+\/settings\/([^/#]+)(?:\/([^/#]+))?(?:#.*)?$/u.exec(href);
  return match?.[1] === undefined ? null : [decodeURIComponent(match[1]), match[2] && decodeURIComponent(match[2])];
};

describe('the links from the Runtimes screens to other tabs', () => {
  for (const tab of ['runtimes', 'profiles', 'model-sets'] as const)
    test(`the ${tab} tab link names one of Runtimes’ own declared settings tabs`, () => {
      const [plugin, id] = settingsPair(tabHref('d1', 'studio-mac', tab, 'item')) ?? [];
      expect(plugin).toBe('runtimes');
      expect(runtimesTabs.has(id as string)).toBe(true);
    });

  test('Runtimes’ own three tabs are addressed by their own ids, and Sign-ins by Logins’', () => {
    expect(tabHref('d1', 'm', 'runtimes')).toStartWith('/d/d1/settings/runtimes/runtimes#');
    expect(tabHref('d1', 'm', 'profiles')).toStartWith('/d/d1/settings/runtimes/profiles#');
    expect(tabHref('d1', 'm', 'model-sets')).toStartWith('/d/d1/settings/runtimes/model-sets#');
    expect(tabHref('d1', 'm', 'sign-ins')).toStartWith('/d/d1/settings/logins/logins#');
  });

  test('an Install link names the Settings page of the harness plugin, at its first tab', () => {
    // The harness plugins (`claude-code`, `codex`) are not Runtimes' needs, so their tabs are not checked here.
    for (const harness of ['claude-code', 'codex'] as const)
      expect(settingsPair(harnessHref('d1', harness))).toEqual([harness, undefined]);
  });
});
