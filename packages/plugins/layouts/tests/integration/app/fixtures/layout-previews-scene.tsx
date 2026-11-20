/**
 * The browser entry for the layout page over FAKE data (no daemon): the REAL Layout page, read from a scripted client,
 * under the settings header the shell draws (machine, state, and the scope chip ONLY when the tab's real declaration asks
 * for one), with a fake device so "Same on all my devices / Just this device" is drawn, and fake nav places that carry icons.
 *
 *   ?theme=<family>-<mode>   ?motion=reduced  sets Settings › Motion to Reduced   ?scope=device  opens on Just this device
 */
import type { DeviceLayout, NavCatalogItem } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import { DEFAULT_LAYOUT } from '../../../../contract/index.ts';
import manifest from '../../../../manifest.ts';
import { LayoutSettings } from '../../../../app/features/layout/layout-settings.tsx';
import { scriptedLayouts } from '../../../support/layouts-app.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
if (params.get('motion') === 'reduced') document.documentElement.dataset.motion = 'reduced';

const script = scriptedLayouts();

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
