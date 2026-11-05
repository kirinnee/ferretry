/**
 * B164: a hypermedia block inside the phone's agenda swipe-deck card, the one place `position: fixed` fullscreen
 * was confined to the card (`fy-render-expand-screenshot.ts` drives it). Fake data only.
 */
import { createRoot } from 'react-dom/client';
import { Markdown } from '../src/components/markdown.tsx';

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="120" height="60" fill="#7aa2f7"/></svg>';
const text = ['```fy-render', 'type: svg', 'alt: A blue rectangle', '---', SVG, '```'].join('\n');

createRoot(document.getElementById('root') as HTMLElement).render(
  <>
    <header data-testid="app-header" style={{ position: 'sticky', top: 0, zIndex: 20, background: 'var(--bg)' }}>
      Ferretry
    </header>
    <div className="fy-attn-deck" style={{ margin: 12 }}>
      <div className="fy-attn-deck__top" style={{ touchAction: 'pan-y' }}>
        <div className="fy-attn-card" style={{ padding: 12 }}>
          <Markdown enableFyRender text={text} />
        </div>
      </div>
    </div>
  </>,
);
