/**
 * THE `layout` SETTINGS TAB (§5.3): the layout in use with the owner's changes applied, and the keys of it a person
 * may change as data — sidebar side, navigation, panels, density, theme.
 *
 * Two scopes, one set of rows. "Every device" saves through Layouts' own routes (`config/layout.yaml`, the same
 * writes `fy layout set` makes), so every open app follows at once. "This device only" is the app's saved data
 * (`--device`): no route, nothing sent to a daemon, and a phone and a laptop can differ.
 */
import type { DeviceLayout, NavCatalogItem } from '@ferretry/app';
import { Button, SHELL_ITEMS, Segmented, SettingGroup, SettingRow } from '@ferretry/app';
import { Loading, SortableList } from '@ferretry/app/ui';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { EyeIcon } from './eye-icon.tsx';
import { DEFAULT_LAYOUT, type Layout } from '../../../contract/index.ts';
import { useLayouts } from '../../hooks/use-layouts.ts';
import {
  type ChoiceSetting,
  choiceOf,
  LAYOUT_ID,
  LAYOUT_SETTINGS,
  type ListSetting,
  listOf,
  refusalSentence,
} from '../../lib/layout-model.ts';
import type { LayoutsClient } from '../../lib/layouts-client.ts';
import {
  type Change,
  changesOf,
  hiddenOf,
  humanize,
  navSources,
  type Place,
  type PlaceSource,
  placesOf,
  sourcesFromNames,
  withHidden,
} from '../../lib/list-places.ts';
import { LayoutPreview } from './previews/layout-preview.tsx';
import { NavListPreview } from './previews/nav-list-preview.tsx';

/** Saves one or more keys together; answers the reason it was refused, or `undefined` once it is saved. */
type Apply = (changes: readonly Change[]) => Promise<string | undefined>;

const INPUT_CLASS =
  'kt-input min-h-[44px] w-full min-w-0 rounded-control border border-border bg-surface-2 px-2 text-fg';

/** Why a place cannot be switched: Settings is the way back to every other setting. */
const LOCKED_HINT = 'Always shown';

function ListRow({
  setting,
  layout,
  sources,
  apply,
  busy,
}: {
  readonly setting: ListSetting;
  readonly layout: Layout;
  readonly sources: readonly PlaceSource[];
  readonly apply: Apply;
  readonly busy: boolean;
}) {
  const held = placesOf(layout, setting.path, sources);
  const heldKey = held.map(row => `${row.id}:${row.hidden ? 0 : 1}`).join('|');
  // What was just done stays on screen until the daemon's answer arrives and matches it: the row never snaps back.
  const [pending, setPending] = useState<readonly Place[] | undefined>(undefined);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new read of the layout (or a different list) is the trigger
  useEffect(() => setPending(undefined), [heldKey, layout]);
  const rows = pending ?? held;
  const save = async (next: readonly Place[]): Promise<void> => {
    setPending(next);
    const reason = await apply(changesOf(setting.path, next));
    setRefusal(reason);
    if (reason !== undefined) setPending(undefined);
  };
  const visible = rows.filter(row => !row.hidden).map(row => row.label);
  return (
    <SettingRow
      name={setting.name}
      hint={setting.hint}
      preview={
        setting.path === 'nav.items' || setting.path === 'phone.nav.items' ? (
          <NavListPreview items={visible} label={`${setting.name}: reorder and hide`} />
        ) : undefined
      }
    >
      <div className="min-w-0 px-panel pb-3" data-layout-list={setting.path}>
        <SortableList
          items={rows}
          itemKey={row => row.id}
          itemLabel={row => row.label}
          label={setting.name}
          disabled={busy}
          onReorder={next => void save(next)}
          renderItem={row => (
            <span className="flex min-w-0 items-center gap-2" data-hidden={row.hidden ? '' : undefined}>
              <span className={`min-w-0 flex-1 truncate text-ui ${row.hidden ? 'text-muted line-through' : 'text-fg'}`}>
                {row.label}
              </span>
              <button
                type="button"
                aria-pressed={!row.hidden}
                aria-label={`${row.hidden ? 'Show' : 'Hide'} ${row.label}`}
                title={row.locked ? LOCKED_HINT : row.hidden ? 'Hidden: press to show' : 'Shown: press to hide'}
                aria-disabled={busy || row.locked ? true : undefined}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
                onClick={() => {
                  if (!busy && !row.locked) void save(withHidden(rows, row.id, !row.hidden));
                }}
              >
                <EyeIcon hidden={row.hidden} />
              </button>
            </span>
          )}
        />
      </div>
      {refusal === undefined ? null : (
        <p role="alert" className="m-0 px-panel pb-2 text-meta text-err">
          {refusal}
        </p>
      )}
    </SettingRow>
  );
}

