/**
 * The browser entry for the layout page over FAKE data (no daemon): the REAL Layout page, read from a scripted client,
 * with a fake device so "Same on all my devices / Just this device" is drawn, and fake nav places that carry icons.
 *
 *   ?theme=<family>-<mode>   ?motion=reduced  sets Settings › Motion to Reduced   ?scope=device  opens on Just this device
 */
import type { DeviceLayout, NavCatalogItem } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import { DEFAULT_LAYOUT } from '../../../../contract/index.ts';
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

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="p-4" data-scene-ready="">
      <LayoutSettings client={script.client} device={device} navCatalog={catalog} />
    </div>,
  );
