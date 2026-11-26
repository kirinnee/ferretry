/**
 * The browser entry for the map style: the REAL Settings row and the REAL map block, over fake data (no daemon, no
 * network). The key is a FAKE one; the Google frame is stubbed by the driver and the OpenStreetMap tiles answered
 * locally, so no capture ever carries a real key or makes a real request.
 *
 *   ?style=<style>&mode=light|dark   ?view=setting|setting-key|osm|google|fallback|needs-key|blocked
 *
 * `blocked` is the Settings row beside a map with the driver blocking this page's storage: the person picks Google and
 * types a (fake) key, and the page must stay on OpenStreetMap.
 */
import { SettingGroup } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import '../../../../app/render/fy-render.css';
import { FyRenderMap } from '../../../../app/render/fy-render-map.tsx';
import { MapStyleRow, changeMapChoice } from '../../../../app/render/fy-render-map-style-row.tsx';
import type { MapChoiceStorage } from '../../../../app/render/fy-render-map-style.ts';

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

/** A storage that keeps what it is given: a key this browser would not keep is not held, so a scene sets one up in here. */
const items = new Map<string, string>();
const memory: MapChoiceStorage = {
  getItem: name => items.get(name) ?? null,
  removeItem: name => void items.delete(name),
  setItem: (name, value) => void items.set(name, value),
};

if (view === 'setting-key' || view === 'google' || view === 'fallback')
  changeMapChoice({ key: FAKE_KEY, style: 'google' }, memory);
if (view === 'needs-key') changeMapChoice({ key: null, style: 'google' }, memory);

const noop = (): void => {};

/** The map block, drawn in the page beside the settings (the settings page scrolls inside itself, so the map is not in it). */
function Block({ payload }: { readonly payload: string }) {
  return (
    <div className="fy-render p-3" data-fy-render-fullscreen="false">
      <FyRenderMap
        alt="Big Ben"
        environment={{ credentialless: true, isolated: false }}
        fullscreen={false}
        mode={mode}
        onListing={noop}
        payload={payload}
      />
    </div>
  );
}

function Scene() {
  if (view.startsWith('setting') || view === 'blocked')
    return (
      <SettingGroup label="Conversation">
        <MapStyleRow />
      </SettingGroup>
    );
  return <Block payload={view === 'fallback' ? ROUTE : PIN} />;
}

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <>
      <section className="fy-page fy-settings" data-settings-open="panel">
        <div className="fy-settings-body">
          <div aria-hidden="true" className="fy-settings-nav" />
          <section className="fy-settings-page" aria-label="Conversation">
            <Scene />
          </section>
        </div>
      </section>
      {view === 'blocked' ? <Block payload={PIN} /> : null}
    </>,
  );
