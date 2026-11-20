/**
 * Registers the REAL Look group (`DeviceAppearance`, Style / Palette / Colour mode / Specimen / Text size / Motion) as the body of
 * the Settings shell scene's `usage/budgets` tab, so it is drawn in the real App with its default drawer and Settings list and
 * measured against the panel the shell leaves a tab (212px at a 768px window), which the standalone scene never reproduces.
 * The test's generated entry calls this BEFORE importing `settings-shell-scene.tsx` (it reads the registry once).
 *
 *   /d/ws/settings/usage/budgets?theme=<family>-<mode>
 */
import type { ReactNode } from 'react';
import { DeviceAppearance } from '../../../src/shell/device-appearance.tsx';

export const registerAppearanceBody = (): void => {
  const scope = globalThis as { __FY_SCENE_SETTINGS_BODIES__?: Map<string, () => ReactNode> };
  const registry = scope.__FY_SCENE_SETTINGS_BODIES__ ?? new Map<string, () => ReactNode>();
  scope.__FY_SCENE_SETTINGS_BODIES__ = registry;
  registry.set('usage/budgets', () => <DeviceAppearance />);
};
