/**
 * The browser entry for the BADGE ROW and the LOOK PICKER (`badge-picker.visual.test.ts`): the real `Badge` primitive
 * carrying a very long label between two text lines, and the real Style picker with every style's mini. It owns no style:
 * the test sets the root attributes in place, so a style added to the catalogue is covered without touching this file.
 *
 *   ?style=<id>&palette=<id>&mode=<light|dark>
 */
import '../../../src/styles/index.css';
import '../../../src/ui/design-system.css';
import { createRoot } from 'react-dom/client';
import { StylePicker } from '../../../src/shell/appearance-pickers.tsx';
import { STYLES, type StyleId } from '../../../src/theme/catalog.ts';
import { Badge } from '../../../src/ui/primitives.tsx';

const params = new URLSearchParams(window.location.search);
const root = document.documentElement;
root.setAttribute('data-style', params.get('style') ?? 'studio');
root.setAttribute('data-palette', params.get('palette') ?? 'studio');
root.setAttribute('data-mode', params.get('mode') === 'dark' ? 'dark' : 'light');

export const LONG_LABEL =
  'build-machine-with-a-very-long-user-chosen-name-that-keeps-going-and-going-until-it-is-far-wider-than-any-phone';

createRoot(document.getElementById('root') as HTMLElement).render(
  <main className="bg-bg text-fg" style={{ minHeight: '100vh', padding: 16 }}>
    <section data-badge-row="" className="kt-panel" style={{ padding: 12, marginBottom: 16 }}>
      <p data-line="before">A line above the badge.</p>
      <div data-badge-host="" style={{ display: 'block' }}>
        <Badge tone="accent">{LONG_LABEL}</Badge>
      </div>
      <p data-line="after">Signed in as someone with a normal name.</p>
      <p data-short="">
        <Badge tone="ok">Short</Badge> <Badge tone="warn">Two words</Badge>
      </p>
    </section>
    <StylePicker
      styles={STYLES}
      value={(params.get('style') ?? 'studio') as StyleId}
      palette={(params.get('palette') ?? 'studio') as never}
      mode={params.get('mode') === 'dark' ? 'dark' : 'light'}
      onChange={() => undefined}
    />
  </main>,
);
