/**
 * Registers the REAL Layout settings page (over a scripted client and a fake device) as the body of the app's Settings shell
 * scene, so it is drawn in the real App with its real nav: the nav's block headings and the page's own switch are read together,
 * which a standalone mount of the page never does. The test's generated entry registers it, then imports the shell scene.
 *
 *   /d/ws/settings/layouts/layout?theme=<family>-<mode>
 */
import type { DeviceLayout } from '@ferretry/app';
import type { ReactNode } from 'react';
import { DEFAULT_LAYOUT } from '../../../../contract/index.ts';
import { LayoutSettings } from '../../../../app/features/layout/layout-settings.tsx';
import { scriptedLayouts } from '../../../support/layouts-app.ts';

const device: DeviceLayout = {
  overrides: {},
  base: DEFAULT_LAYOUT,
  inForce: DEFAULT_LAYOUT,
  set: () => undefined,
  reset: () => undefined,
};

/** Puts the Layout page on the scene's body registry; call it BEFORE the shell scene is imported (it reads the registry once). */
export const registerLayoutScopeBody = (): void => {
  const scope = globalThis as { __FY_SCENE_SETTINGS_BODIES__?: Map<string, () => ReactNode> };
  const registry = scope.__FY_SCENE_SETTINGS_BODIES__ ?? new Map<string, () => ReactNode>();
  scope.__FY_SCENE_SETTINGS_BODIES__ = registry;
  const script = scriptedLayouts();
  registry.set('layouts/layout', () => <LayoutSettings client={script.client} device={device} />);
};
