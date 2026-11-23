/** Every editable key of a layout, in headed groups (Navigation · The page · On a phone), saved by `apply`. */
import { SHELL_ITEMS } from '@ferretry/app';
import { DEFAULT_LAYOUT, type Layout } from '../../../contract/index.ts';
import { LAYOUT_SECTIONS, LAYOUT_SETTINGS, type ListSetting, listOf } from '../../lib/layout-model.ts';
import { hiddenOf, humanize, type PlaceSource, sourcesFromNames } from '../../lib/list-places.ts';
import { type Apply, ChoiceRow } from './choice-row.tsx';
import { LayoutGroup } from './layout-row.tsx';
import { ListRow } from './list-row.tsx';

/** Where each list key's places come from: the installed nav set, the top bar's own items, the ferret side panels. */
function sourcesOf(
  path: ListSetting['path'],
  layout: Layout,
  catalog: readonly PlaceSource[] | undefined,
  absent: ReadonlySet<string>,
): readonly PlaceSource[] {
  switch (path) {
    case 'nav.items':
    case 'phone.nav.items':
      // Outside a shell there is no installed set: the places the layout already names stand in for it.
      return catalog ?? sourcesFromNames([...listOf(layout, path), ...(hiddenOf(layout, path) ?? [])]);
    case 'top':
    case 'phone.top':
      return SHELL_ITEMS.top.map(id => ({ id, label: humanize(id) }));
    case 'panels.ferret.side':
      return (DEFAULT_LAYOUT.panels['ferret.side'] ?? [])
        .filter(id => !absent.has(id))
        .map(id => ({ id, label: humanize(id) }));
  }
}

const NOTHING_ABSENT: ReadonlySet<string> = new Set();

export function LayoutKeys({
  layout,
  apply,
  busy,
  catalog,
  absentPanels = NOTHING_ABSENT,
}: {
  readonly layout: Layout;
  readonly apply: Apply;
  readonly busy: boolean;
  readonly catalog: readonly PlaceSource[] | undefined;
  /** Ferret side panels no paired machine offers (their plugin is off): no control for them, and a save keeps them. */
  readonly absentPanels?: ReadonlySet<string>;
}) {
  return (
    <>
      {LAYOUT_SECTIONS.map(section => (
        <LayoutGroup key={section.id} label={section.name}>
          {section.paths.map(path => {
            const setting = LAYOUT_SETTINGS.find(entry => entry.path === path);
            if (setting === undefined) return null;
            return setting.kind === 'choice' ? (
              <ChoiceRow key={path} setting={setting} layout={layout} apply={apply} busy={busy} />
            ) : (
              <ListRow
                key={path}
                setting={setting}
                layout={layout}
                sources={sourcesOf(setting.path, layout, catalog, absentPanels)}
                apply={apply}
                busy={busy}
                absent={setting.path === 'panels.ferret.side' ? absentPanels : undefined}
              />
            );
          })}
        </LayoutGroup>
      ))}
    </>
  );
}
