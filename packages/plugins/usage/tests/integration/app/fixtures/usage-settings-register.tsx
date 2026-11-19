/**
 * Registers the three Usage settings tabs' REAL pages (over fake data) as the bodies of the Settings shell scene, so the pages are
 * drawn in the real App with its default drawer and Settings nav and measured against the panel the shell leaves them (212px at a
 * 768px window), which a standalone mount never reproduces. The test's generated entry registers them, then imports the shell scene
 * (`packages/app/tests/integration/fixtures/settings-shell-scene.tsx`).
 *
 *   /d/ws/settings/usage/<budgets|model-pricing|performance>?theme=<family>-<mode>&tab=<…>&act=<…>
 */
import type { ReactNode } from 'react';
import { page } from './usage-settings-page.tsx';

/** Puts the three pages on the scene's registry; call it BEFORE the shell scene is imported (it reads the registry once). */
export const registerUsageSettingsBodies = (): void => {
  const scope = globalThis as { __FY_SCENE_SETTINGS_BODIES__?: Map<string, () => ReactNode> };
  const registry = scope.__FY_SCENE_SETTINGS_BODIES__ ?? new Map<string, () => ReactNode>();
  scope.__FY_SCENE_SETTINGS_BODIES__ = registry;
  for (const tab of ['budgets', 'model-pricing', 'performance']) registry.set(`usage/${tab}`, () => page);
};
