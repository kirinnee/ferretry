/**
 * The browser entry for the layout page over FAKE data (no daemon): the REAL Layout page, read from a scripted client,
 * under the settings header the shell draws (machine, state, and the scope chip ONLY when the tab's real declaration asks
 * for one), with a fake device so "Same on all my devices / Just this device" is drawn, and fake nav places that carry icons.
 *
 *   ?theme=<family>-<mode>   ?motion=reduced  sets Settings › Motion to Reduced   ?scope=device  opens on Just this device   ?painted=1  the theme in use sets its own colours
 */
import type { DeviceLayout, NavCatalogItem } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import { DEFAULT_LAYOUT, DEFAULT_THEME } from '../../../../contract/index.ts';
import manifest from '../../../../manifest.ts';
import { LayoutSettings } from '../../../../app/features/layout/layout-settings.tsx';
import { listOf, readOf, scriptedLayouts } from '../../../support/layouts-app.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
if (params.get('motion') === 'reduced') document.documentElement.dataset.motion = 'reduced';

// Eight layouts (the SelectBox opens a search field above seven), so the chooser's type-to-filter is exercised for real.
const LAYOUT_IDS = ['default', 'compact', 'focus', 'wide', 'classic', 'sidebar-left', 'sidebar-right', 'minimal'];
// ?painted=1: the theme in use sets its own colours (light and dark), so the Theme preview draws a pane for each.
const PAINTED = {
  ...DEFAULT_THEME,
  id: 'dusk',
  label: 'Dusk',
  light: {
    bg: '#f4efe6',
    fg: '#2b2a33',
    'fg-soft': '#6b6878',
    accent: '#7b4bb7',
    'accent-soft': '#e6dcf3',
    'accent-border': '#b69be0',
    border: '#d8d0c2',
  },
  dark: {
    bg: '#17151f',
    fg: '#ece9f5',
    'fg-soft': '#a29fb5',
    accent: '#a98be0',
    'accent-soft': '#2c2540',
    'accent-border': '#5b4a8a',
    border: '#322d44',
  },
};
const painted = params.get('painted') === '1';
const script = scriptedLayouts(
  readOf(
    painted ? { theme: PAINTED } : {},
    listOf({
      layouts: LAYOUT_IDS.map(id => ({ id, origin: 'built-in' as const })),
      ...(painted
        ? {
            themes: [
              { id: 'default', origin: 'built-in' as const },
              { id: 'dusk', origin: 'saved' as const },
            ],
            current: { layout: 'default', theme: 'dusk' },
          }
        : {}),
    }),
  ),
);
// What the fake daemon was asked to do, for a test to read (the same writes the verbs make: `use compact`, `theme studio`).
(window as unknown as { __fyCalls: readonly string[] }).__fyCalls = script.calls;

const PLACES: readonly (readonly [string, string, string])[] = [
  ['ferrets', 'Ferrets', 'users'],
  ['agenda', 'Agenda', 'inbox'],
  ['board', 'Board', 'columns'],
  ['projects', 'Projects', 'folder'],
  ['insights', 'Insights', 'chart'],
  ['settings', 'Settings', 'settings'],
];
const catalog = PLACES.map(([id, label, icon], order) => ({
  id,
  label,
  icon,
  order,
  entry: { kind: 'shell', item: 'settings' },
})) as unknown as readonly NavCatalogItem[];

const device: DeviceLayout = {
  overrides: params.get('scope') === 'device' ? { density: 'compact' } : {},
  base: DEFAULT_LAYOUT,
  inForce: DEFAULT_LAYOUT,
  set: () => undefined,
  reset: () => undefined,
};

// The Layout tab as the plugin really declares it: the header below is the shell's own markup and classes.
const tab = manifest.ui?.settings?.find(declared => declared.id === 'layout');
const chip = tab === undefined || tab.scopeChip === false ? null : (tab.scope ?? 'machine');

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="fy-page p-4" data-scene-ready="">
      <header className="fy-settings-head" data-scene-header="">
        <h1>Settings</h1>
        <p className="fy-settings-machine">
          <span className="fy-settings-machine__name">workshop-host</span>
          <span className="fy-settings-machine__state" data-online="true">
            Online
          </span>
          {chip === null ? null : (
            <span className="fy-settings-machine__scope" data-scope={chip}>
              {chip === 'device' ? 'Only this browser' : 'This machine · every device'}
            </span>
          )}
        </p>
      </header>
      <LayoutSettings client={script.client} device={device} navCatalog={catalog} />
    </div>,
  );
