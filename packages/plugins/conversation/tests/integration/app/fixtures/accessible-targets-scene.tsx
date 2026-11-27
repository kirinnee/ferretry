/**
 * THE SHARED CONTROLS the Accessible style promises 44 x 44 px targets on (`accessible-targets.visual.test.ts`): the real
 * Dialog (its Close), the settings nav, a terminal's Replay (the real hypermedia renderer), a Button (both sizes) and an
 * icon-only Button, over fake data. Every control the test measures says so: `data-target="<name>"`. It owns NO style:
 * the test sets `data-style`, `data-palette` and `data-mode` on the root.
 */
import { Play } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import { ReferenceSurfaceProvider, ScreenHrefProvider } from '@ferretry/app';
import { Button, Dialog } from '@ferretry/app/ui';
import { HypermediaProse } from '../../../../app/hypermedia/hypermedia-prose.tsx';

const params = new URLSearchParams(window.location.search);
const root = document.documentElement;
root.setAttribute('data-style', params.get('style') ?? 'accessible');
root.setAttribute('data-palette', params.get('palette') ?? 'contrast');
root.setAttribute('data-mode', params.get('mode') === 'dark' ? 'dark' : 'light');

const FENCE = '`'.repeat(3);
const TERMINAL = [`${FENCE}terminal`, '$ bun test', 'ok 12 tests', FENCE].join('\n');
const referenceSurface = {};
const noop = () => undefined;

createRoot(document.getElementById('root') as HTMLElement).render(
  <main className="bg-bg text-fg" style={{ minHeight: '100vh', padding: 16 }}>
    <nav className="fy-settings-nav" style={{ margin: '12px 0', maxWidth: 220 }}>
      <a aria-current="page" className="fy-tab fy-tab--active" data-target="settings-nav-link" href="#current">
        Current page
      </a>
      <a className="fy-tab" data-target="settings-nav-link" href="#other">
        Other page
      </a>
    </nav>
    <div style={{ margin: '12px 0', maxWidth: 360 }}>
      <ScreenHrefProvider href={(daemon, plugin, screen) => `/${daemon}/${plugin}/${screen}`}>
        <ReferenceSurfaceProvider surface={referenceSurface}>
          <HypermediaProse text={TERMINAL} />
        </ReferenceSurfaceProvider>
      </ScreenHrefProvider>
    </div>
    <p style={{ display: 'flex', gap: 12 }}>
      <Button data-target="button">Save</Button>
      <Button data-target="button-sm" size="sm">
        Small
      </Button>
      <Button aria-label="Play" data-target="icon-button" icon={<Play aria-hidden size={16} />} size="sm" />
    </p>
    <Dialog closeLabel="Close" onClose={noop} open title="A dialog">
      <p>Some text.</p>
    </Dialog>
  </main>,
);
