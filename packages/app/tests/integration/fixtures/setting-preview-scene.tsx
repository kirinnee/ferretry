/**
 * The browser entry for the setting preview: three fake settings rows, each with a `SettingPreview` whose scene is drawn
 * from divs (a menu that moves from the left to the right, a list that tightens, a switch that turns on). Fake data only;
 * the scenes are the kind C5 to C7 write, drawn from theme tokens through utilities.
 *
 *   ?theme=<family>-<mode>   ?motion=reduced  sets Settings › Motion to Reduced
 */

import { createRoot } from 'react-dom/client';
import { SettingPreview } from '../../../src/compose/setting-preview.tsx';
import { SettingGroup, SettingRow } from '../../../src/compose/setting-row.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
if (params.get('motion') === 'reduced') document.documentElement.dataset.motion = 'reduced';

/** Geometry is inline pixels (a scene must not depend on which utilities the stylesheet generated); colour is the theme's. */
const block = (style: React.CSSProperties, accent = false) => (
  <div
    className={accent ? 'bg-accent' : 'bg-border-strong'}
    style={{ position: 'absolute', borderRadius: 3, ...style }}
  />
);

/** A mini app: a menu column on one side and a few lines of content beside it. */
const Menu = ({ side }: { readonly side: 'left' | 'right' }) => {
  const menuAt = side === 'left' ? { left: 0 } : { right: 0 };
  const contentAt = side === 'left' ? { left: 36, right: 0 } : { left: 0, right: 36 };
  return (
    <div style={{ position: 'absolute', inset: 8 }}>
      {block({ top: 0, bottom: 0, width: 28, ...menuAt }, true)}
      {[0, 1, 2].map(index => (
        <div key={index}>{block({ top: 4 + index * 14, height: 8, ...contentAt })}</div>
      ))}
    </div>
  );
};

const Rows = ({ gap }: { readonly gap: number }) => (
  <div style={{ position: 'absolute', inset: 8, display: 'flex', flexDirection: 'column', gap }}>
    {[0, 1, 2, 3].map(index => (
      <div
        key={index}
        className="bg-border-strong"
        style={{ height: 12, borderRadius: 3, width: `${100 - index * 12}%` }}
      />
    ))}
  </div>
);

const Switch = ({ on }: { readonly on: boolean }) => (
  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <div
      className={on ? 'bg-accent' : 'bg-border-strong'}
      style={{ width: 36, height: 20, borderRadius: 10, position: 'relative' }}
    >
      <div
        className="bg-surface"
        style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 16, height: 16, borderRadius: 8 }}
      />
    </div>
  </div>
);

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="mx-auto max-w-3xl p-4">
      <SettingGroup label="Look">
        <SettingRow
          name="Menu side"
          hint="Which edge the menu sits on."
          preview={
            <SettingPreview
              label="The menu on the right"
              value="right"
              before={<Menu side="left" />}
              after={<Menu side="right" />}
            />
          }
          control={() => <span className="text-ui text-fg">Right</span>}
        />
        <SettingRow
          name="Density"
          hint="How tightly the rows sit."
          preview={
            <SettingPreview label="Compact rows" value="compact" before={<Rows gap={14} />} after={<Rows gap={4} />} />
          }
          control={() => <span className="text-ui text-fg">Compact</span>}
        />
        <SettingRow
          name="Group needs-you"
          hint="Put what is waiting on you first."
          preview={
            <SettingPreview label="Switched on" value="on" before={<Switch on={false} />} after={<Switch on />} />
          }
          control={() => <span className="text-ui text-fg">On</span>}
        />
        <SettingRow
          name="No preview here"
          hint="A row without one is unchanged."
          control={() => <span className="text-ui text-fg">—</span>}
        />
      </SettingGroup>
    </div>,
  );
