/**
 * The browser entry for a setting row laid out by its OWN width: the same labelled row, with a preview and a control, drawn
 * in boxes of fixed widths (a resized drawer or nav leaves the panel any width, whatever the window is). Fake data only.
 *
 *   ?theme=<family>-<mode>
 */

import { createRoot } from 'react-dom/client';
import { SettingGroup, SettingRow } from '../../../src/compose/setting-row.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const WIDTHS = [300, 480, 700, 1000] as const;

createRoot(document.getElementById('root') as HTMLElement).render(
  <div style={{ padding: 8 }}>
    {WIDTHS.map(width => (
      <div key={width} data-box={width} style={{ width, maxWidth: '100%', marginBottom: 16 }}>
        <SettingGroup label={`Panel ${width}px`}>
          <SettingRow
            name="Menu side"
            hint="Which side the menu sits on"
            preview={<div data-scene="" style={{ width: 160, height: 100, background: 'var(--surface-2, #ddd)' }} />}
            control={() => <button type="button">Left</button>}
          />
        </SettingGroup>
      </div>
    ))}
  </div>,
);
document.body.dataset.scene = 'ready';
