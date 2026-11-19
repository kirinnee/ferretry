/**
 * The browser entry for chrome-less screens over FAKE data (no daemon, no pairing code): the REAL app shell with a fake
 * plugin whose daemon-less `flow` screen says `chrome: 'none'` and whose `plain` screen does not.
 *
 *   ?theme=<family>-<mode>
 *   ?view=flow    /flow, drawn alone (no drawer, bars, side column or command bar)
 *   ?view=plain   /plain, the same page with the shell's chrome (the "before")
 */
import { createRoot } from 'react-dom/client';
import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import { type DaemonlessPorts, provideToShell, registeredDaemonless } from '../../../src/connect/provides.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { CORE, FakeTransport, json } from '../../unit/client/fixtures.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const root = document.getElementById('root');

const manifest = {
  id: 'setup',
  title: 'Setup',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  ui: {
    screens: [
      { id: 'flow', path: '/flow', daemonless: true, chrome: 'none' },
      { id: 'plain', path: '/plain', daemonless: true },
    ],
  },
} as unknown as Manifest;

/** A stand-in page: a title, a line, two cards and a footer, so the shots show how the page sits in the frame. */
function FakePage({ title }: { readonly title: string }) {
  return (
    <section style={{ maxWidth: 880, margin: '0 auto', padding: '48px 16px', display: 'grid', gap: 16 }}>
      <h1 style={{ margin: 0 }}>{title}</h1>
      <p style={{ margin: 0 }}>Pick how this looks. Nothing here is real data.</p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {['Rail', 'Wide'].map(name => (
          <div key={name} style={{ width: 200, padding: 16, border: '1px solid currentColor', borderRadius: 8 }}>
            {name}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="kt-btn">
          Back
        </button>
        <button type="button" className="kt-btn" data-variant="primary">
          Next
        </button>
      </div>
    </section>
  );
}

const half = provideToShell(implementApp(manifest, { build: () => ({}) }), {
  daemonless: () => ({
    flow: () => <FakePage title="Set up this device" />,
    plain: () => <FakePage title="Set up this device (with the shell around it)" />,
  }),
});
const entry: SurfaceEntry = {
  id: 'setup',
  title: 'Setup',
  core: false,
  contract: 'h-setup',
  consumes: [],
  manifest,
  app: half,
};
const surfaces: SurfaceEntry[] = [...CORE, entry];

const storage = memoryStore();
const transport = new FakeTransport(() => json({ error: 'none', code: 'not_found' }, 404));
const runtime = new ShellRuntime({
  appVersion: '5.0.0',
  surfaces,
  daemons: new DaemonList({ storage, now: () => 1 }),
  connect: async () => transport,
  daemonless: {
    views: registeredDaemonless(surfaces, {} as DaemonlessPorts).views,
    location: () => window.location.href,
  },
});
if (root !== null)
  createRoot(root).render(
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={window}
      scroll={new ScrollMemory(null)}
    />,
  );
