/**
 * THE `layout` SETTINGS TAB (§5.3): the layout in use with the owner's changes applied, and the keys of it a person
 * may change as data — sidebar side, navigation, panels, density, theme.
 *
 * Two scopes, one set of rows. "Every device" saves through Layouts' own routes (`config/layout.yaml`, the same
 * writes `fy layout set` makes), so every open app follows at once. "This device only" is the app's saved data
 * (`--device`): no route, nothing sent to a daemon, and a phone and a laptop can differ.
 */
import type { DeviceLayout } from '@ferretry/app';
import { Button, Segmented, SettingGroup, SettingRow } from '@ferretry/app';
import { type ReactNode, useCallback, useId, useState } from 'react';
import type { Layout } from '../../../contract/index.ts';
import { useLayouts } from '../../hooks/use-layouts.ts';
import {
  type ChoiceSetting,
  choiceOf,
  LAYOUT_ID,
  LAYOUT_SETTINGS,
  type ListSetting,
  listOf,
  listText,
  refusalSentence,
} from '../../lib/layout-model.ts';
import type { LayoutsClient } from '../../lib/layouts-client.ts';

/** Saves one key; answers the reason it was refused, or `undefined` once it is saved. */
type Apply = (path: string, value: string) => Promise<string | undefined>;

const INPUT_CLASS =
  'kt-input min-h-[44px] w-full min-w-0 rounded-control border border-border bg-surface-2 px-2 text-fg';

function ListRow({
  setting,
  layout,
  apply,
  busy,
}: {
  readonly setting: ListSetting;
  readonly layout: Layout;
  readonly apply: Apply;
  readonly busy: boolean;
}) {
  const held = listText(listOf(layout, setting.path));
  const [draft, setDraft] = useState(held);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const id = useId();
  const save = async (): Promise<void> => {
    setRefusal(await apply(setting.path, draft));
  };
  return (
    <SettingRow
      name={setting.name}
      hint={setting.hint}
      wide
      control={labelId => (
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 max-md:w-full">
          <input
            id={id}
            type="text"
            aria-labelledby={labelId}
            aria-invalid={refusal === undefined ? undefined : true}
            className={INPUT_CLASS}
            value={draft}
            disabled={busy}
            onChange={event => setDraft(event.target.value)}
          />
          <Button type="button" size="sm" disabled={busy || draft === held} onClick={() => void save()}>
            Save
          </Button>
        </span>
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
      control={() => (
        <Segmented
          label={setting.name}
          value={choiceOf(layout, setting.path)}
          options={setting.options}
          disabled={busy}
          onChange={async word => setRefusal(await apply(setting.path, word))}
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

/** Every editable key of `layout`, saved by `apply`. */
function Keys({ layout, apply, busy }: { readonly layout: Layout; readonly apply: Apply; readonly busy: boolean }) {
  return (
    <>
      {LAYOUT_SETTINGS.map(setting =>
        setting.kind === 'choice' ? (
          <ChoiceRow key={setting.path} setting={setting} layout={layout} apply={apply} busy={busy} />
        ) : (
          <ListRow
            // The key carries what is held, so a change made elsewhere replaces what was half typed.
            key={`${setting.path}=${listText(listOf(layout, setting.path))}`}
            setting={setting}
            layout={layout}
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
}

export function LayoutSettings({ client, device }: LayoutSettingsProps) {
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

  if (state.status === 'loading') return <p role="status">Reading the layout…</p>;
  if (state.status === 'failed') return <Problem>{state.error}</Problem>;

  const { current, list } = state.read;
  const saved = list.layouts.filter(layout => layout.origin === 'saved');
  const owner: Apply = (path, value) => run(() => client.set(path, value));
  const theirs: Apply = async (path, value) => device?.set(path, value);

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
        <Keys layout={current.layout} apply={owner} busy={busy} />
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
        <SettingGroup label="Layout — this device only">
          <Keys layout={device.inForce} apply={theirs} busy={false} />
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
      )}
    </div>
  );
}
