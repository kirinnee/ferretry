/**
 * The browser entry for the layout previews over FAKE data (no daemon): the REAL Layout tab, read from a scripted client.
 *
 *   ?theme=<family>-<mode>   ?motion=reduced  sets Settings › Motion to Reduced
 */
import { createRoot } from 'react-dom/client';
import { LayoutSettings } from '../../../../app/features/layout/layout-settings.tsx';
import { scriptedLayouts } from '../../../support/layouts-app.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
if (params.get('motion') === 'reduced') document.documentElement.dataset.motion = 'reduced';

const script = scriptedLayouts();

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="mx-auto max-w-3xl p-4" data-scene-ready="">
      <LayoutSettings client={script.client} />
    </div>,
  );
