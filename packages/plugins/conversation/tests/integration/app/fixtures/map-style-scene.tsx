/**
 * The browser entry for the map style: the REAL Settings row and the REAL map block, over fake data (no daemon, no
 * network). The key is a FAKE one; the Google frame is stubbed by the driver and the OpenStreetMap tiles answered
 * locally, so no capture ever carries a real key or makes a real request.
 *
 *   ?style=<style>&mode=light|dark   ?view=setting|setting-key|osm|google|fallback|needs-key
 */
import { SettingGroup } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import '../../../../app/render/fy-render.css';
import { FyRenderMap } from '../../../../app/render/fy-render-map.tsx';
import { MapStyleRow, changeMapChoice } from '../../../../app/render/fy-render-map-style-row.tsx';

const params = new URLSearchParams(window.location.search);
const html = document.documentElement;
const mode = params.get('mode') === 'dark' ? 'dark' : 'light';
html.dataset.style = params.get('style') ?? 'studio';
html.dataset.palette = 'studio';
html.dataset.mode = mode;
html.dataset.theme = `studio-${mode}`;
const view = params.get('view') ?? 'setting';

/** A FAKE key of the right shape. */
const FAKE_KEY = 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0';
const PIN =
  'center: [51.5007, -0.1246]\nzoom: 14\nmarkers:\n  - {at: [51.5007, -0.1246], label: Big Ben, popup: Clock tower}';
const ROUTE =
  'markers:\n  - {at: [51.5007, -0.1246], label: Big Ben}\n  - {at: [51.5033, -0.1195], label: London Eye}\nlines:\n  - {points: [[51.5007, -0.1246], [51.5033, -0.1195]], label: Walk}';

if (view === 'setting-key' || view === 'google' || view === 'fallback')
  changeMapChoice({ key: FAKE_KEY, style: 'google' }, null);
if (view === 'needs-key') changeMapChoice({ key: null, style: 'google' }, null);

const noop = (): void => {};

function Scene() {
  if (view.startsWith('setting'))
    return (
      <SettingGroup label="Conversation">
        <MapStyleRow />
      </SettingGroup>
    );
  return (
    <div className="fy-render p-3" data-fy-render-fullscreen="false">
      <FyRenderMap
        alt="Big Ben"
        environment={{ credentialless: true, isolated: false }}
        fullscreen={false}
        mode={mode}
        onListing={noop}
        payload={view === 'fallback' ? ROUTE : PIN}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <section className="fy-page fy-settings" data-settings-open="panel">
      <div className="fy-settings-body">
        <div aria-hidden="true" className="fy-settings-nav" />
        <section className="fy-settings-page" aria-label="Conversation">
          <Scene />
        </section>
      </div>
    </section>,
  );
