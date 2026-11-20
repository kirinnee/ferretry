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

/** The plugins that declare a first-run step: each must contribute a panel to the slot for every step it declares. */
const contributors = generated.surfaces.filter(entry => (entry.manifest.onboarding ?? []).length > 0);

/** Steps declared ahead of their page (r10 O7b builds Claude's import pages 23-29): they may draw nowhere yet, never twice. */
const awaitingPage = new Set([
  'claude-code.import-settings',
  'claude-code.import-model-set',
  'claude-code.import-instructions',
  'claude-code.import-skills',
  'claude-code.import-mcp',
  'claude-code.conversations',
  'claude-code.import-run',
]);

describe('S14 every plugin that declares a first-run step contributes its panels', () => {
  test('S14 the contributors are the ten that declare a step (Onboarding’s own two pages included)', () => {
    expect(contributors.map(entry => entry.id).toSorted()).toEqual(
      [
        'access',
        'claude-code',
        'codex',
        'layouts',
        'lessons',
        'onboarding',
        'runtimes',
        'shells',
        'voice',
        'warden',
      ].toSorted(),
    );
  });

  for (const entry of contributors) {
    test(`S14 ${entry.id} draws every declared step in exactly one onboarding.step panel and each is silent for other steps`, () => {
      const placed = (entry.manifest.ui?.panels ?? []).filter(panel => panel.slot === 'onboarding.step');
      const built = entry.app?.build?.({ manifest: entry.manifest, client: { call: async () => ({}) } as never });
      const panels = placed.map(
        item => (built?.panels as Record<string, AppComponent<PanelProps>> | undefined)?.[item.id],
      );
      for (const panel of panels) {
        expect(panel).toBeDefined();
        // Another plugin's step, or none: nothing is drawn, and nothing is loaded or thrown (a lazy view would throw).
        expect(panel?.({ subject: 'nobody.nothing' })).toBeNull();
        expect(panel?.({})).toBeNull();
      }
      // Each declared step draws in exactly one of the plugin's panels (or, for a lazily loaded view, suspends by
      // throwing the loading promise): never in none, never in two.
      for (const step of entry.manifest.onboarding ?? []) {
        const drew = panels.filter(panel => {
          let result: unknown;
          try {
            result = panel?.({ subject: `${entry.id}.${step.id}` });
          } catch (thrown) {
            result = thrown;
          }
          return result !== null && result !== undefined;
        });
        if (awaitingPage.has(`${entry.id}.${step.id}`)) expect(drew.length).toBeLessThanOrEqual(1);
        else expect(drew).toHaveLength(1);
      }
    });
  }
});
