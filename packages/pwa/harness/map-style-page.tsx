/**
 * The page `map-style-screenshot.tsx` bundles: Settings › Appearance with the Map style row, and a `map` block in
 * each style. Fake key, fake data; the screenshot pass answers every request locally.
 */
import { createRoot } from 'react-dom/client';
import { Markdown } from '../src/components/markdown.tsx';
import { AppearanceGroups } from '../src/features/settings/appearance-groups.tsx';
import type { ThemeState } from '../src/hooks/use-theme.ts';
import { DaemonControlsStore } from '../src/lib/controls.ts';
import { MapStyleProvider } from '../src/lib/map-style-context.tsx';
import { THEME_FAMILIES } from '../src/lib/theme-preferences.ts';

const FAKE_KEY = 'AIzaFAKEfakeFAKEfakeFAKEfakeFAKEfake00';

const memory = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
};
const controls = new DaemonControlsStore(memory());
controls.setDeviceControls({ mapStyle: 'google' });

const theme = {
  attr: 'x',
  families: THEME_FAMILIES,
  family: THEME_FAMILIES[0]?.id ?? 'studio',
  mode: 'system',
  resolved: document.documentElement.dataset.theme?.endsWith('dark') ? 'dark' : 'light',
  setFamily() {},
  setMode() {},
  setTextScale() {},
  textScale: 'default',
} as ThemeState;

const block = (lines: readonly string[]): string => `\`\`\`fy-render\n${lines.join('\n')}\n\`\`\``;
const ONE = block([
  'type: map',
  'alt: Big Ben, London',
  '---',
  'center: [51.5007, -0.1246]',
  'zoom: 15',
  'markers:',
  '  - {at: [51.5007, -0.1246], label: Big Ben, popup: Clock tower}',
]);
const MANY = block([
  'type: map',
  'alt: Two London sights',
  '---',
  'markers:',
  '  - {at: [51.5007, -0.1246], label: Big Ben}',
  '  - {at: [51.5055, -0.0754], label: Tower Bridge}',
]);

// Each scene is cropped to its own box for the screenshot, so give it the inset a message column has;
// without it a caption's text touches the crop edge.
const SCENE_INSET = { padding: '0 12px' } as const;

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <main style={{ display: 'flex', flexDirection: 'column', gap: 24, margin: '0 auto', maxWidth: 760, padding: 16 }}>
      <div data-scene="settings" style={SCENE_INSET}>
        <ul className="m-0 list-none p-0">
          <AppearanceGroups
            computerAvailable={false}
            controls={controls}
            densityState={{ density: 'full', explicit: null, setDensity() {} }}
            device={controls.snapshot().device}
            googleMapsAvailable
            theme={theme}
          />
        </ul>
      </div>
      <div data-scene="osm" style={SCENE_INSET}>
        <MapStyleProvider embedKey={FAKE_KEY} style="osm">
          <Markdown enableFyRender text={ONE} />
        </MapStyleProvider>
      </div>
      <div data-scene="google" style={SCENE_INSET}>
        <MapStyleProvider embedKey={FAKE_KEY} style="google">
          <Markdown enableFyRender text={ONE} />
        </MapStyleProvider>
      </div>
      <div data-scene="fallback" style={SCENE_INSET}>
        <MapStyleProvider embedKey={FAKE_KEY} style="google">
          <Markdown enableFyRender text={MANY} />
        </MapStyleProvider>
      </div>
    </main>,
  );
}