function ChoiceRow({
  setting,
  layout,
  apply,
  busy,
}: {
  readonly setting: ChoiceSetting;
  readonly layout: Layout;
  readonly apply: Apply;
  readonly busy: boolean;
}) {
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  return (
    <SettingRow
      name={setting.name}
      hint={setting.hint}
      wide
      preview={<LayoutPreview setting={setting} value={choiceOf(layout, setting.path)} />}
      control={() => (
        <Segmented
          label={setting.name}
          value={choiceOf(layout, setting.path)}
          options={setting.options}
          disabled={busy}
          onChange={async word => setRefusal(await apply([{ path: setting.path, value: word }]))}
        />
      )}
    >
      {refusal === undefined ? null : (
        <p role="alert" className="m-0 px-panel pb-2 text-meta text-err">
          {refusal}
        </p>
      )}
    </SettingRow>
  );
}

/** Where each list key's places come from: the installed nav set, the top bar's own items, the ferret side panels. */
function sourcesOf(
  path: ListSetting['path'],
  layout: Layout,
  catalog: readonly PlaceSource[] | undefined,
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
      return (DEFAULT_LAYOUT.panels['ferret.side'] ?? []).map(id => ({ id, label: humanize(id) }));
  }
}

/** Every editable key of `layout`, saved by `apply`. */
function Keys({
  layout,
  apply,
  busy,
  catalog,
}: {
  readonly layout: Layout;
  readonly apply: Apply;
  readonly busy: boolean;
  readonly catalog: readonly PlaceSource[] | undefined;
}) {
  return (
    <>
      {LAYOUT_SETTINGS.map(setting =>
        setting.kind === 'choice' ? (
          <ChoiceRow key={setting.path} setting={setting} layout={layout} apply={apply} busy={busy} />
        ) : (
          <ListRow
            key={setting.path}
            setting={setting}
            layout={layout}
            sources={sourcesOf(setting.path, layout, catalog)}
            apply={apply}
            busy={busy}
          />
        ),
      )}
    </>
  );
}

function Choose({
  label,
  value,
  ids,
  busy,
  onChoose,
}: {
  readonly label: string;
  readonly value: string;
  readonly ids: readonly { readonly id: string; readonly origin: 'built-in' | 'saved' }[];
  readonly busy: boolean;
  readonly onChoose: (id: string) => void;
}) {
  return (
    <select
      aria-label={label}
      className={`${INPUT_CLASS} max-w-[16rem]`}
      value={value}
      disabled={busy}
      onChange={event => onChoose(event.target.value)}
    >
      {ids.map(item => (
        <option key={item.id} value={item.id}>
          {item.origin === 'saved' ? `${item.id} (saved)` : item.id}
        </option>
      ))}
    </select>
  );
}

function Problem({ children }: { readonly children: ReactNode }) {
  return (
    <p role="alert" className="m-0 text-ui text-err">
      {children}
    </p>
  );
}

export interface LayoutSettingsProps {
  readonly client: LayoutsClient;
  /** This device's own choice; absent outside the shell, where the tab offers only the owner's. */
  readonly device?: DeviceLayout;
  /** The installed navigation places (the shell's `useNavCatalog()`); absent outside the shell. */
  readonly navCatalog?: readonly NavCatalogItem[];
}

