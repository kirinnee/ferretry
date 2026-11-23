/** A key that takes a list of places: the name, and its places as chips to drag, move and hide (nav-chips.tsx). */
import { useEffect, useId, useState } from 'react';
import type { Layout } from '../../../contract/index.ts';
import type { ListSetting } from '../../lib/layout-model.ts';
import { changesOf, keepPhoneNav, type Place, type PlaceSource, placesOf, withHidden } from '../../lib/list-places.ts';
import type { Apply } from './choice-row.tsx';
import { LayoutRow } from './layout-row.tsx';
import { NavChips } from './nav-chips.tsx';
import { NavListPreview } from './previews/nav-list-preview.tsx';

export function ListRow({
  setting,
  layout,
  sources,
  apply,
  busy,
  absent,
}: {
  readonly setting: ListSetting;
  readonly layout: Layout;
  readonly sources: readonly PlaceSource[];
  readonly apply: Apply;
  readonly busy: boolean;
  /** Places this list names that are not drawn here (a panel of a plugin that is off): no row, and a save keeps them. */
  readonly absent?: ReadonlySet<string>;
}) {
  const id = useId();
  const held = placesOf(layout, setting.path, sources, absent);
  const heldKey = held.map(row => `${row.id}:${row.hidden ? 0 : 1}`).join('|');
  // What was just done stays on screen until the daemon's answer arrives and matches it: the row never snaps back.
  const [pending, setPending] = useState<readonly Place[] | undefined>(undefined);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new read of the layout (or a different list) is the trigger
  useEffect(() => setPending(undefined), [heldKey, layout]);
  const rows = pending ?? held;
  const save = async (next: readonly Place[]): Promise<void> => {
    setPending(next);
    const reason = await apply(
      keepPhoneNav(
        layout,
        setting.path,
        sources,
        changesOf(setting.path, next, {
          layout,
          sources,
          ...(absent === undefined ? {} : { absent }),
        }),
      ),
    );
    setRefusal(reason);
    if (reason !== undefined) setPending(undefined);
  };
  const visible = rows.filter(row => !row.hidden).map(row => row.label);
  return (
    <LayoutRow
      id={id}
      full
      name={setting.name}
      hint={setting.hint}
      preview={
        setting.path === 'nav.items' || setting.path === 'phone.nav.items' ? (
          <NavListPreview items={visible} label={`${setting.name}: reorder and hide`} />
        ) : undefined
      }
      control={() => (
        <div className="min-w-0" data-layout-list={setting.path}>
          <NavChips
            rows={rows}
            label={setting.name}
            disabled={busy}
            onReorder={next => void save(next)}
            onToggle={(placeId, hidden) => void save(withHidden(rows, placeId, hidden))}
          />
        </div>
      )}
    >
      {refusal === undefined ? null : (
        <p role="alert" className="m-0 pt-2 text-meta text-err">
          {refusal}
        </p>
      )}
    </LayoutRow>
  );
}
