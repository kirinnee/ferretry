/**
 * THE `layout` SETTINGS PAGE (§5.3): ONE page, one set of rows — sidebar side, navigation, panels, density — and one
 * switch that says where a change is saved: "Same on all my devices" or "Just this device".
 *
 * "Same on all my devices" saves through Layouts' own routes (`config/layout.yaml`, the same writes `fy layout set`
 * makes), so every open app follows at once. "Just this device" is the app's saved data (`--device`): no route, nothing
 * sent to a daemon, and a phone and a laptop can differ. Outside a shell there is no device, so the switch is not drawn.
 */
import type { DeviceLayout, NavCatalogItem } from '@ferretry/app';
import { Button } from '@ferretry/app';
import { Loading, SelectBox } from '@ferretry/app/ui';
import { type ReactNode, useCallback, useId, useState } from 'react';
import type { Apply } from './choice-row.tsx';
import { LayoutKeys } from './layout-keys.tsx';
import { LayoutGroup, LayoutRow } from './layout-row.tsx';
import { ScopeSwitch } from './scope-switch.tsx';
import { LAYOUT_ID, refusalSentence, type Scope } from '../../lib/layout-model.ts';
import type { LayoutsClient } from '../../lib/layouts-client.ts';
import { navSources } from '../../lib/list-places.ts';
import { useLayouts } from '../../hooks/use-layouts.ts';

const INPUT_CLASS =
  'kt-input min-h-[44px] w-full min-w-0 rounded-control border border-border bg-surface-2 px-2 text-fg';

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
    <SelectBox
      className="max-w-[16rem]"
      disabled={busy}
      label={label}
      onChange={onChoose}
      options={ids.map(item => ({ value: item.id, label: item.origin === 'saved' ? `${item.id} (saved)` : item.id }))}
      value={value}
    />
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
  /** This device's own choice; absent outside the shell, where the page offers only the shared layout. */
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
  const ids = useId();
  const changes = device === undefined ? 0 : Object.keys(device.overrides).length;
  // A device that already differs opens on its own changes; one that follows opens on the shared layout.
  const [chosen, setScope] = useState<Scope | undefined>(undefined);
  const scope: Scope = device === undefined ? 'all' : (chosen ?? (changes > 0 ? 'device' : 'all'));

  /** Runs one write on the daemon, then reads again; the refusal becomes the sentence the page shows. */
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
  const owner: Apply = changesToSave => run(() => client.setMany(changesToSave));
  const theirs: Apply = async changesToSave => {
    for (const change of changesToSave) {
      const refused = device?.set(change.path, change.value);
      if (refused !== undefined) return refused;
    }
    return undefined;
  };

  return (
    <div className="fy-lr-page" data-layout-settings="">
      {notice === undefined ? null : <Problem>{notice}</Problem>}

      {device === undefined ? null : <ScopeSwitch scope={scope} onChange={setScope} changes={changes} />}

      {scope === 'all' || device?.refused !== undefined ? (
        <LayoutGroup label="In use">
          {scope === 'all' ? (
            <>
              <LayoutRow
                id={`${ids}-layout`}
                name="Layout"
                hint={`${current.layout.id} — the layout in use, with your changes applied`}
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
              <LayoutRow
                id={`${ids}-theme`}
                name="Theme"
                hint={`${current.theme.label} — colours, type and spacing`}
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
            </>
          ) : null}
          {device?.refused === undefined ? null : (
            <LayoutRow
              id={`${ids}-refused`}
              name="Refused layout"
              hint={`The layout "${device.refused.layout}" cannot be used here: ${device.refused.issues[0]?.message ?? 'a name it holds is not installed'}.`}
              control={() => null}
            />
          )}
        </LayoutGroup>
      ) : null}

      {scope === 'all' ? (
        <LayoutKeys layout={current.layout} apply={owner} busy={busy} catalog={catalog} />
      ) : device === undefined ? null : (
        <LayoutKeys layout={device.inForce} apply={theirs} busy={false} catalog={catalog} />
      )}

      {scope === 'all' ? (
        <LayoutGroup label="Saved layouts">
          <LayoutRow
            id={`${ids}-reset`}
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
          <LayoutRow
            id={`${ids}-save`}
            name="Save as a new layout"
            hint="Keep the layout in use under a name, to switch back to or share"
            control={labelId => (
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <input
                  type="text"
                  aria-labelledby={labelId}
                  className={`${INPUT_CLASS} max-w-[14rem]`}
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
            <LayoutRow
              key={layout.id}
              id={`${ids}-${layout.id}`}
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
        </LayoutGroup>
      ) : device === undefined ? null : (
        <LayoutGroup label="This device">
          <LayoutRow
            id={`${ids}-follow`}
            name="Follow the shared layout"
            hint={changes === 0 ? 'This device has no changes of its own' : 'Drop what this device changed'}
            control={() => (
              <Button type="button" size="sm" disabled={changes === 0} onClick={() => device.reset()}>
                Follow again
              </Button>
            )}
          />
        </LayoutGroup>
      )}
    </div>
  );
}