export function LayoutSettings({ client, device, navCatalog }: LayoutSettingsProps) {
  const { state, refresh } = useLayouts(client);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [saveAs, setSaveAs] = useState('');

  /** Runs one write on the daemon, then reads again; the refusal becomes the sentence the tab shows. */
  const run = useCallback(
    async (write: () => Promise<void>): Promise<string | undefined> => {
      setBusy(true);
      setNotice(undefined);
      try {
        await write();
        refresh();
        return undefined;
      } catch (error) {
        const sentence = refusalSentence(error);
        setNotice(sentence);
        return sentence;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  if (state.status === 'loading') return <Loading kind="page" label="Reading the layout…" />;
  if (state.status === 'failed') return <Problem>{state.error}</Problem>;

  const { current, list } = state.read;
  const saved = list.layouts.filter(layout => layout.origin === 'saved');
  const catalog = navCatalog === undefined ? undefined : navSources(navCatalog);
  const owner: Apply = changes => run(() => client.setMany(changes));
  const theirs: Apply = async changes => {
    for (const change of changes) {
      const refused = device?.set(change.path, change.value);
      if (refused !== undefined) return refused;
    }
    return undefined;
  };

  return (
    <div className="flex min-w-0 flex-col gap-4" data-layout-settings="">
      {notice === undefined ? null : <Problem>{notice}</Problem>}

      <SettingGroup label="In use">
        <SettingRow
          name="Layout"
          hint={`${current.layout.id} — the layout in use, with your changes applied`}
          wide
          control={() => (
            <Choose
              label="Layout"
              value={list.current.layout}
              ids={list.layouts}
              busy={busy}
              onChoose={id => void run(() => client.switchLayout(id))}
            />
          )}
        />
        <SettingRow
          name="Theme"
          hint={`${current.theme.label} — colours, type and spacing`}
          wide
          control={() => (
            <Choose
              label="Theme"
              value={list.current.theme}
              ids={list.themes}
              busy={busy}
              onChoose={id => void run(() => client.switchTheme(id))}
            />
          )}
        />
        {device?.refused === undefined ? null : (
          <SettingRow
            name="Refused layout"
            hint={`The layout "${device.refused.layout}" cannot be used here: ${device.refused.issues[0]?.message ?? 'a name it holds is not installed'}.`}
          />
        )}
      </SettingGroup>

      <SettingGroup label="Layout — every device">
        <Keys layout={current.layout} apply={owner} busy={busy} catalog={catalog} />
        <SettingRow
          name="Start over"
          hint="Drop your changes and use the built-in default"
          control={() =>
            confirmingReset ? (
              <span className="flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    setConfirmingReset(false);
                    void run(() => client.reset());
                  }}
                >
                  Confirm reset
                </Button>
                <Button type="button" size="sm" onClick={() => setConfirmingReset(false)}>
                  Keep
                </Button>
              </span>
            ) : (
              <Button type="button" size="sm" disabled={busy} onClick={() => setConfirmingReset(true)}>
                Reset
              </Button>
            )
          }
        />
        <SettingRow
          name="Save as a new layout"
          hint="Keep the layout in use under a name, to switch back to or share"
          wide
          control={labelId => (
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 max-md:w-full">
              <input
                type="text"
                aria-labelledby={labelId}
                className={INPUT_CLASS}
                value={saveAs}
                placeholder="mine"
                disabled={busy}
                onChange={event => setSaveAs(event.target.value)}
              />
              <Button
                type="button"
                size="sm"
                disabled={busy || !LAYOUT_ID.test(saveAs)}
                onClick={() => {
                  void run(() => client.save(saveAs)).then(refusal => {
                    if (refusal === undefined) setSaveAs('');
                  });
                }}
              >
                Save layout
              </Button>
            </span>
          )}
        />
        {saved.map(layout => (
          <SettingRow
            key={layout.id}
            name={layout.id}
            hint="A saved layout"
            control={() => (
              <Button
                type="button"
                size="sm"
                aria-label={`Remove ${layout.id}`}
                disabled={busy}
                onClick={() => void run(() => client.remove(layout.id))}
              >
                Remove
              </Button>
            )}
          />
        ))}
      </SettingGroup>

      {device === undefined ? null : (
        // The same keys again, for this device alone: closed until this device has changes of its own.
        <details open={Object.keys(device.overrides).length > 0} data-layout-device="">
          <summary className="cursor-pointer text-meta font-semibold uppercase tracking-wide text-muted">
            Layout — this device only
          </summary>
          <div className="mt-2">
            <SettingGroup label="Layout — this device only">
              <Keys layout={device.inForce} apply={theirs} busy={false} catalog={catalog} />
              <SettingRow
                name="Follow the owner's layout"
                hint={
                  Object.keys(device.overrides).length === 0
                    ? 'This device has no changes of its own'
                    : 'Drop what this device changed'
                }
                control={() => (
                  <Button
                    type="button"
                    size="sm"
                    disabled={Object.keys(device.overrides).length === 0}
                    onClick={() => device.reset()}
                  >
                    Follow again
                  </Button>
                )}
              />
            </SettingGroup>
          </div>
        </details>
      )}
    </div>
  );
}
