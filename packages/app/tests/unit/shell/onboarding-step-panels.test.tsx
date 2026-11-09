import { describe, expect, test } from 'bun:test';
import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import { forSubject } from '../../../src/shell/for-subject.ts';
import { generated } from '../../../src/generated/surfaces.ts';

/**
 * S14: the `onboarding.step` slot mounts every contributed panel once per declared step, so a contributor must draw for
 * ITS step only — and a lazily loaded view must not even start loading for another step's subject.
 */

describe('S14 forSubject', () => {
  test('S14 draws its view for its own subject and nothing for any other', () => {
    let drawn = 0;
    const panel = forSubject('shells.nix', (() => {
      drawn += 1;
      return 'body';
    }) as unknown as AppComponent<PanelProps>);
    expect(panel({ subject: 'shells.nix' })).toBe('body');
    expect(panel({ subject: 'codex.harness' })).toBeNull();
    expect(panel({})).toBeNull();
    expect(drawn).toBe(1);
  });
});

/** The plugins that declare a first-run step: each must contribute exactly one panel to the slot, for its own steps. */
const contributors = generated.surfaces.filter(entry => (entry.manifest.onboarding ?? []).length > 0);

describe('S14 every plugin that declares a first-run step contributes its panel', () => {
  test('S14 the contributors are the five that declare a per-machine step', () => {
    expect(contributors.map(entry => entry.id).toSorted()).toEqual(
      ['claude-code', 'codex', 'logins', 'runtimes', 'shells'].toSorted(),
    );
  });

  for (const entry of contributors) {
    test(`S14 ${entry.id} offers one panel in onboarding.step and it is silent for other steps`, () => {
      const placed = (entry.manifest.ui?.panels ?? []).filter(panel => panel.slot === 'onboarding.step');
      expect(placed).toHaveLength(1);
      const built = entry.app?.build?.({ manifest: entry.manifest, client: { call: async () => ({}) } as never });
      const panel = (built?.panels as Record<string, AppComponent<PanelProps>> | undefined)?.[placed[0]?.id ?? ''];
      expect(panel).toBeDefined();
      // Another plugin's step, or none: nothing is drawn, and nothing is loaded or thrown (a lazy view would throw).
      expect(panel?.({ subject: 'nobody.nothing' })).toBeNull();
      expect(panel?.({})).toBeNull();
      // Its own step: it draws (or, for a lazily loaded view, suspends by throwing the loading promise).
      for (const step of entry.manifest.onboarding ?? []) {
        let result: unknown;
        try {
          result = panel?.({ subject: `${entry.id}.${step.id}` });
        } catch (thrown) {
          result = thrown;
        }
        expect(result).not.toBeNull();
        expect(result).not.toBeUndefined();
      }
    });
  }
});
