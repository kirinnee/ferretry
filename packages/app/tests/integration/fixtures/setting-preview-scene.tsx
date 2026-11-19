/**
 * The browser entry for the setting preview: three fake settings rows, each with a `SettingPreview` whose scene is drawn
 * from divs (a menu that moves from the left to the right, a list that tightens, a switch that turns on). Fake data only;
 * the scenes are the kind C5 to C7 write, drawn from theme tokens through utilities.
 *
 *   ?theme=<family>-<mode>   ?motion=reduced  sets Settings › Motion to Reduced
 */

import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingPreview } from '../../../src/compose/setting-preview.tsx';
import { SettingGroup, SettingRow, SettingRowGrid } from '../../../src/compose/setting-row.tsx';

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

/**
 * A setting that RESTS on its value and plays once when it changes: the button flips the value, and the preview's
 * `before` is the value it just left.
 */
function Flip<T extends string>({
  name,
  hint,
  values,
  label,
  scene,
}: {
  readonly name: string;
  readonly hint: string;
  readonly values: readonly [T, T];
  readonly label: (value: T) => string;
  readonly scene: (value: T) => React.ReactNode;
}) {
  const [{ previous, value }, set] = useState<{ previous: T; value: T }>({ previous: values[0], value: values[1] });
  return (
    <SettingRow
      name={name}
      hint={hint}
      preview={<SettingPreview label={label(value)} value={value} before={scene(previous)} after={scene(value)} />}
      control={() => (
        <button
          type="button"
          data-flip=""
          className="min-h-[44px] rounded-control border border-border px-3 text-ui text-fg"
          onClick={() =>
            set(state => ({ previous: state.value, value: state.value === values[0] ? values[1] : values[0] }))
          }
        >
          {value}
        </button>
      )}
    />
  );
}

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="mx-auto max-w-5xl p-4">
      <SettingGroup label="Look">
        <Flip
          name="Menu side"
          hint="Which edge the menu sits on."
          values={['left', 'right']}
          label={value => `The menu on the ${value}`}
          scene={value => <Menu side={value} />}
        />
        <Flip
          name="Density"
          hint="How tightly the rows sit."
          values={['comfortable', 'compact']}
          label={value => `${value} rows`}
          scene={value => <Rows gap={value === 'compact' ? 4 : 14} />}
        />
        <SettingRow
          name="No preview here"
          hint="A row without one is unchanged."
          control={() => <span className="text-ui text-fg">—</span>}
        />
      </SettingGroup>
      <SettingGroup label="Quiet">
        <Flip
          name="Group needs-you"
          hint="Put what is waiting on you first."
          values={['off', 'on']}
          label={value => `Switched ${value}`}
          scene={value => <Switch on={value === 'on'} />}
        />
        <SettingRowGrid>
          <SettingRow name="Short one" control={() => <span className="text-ui text-fg">A</span>} />
          <SettingRow name="Short two" control={() => <span className="text-ui text-fg">B</span>} />
        </SettingRowGrid>
      </SettingGroup>
    </div>,
  );
